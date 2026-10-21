/* 数学人生 PWA — 应用壳：hash 路由 / 卡片浏览与搜索 / 动态计算器 */
(function () {
  "use strict";

  var state = {
    cards: [],        // cards.json
    spec: {},         // compute-spec.json
    meta: {},         // meta.json
    bySlug: {},
    searchText: {},
  };

  // 列表浏览状态：返回列表时恢复滚动位置 / 搜索词 / 筛选
  var listState = { scroll: 0, query: "", theme: "", favOnly: false };
  var listVisited = false;
  var currentPage = null;
  var calcScene = ""; // 计算器列表当前选中的场景分类（""=未选/空状态）

  var view = document.getElementById("view");
  var versionBadge = document.getElementById("version-badge");

  // ---------------------------------------------------------------- 工具
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  // 构建期注入的版本号（build.py 把 __ASSET_V__ 替换为实际版本）。
  // dev / 测试环境未替换时保持 "1.11.11"，此时不加版本参数，兼容本地与桩。
  var ASSET_V = "1.11.11";
  // 诊断开关：仅 ?debug=1 时收集输入/渲染计数，用于定位「能输入但结果不动」
  var DBG = /[?&]debug=1/.test(location.search);
  var DIAG = DBG ? { input: 0, paint: 0, lastVal: "", err: "" } : null;
  function fetchJSON(url) {
    // 数据文件同样带版本参数：否则「新代码 + 旧 meta.json 缓存」会显示旧版本号，
    // 用户会以为根本没更新（v1.11.6 → v1.11.7 真实踩到过）。
    var q = (ASSET_V && ASSET_V.charAt(0) !== "_") ? "?v=" + ASSET_V : "";
    return fetch(url + q).then(function (r) {
      if (!r.ok) throw new Error("加载失败: " + url + " (" + r.status + ")");
      return r.json();
    });
  }
  function stripTags(html) {
    var d = document.createElement("div");
    d.innerHTML = html;
    return (d.textContent || d.innerText || "").replace(/\s+/g, " ");
  }
  function toast(msg, ms) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { t.hidden = true; }, ms || 2200);
  }

  // ---------------------------------------------------------------- 收藏（localStorage）
  var FAV_KEY = "lm-favs";
  function loadFavs() {
    try { var v = JSON.parse(localStorage.getItem(FAV_KEY) || "[]"); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  var favs = loadFavs();
  function saveFavs() {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch (e) { /* 隐私模式忽略 */ }
  }
  function isFav(slug) { return favs.indexOf(slug) > -1; }
  function toggleFav(slug) {
    var i = favs.indexOf(slug);
    if (i > -1) favs.splice(i, 1); else favs.push(slug);
    saveFavs();
  }

  // ---------------------------------------------------------------- 数据加载
  function loadData() {
    return Promise.all([
      fetchJSON("./cards.json"),
      fetchJSON("./compute-spec.json"),
      fetchJSON("./meta.json"),
    ]).then(function (rs) {
      state.cards = rs[0];
      state.spec = rs[1];
      state.meta = rs[2];
      state.cards.forEach(function (c) {
        state.bySlug[c.slug] = c;
        state.searchText[c.slug] = (c.title + " " + c.summary + " " +
          (c.scenarios || []).join(" ") + " " + (c.misconceptions || []).join(" ") + " " +
          c.thinking + " " + stripTags(c.html)).toLowerCase();
      });
      versionBadge.textContent = "v" + state.meta.version;
      document.title = state.meta.name + " v" + state.meta.version;
    });
  }

  function themes() {
    var counts = {};
    state.cards.forEach(function (c) { var t = c.thinking || "未分类"; counts[t] = (counts[t] || 0) + 1; });
    return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
  }

  // ---------------------------------------------------------------- Phase 2 云端语义兜底（优雅降级）
  // 仅在「在线 + 配置了网关 URL」时，把用户大白话问题交给云端 LLM 路由到更多卡片/工具，并附一句解读。
  // 任何失败（离线 / 超时 / 网关未开通 / 无结果）都静默忽略，绝不破坏离线搜索结果。
  var _cloudReqId = 0;
  var _cloudTimer = null;
  function cloudSuggest(q, page, box) {
    var url = state.meta && state.meta.cloudSuggestUrl;
    if (!url || !q || typeof navigator === "undefined" || !navigator.onLine) return;
    if (_cloudTimer) clearTimeout(_cloudTimer);
    var myQ = q;
    _cloudTimer = setTimeout(function () { doCloudSuggest(myQ, page, box); }, 350); // 输入防抖
  }
  // 模块加载兜底：aliases.js 若未能加载（旧内核解析失败 / 被拦截 / 缓存异常），
  // 直接用朴素子串匹配，保证「输入一定有反应」，而不是让整条渲染链抛错后静默失败。
  function matchHaySafe(raw, hay) {
    var q = String(raw == null ? "" : raw).replace(/^\s+|\s+$/g, "");
    // 空关键词：全部命中满分。必须与原 `kw ? matchHay(...) : {score:100}` 语义一致，
    // 否则计算器列表（无关键词时靠 score>0 过滤）会被全部滤掉。
    if (!q) return { hit: true, score: 100 };
    var A = window.LMAliases;
    if (A && typeof A.matchHay === "function") return A.matchHay(raw, hay);
    var h = String(hay == null ? "" : hay).toLowerCase();
    return h.indexOf(q.toLowerCase()) >= 0 ? { hit: true, score: 50 } : { hit: false, score: 0 };
  }
  function showAiLoading(box) {
    if (!box || box.querySelector(".ai-loading")) return;
    box.insertAdjacentHTML("beforeend",
      '<div class="ai-loading"><span class="ai-ico">🤖</span><span>AI 正在补充建议…</span></div>');
  }
  function hideAiLoading(box) {
    if (!box) return;
    var el = box.querySelector(".ai-loading");
    if (el) el.parentNode.removeChild(el);
  }
  function doCloudSuggest(q, page, box) {
    if (!box) return;
    var myId = ++_cloudReqId;
    var ctrl = new AbortController();
    // 云函数冷启动可能 10s+，先给即时反馈，避免用户以为「点了没反应」。
    showAiLoading(box);
    // 前端超时必须大于云函数内部 LLM 超时（AGNES_TIMEOUT=12s），否则冷启动
    // （实测约 11.5s）时请求会被前端提前 abort，AI 兜底永远不显示。
    var timer = setTimeout(function () { ctrl.abort(); }, 16000);
    fetch(state.meta.cloudSuggestUrl + "?q=" + encodeURIComponent(q.slice(0, 200)), { signal: ctrl.signal })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        clearTimeout(timer);
        if (myId !== _cloudReqId) return;        // 已有更新的搜索，丢弃本次（loading 交给新请求）
        hideAiLoading(box);
        if (!j || !j.ok) return;                 // 云端不可用 / 无结果 -> 保持离线结果
        renderCloudAddon(j, page, box);
      })
      .catch(function () {
        clearTimeout(timer);
        // 离线 / 超时 / 网络错误 -> 静默降级；仅当本次仍是最新请求时才收起提示
        if (myId === _cloudReqId) hideAiLoading(box);
      });
  }
  function renderCloudAddon(j, page, box) {
    var old = box.querySelector(".ai-addon");
    if (old) old.parentNode.removeChild(old);

    var cards = (j.cards || []).filter(function (s) { return state.bySlug[s]; });
    var cmds = (j.commands || []).filter(function (n) { return state.spec[n]; });

    // 去重：跳过当前页面已经展示的条目
    var shown = {};
    var links = box.querySelectorAll("a.card-item, a.cmd-item");
    for (var k = 0; k < links.length; k++) {
      var m = (links[k].getAttribute("href") || "").match(/#\/(?:card|calc)\/(.+)$/);
      if (m) shown[m[1]] = 1;
    }
    cards = cards.filter(function (s) { return !shown[s]; });
    cmds = cmds.filter(function (n) { return !shown[n]; });
    if (!cards.length && !cmds.length && !j.reply) return;

    var html = '<div class="ai-addon">';
    if (j.reply) {
      html += '<div class="ai-note"><span class="ai-ico">🤖</span><span>' + esc(j.reply) + "</span></div>";
    }
    if (page === "list" && cards.length) {
      html += '<div class="ai-head">AI 还建议你看看</div>';
      for (var i = 0; i < cards.length; i++) {
        var c = state.bySlug[cards[i]];
        html += '<a class="card-item" href="#/card/' + esc(c.slug) + '">' +
          "<h3>" + esc(c.title) + "</h3><p>" + esc(c.summary) + "</p>" +
          '<div class="chips"><span class="chip thinking">' + esc(c.thinking) + "</span></div></a>";
      }
    }
    if (page === "calc" && cmds.length) {
      html += '<div class="ai-head">AI 还建议你试试</div>';
      for (var h = 0; h < cmds.length; h++) {
        var n = cmds[h], e = state.spec[n];
        var cn = (window.LMLabels && window.LMLabels.cmdName) ? window.LMLabels.cmdName(n) : n;
        html += '<a class="cmd-item" href="#/calc/' + esc(n) + '">' +
          '<div class="cmd-top"><b>' + esc(cn) + '</b><i class="cmd-en">' + esc(n) + "</i></div>" +
          "<span>" + esc(e.doc || e.help || "") + "</span></a>";
      }
    }
    html += "</div>";
    box.insertAdjacentHTML("beforeend", html);
  }

  // ---------------------------------------------------------------- 路由
  function route() {
    var hash = location.hash || "#/";
    var parts = hash.replace(/^#\//, "").split("/").filter(Boolean);
    var page = parts[0] || "list"; // 空 hash = 列表页（归一化，供状态保存与 Tab 激活判断）

    // 离开列表：保存浏览状态（滚动位置 / 搜索词）
    if (currentPage === "list" && page !== "list") {
      var qEl = document.getElementById("q");
      if (qEl) listState.query = qEl.value;
      listState.scroll = window.scrollY || document.documentElement.scrollTop || 0;
    }

    if (page === "card") renderDetail(parts[1]);
    else if (page === "calc") renderCalc(parts[1] || "");
    else if (page === "about") renderAbout();
    else renderList();

    currentPage = page;
    updateTabs(page);

    if (page === "list") {
      // 恢复滚动位置（等一帧确保 DOM 布局稳定）
      var restore = listVisited ? listState.scroll : 0;
      listVisited = true;
      requestAnimationFrame(function () { window.scrollTo(0, restore); });
    } else {
      window.scrollTo(0, 0);
    }
  }

  function updateTabs(page) {
    var tabs = document.querySelectorAll(".tab");
    var active = (page === "card") ? "list" : page;
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle("active", tabs[i].getAttribute("data-tab") === active);
    }
  }
  // ---------------------------------------------------------------- 列表页
  function renderList() {
    var chips = '<div class="filter-row" id="filter-row">' +
      themes().map(function (t) { return filterChip(t, t); }).join("") +
      filterChip("__fav__", "★ 收藏 " + favs.length) +
      "</div>";
    view.innerHTML =
      '<div class="searchbox"><input id="q" type="search" placeholder="搜索卡片：主题、场景、误区…" enterkeyhint="search"></div>' +
      chips +
      '<div id="results"></div>';

    var q = document.getElementById("q");
    q.value = listState.query;

    function cardItem(c, showTheme) {
      return '<a class="card-item" href="#/card/' + esc(c.slug) + '">' +
        "<h3>" + esc(c.title) + (isFav(c.slug) ? ' <span class="fav-mark">★</span>' : "") + "</h3>" +
        "<p>" + esc(c.summary) + "</p>" +
        '<div class="chips">' +
        (showTheme && c.thinking ? '<span class="chip thinking">' + esc(c.thinking) + "</span>" : "") +
        (c.scenarios || []).slice(0, 3).map(function (s) { return '<span class="chip">' + esc(s) + "</span>"; }).join("") +
        (c.compute && c.compute.length ? '<span class="chip">可计算</span>' : "") +
        "</div></a>";
    }

    function paint() {
      if (DIAG) DIAG.paint++;
      var raw = q.value.trim();
      var box = document.getElementById("results");
      // 默认不预选：未选主题且未选收藏 => 空状态引导（必须先选分类）
      if (!listState.theme && !listState.favOnly) {
        if (!raw) {
          box.innerHTML = '<div class="empty"><div class="empty-ico">📚</div><div class="empty-main">挑一个主题开始</div><div class="empty-sub">或查看你 ★ 收藏的卡片</div></div>';
          syncChips();
          return;
        }
        // 全局搜索：同义词/概念桥匹配 + 打分排序，结果带「所属主题」标签
        var g = state.cards.map(function (c) {
          var m = matchHaySafe(raw, state.searchText[c.slug]);
          return { c: c, score: m.score };
        }).filter(function (x) { return x.score > 0; });
        syncChips();
        if (!g.length) {
          box.innerHTML = '<div class="empty"><div class="empty-main">没有匹配的卡片</div><div class="empty-sub">换个说法，或选主题缩小范围</div></div>';
          // 本地词典搜不到，恰恰是最需要 AI 兜底的场景（此前直接 return，等于关掉了兜底）。
          // 在线时由云端按语义推荐相关卡片，离线时静默降级、保持本提示不变。
          cloudSuggest(raw, "list", box);
          return;
        }
        g.sort(function (a, b) { return b.score - a.score; });
        box.innerHTML = g.map(function (x) { return cardItem(x.c, true); }).join("");
        cloudSuggest(raw, "list", box);
        return;
      }
      // 已选主题/收藏：先按分类过滤，再按关键词（含同义词桥）匹配并排序
      var favsOnly = listState.favOnly, theme = listState.theme;
      var items = state.cards.map(function (c) {
        if (favsOnly && !isFav(c.slug)) return null;
        if (theme && c.thinking !== theme) return null;
        if (!raw) return { c: c, score: 100 };
        var m = window.LMAliases.matchHay(raw, state.searchText[c.slug]);
        if (!m.hit) return null;
        return { c: c, score: m.score };
      }).filter(function (x) { return x; });
      syncChips();
      if (!items.length) {
        box.innerHTML = '<div class="empty"><div class="empty-main">' +
          (favsOnly && !favs.length ? "还没有收藏。打开任意卡片，点「★ 收藏」即可加入。" :
           "没有匹配的卡片") + '</div><div class="empty-sub">换个关键词或筛选试试</div></div>';
        // 主题内没搜到（且有关键词）时同样让 AI 兜底；纯空收藏不触发
        if (raw) cloudSuggest(raw, "list", box);
        return;
      }
      items.sort(function (a, b) { return b.score - a.score; });
      box.innerHTML = items.map(function (x) { return cardItem(x.c, false); }).join("");
      if (raw) cloudSuggest(raw, "list", box);
    }

    function syncChips() {
      var tabs = document.querySelectorAll(".filter-chip");
      for (var i = 0; i < tabs.length; i++) {
        var key = tabs[i].getAttribute("data-key");
        var on = (key === "__fav__") ? listState.favOnly : (key === listState.theme);
        tabs[i].classList.toggle("on", on);
      }
      var favChip = document.querySelector('.filter-chip[data-key="__fav__"]');
      if (favChip) favChip.textContent = "★ 收藏 " + favs.length;
    }

    function filterChip(key, label) {
      return '<button type="button" class="filter-chip" data-key="' + esc(key) + '">' + esc(label) + "</button>";
    }

    // 某些定制内核 / 内置浏览器（微信 X5、部分华为内核）对 <input type="search">
    // 只派发 change 或 compositionend，不派发 input，导致「字能输入、结果不动」。
    // 四种事件统一走同一个去重入口（值未变则跳过），兼顾中文输入法组词结束。
    var lastListKey = null;
    function onListInput() {
      var v = q.value;
      if (DIAG) {
        DIAG.input++;
        DIAG.lastVal = v;
      }
      if (v === lastListKey) return;
      lastListKey = v;
      paint();
    }
    q.addEventListener("input", onListInput);
    q.addEventListener("keyup", onListInput);
    q.addEventListener("change", onListInput);
    q.addEventListener("compositionend", onListInput);
    document.getElementById("filter-row").addEventListener("click", function (ev) {
      var btn = ev.target.closest ? ev.target.closest(".filter-chip") : null;
      if (!btn) return;
      var key = btn.getAttribute("data-key");
      if (key === "__fav__") listState.favOnly = !listState.favOnly;
      else {
        listState.theme = (listState.theme === key) ? "" : key;
        listState.favOnly = false;
      }
      listState.scroll = 0;
      paint();
    });
    paint();
    // 仅首次进入自动聚焦（返回时不吃焦点、不弹键盘）
    if (!listVisited && !listState.query) q.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- 卡片详情
  function renderDetail(slug) {
    var c = state.bySlug[slug];
    if (!c) { view.innerHTML = '<div class="empty">卡片不存在：' + esc(slug) + "</div>"; return; }
    var idx = state.cards.indexOf(c);
    var prev = state.cards[idx - 1], next = state.cards[idx + 1];
    var computeBtns = (c.compute || []).map(function (cmd) {
      return '<a class="btn" href="#/calc/' + esc(cmd) + '">用计算器：' + esc(window.LMLabels.cmdName(cmd)) + "</a>";
    }).join("");
    var favOn = isFav(c.slug);
    view.innerHTML =
      '<div class="backbar"><a href="#/">← 卡片</a></div>' +
      '<article class="card-detail">' +
      "<h1>" + esc(c.title) + "</h1>" +
      '<div class="meta-row"><span class="chip thinking">' + esc(c.thinking) + "</span>" +
      (c.scenarios || []).map(function (s) { return '<span class="chip">' + esc(s) + "</span>"; }).join("") +
      "</div>" +
      '<div class="action-row">' +
      '<button type="button" class="act-btn' + (favOn ? " on" : "") + '" id="fav-btn">' + (favOn ? "★ 已收藏" : "☆ 收藏") + "</button>" +
      '<button type="button" class="act-btn" id="share-btn">📤 分享</button>' +
      "</div>" +
      c.html +
      (computeBtns ? '<div style="margin-top:18px">' + computeBtns + "</div>" : "") +
      '<div class="detail-nav">' +
      (prev ? '<a href="#/card/' + esc(prev.slug) + '">← ' + esc(prev.title) + "</a>" : "<span></span>") +
      (next ? '<a href="#/card/' + esc(next.slug) + '">' + esc(next.title) + " →</a>" : "<span></span>") +
      "</div>" +
      "</article>";

    document.getElementById("fav-btn").addEventListener("click", function () {
      toggleFav(c.slug);
      var on = isFav(c.slug);
      this.textContent = on ? "★ 已收藏" : "☆ 收藏";
      this.classList.toggle("on", on);
      toast(on ? "已加入收藏" : "已取消收藏");
    });
    document.getElementById("share-btn").addEventListener("click", function () {
      shareCard(c);
    });

    // 长卡小节导航：提取 H2 生成 sticky 横滑 chips
    var article = view.querySelector(".card-detail");
    var h2s = article ? article.querySelectorAll("h2") : [];
    if (h2s.length >= 3) {
      var nav = document.createElement("div");
      nav.className = "section-nav";
      h2s.forEach(function (h, i) {
        h.id = "sec-" + i;
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "sec-chip";
        chip.textContent = h.textContent;
        chip.addEventListener("click", function () {
          h.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        nav.appendChild(chip);
      });
      var actionRow = article.querySelector(".action-row");
      article.insertBefore(nav, actionRow ? actionRow.nextSibling : article.firstChild);
    }

    // 用户已消费内容（产生价值）→ 可触发 Android 安装提示
    if (!valueSeen) {
      valueSeen = true;
      maybeShowInstall();
    }
  }

  function shareCard(c) {
    var url = location.href.split("#")[0] + "#/card/" + c.slug;
    if (navigator.share) {
      navigator.share({ title: c.title, text: c.summary, url: url }).catch(function () { /* 用户取消 */ });
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { toast("卡片链接已复制，去粘贴给朋友吧"); },
        function () { toast("复制失败，请长按地址栏手动复制"); });
      return;
    }
    toast("请长按地址栏复制链接");
  }

  // ---------------------------------------------------------------- 计算器
  function renderCalc(cmd) {
    if (!cmd) {
      // 子命令选择：按场景分组展示中文名 + 搜索（英文名降级为技术对照）
      calcScene = ""; // 进入列表重置分类筛选
      var L = window.LMLabels;
      var scenes = Object.keys(L.CMD_SCENES);
      var sceneChips = scenes.map(function (s) {
        return '<button type="button" class="filter-chip" data-scene="' + esc(s) + '">' +
          esc(s) + " " + L.CMD_SCENES[s].length + "</button>";
      }).join("");
      view.innerHTML =
        '<div class="calc-head">计算器</div>' +
        '<p class="calc-desc">' + state.meta.subcommandCount + ' 个计算工具，按场景找、按关键词搜；数值与 skill 版 compute.py 逐位一致。</p>' +
        '<div class="calc-tools">' +
        '<div class="searchbox"><input id="cq" type="search" placeholder="搜索计算工具：复利、贷款、中奖、置信区间…" enterkeyhint="search"></div>' +
        '<div class="scene-row" id="scene-row">' + sceneChips + "</div>" +
        "</div>" +
        '<div id="cmd-results"></div>';
      var cq = document.getElementById("cq");
      var sceneRow = document.getElementById("scene-row");
      // 命令 -> 所属场景 反查表（全局搜索结果带场景标签用）
      var cmdScene = {};
      Object.keys(L.CMD_SCENES).forEach(function (s) {
        L.CMD_SCENES[s].forEach(function (n) { cmdScene[n] = s; });
      });
      function hayOf(name) {
        return (L.cmdName(name) + " " + name + " " +
          (state.spec[name].doc || "") + " " + (state.spec[name].help || "")).toLowerCase();
      }
      function scoredCmds(names, kw) {
        return names.map(function (n) {
          var m = matchHaySafe(kw, hayOf(n));
          return { n: n, score: m.score };
        }).filter(function (x) { return x.score > 0; })
          .sort(function (a, b) { return b.score - a.score; })
          .map(function (x) { return x.n; });
      }

      function cmdItemHtml(name, showScene) {
        var e = state.spec[name];
        var scene = cmdScene[name];
        return '<a class="cmd-item" href="#/calc/' + esc(name) + '">' +
          '<div class="cmd-top"><b>' + esc(L.cmdName(name)) + '</b><i class="cmd-en">' + esc(name) + "</i></div>" +
          (showScene && scene ? '<div class="cmd-scene">' + esc(scene) + "</div>" : "") +
          "<span>" + esc(e.doc || e.help || "") + "</span></a>";
      }

      function paintCmds() {
        var box = document.getElementById("cmd-results");
        var kw = cq.value.trim();
        // 默认不预选：未选分类 => 空状态引导（必须先选分类）
        if (!calcScene) {
          if (!kw) {
            box.innerHTML = '<div class="empty"><div class="empty-ico">🧮</div><div class="empty-main">选择一个分类</div><div class="empty-sub">按场景找到对应的计算工具</div></div>';
            return;
          }
          // 全局搜索所有计算工具（同义词/概念桥匹配 + 打分排序，带场景标签）
          var seen = {}, all = [];
          Object.keys(L.CMD_SCENES).forEach(function (s) {
            L.CMD_SCENES[s].forEach(function (name) {
              if (state.spec[name] && !seen[name]) { seen[name] = 1; all.push(name); }
            });
          });
          var matched = scoredCmds(all, kw);
          if (!matched.length) {
            box.innerHTML = '<div class="empty"><div class="empty-main">没有匹配的工具</div><div class="empty-sub">换个说法试试</div></div>';
            return;
          }
          box.innerHTML = matched.map(function (n) { return cmdItemHtml(n, true); }).join("");
          return;
        }
        var cmds = scoredCmds(L.CMD_SCENES[calcScene], kw);
        if (!cmds.length) {
          box.innerHTML = '<div class="empty"><div class="empty-main">该分类下没有匹配的工具</div><div class="empty-sub">换个说法试试</div></div>';
          return;
        }
        box.innerHTML = cmds.map(function (n) { return cmdItemHtml(n, false); }).join("");
        if (kw) cloudSuggest(kw, "calc", box);
      }
      // 同上：计算器搜索框也需要多事件兜底
      var lastCalcKey = null;
      function onCalcInput() {
        var v = cq.value;
        if (DIAG) {
          DIAG.input++;
          DIAG.lastVal = v;
        }
        if (v === lastCalcKey) return;
        lastCalcKey = v;
        paintCmds();
      }
      cq.addEventListener("input", onCalcInput);
      cq.addEventListener("keyup", onCalcInput);
      cq.addEventListener("change", onCalcInput);
      cq.addEventListener("compositionend", onCalcInput);
      sceneRow.addEventListener("click", function (ev) {
        var btn = ev.target.closest ? ev.target.closest(".filter-chip") : null;
        if (!btn) return;
        var sc = btn.getAttribute("data-scene") || "";
        calcScene = (calcScene === sc) ? "" : sc; // 再次点击同一分类 => 取消筛选
        var chips = sceneRow.querySelectorAll(".filter-chip");
        for (var i = 0; i < chips.length; i++) {
          chips[i].classList.toggle("on", (chips[i].getAttribute("data-scene") || "") === calcScene);
        }
        paintCmds();
      });
      paintCmds();
      return;
    }
    var entry = state.spec[cmd];
    if (!entry) { view.innerHTML = '<div class="empty">未知子命令：' + esc(cmd) + "</div>"; return; }
    var fields = "";
    var boolSeenRender = {};
    (entry.positionals || []).forEach(function (p) {
      fields += field(p.name, p.name, "text", p.required, p.help, null, null);
    });
    entry.options.forEach(function (o) {
      if ((o.type === "bool" || o.action === "store_true" || o.action === "store_false")) {
        if (boolSeenRender[o.dest]) return; // --nonneg/--no-nonneg 同 dest，只渲染首个
        boolSeenRender[o.dest] = true;
      }
      fields += field(o.dest, o.flag, o.type, o.required, o.help, o.default, o.choices, o.action);
    });
    view.innerHTML =
      '<div class="backbar"><a href="#/calc">← 计算器</a></div>' +
      '<div class="calc-head">' + esc(window.LMLabels.cmdName(cmd)) + "</div>" +
      '<p class="calc-desc"><span class="cmd-en">' + esc(cmd) + "</span>" + esc(entry.doc || entry.help || "") + "</p>" +
      '<form id="calc-form" novalidate>' + fields +
      '<button class="btn" type="submit">计算</button></form>' +
      '<div id="calc-out"></div>';
    document.getElementById("calc-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      runCalc(cmd, entry);
    });
  }

  function fid(flag) { return "f_" + String(flag).replace(/^--/, "").replace(/-/g, "_"); }

  function field(dest, flag, type, required, help, def, choices, action) {
    // 中文标签优先；--flag 作为技术对照放进 hint（方便对照卡片文档里的 CLI 示例）
    var cn = window.LMLabels.flagLabel(dest, flag);
    var base = cn || String(flag || dest).replace(/^--/, "");
    var hintParts = [];
    if (String(flag || "").indexOf("--") === 0) hintParts.push(String(flag));
    if (help) hintParts.push(help);
    var label = esc(base) + (required ? '<span class="req">*</span>' : "") +
      (hintParts.length ? '<span class="hint">' + esc(hintParts.join(" · ")) + "</span>" : "");
    if (type === "bool" || action === "store_true" || action === "store_false") {
      var checked = (action === "store_false") ? true : (def === true);
      return '<div class="field check"><input type="checkbox" id="' + fid(flag) + '"' + (checked ? " checked" : "") + ">" +
        "<label for=\"" + fid(flag) + '">' + esc(flag || dest) + "</label>" +
        (help ? '<span class="hint">' + esc(help) + "</span>" : "") + "</div>";
    }
    var input;
    if (choices) {
      input = '<select id="' + fid(flag) + '">' + choices.map(function (ch) {
        return '<option value="' + esc(ch) + '"' + (ch === def ? " selected" : "") + ">" + esc(ch) + "</option>";
      }).join("") + "</select>";
    } else if (type === "float" || type === "int") {
      input = '<input type="number" id="' + fid(flag) + '" step="' + (type === "int" ? "1" : "any") + '"' +
        (def !== null && def !== undefined ? ' value="' + esc(def) + '"' : "") + ">";
    } else {
      var ph = type === "odds" ? ' placeholder="a:b，如 1:5"' : "";
      input = '<input type="text" id="' + fid(flag) + '"' + ph +
        (def !== null && def !== undefined && def !== "" ? ' value="' + esc(def) + '"' : "") + ">";
    }
    return '<div class="field"><label for="' + fid(flag) + '">' + label + "</label>" + input + "</div>";
  }

  function runCalc(cmd, entry) {
    var args = {};
    var missing = [];
    function val(id) { return document.getElementById(id).value.trim(); }
    (entry.positionals || []).forEach(function (p) {
      var v = val(fid(p.name));
      if (!v && p.required) missing.push(p.name);
      args[p.name] = v;
    });
    var boolSeen = {};
    entry.options.forEach(function (o) {
      var node = document.getElementById(fid(o.flag));
      if (o.type === "bool" || o.action === "store_true" || o.action === "store_false") {
        // 同 dest 的多个布尔旗标（--nonneg/--no-nonneg）只渲染一个，取首个（store_true）的值
        if (boolSeen[o.dest]) return;
        boolSeen[o.dest] = true;
        args[o.dest] = node.checked;
        return;
      }
      var raw = node.value.trim();
      if (!raw) {
        args[o.dest] = null;
        if (o.required) missing.push(o.flag);
        return;
      }
      if (o.type === "float") { var f = parseFloat(raw); if (!isFinite(f)) { missing.push(o.flag); return; } args[o.dest] = f; }
      else if (o.type === "int") { var i = parseInt(raw, 10); if (!isFinite(i)) { missing.push(o.flag); return; } args[o.dest] = i; }
      else args[o.dest] = raw;
    });
    var out = document.getElementById("calc-out");
    if (missing.length) {
      out.innerHTML = '<div class="error-box">缺少必填参数：' + esc(missing.join("、")) + "</div>";
      return;
    }
    try {
      var result = window.LifeMathCompute.run(cmd, args);
      out.innerHTML = humanize(cmd, result);
    } catch (err) {
      out.innerHTML = '<div class="error-box">' + esc(err && err.message ? err.message : String(err)) + "</div>";
    }
  }

  // -------------------------------------------------- 结果人话化（键名翻译 + 主指标）
  var PRIMARY = { // 每个子命令的"头条指标"（数组 = 按存在性择优，适配多模式命令）
    compound: "future_value", expected: "expected_value", "prob-at-least-one": "prob_at_least_one",
    "present-value": "present_value", stats: "mean", irr: ["effective_annual_rate", "period_IRR"],
    geomean: "geometric_mean", sharpe: "sharpe", pmt: "periodic_payment", tco: "ev_saves_over_horizon",
    dca: "fv_dca", prepay: "interest_saved", eoq: "optimal_q", combo: "combinations_C",
    "prob-shared": "prob_shared", markov: "steady_distribution", mcdm: "ranking", lp: "optimal_value",
    queue: "avg_wait_in_queue_Wq", ci: "margin_of_error", bayes: "posterior_P(H|E)",
    hypergeom: "probability", binomial: "probability", odds: "probability",
    poisson: ["P(at_least_one_in_t)", "P(X=k)"], decay: "remaining", regress: "pearson_r",
    nash: "nash_equilibria", mix: "weighted_mean", rule72: ["double_in_years_approx", "rate_pct_approx"],
    ma: "last", trend: "next_value", mcgoal: "probability_reach_target",
    scenario: "final_base", kelly: "fraction", ruin: "prob_reach_target", pareto: "top_share",
  };
  var FOOT_KEYS = { note: 1, disclaimer: 1, message: 1, equation: 1, mode: 1, status: 1,
    input_as: 1, kind: 1, scenario: 1, objective: 1, direction: 1, input_odds: 1, input_prob: 1 };
  var RESULT_LABELS = {
    "P(E)": "证据出现的总概率", "P(E|H)": "灵敏度 P(E\|H)", "P(E|~H)": "假阳率 P(E\|¬H)",
    "P(X=k)": "恰好 k 次的概率", "P(at_least_one_in_t)": "时间内至少一次", "P(wait>t)": "等待超过 t 的概率",
    "R2": "决定系数 R²", "K": "中奖物数量", "N": "总池大小", "alpha": "形状参数 α",
    "annual_demand": "年需求量", "annual_holding_cost": "年持有成本", "annual_order_cost": "年订货成本",
    "annual_rate": "年化收益率", "annual_save_ev": "电车每年省下", "arithmetic_mean": "算术平均",
    "arrival_rate": "到达率 λ", "avg_in_queue_Lq": "队列内平均人数", "avg_in_system_L": "系统内平均人数",
    "avg_time_in_system_W": "平均逗留时间", "avg_wait_in_queue_Wq": "平均排队时间",
    "blended_elec_rate": "混合电价", "center": "中心估计", "col_dominant": "列玩家占优策略",
    "combinations_C": "组合数 C", "compare_lump_upfront": "对比的一次性投入",
    "compounds_per_year": "每年复利次数", "criteria": "准则方向", "cumulative_growth_multiple": "累计增长倍数",
    "current_payment": "当前每期还款", "current_total_interest": "当前总利息", "cycle_days": "订货周期（天）",
    "days": "可能取值数", "decimal_odds": "小数赔率", "direction": "趋势方向",
    "disclaimer": "免责声明", "discount_factor": "贴现因子", "dist_after_steps": "n 步后分布",
    "double_in_years_approx": "翻倍年数（约）", "edge": "优势（期望收益）", "effective_annual_rate": "有效年化利率",
    "equation": "拟合方程", "ev_energy_per_year": "电车每年电费", "ev_op_per_year": "电车每年运维",
    "ev_purchase_total": "电车购入总价", "ev_saves_over_horizon": "期限内电车省下", "ev_total_cost": "电车总成本",
    "eval_holding_cost": "该批量持有成本", "eval_order_cost": "该批量订货成本", "eval_q": "测算批量",
    "eval_total_cost": "该批量总成本", "exact_ln2": "精确翻倍年数", "excess_return": "超额收益",
    "expected_final": "期望终值", "expected_value": "期望值", "extra_upfront_ev": "电车多付的购车款",
    "feasible_vertices": "可行顶点数", "final_base": "基准情景终值", "final_best": "最好情景终值",
    "final_p5": "终值 P5", "final_p50": "终值中位数", "final_p95": "终值 P95", "final_worst": "最差情景终值",
    "forecast": "未来预测", "fraction": "最优下注比例", "fraction_pct": "最优下注比例（%）",
    "freq": "每年期数", "future_value": "未来价值", "fv_dca": "定投终值", "fv_lump_same_total": "同额一次性终值",
    "geometric_mean": "几何平均收益", "growth_multiple": "增长倍数", "half_life": "半衰期",
    "holding_cost_per_unit_year": "单位年持有成本", "initial": "初始量", "input_as": "输入按",
    "input_odds": "输入赔率", "input_prob": "输入概率", "intercept_a": "截距 a", "interest_earned": "利息收入",
    "interest_earned_dca": "定投利息", "interest_saved": "节省利息", "iters": "模拟次数", "k": "命中数 k",
    "kind": "区间类型", "lambda": "平均发生率 λ", "last": "最新平滑值", "level": "置信水平",
    "lower": "区间下限", "lump_minus_dca": "一次性减定投", "margin_of_error": "边际误差",
    "max": "最大值", "mean": "均值", "median": "中位数", "meets_base": "基准达标", "meets_best": "最好达标",
    "meets_worst": "最差达标", "message": "提示", "min": "最小值", "mode": "模式", "months": "月数",
    "n": "样本量 / 次数", "n_periods": "期数", "nash_equilibria": "纳什均衡", "net_odds_b": "净赔率 b",
    "new_payment": "新月供", "new_principal": "提前还后本金", "new_term_periods": "新期限（期）",
    "new_term_years": "新期限（年）", "new_total_interest": "新总利息", "next_value": "下一期预测",
    "nominal_annual_rate": "名义年化利率", "normalized": "标准化矩阵", "note": "备注",
    "objective": "优化目标", "odds_in_favor": "支持赔率", "oil_energy_per_year": "油车每年油费",
    "oil_op_per_year": "油车每年运维", "oil_purchase_total": "油车购入总价", "oil_total_cost": "油车总成本",
    "optimal_q": "最优订货量", "optimal_value": "最优目标值", "optimal_x": "最优 x", "optimal_y": "最优 y",
    "order_cost": "每次订货成本", "orders_per_year": "每年订货次数", "outcomes": "可能结果",
    "p": "成功概率", "payback_years": "回本年限", "payment_drop": "月供减少", "pearson_r": "相关系数 r",
    "per_period_amount": "每期投入", "period_IRR": "周期利率", "periodic_payment": "每期付款",
    "periods": "期数", "permutations_P": "排列数 P", "posterior_P(H|E)": "后验概率 P(H\|E)",
    "prepay": "提前还款额", "present_value": "现值", "principal": "本金", "prior": "先验概率",
    "prob_at_least_one": "至少一次的概率", "prob_no_shared": "无碰撞概率", "prob_none": "全部落空概率",
    "prob_reach_target": "达成目标概率", "prob_ruin": "破产概率", "prob_shared": "至少一对相同概率",
    "prob_system_empty_P0": "系统空闲概率", "probability": "概率", "probability_reach_target": "目标达成概率",
    "probs": "对应概率", "range_max": "情景区间上限", "range_min": "情景区间下限", "ranking": "排名",
    "rate_pct": "年化利率（%）", "rate_pct_approx": "所需利率（约）", "remaining": "剩余量",
    "returns_pct": "三档收益（%）", "risk_free": "无风险利率", "row_dominant": "行玩家占优策略",
    "scenario": "情景类型", "seed": "随机种子", "service_rate": "服务率 μ", "sharpe": "夏普比率",
    "single_trial_prob": "单次概率", "slope_b": "斜率 b", "smoothed": "平滑序列", "start": "初始分布",
    "states": "状态数", "status": "状态", "std_error": "标准误", "stdev_pop": "总体标准差",
    "stdev_sample": "样本标准差", "steady_check_sum": "稳态和校验", "steady_distribution": "稳态分布",
    "steps": "步数", "t": "时间", "target": "目标金额", "top_fraction": "顶部占比", "top_share": "顶部份额",
    "total_cost_at_eoq": "最优批量总成本", "total_deposited": "总投入", "total_interest": "总利息",
    "total_invested": "总投入", "total_paid": "总还款", "trials": "试验次数", "type": "类型",
    "upper": "区间上限", "utilization_rho": "利用率 ρ", "volatility_drag": "波动率拖累",
    "weighted_mean": "加权平均", "weighted_scores": "加权得分", "weights": "权重",
    "win_prob_p": "胜率 p", "win_prob_per_step": "每步胜率", "window": "窗口", "years": "年限",
  };

  function fmtNum(v) { return typeof v === "number" ? String(v) : esc(v); }

  function fmtVal(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return fmtNum(v);
    if (typeof v === "boolean") return v ? "是" : "否";
    if (Array.isArray(v)) {
      if (v.length && Array.isArray(v[0])) { // 纳什均衡等数对
        return '<span class="arr">' + v.map(function (p) { return "(" + p.map(fmtNum).join(", ") + ")"; }).join(" ") + "</span>";
      }
      if (v.length && typeof v[0] === "object") { // ranking: [{rank,label,score}]
        return '<span class="arr">' + v.map(function (o) {
          return Object.keys(o).map(function (kk) {
            return (RESULT_LABELS[kk] || kk) + " " + (typeof o[kk] === "number" ? fmtNum(o[kk]) : esc(o[kk]));
          }).join(" · ");
        }).join("<br>") + "</span>";
      }
      return '<span class="arr">[' + v.map(function (x) { return typeof x === "number" ? fmtNum(x) : esc(x); }).join(", ") + "]</span>";
    }
    return esc(v);
  }

  function humanize(cmd, result) {
    var html = "";
    var pk = null;
    var cand = PRIMARY[cmd];
    if (cand) {
      var list = Array.isArray(cand) ? cand : [cand];
      for (var ci = 0; ci < list.length; ci++) {
        if (list[ci] in result) { pk = list[ci]; break; }
      }
    }
    if (!pk) {
      for (var k0 in result) { if (typeof result[k0] === "number") { pk = k0; break; } }
    }
    if (pk) {
      html += '<div class="metric"><div class="metric-label">' + esc(RESULT_LABELS[pk] || pk) + "</div>" +
        '<div class="metric-value">' + fmtVal(result[pk]) + "</div></div>";
    }
    var rows = "";
    for (var k in result) {
      if (k === pk) continue;
      var v = result[k];
      if (v === null || v === undefined) continue;
      rows += '<div class="kv' + (FOOT_KEYS[k] ? " kv-foot" : "") + '"><span class="kv-k">' +
        esc(RESULT_LABELS[k] || k) + '</span><span class="kv-v">' + fmtVal(v) + "</span></div>";
    }
    if (rows) html += '<div class="kv-list">' + rows + "</div>";
    html += '<details class="raw"><summary>查看原始 JSON（与 skill 版 compute.py 逐位一致）</summary><pre>' +
      esc(JSON.stringify(result, null, 2)) + "</pre></details>";
    return html;
  }

  // ---------------------------------------------------------------- 关于页
  function renderAbout() {
    var m = state.meta;
    view.innerHTML =
      '<div class="about-box">' +
      "<h2>关于「" + esc(m.name) + "」 v" + esc(m.version) + "</h2>" +
      "<table>" +
      "<tr><th>思维卡</th><td>" + m.cardCount + " 张</td></tr>" +
      "<tr><th>计算子命令</th><td>" + m.subcommandCount + " 个（与 skill 版 compute.py 同源同值）</td></tr>" +
      "<tr><th>思维主题</th><td>" + m.modelCount + " 类</td></tr>" +
      "<tr><th>内容来源</th><td>life-math skill（唯一内容源）</td></tr>" +
      "</table>" +
      "<h2>在手机上安装</h2>" +
      "<p><b>iPhone</b>：用 Safari 打开本站 → 点底部工具栏的<b>分享按钮</b> " +
      '<svg class="ios-share-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="10" width="13" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><line x1="10.5" y1="18" x2="10.5" y2="4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M6.5 8 L10.5 4 L14.5 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      " → 在弹出菜单中下滑选<b>「添加到主屏幕」</b>。安装后从桌面图标启动，全屏离线可用。</p>" +
      "<p><b>Android</b>：用 Chrome 打开 → 地址栏安装图标或菜单「安装应用」。</p>" +
      "<h2>版权与免责</h2>" +
      '<p class="fine">© 2026 Bob Yu. 保留所有权利。允许个人学习与非商业使用；修改须保留作者署名与版权声明。内容仅供数学思维启发与计算参考，不构成专业财务、法律、医疗建议。</p>' +
      '<p class="fine">计算数值与 life-math skill 的 scripts/compute.py 由同一批测试夹具守护，两端逐位一致。</p>' +
      "</div>";
  }

  // ---------------------------------------------------------------- 深浅色主题
  function applyTheme(theme, persist) {
    document.documentElement.setAttribute("data-theme", theme);
    var btn = document.getElementById("theme-btn");
    if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
    if (persist) {
      try { localStorage.setItem("lm-theme", theme); } catch (e) { /* 隐私模式忽略 */ }
    }
  }
  function setupTheme() {
    var stored = null;
    try { stored = localStorage.getItem("lm-theme"); } catch (e) { /* 忽略 */ }
    var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    var initial = (stored === "dark" || stored === "light") ? stored : (mq && mq.matches ? "dark" : "light");
    applyTheme(initial, false); // 自动解析不落盘，保留"跟随系统"语义
    document.getElementById("theme-btn").addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      applyTheme(cur === "dark" ? "light" : "dark", true);
    });
    if (!stored && mq) {
      var onSys = function (e) { applyTheme(e.matches ? "dark" : "light", false); };
      if (mq.addEventListener) mq.addEventListener("change", onSys);
      else if (mq.addListener) mq.addListener(onSys);
    }
  }

  // ---------------------------------------------------------------- Android 自定义安装
  var installEvent = null;
  var valueSeen = false; // 用户产生价值（浏览过卡片）后才提示安装
  function maybeShowInstall() {
    if (!installEvent || !valueSeen) return;
    try { if (localStorage.getItem("lm-install-dismissed")) return; } catch (e) { /* 忽略 */ }
    if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return;
    if (window.navigator.standalone === true) return;
    var bar = document.getElementById("install-bar");
    if (bar) bar.hidden = false;
  }
  function setupInstall() {
    if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return;
    if (window.navigator.standalone === true) return; // iOS 已安装
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault(); // 禁用 Chrome 默认迷你栏，改用自己的安装条
      installEvent = e;
      maybeShowInstall();
    });
    window.addEventListener("appinstalled", function () {
      installEvent = null;
      var bar = document.getElementById("install-bar");
      if (bar) bar.hidden = true;
      toast("已安装到主屏幕，可离线使用");
    });
    document.getElementById("install-go").addEventListener("click", function () {
      if (!installEvent) return;
      installEvent.prompt();
      Promise.resolve(installEvent.userChoice).then(function () {
        installEvent = null;
        document.getElementById("install-bar").hidden = true;
      }).catch(function () { /* 用户关闭对话框 */ });
    });
    document.getElementById("install-close").addEventListener("click", function () {
      document.getElementById("install-bar").hidden = true;
      try { localStorage.setItem("lm-install-dismissed", "1"); } catch (e) { /* 忽略 */ }
    });
  }

  // ---------------------------------------------------------------- iOS 安装引导
  function setupIOSInstall() {    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    var standalone = window.navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;
    if (!isIOS || standalone) return;
    if (localStorage.getItem("lm-ios-install-dismissed")) return;
    var box = document.getElementById("ios-install");
    box.hidden = false;
    document.getElementById("ios-install-close").addEventListener("click", function () {
      box.hidden = true;
      try { localStorage.setItem("lm-ios-install-dismissed", "1"); } catch (e) { /* 隐私模式忽略 */ }
    });
  }

  // ---------------------------------------------------------------- SW 注册与更新提示
  function setupSW() {
    if (!("serviceWorker" in navigator) || location.protocol.indexOf("http") !== 0) return;
    var pendingReload = false;
    function doReload() {
      if (pendingReload) return;
      pendingReload = true;
      location.reload();
    }
    navigator.serviceWorker.addEventListener("controllerchange", doReload);
    // updateViaCache:"none"：强制 SW 脚本不走 HTTP 缓存。GitHub Pages 对 sw.js 返回
    // Cache-Control: max-age=600，默认策略下新版 sw.js 在 10 分钟内不可见，
    // 更新检查拿不到变化 → 页面永久停在旧版本（更新死锁）。
    // 注册后主动 update()，并在页面重新可见时再查一次。
    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
      .then(function (reg) {
        if (!reg) return;
        reg.update().catch(function () {});
        document.addEventListener("visibilitychange", function () {
          if (document.visibilityState === "visible") reg.update().catch(function () {});
        });
      })
      .catch(function () { /* 本地降级环境忽略 */ });
    navigator.serviceWorker.ready.then(function (reg) {
      function announce(waiting) {
        if (document.getElementById("update-toast")) return;
        var t = document.createElement("div");
        t.id = "update-toast";
        t.className = "update-toast";
        t.innerHTML = '发现新版本 <button type="button" id="update-reload">刷新</button>';
        document.getElementById("app").appendChild(t);
        document.getElementById("update-reload").addEventListener("click", function () {
          if (waiting) waiting.postMessage("skipWaiting");
          // 兜底：若 controllerchange 未触发（如多次连续部署导致 waiting 态竞态），1s 后强制刷新
          setTimeout(doReload, 1000);
        });
      }
      if (reg.waiting && navigator.serviceWorker.controller) announce(reg.waiting);
      reg.addEventListener("updatefound", function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", function () {
          if (nw.state === "installed" && navigator.serviceWorker.controller) announce(reg.waiting);
        });
      });
    });
  }

  // ---------------------------------------------------------------- 启动
  setupTheme();   // 先行应用主题，避免首屏闪烁
  // 量出顶栏实际高度（含安全区），供计算器场景导航 sticky 定位（top: var(--topbar-h)）
  function syncTopbarHeight() {
    var tb = document.querySelector(".topbar");
    if (tb) document.documentElement.style.setProperty("--topbar-h", tb.offsetHeight + "px");
  }
  syncTopbarHeight();
  window.addEventListener("resize", syncTopbarHeight);
  setupInstall();

  // ?debug=1 环境自检：仅当地址带 debug=1 时在页面底部显示关键状态与脚本错误，
  // 用于在异常内核 / 内置浏览器上定位「某模块未加载」类问题（平时完全不可见）。
  if (/[?&]debug=1/.test(location.search)) {
    var dbg = document.createElement("div");
    dbg.id = "lm-debug";
    dbg.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99999;max-height:44vh;overflow:auto;background:#111;color:#0f0;font:11px/1.6 monospace;padding:8px;white-space:pre-wrap;word-break:break-all";
    dbg.textContent = "自检加载中…";
    document.body.appendChild(dbg);
    window.addEventListener("error", function (e) {
      dbg.textContent += "\n[ERR] " + (e.message || e.error) + " @ " +
        String(e.filename || "").split("/").pop() + ":" + e.lineno;
    });
    setInterval(function () {
      dbg.textContent = [
        "ver=" + (state.meta && state.meta.version),
        "LMAliases=" + typeof window.LMAliases,
        "cards=" + (state.cards ? state.cards.length : "?"),
        "sw=" + ("serviceWorker" in navigator),
        "online=" + navigator.onLine,
        "input=" + (DIAG ? DIAG.input : "-"),
        "paint=" + (DIAG ? DIAG.paint : "-"),
        "lastVal=" + JSON.stringify(DIAG ? DIAG.lastVal : null),
        "ua=" + String(navigator.userAgent || "").slice(0, 80)
      ].join("\n");
    }, 800);
  }

  loadData().then(function () {
    // 加载成功即清除自愈标记，保证下一次版本切换仍能自愈
    try { sessionStorage.removeItem("lm-autoheal"); } catch (e) {}
    route();
    setupIOSInstall();
    setupSW();
    window.addEventListener("hashchange", route);
  }).catch(function (err) {
    // Service Worker 版本切换瞬间（skipWaiting 立即换版 + 旧缓存清理）常出现
    // 「旧缓存已删 / 新缓存未就绪」导致数据请求失败：表现为只有顶栏底栏、
    // 列表与搜索框都不渲染，用户以为「搜索框输入没反应」。
    // 此处自动重载一次自愈；用 sessionStorage 守卫，避免真实网络故障时无限刷新。
    var tried = false;
    try { tried = !!sessionStorage.getItem("lm-autoheal"); } catch (e) {}
    if (!tried) {
      try { sessionStorage.setItem("lm-autoheal", "1"); } catch (e) {}
      location.reload();
      return;
    }
    try { sessionStorage.removeItem("lm-autoheal"); } catch (e) {}
    var box = document.getElementById("results") || view;
    box.innerHTML = '<div class="error-box">数据加载失败：' + esc(err.message) +
      "<br>请检查网络连接后刷新页面。" + "</div>";
  });
})();
