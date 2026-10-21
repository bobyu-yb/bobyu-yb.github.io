/* life-math compute.js — life-math 计算引擎的浏览器/Node 双端移植。
 *
 * 与 scripts/compute.py 保持数值逐位一致（同一批期望值由 tests/parity.js 守护）。
 * 保真点：
 *   - Python round()  => 银行家中途舍入（pyround）
 *   - Python %        => 符号跟随除数（pyMod）
 *   - math.comb/perm  => BigInt 精确整数
 *   - random.gauss    => MT19937 + Python 播种 + gauss 缓存对（mcgoal 可复现）
 *   - Fraction.limit_denominator => Stern-Brocot 最近有理数（odds）
 *   - math.erf        => Abramowitz-Stegun 7.1.26（|ε|≤1.5e-7，满足 CI 容差）
 *
 * ponytail: BigInt 组合数在 Number 化时若超过 ~1.8e308（N>约 10^5 的池）会得 Infinity，
 *   Python 大整数版不受限；抽奖/彩票等卡片场景（N≤几千）不触顶。
 * ponytail: cos/sin 与 libm 可能有末位ulp差，mcgoal 结果按 2 位小数舍入后一致。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LifeMathCompute = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // ---------------------------------------------------------------- 基础工具
  function pyround(x, n) {
    if (typeof n !== "number") n = 0;
    if (!isFinite(x) || x === 0) return x;
    var p = Math.pow(10, n);
    var scaled = x * p;
    var fl = Math.floor(scaled);
    var diff = scaled - fl;
    var r;
    if (diff > 0.5) r = fl + 1;
    else if (diff < 0.5) r = fl;
    else r = (fl % 2 === 0) ? fl : fl + 1; // 银行家舍入
    return r / p;
  }

  function pyMod(a, b) {
    // Python: 结果符号跟随除数
    var r = a % b;
    if (r !== 0 && (r < 0) !== (b < 0)) r += b;
    return r;
  }

  function nums(s) {
    if (Array.isArray(s)) return s.map(Number);
    return String(s).split(",").map(function (x) { return x.trim(); })
      .filter(function (x) { return x !== ""; }).map(Number);
  }

  function combBig(n, k) {
    n = BigInt(n); k = BigInt(k);
    if (k < 0n || k > n) return 0n;
    if (k > n - k) k = n - k;
    var r = 1n;
    for (var i = 0n; i < k; i++) r = (r * (n - i)) / (i + 1n);
    return r;
  }

  function permBig(n, k) {
    n = BigInt(n); k = BigInt(k);
    if (k < 0n || k > n) return 0n;
    var r = 1n;
    for (var i = 0n; i < k; i++) r *= (n - i);
    return r;
  }

  function factBig(k) {
    var r = 1n;
    for (var i = 2n; i <= BigInt(k); i++) r *= i;
    return r;
  }

  function formatG(x) {
    // Python "%g"：最多 6 位有效数字，去尾零
    return String(Number(Number(x).toPrecision(6)));
  }

  function erf(x) {
    // Abramowitz & Stegun 7.1.26, |ε| ≤ 1.5e-7
    var sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    var t = 1 / (1 + 0.3275911 * x);
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return sign * y;
  }

  function normCdf(x) { return 0.5 * (1.0 + erf(x / Math.SQRT2)); }

  function normPpf(p) {
    if (!(p > 0 && p < 1)) throw new Error("p must be in (0,1)");
    var lo = -8.0, hi = 8.0;
    for (var i = 0; i < 100; i++) {
      var mid = (lo + hi) / 2.0;
      if (normCdf(mid) < p) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2.0;
  }

  function pctFactor(raw) {
    for (var i = 0; i < raw.length; i++) if (Math.abs(raw[i]) > 1) return 0.01;
    return 1.0;
  }

  // ------------------------------------------------- MT19937（Python 播种语义）
  var N = 624, M = 397, MATRIX_A = 0x9908b0df, UPPER = 0x80000000, LOWER = 0x7fffffff;

  function MT19937(seed) {
    this.mt = new Uint32Array(N);
    this.mti = N + 1;
    this.initBySeed(seed);
  }
  MT19937.prototype.initBySeed = function (seed) {
    // Python random.Random(int)：取绝对值，按 32 位小端字序列 init_by_array
    var key = [];
    var s = BigInt(Math.floor(Math.abs(Number(seed))));
    if (s === 0n) key.push(0);
    while (s > 0n) { key.push(Number(s & 0xffffffffn)); s >>= 32n; }
    this.initByArray(key);
  };
  MT19937.prototype.initByArray = function (key) {
    var mt = this.mt;
    mt[0] = 19650218 >>> 0;
    for (var i = 1; i < N; i++) {
      var prev = mt[i - 1];
      mt[i] = (Math.imul(1812433253, (prev ^ (prev >>> 30)) >>> 0) + i) >>> 0;
    }
    var i = 1, j = 0, k = Math.max(N, key.length);
    for (; k; k--) {
      var prev2 = mt[i - 1];
      mt[i] = (((mt[i] ^ (Math.imul((prev2 ^ (prev2 >>> 30)) >>> 0, 1664525) >>> 0)) >>> 0) + key[j] + j) >>> 0;
      i++; j++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (k = N - 1; k; k--) {
      var prev3 = mt[i - 1];
      mt[i] = ((((mt[i] ^ (Math.imul((prev3 ^ (prev3 >>> 30)) >>> 0, 1566083941) >>> 0)) >>> 0)) - i) >>> 0;
      i++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
    }
    mt[0] = 0x80000000 >>> 0;
  };
  MT19937.prototype.genrand = function () {
    var mt = this.mt, y;
    if (this.mti >= N) {
      var kk;
      for (kk = 0; kk < N - M; kk++) {
        y = (mt[kk] & UPPER) | (mt[kk + 1] & LOWER);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0);
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk] & UPPER) | (mt[kk + 1] & LOWER);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0);
      }
      y = (mt[N - 1] & UPPER) | (mt[0] & LOWER);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0);
      this.mti = 0;
    }
    y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  };
  MT19937.prototype.random = function () {
    var a = this.genrand() >>> 5, b = this.genrand() >>> 6;
    return (a * 67108864.0 + b) / 9007199254740992.0;
  };
  MT19937.prototype.gauss = function (mu, sigma) {
    var z = this.gaussNext;
    this.gaussNext = null;
    if (z === null || z === undefined) {
      var r1 = this.random();
      var x2pi = r1 * (2 * Math.PI);
      var g2rad = Math.sqrt(-2.0 * Math.log(1.0 - this.random()));
      z = Math.cos(x2pi) * g2rad;
      this.gaussNext = Math.sin(x2pi) * g2rad;
    }
    return mu + z * sigma;
  };

  // --------------------------------------- Fraction(p).limit_denominator 移植
  function limitDenominator(num, den, maxDen) {
    // 精确有理数 num/den（num,den 为 BigInt，den>0）=> 最近且分母≤maxDen 的分数 [p,q]
    num = BigInt(num); den = BigInt(den); maxDen = BigInt(maxDen);
    if (den <= maxDen) return [num, den];
    var a = 0n, b = 1n, c = 1n, d = 0n; // 界：a/b <= x <= c/d
    while (true) {
      var medA = a + c, medB = b + d;
      if (medB > maxDen) break;
      if (num * medB < den * medA) { c = medA; d = medB; }
      else { a = medA; b = medB; }
    }
    // |x - a/b| vs |x - c/d|：叉乘比较（BigInt 精确）
    var distA = (num * b - den * a < 0n ? den * a - num * b : num * b - den * a) * d;
    var distC = (num * d - den * c < 0n ? den * c - num * d : num * d - den * c) * b;
    if (distA < distC) return [a, b];
    if (distC < distA) return [c, d];
    return b <= d ? [a, b] : [c, d];
  }

  function floatToExactFraction(x) {
    // 浮点 => 精确二元分数 BigInt(num)/BigInt(den)
    if (Number.isInteger(x)) return [BigInt(x), 1n];
    var sign = x < 0 ? -1n : 1n;
    x = Math.abs(x);
    // 用连续乘 2 找精确表示（double 最多 52 位尾数）
    var den = 1n;
    for (var i = 0; i < 1074 && x * 1 !== Math.floor(x * 1); i++) {
      x *= 2; den *= 2n;
      if (den > (1n << 60n)) break;
    }
    var num = BigInt(Math.round(x));
    // 约分（num/den 已是 2 的幂分母，直接除）
    while (den > 1n && num % 2n === 0n) { num /= 2n; den /= 2n; }
    return [sign * num, den];
  }

  // ---------------------------------------------------------------- 表达式
  function safeEval(expr) {
    var s = String(expr);
    var pos = 0;
    function skipWs() { while (pos < s.length && s[pos] === " ") pos++; }
    function parseExpr() {
      var v = parseTerm();
      for (;;) {
        skipWs();
        var ch = s[pos];
        if (ch === "+" || ch === "-") { pos++; var rhs = parseTerm(); v = ch === "+" ? v + rhs : v - rhs; }
        else break;
      }
      return v;
    }
    function parseTerm() {
      var v = parseFactor();
      for (;;) {
        skipWs();
        var ch = s[pos];
        if (ch === "*" || ch === "/" || ch === "%") {
          pos++;
          var rhs = parseFactor();
          if (ch === "*") v = v * rhs;
          else if (ch === "/") v = v / rhs;
          else v = pyMod(v, rhs);
        } else break;
      }
      return v;
    }
    function parseFactor() {
      skipWs();
      var ch = s[pos];
      if (ch === "+" || ch === "-") {
        pos++;
        var v = parseFactor();
        return ch === "+" ? +v : -v;
      }
      return parsePower();
    }
    function parsePower() {
      var base = parseAtom();
      skipWs();
      if (s[pos] === "*" && s[pos + 1] === "*") {
        pos += 2;
        var exp = parseFactor(); // 右结合，且允许负指数
        return Math.pow(base, exp);
      }
      return base;
    }
    function parseAtom() {
      skipWs();
      if (s[pos] === "(") {
        pos++;
        var v = parseExpr();
        skipWs();
        if (s[pos] !== ")") throw new Error("Disallowed syntax: unbalanced parentheses");
        pos++;
        return v;
      }
      var start = pos;
      if (s[pos] === "." || (s[pos] >= "0" && s[pos] <= "9")) {
        while (pos < s.length && (s[pos] >= "0" && s[pos] <= "9" || s[pos] === ".")) pos++;
        if (s[pos] === "e" || s[pos] === "E") {
          pos++;
          if (s[pos] === "+" || s[pos] === "-") pos++;
          while (pos < s.length && s[pos] >= "0" && s[pos] <= "9") pos++;
        }
        var numStr = s.slice(start, pos);
        var v = Number(numStr);
        if (!isFinite(v)) throw new Error("Disallowed syntax: bad number " + numStr);
        return v;
      }
      throw new Error("Disallowed syntax: " + (s[pos] === undefined ? "EOF" : s[pos]));
    }
    var result = parseExpr();
    skipWs();
    if (pos < s.length) throw new Error("Disallowed syntax: trailing " + s.slice(pos));
    return result;
  }

  // ---------------------------------------------------------------- 子命令
  var cmd = {};

  cmd.expr = function (a) { return safeEval(a.expr); };

  cmd.compound = function (a) {
    var p = a.principal, r = a.rate, t = a.years, n = a.freq;
    var amount = p * Math.pow(1 + r / n, n * t);
    return {
      principal: p, annual_rate: r, years: t, compounds_per_year: n,
      future_value: pyround(amount, 2),
      total_interest: pyround(amount - p, 2),
      growth_multiple: pyround(amount / p, 4),
    };
  };

  cmd.expected = function (a) {
    var values = nums(a.values);
    var probs = a.probs ? nums(a.probs) : values.map(function () { return 1 / values.length; });
    if (values.length !== probs.length) throw new Error("values and probs must have equal length");
    var sp = 0; for (var i = 0; i < probs.length; i++) sp += probs[i];
    if (Math.abs(sp - 1.0) > 1e-9) throw new Error("probabilities must sum to 1, got " + sp);
    var ev = 0; for (var j = 0; j < values.length; j++) ev += values[j] * probs[j];
    return { expected_value: pyround(ev, 4), outcomes: values, probs: probs };
  };

  cmd["prob-at-least-one"] = function (a) {
    var p = a.p, n = a.n;
    if (!(p >= 0 && p <= 1)) throw new Error("p must be in [0,1]");
    var result = 1 - Math.pow(1 - p, n);
    return {
      single_trial_prob: p, trials: n,
      prob_at_least_one: pyround(result, 6),
      prob_none: pyround(Math.pow(1 - p, n), 6),
    };
  };

  cmd["present-value"] = function (a) {
    var fv = a.future, r = a.rate, t = a.years;
    var pv = fv / Math.pow(1 + r, t);
    return {
      future_value: fv, annual_rate: r, years: t,
      present_value: pyround(pv, 2),
      discount_factor: pyround(pv / fv, 4),
    };
  };

  cmd.stats = function (a) {
    var data = nums(a.data);
    var n = data.length;
    var mean = 0; for (var i = 0; i < n; i++) mean += data[i]; mean /= n;
    var sorted = data.slice().sort(function (x, y) { return x - y; });
    var mid = Math.floor(n / 2);
    var median = (n % 2) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    var varSum = 0; for (var k = 0; k < n; k++) varSum += Math.pow(data[k] - mean, 2);
    var std = Math.sqrt(varSum / n);
    return {
      n: n, mean: pyround(mean, 4), median: median,
      stdev_pop: pyround(std, 4),
      min: Math.min.apply(null, data), max: Math.max.apply(null, data),
    };
  };

  cmd.irr = function (a) {
    var flows = nums(a.flows);
    if (flows.length < 2) throw new Error("need at least 2 cash flows");
    var periods = a.periods_per_year || 1;
    function npv(rate) {
      var base = 1.0 + rate;
      if (base <= 0) return flows[flows.length - 1] >= 0 ? Infinity : -Infinity;
      var total = 0.0;
      for (var i = 0; i < flows.length; i++) {
        var pw = Math.pow(base, i);
        if (pw === 0.0) return flows[i] >= 0 ? Infinity : -Infinity;
        total += flows[i] / pw;
      }
      return total;
    }
    var lo = null, hi = null, flo = null;
    var prevV = npv(-0.9);
    for (var step = 1; step < 5000; step++) {
      var r = -0.9 + step * 0.01;
      var v = npv(r);
      if (prevV === 0) { lo = r - 0.01; hi = r; flo = prevV; break; }
      if (prevV * v < 0) { lo = r - 0.01; hi = r; flo = prevV; break; }
      prevV = v;
    }
    if (lo === null) throw new Error("no IRR bracket found (cash flows need exactly one sign change)");
    for (var it = 0; it < 400; it++) {
      var mid = (lo + hi) / 2;
      var fm = npv(mid);
      if (flo * fm <= 0) hi = mid; else { lo = mid; flo = fm; }
    }
    var rate = (lo + hi) / 2;
    var out = { period_IRR: pyround(rate, 6) };
    if (a.annualize) {
      var eff = Math.pow(1 + rate, periods) - 1;
      out.effective_annual_rate = pyround(eff, 6);
      out.nominal_annual_rate = pyround(rate * periods, 6);
    }
    return out;
  };

  cmd.geomean = function (a) {
    var raw = nums(a.returns);
    var factor = pctFactor(raw);
    var r = raw.map(function (x) { return x * factor; });
    var n = r.length;
    if (n < 1) throw new Error("need at least 1 return");
    for (var i = 0; i < n; i++) if (1 + r[i] <= 0) throw new Error("a return <= -100% makes the portfolio worthless; geometric mean is undefined");
    var prod = 1.0;
    for (var j = 0; j < n; j++) prod *= (1 + r[j]);
    var gmean = Math.pow(prod, 1.0 / n) - 1;
    var arith = 0; for (var k = 0; k < n; k++) arith += r[k]; arith /= n;
    return {
      n_periods: n,
      input_as: factor === 0.01 ? "percent" : "decimal",
      arithmetic_mean: pyround(arith, 6),
      geometric_mean: pyround(gmean, 6),
      volatility_drag: pyround(arith - gmean, 6),
      cumulative_growth_multiple: pyround(prod, 6),
    };
  };

  cmd.sharpe = function (a) {
    var raw = nums(a.returns);
    var factor = pctFactor(raw);
    var r = raw.map(function (x) { return x * factor; });
    var n = r.length;
    if (n < 2) throw new Error("need at least 2 returns to compute a standard deviation");
    var rf = a.risk_free;
    rf = Math.abs(rf) > 1 ? rf / 100.0 : rf;
    var mean = 0; for (var i = 0; i < n; i++) mean += r[i]; mean /= n;
    var varSample = 0; for (var j = 0; j < n; j++) varSample += Math.pow(r[j] - mean, 2);
    var std = Math.sqrt(varSample / (n - 1));
    var excess = mean - rf;
    var sharpe = std > 0 ? excess / std : null;
    return {
      n_periods: n,
      arithmetic_mean: pyround(mean, 6),
      stdev_sample: pyround(std, 6),
      risk_free: pyround(rf, 6),
      excess_return: pyround(excess, 6),
      sharpe: sharpe === null ? null : pyround(sharpe, 6),
    };
  };

  cmd.pmt = function (a) {
    if (a.present === null && a.future === null) throw new Error("specify --present (loan payoff) or --future (savings goal)");
    if (a.present !== null && a.future !== null) throw new Error("specify exactly one of --present / --future");
    var r = a.rate, freq = a.freq;
    var n = Math.trunc(pyround(freq * a.years, 0));
    var rp = r / freq;
    if (a.present !== null) {
      var pv = a.present;
      var pmt = rp === 0 ? pv / n : pv * rp / (1 - Math.pow(1 + rp, -n));
      var total = pmt * n;
      return {
        mode: "loan", present_value: pv, annual_rate: r, years: a.years, freq: freq,
        periods: n, periodic_payment: pyround(pmt, 2),
        total_paid: pyround(total, 2), total_interest: pyround(total - pv, 2),
      };
    }
    var fv = a.future;
    var pmt2 = rp === 0 ? fv / n : fv * rp / (Math.pow(1 + rp, n) - 1);
    var total2 = pmt2 * n;
    return {
      mode: "savings", future_value: fv, annual_rate: r, years: a.years, freq: freq,
      periods: n, periodic_payment: pyround(pmt2, 2),
      total_deposited: pyround(total2, 2), interest_earned: pyround(fv - total2, 2),
    };
  };

  cmd.tco = function (a) {
    var oilPurchase = a.oil_car_price * (1 + a.oil_purchase_tax);
    var evPurchase = a.ev_car_price * (1 + a.ev_purchase_tax);
    var blended = a.home_rate * (1 - a.public_share) + a.public_rate * a.public_share;
    var oilEnergyYear = a.oil_consumption / 100 * a.oil_price * a.annual_km;
    var evEnergyYear = a.ev_consumption / 100 * blended * a.annual_km;
    var oilOpYear = oilEnergyYear + a.oil_maintenance + a.oil_insurance;
    var evOpYear = evEnergyYear + a.ev_maintenance + a.ev_insurance;
    var oilTotal = oilPurchase + oilOpYear * a.years;
    var evTotal = evPurchase + evOpYear * a.years;
    var diff = oilTotal - evTotal;
    var extraUpfront = evPurchase - oilPurchase;
    var annualSave = oilOpYear - evOpYear;
    var payback = annualSave > 0 ? extraUpfront / annualSave : null;
    return {
      oil_purchase_total: pyround(oilPurchase, 2),
      ev_purchase_total: pyround(evPurchase, 2),
      blended_elec_rate: pyround(blended, 4),
      oil_energy_per_year: pyround(oilEnergyYear, 2),
      ev_energy_per_year: pyround(evEnergyYear, 2),
      oil_op_per_year: pyround(oilOpYear, 2),
      ev_op_per_year: pyround(evOpYear, 2),
      oil_total_cost: pyround(oilTotal, 2),
      ev_total_cost: pyround(evTotal, 2),
      ev_saves_over_horizon: pyround(diff, 2),
      extra_upfront_ev: pyround(extraUpfront, 2),
      annual_save_ev: pyround(annualSave, 2),
      payback_years: payback === null ? null : pyround(payback, 2),
    };
  };

  cmd.dca = function (a) {
    var amount = a.amount, rate = a.rate, years = a.years, freq = a.freq;
    var rp = rate / freq;
    var n = Math.trunc(pyround(freq * years, 0));
    var fvDca = rp === 0 ? amount * n : amount * ((Math.pow(1 + rp, n) - 1) / rp);
    var invested = amount * n;
    var lump = (a.lump !== null && a.lump !== undefined) ? a.lump : invested;
    var fvLump = lump * Math.pow(1 + rate, years);
    return {
      per_period_amount: amount, freq: freq, years: years, annual_rate: rate,
      total_invested: pyround(invested, 2),
      fv_dca: pyround(fvDca, 2),
      interest_earned_dca: pyround(fvDca - invested, 2),
      compare_lump_upfront: pyround(lump, 2),
      fv_lump_same_total: pyround(fvLump, 2),
      lump_minus_dca: pyround(fvLump - fvDca, 2),
    };
  };

  cmd.prepay = function (a) {
    var P = a.principal, rate = a.rate, years = a.years, freq = a.freq, prepay = a.prepay;
    if (prepay >= P) throw new Error("prepay must be < remaining principal");
    var rp = rate / freq;
    var n = Math.trunc(pyround(freq * years, 0));
    var M = rp === 0 ? P / n : P * rp / (1 - Math.pow(1 + rp, -n));
    var curTotalInterest = M * n - P;
    var P2 = P - prepay;
    var mode = a.mode;
    if (mode === "reduce-payment") {
      var M2 = rp === 0 ? P2 / n : P2 * rp / (1 - Math.pow(1 + rp, -n));
      var newTotalInterest = M2 * n - P2;
      var interestSaved = curTotalInterest - newTotalInterest;
      return {
        mode: "reduce-payment (保持期限，降低月供)",
        current_payment: pyround(M, 2),
        current_total_interest: pyround(curTotalInterest, 2),
        prepay: prepay, new_principal: pyround(P2, 2),
        new_payment: pyround(M2, 2),
        payment_drop: pyround(M - M2, 2),
        new_total_interest: pyround(newTotalInterest, 2),
        interest_saved: pyround(interestSaved, 2),
      };
    }
    var n2;
    if (rp === 0) n2 = M > 0 ? P2 / M : n;
    else {
      var rhs = 1 - P2 * rp / M;
      if (rhs <= 0) throw new Error("prepay too large for reduce-term with this payment");
      n2 = -Math.log(rhs) / Math.log(1 + rp);
    }
    var newTi = M * n2 - P2;
    var is = curTotalInterest - newTi;
    return {
      mode: "reduce-term (保持月供，缩短期限)",
      current_payment: pyround(M, 2),
      current_total_interest: pyround(curTotalInterest, 2),
      prepay: prepay, new_principal: pyround(P2, 2),
      new_term_periods: pyround(n2, 1),
      new_term_years: pyround(n2 / freq, 2),
      new_total_interest: pyround(newTi, 2),
      interest_saved: pyround(is, 2),
    };
  };

  cmd.eoq = function (a) {
    var D = a.annual_demand, S = a.order_cost, H = a.holding_cost;
    if (H <= 0) throw new Error("holding_cost must be > 0 (否则持有零成本，应无限囤货)");
    if (D <= 0 || S <= 0) throw new Error("annual_demand and order_cost must be > 0");
    var q = Math.sqrt(2 * D * S / H);
    var orders = D / q;
    var cycle = 365.0 / orders;
    var orderCost = orders * S;
    var holdingCost = (q / 2) * H;
    var total = orderCost + holdingCost;
    var out = {
      annual_demand: D, order_cost: S, holding_cost_per_unit_year: H,
      optimal_q: pyround(q, 2), orders_per_year: pyround(orders, 2),
      cycle_days: pyround(cycle, 1),
      annual_order_cost: pyround(orderCost, 2),
      annual_holding_cost: pyround(holdingCost, 2),
      total_cost_at_eoq: pyround(total, 2),
    };
    if (a.eval_q !== null && a.eval_q !== undefined) {
      var qe = a.eval_q;
      var oe = (D / qe) * S;
      var he = (qe / 2) * H;
      out.eval_q = qe;
      out.eval_order_cost = pyround(oe, 2);
      out.eval_holding_cost = pyround(he, 2);
      out.eval_total_cost = pyround(oe + he, 2);
    }
    return out;
  };

  cmd.combo = function (a) {
    var n = a.n, k = a.k;
    if (k < 0 || k > n) throw new Error("need 0 <= k <= n");
    return {
      n: n, k: k,
      permutations_P: Number(permBig(n, k)),
      combinations_C: Number(combBig(n, k)),
    };
  };

  cmd["prob-shared"] = function (a) {
    var n = a.n, days = a.days;
    if (n < 2) throw new Error("need n >= 2");
    if (n > days) return { n: n, days: days, prob_no_shared: 0.0, prob_shared: 1.0 };
    var pNo = 1.0;
    for (var i = 0; i < n; i++) pNo *= (days - i) / days;
    return {
      n: n, days: days,
      prob_no_shared: pyround(pNo, 6),
      prob_shared: pyround(1 - pNo, 6),
    };
  };

  cmd.markov = function (a) {
    var rows = [];
    String(a.matrix).split(";").forEach(function (r) {
      r = r.trim();
      if (r) rows.push(nums(r));
    });
    var n = rows.length;
    if (n === 0) throw new Error("matrix is empty");
    rows.forEach(function (r, i) {
      if (r.length !== n) throw new Error("row " + i + " has " + r.length + " entries, expected " + n + " (square matrix)");
      var s = 0; for (var k = 0; k < r.length; k++) s += r[k];
      if (Math.abs(s - 1.0) > 1e-6) throw new Error("row " + i + " sums to " + s + ", must be 1 (transition probabilities)");
    });
    var v = rows.map(function () { return 1.0 / n; });
    for (var iter = 0; iter < 100000; iter++) {
      var vNext = [];
      for (var i2 = 0; i2 < n; i2++) {
        var acc = 0;
        for (var j = 0; j < n; j++) acc += v[j] * rows[j][i2];
        vNext.push(acc);
      }
      var diff = 0;
      for (var d = 0; d < n; d++) diff = Math.max(diff, Math.abs(vNext[d] - v[d]));
      v = vNext;
      if (diff < 1e-12) break;
    }
    var out = {
      states: n,
      steady_distribution: v.map(function (x) { return pyround(x, 6); }),
      steady_check_sum: pyround(v.reduce(function (s, x) { return s + x; }, 0), 6),
    };
    if (a.start !== null && a.start !== undefined) {
      var start = nums(a.start);
      if (start.length !== n) throw new Error("start has " + start.length + " entries, expected " + n);
      var ss = 0; for (var s2 = 0; s2 < start.length; s2++) ss += start[s2];
      if (Math.abs(ss - 1.0) > 1e-6) throw new Error("start distribution must sum to 1");
      var cur = start.slice();
      for (var st = 0; st < a.steps; st++) {
        var nx = [];
        for (var i3 = 0; i3 < n; i3++) {
          var acc2 = 0;
          for (var j2 = 0; j2 < n; j2++) acc2 += cur[j2] * rows[j2][i3];
          nx.push(acc2);
        }
        cur = nx;
      }
      out.start = start.map(function (x) { return pyround(x, 4); });
      out.steps = a.steps;
      out.dist_after_steps = cur.map(function (x) { return pyround(x, 6); });
    }
    return out;
  };

  cmd.mcdm = function (a) {
    var rows = [];
    String(a.matrix).split(";").forEach(function (r) {
      r = r.trim();
      if (r) rows.push(nums(r));
    });
    var m = rows.length;
    if (m === 0) throw new Error("matrix is empty");
    var k = rows[0].length;
    rows.forEach(function (r, i) {
      if (r.length !== k) throw new Error("row " + i + " has " + r.length + " values, expected " + k);
    });
    var weights = nums(a.weights);
    if (weights.length !== k) throw new Error("need " + k + " weights, got " + weights.length);
    var wsum = 0; for (var w = 0; w < weights.length; w++) wsum += weights[w];
    if (Math.abs(wsum - 1.0) > 1e-6) throw new Error("weights must sum to 1, got " + wsum);
    var criteria = String(a.criteria).split(",").map(function (c) { return c.trim(); }).filter(function (c) { return c !== ""; });
    if (criteria.length !== k) throw new Error("need " + k + " criteria signs, got " + criteria.length);
    // 转置
    var cols = [];
    for (var j = 0; j < k; j++) {
      var col = [];
      for (var i = 0; i < m; i++) col.push(rows[i][j]);
      cols.push(col);
    }
    var norm = [];
    for (var j2 = 0; j2 < k; j2++) {
      var col2 = cols[j2];
      var lo = Math.min.apply(null, col2), hi = Math.max.apply(null, col2);
      var ncol = [];
      for (var x = 0; x < col2.length; x++) {
        if (criteria[j2] === "+") ncol.push(hi === lo ? 1.0 : (col2[x] - lo) / (hi - lo));
        else if (criteria[j2] === "-") ncol.push(hi === lo ? 1.0 : (hi - col2[x]) / (hi - lo));
        else throw new Error("criterion must be '+' or '-', got '" + criteria[j2] + "'");
      }
      norm.push(ncol);
    }
    var normRows = [];
    for (var i2 = 0; i2 < m; i2++) {
      var nr = [];
      for (var j3 = 0; j3 < k; j3++) nr.push(norm[j3][i2]);
      normRows.push(nr);
    }
    var scores = [];
    for (var i4 = 0; i4 < m; i4++) {
      var s = 0;
      for (var j4 = 0; j4 < k; j4++) s += normRows[i4][j4] * weights[j4];
      scores.push(s);
    }
    var ranking = scores.map(function (_, i) { return i; })
      .sort(function (x, y) { return scores[y] - scores[x]; }); // 稳定排序
    var labels = a.labels ? String(a.labels).split(",").map(function (x) { return x.trim(); })
      : scores.map(function (_, i) { return String(i + 1); });
    if (labels.length < m) {
      for (var p = labels.length; p < m; p++) labels.push(String(p + 1));
    }
    return {
      criteria: criteria, weights: weights,
      normalized: normRows.map(function (nr) { return nr.map(function (x) { return pyround(x, 4); }); }),
      weighted_scores: scores.map(function (s) { return pyround(s, 4); }),
      ranking: ranking.map(function (idx, r) {
        return { rank: r + 1, label: labels[idx], score: pyround(scores[idx], 4) };
      }),
    };
  };

  cmd.lp = function (a) {
    if (a.max && a.min) throw new Error("specify exactly one of --max / --min");
    if (!a.max && !a.min) throw new Error("specify --max or --min (objective coefficients c1,c2)");
    var obj, sense;
    if (a.max) { obj = nums(a.max); sense = 1; } else { obj = nums(a.min); sense = -1; }
    if (obj.length !== 2) throw new Error("objective needs exactly 2 coefficients (c1 for x, c2 for y)");

    var leq = [], bnd = [];
    function addLeq(x, y, c) { leq.push([x, y, c]); bnd.push([x, y, c]); }
    String(a.constraints).split(";").forEach(function (part) {
      part = part.trim();
      if (!part) return;
      var toks = part.split(",").map(function (t) { return t.trim(); });
      if (toks.length !== 4) throw new Error("constraint '" + part + "' needs a,b,op,c");
      var x = parseFloat(toks[0]), y = parseFloat(toks[1]), op = toks[2], c = parseFloat(toks[3]);
      if (op === "<=") addLeq(x, y, c);
      else if (op === ">=") addLeq(-x, -y, -c);
      else if (op === "=") { addLeq(x, y, c); addLeq(-x, -y, -c); }
      else throw new Error("unknown operator '" + op + "' (use <=, >=, =)");
    });
    if (a.nonneg) { addLeq(-1.0, 0.0, 0.0); addLeq(0.0, -1.0, 0.0); }

    function feasible(x, y) {
      return leq.every(function (c) { return c[0] * x + c[1] * y <= c[2] + 1e-9; });
    }
    var cand = [];
    for (var i = 0; i < bnd.length; i++) {
      for (var j = i + 1; j < bnd.length; j++) {
        var a1 = bnd[i][0], b1 = bnd[i][1], c1 = bnd[i][2];
        var a2 = bnd[j][0], b2 = bnd[j][1], c2 = bnd[j][2];
        var det = a1 * b2 - a2 * b1;
        if (Math.abs(det) < 1e-12) continue;
        cand.push([(c1 * b2 - c2 * b1) / det, (a1 * c2 - a2 * c1) / det]);
      }
    }
    bnd.forEach(function (c) {
      if (Math.abs(c[1]) > 1e-12) cand.push([0.0, c[2] / c[1]]);
      if (Math.abs(c[0]) > 1e-12) cand.push([c[2] / c[0], 0.0]);
    });
    var uniq = [];
    cand.forEach(function (p) {
      if (!uniq.some(function (q) { return Math.abs(p[0] - q[0]) < 1e-7 && Math.abs(p[1] - q[1]) < 1e-7; })) uniq.push(p);
    });
    var feas = uniq.filter(function (p) { return feasible(p[0], p[1]); });
    if (!feas.length) return { status: "infeasible", message: "约束冲突，无可行解" };

    function oval(x, y) { return sense * (obj[0] * x + obj[1] * y); }
    var best = feas[0];
    for (var bi = 1; bi < feas.length; bi++) if (oval(feas[bi][0], feas[bi][1]) > oval(best[0], best[1])) best = feas[bi];
    var bestVal = obj[0] * best[0] + obj[1] * best[1];

    var unb = false;
    var dirs = feas.filter(function (p) { return p !== best; })
      .map(function (p) { return [p[0] - best[0], p[1] - best[1]]; });
    dirs.push([1, 0], [-1, 0], [0, 1], [0, -1]);
    for (var di = 0; di < dirs.length; di++) {
      var dx = dirs[di][0], dy = dirs[di][1];
      if (dx === 0 && dy === 0) continue;
      if (sense * (obj[0] * dx + obj[1] * dy) <= 0) continue;
      if (leq.every(function (c) { return c[0] * dx + c[1] * dy <= 1e-9; })) { unb = true; break; }
    }
    var out = {
      status: unb ? "unbounded" : "optimal",
      objective: sense === 1 ? "max" : "min",
      optimal_x: pyround(best[0], 6),
      optimal_y: pyround(best[1], 6),
      optimal_value: pyround(bestVal, 6),
      feasible_vertices: feas.length,
    };
    if (unb) out.message = "可行域无界，目标可无限改善（缺约束封口）";
    return out;
  };

  cmd.queue = function (a) {
    var lam = a.arrival, mu = a.service;
    if (lam < 0 || mu <= 0) throw new Error("arrival must be >= 0 and service must be > 0");
    var rho = lam / mu;
    if (rho >= 1) throw new Error("system unstable: utilization ρ=" + rho.toFixed(3) + " ≥ 1 (到达率须 < 服务率)");
    var L = rho / (1 - rho);
    var Lq = Math.pow(rho, 2) / (1 - rho);
    var W = 1.0 / (mu - lam);
    var Wq = W - 1.0 / mu;
    var P0 = 1.0 - rho;
    return {
      arrival_rate: lam, service_rate: mu,
      utilization_rho: pyround(rho, 6),
      avg_in_system_L: pyround(L, 4),
      avg_in_queue_Lq: pyround(Lq, 4),
      avg_time_in_system_W: pyround(W, 4),
      avg_wait_in_queue_Wq: pyround(Wq, 4),
      prob_system_empty_P0: pyround(P0, 4),
    };
  };

  cmd.ci = function (a) {
    var level = a.level;
    if (!(level > 0 && level < 1)) throw new Error("level must be in (0,1), e.g. 0.95");
    if (a.n <= 0) throw new Error("n must be > 0");
    var z = normPpf(1.0 - (1.0 - level) / 2.0);
    var center, se, lo, hi, kind;
    if (a.p !== null && a.p !== undefined) {
      if (!(a.p >= 0 && a.p <= 1)) throw new Error("p (proportion) must be in [0,1]");
      se = Math.sqrt(a.p * (1.0 - a.p) / a.n);
      center = a.p;
      lo = Math.max(0.0, center - z * se);
      hi = Math.min(1.0, center + z * se);
      kind = "proportion";
    } else {
      if (a.mean === null || a.mean === undefined || a.stdev === null || a.stdev === undefined)
        throw new Error("mean-type CI requires --mean and --stdev (or use --p for proportion)");
      if (a.stdev < 0) throw new Error("stdev must be >= 0");
      se = a.stdev / Math.sqrt(a.n);
      center = a.mean;
      lo = center - z * se;
      hi = center + z * se;
      kind = "mean";
    }
    return {
      kind: kind, level: level, z: pyround(z, 4),
      center: pyround(center, 6), std_error: pyround(se, 6),
      margin_of_error: pyround(z * se, 6),
      lower: pyround(lo, 6), upper: pyround(hi, 6),
    };
  };

  cmd.bayes = function (a) {
    var prior = a.prior, lik = a.lik, likNeg = a.lik_neg;
    [[prior, "prior"], [lik, "lik"], [likNeg, "lik_neg"]].forEach(function (pair) {
      if (!(pair[0] >= 0 && pair[0] <= 1)) throw new Error(pair[1] + " must be in [0,1]");
    });
    var pHE = prior * lik;
    var pE = pHE + (1.0 - prior) * likNeg;
    if (pE === 0.0) throw new Error("P(E)=0 under given priors; evidence impossible");
    var posterior = pHE / pE;
    return {
      prior: pyround(prior, 6),
      "P(E|H)": pyround(lik, 6),
      "P(E|~H)": pyround(likNeg, 6),
      "P(E)": pyround(pE, 6),
      "posterior_P(H|E)": pyround(posterior, 6),
    };
  };

  cmd.hypergeom = function (a) {
    var N = a.N, K = a.K, n = a.n;
    if (N <= 0 || K < 0 || n < 0 || K > N || n > N) throw new Error("require 0<=K<=N, 0<=n<=N, all positive");
    var denom = combBig(N, n);
    if (denom === 0n) throw new Error("C(N,n)=0, invalid draw");
    var denomF = Number(denom);
    var kmax = Math.min(K, n);
    function pmf(k) {
      var num = combBig(K, k) * combBig(N - K, n - k);
      return Number(num) / denomF;
    }
    var mode, prob;
    if (a.k !== null && a.k !== undefined) { mode = "exact"; prob = pmf(a.k); }
    else if (a.at_least !== null && a.at_least !== undefined) {
      mode = "at_least"; prob = 0;
      for (var k = Math.max(0, a.at_least); k <= kmax; k++) prob += pmf(k);
    } else if (a.at_most !== null && a.at_most !== undefined) {
      mode = "at_most"; prob = 0;
      for (var k2 = 0; k2 <= Math.min(a.at_most, kmax); k2++) prob += pmf(k2);
    } else { mode = "at_least_1"; prob = 1.0 - pmf(0); }
    return { mode: mode, N: N, K: K, n: n, probability: pyround(prob, 6) };
  };

  cmd.binomial = function (a) {
    var n = a.n, p = a.p;
    if (n < 0 || !(p >= 0 && p <= 1)) throw new Error("require n>=0 and 0<=p<=1");
    function pmf(k) {
      return Number(combBig(n, k)) * Math.pow(p, k) * Math.pow(1.0 - p, n - k);
    }
    var kmax = n, mode, prob;
    if (a.k !== null && a.k !== undefined) {
      if (a.k < 0 || a.k > n) throw new Error("k must be in [0,n]");
      mode = "exact"; prob = pmf(a.k);
    } else if (a.at_least !== null && a.at_least !== undefined) {
      mode = "at_least"; prob = 0;
      for (var k = Math.max(0, a.at_least); k <= kmax; k++) prob += pmf(k);
    } else if (a.at_most !== null && a.at_most !== undefined) {
      mode = "at_most"; prob = 0;
      for (var k2 = 0; k2 <= Math.min(a.at_most, kmax); k2++) prob += pmf(k2);
    } else { mode = "at_least_1"; prob = 1.0 - pmf(0); }
    return { mode: mode, n: n, p: p, probability: pyround(prob, 6) };
  };

  cmd.odds = function (a) {
    if (a.odds !== null && a.odds !== undefined && a.odds !== "") {
      var parts = String(a.odds).split(":");
      if (parts.length !== 2) throw new Error("odds must be 'a:b'");
      var oa = parseFloat(parts[0]), ob = parseFloat(parts[1]);
      if (!isFinite(oa) || !isFinite(ob)) throw new Error("odds must be 'a:b'");
      if (oa < 0 || ob < 0) throw new Error("odds components must be >= 0");
      var total = oa + ob;
      var prob = total > 0 ? oa / total : 0.0;
      return { input_odds: formatG(oa) + ":" + formatG(ob), probability: pyround(prob, 6) };
    }
    if (a.prob !== null && a.prob !== undefined) {
      var p = a.prob;
      if (!(p >= 0 && p < 1)) throw new Error("prob must be in [0,1)");
      var dec = p / (1.0 - p);
      var frac = floatToExactFraction(p);
      var lim = limitDenominator(frac[0] < 0n ? -frac[0] : frac[0], frac[1], 100000);
      return {
        input_prob: pyround(p, 6),
        decimal_odds: pyround(dec, 6),
        odds_in_favor: lim[0].toString() + ":" + lim[1].toString(),
      };
    }
    throw new Error("provide --odds a:b or --prob P");
  };

  cmd.poisson = function (a) {
    var lam = a.lam;
    if (lam < 0) throw new Error("lam must be >= 0");
    if (a.k !== null && a.k !== undefined) {
      var k = a.k;
      if (k < 0) throw new Error("k must be >= 0");
      var p = Math.exp(-lam) * Math.pow(lam, k) / Number(factBig(k));
      return { lambda: lam, k: k, "P(X=k)": pyround(p, 6) };
    }
    if (a.t !== null && a.t !== undefined) {
      var t = a.t;
      if (t < 0) throw new Error("t must be >= 0");
      var pWait = Math.exp(-lam * t);
      return { lambda: lam, t: t, "P(wait>t)": pyround(pWait, 6), "P(at_least_one_in_t)": pyround(1 - pWait, 6) };
    }
    throw new Error("provide --k or --t");
  };

  cmd.decay = function (a) {
    if (a.find_half) {
      var init = a.initial, rem = a.remaining, t = a.t;
      if (init === null || rem === null || t === null || init <= 0 || rem <= 0 || t <= 0)
        throw new Error("--find-half needs --initial --remaining --t all > 0");
      var half = t / (Math.log2(init) - Math.log2(rem));
      return { initial: init, remaining: rem, t: t, half_life: pyround(half, 6) };
    }
    var init2 = a.initial, half2 = a.half, t2 = a.t;
    if (init2 === null || half2 === null || t2 === null)
      throw new Error("provide --initial --half --t (or --find-half mode)");
    if (half2 <= 0 || t2 < 0) throw new Error("half must be > 0, t must be >= 0");
    var remaining = init2 * Math.pow(0.5, t2 / half2);
    return { initial: init2, half_life: half2, t: t2, remaining: pyround(remaining, 6) };
  };

  cmd.regress = function (a) {
    var xs = nums(a.x), ys = nums(a.y);
    var n = xs.length;
    if (n !== ys.length || n < 2) throw new Error("x and y must have equal length >= 2");
    var mx = 0, my = 0;
    for (var i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    var sxx = 0, syy = 0, sxy = 0;
    for (var j = 0; j < n; j++) {
      sxx += Math.pow(xs[j] - mx, 2);
      syy += Math.pow(ys[j] - my, 2);
      sxy += (xs[j] - mx) * (ys[j] - my);
    }
    if (sxx === 0) throw new Error("x has no variation");
    var b = sxy / sxx;
    var aa = my - b * mx;
    var r = syy === 0 ? 1.0 : sxy / Math.sqrt(sxx * syy);
    return {
      n: n, slope_b: pyround(b, 6), intercept_a: pyround(aa, 6),
      pearson_r: pyround(r, 6), R2: pyround(r * r, 6),
      equation: "y = " + aa.toFixed(4) + " + " + b.toFixed(4) + "*x",
    };
  };

  function dominant(M) {
    if (M[0][0] >= M[1][0] && M[0][1] >= M[1][1]) {
      var strict = (M[0][0] > M[1][0]) || (M[0][1] > M[1][1]);
      return "strategy_1" + (strict ? "" : "_weak");
    }
    if (M[1][0] >= M[0][0] && M[1][1] >= M[0][1]) {
      var strict2 = (M[1][0] > M[0][0]) || (M[1][1] > M[0][1]);
      return "strategy_2" + (strict2 ? "" : "_weak");
    }
    return "none";
  }

  cmd.nash = function (a) {
    function mat(s) {
      var v = nums(s);
      if (v.length !== 4) throw new Error("need 4 numbers");
      return [[v[0], v[1]], [v[2], v[3]]];
    }
    var R = mat(a.row), C = mat(a.col);
    var Ct = [[C[0][0], C[1][0]], [C[0][1], C[1][1]]];
    var eq = [];
    [0, 1].forEach(function (i) {
      [0, 1].forEach(function (j) {
        if (R[i][j] >= R[1 - i][j] && C[i][j] >= C[i][1 - j]) eq.push([i, j]);
      });
    });
    return {
      row_dominant: dominant(R), col_dominant: dominant(Ct),
      nash_equilibria: eq,
      note: "(0,0)=A/A,(0,1)=A/B,(1,0)=B/A,(1,1)=B/B",
    };
  };

  cmd.mix = function (a) {
    var vals = nums(a.values);
    var ws = a.weights ? nums(a.weights) : vals.map(function () { return 1.0; });
    if (vals.length !== ws.length) throw new Error("equal-length values/weights, nonzero total weight");
    var wsum = 0; for (var w = 0; w < ws.length; w++) wsum += ws[w];
    if (wsum === 0) throw new Error("equal-length values/weights, nonzero total weight");
    var acc = 0;
    for (var i = 0; i < vals.length; i++) acc += vals[i] * ws[i];
    return { n: vals.length, weighted_mean: pyround(acc / wsum, 6), weights: ws };
  };

  cmd.rule72 = function (a) {
    if (a.rate !== null && a.rate !== undefined) {
      var r = a.rate;
      if (r <= 0) throw new Error("rate must be > 0");
      return {
        rate_pct: r,
        double_in_years_approx: pyround(72.0 / r, 2),
        exact_ln2: pyround(Math.log(2) / Math.log(1 + r / 100.0), 2),
      };
    }
    if (a.years !== null && a.years !== undefined) {
      var y = a.years;
      if (y <= 0) throw new Error("years must be > 0");
      return { years: y, rate_pct_approx: pyround(72.0 / y, 2) };
    }
    throw new Error("provide --rate or --years");
  };

  cmd.ma = function (a) {
    var data = nums(a.data);
    var n = data.length;
    if (n < 1) throw new Error("need at least 1 data point");
    var kind = (a.type || "sma").toLowerCase();
    if (kind === "sma") {
      var w = a.window;
      if (w < 1 || w > n) throw new Error("window must be 1..len(data)");
      var sma = [];
      for (var i = w - 1; i < n; i++) {
        var s = 0;
        for (var k = i - w + 1; k <= i; k++) s += data[k];
        sma.push(pyround(s / w, 6));
      }
      return {
        type: "sma", window: w, smoothed: sma, last: sma[sma.length - 1],
        note: "首 " + (w - 1) + " 个点不足一个窗口，从第 " + w + " 点起有值",
      };
    }
    if (kind === "ema") {
      var alpha = (a.alpha !== null && a.alpha !== undefined) ? a.alpha : 2.0 / (a.window + 1);
      if (!(alpha > 0 && alpha <= 1)) throw new Error("alpha must be in (0,1]");
      var ema = [data[0]];
      for (var x = 1; x < n; x++) ema.push(alpha * data[x] + (1 - alpha) * ema[ema.length - 1]);
      ema = ema.map(function (v) { return pyround(v, 6); });
      return { type: "ema", alpha: pyround(alpha, 6), smoothed: ema, last: ema[ema.length - 1] };
    }
    throw new Error("type must be sma or ema");
  };

  cmd.trend = function (a) {
    var ys = nums(a.data);
    var n = ys.length;
    if (n < 2) throw new Error("need >= 2 data points");
    var xs = [];
    for (var i = 0; i < n; i++) xs.push(i);
    var mx = 0, my = 0;
    for (var j = 0; j < n; j++) { mx += xs[j]; my += ys[j]; }
    mx /= n; my /= n;
    var sxx = 0, syy = 0, sxy = 0;
    for (var k = 0; k < n; k++) {
      sxx += Math.pow(xs[k] - mx, 2);
      syy += Math.pow(ys[k] - my, 2);
      sxy += (xs[k] - mx) * (ys[k] - my);
    }
    var b = sxy / sxx;
    var aa = my - b * mx;
    var r = syy === 0 ? 1.0 : sxy / Math.sqrt(sxx * syy);
    var direction = Math.abs(b) < 1e-9 ? "flat" : (b > 0 ? "up" : "down");
    var fc = a.forecast || 0;
    var forecasts = [];
    for (var f = 0; f < fc; f++) forecasts.push(pyround(aa + b * (n + f), 6));
    return {
      n: n, slope_b: pyround(b, 6), intercept_a: pyround(aa, 6),
      R2: pyround(r * r, 6), direction: direction,
      next_value: pyround(aa + b * n, 6), forecast: forecasts,
    };
  };

  cmd.mcgoal = function (a) {
    var start = a.start, monthly = a.monthly, years = a.years;
    if (years <= 0) throw new Error("years must be > 0");
    var mean = a.mean / 100.0;
    var vol = a.vol / 100.0;
    if (vol < 0) throw new Error("vol must be >= 0");
    var target = a.target;
    var iters = a.iters;
    if (iters <= 0) throw new Error("iters must be > 0");
    var seed = a.seed;
    var months = Math.trunc(pyround(years * 12, 0));
    if (months < 1) throw new Error("years too small: need >= 1 month");
    var mMean = mean / 12.0;
    var mSd = vol > 0 ? vol / Math.sqrt(12.0) : 0.0;
    var rng = new MT19937(seed);
    var finals = [];
    for (var it = 0; it < iters; it++) {
      var bal = start;
      for (var m = 0; m < months; m++) {
        var rr = mSd === 0 ? mMean : rng.gauss(mMean, mSd);
        if (rr < -0.95) rr = -0.95;
        else if (rr > 5.0) rr = 5.0;
        bal = bal * (1.0 + rr) + monthly;
        if (bal < 0) bal = 0.0;
      }
      finals.push(bal);
    }
    finals.sort(function (x, y) { return x - y; });
    var reach = 0;
    for (var f = 0; f < finals.length; f++) if (finals[f] >= target) reach++;
    reach /= iters;
    function pct(p) {
      var idx = Math.min(finals.length - 1, Math.trunc(pyround(p * (finals.length - 1), 0)));
      return finals[idx];
    }
    var sum = 0;
    for (var s = 0; s < finals.length; s++) sum += finals[s];
    return {
      scenario: "savings_goal",
      iters: iters, seed: seed, months: months, target: target,
      probability_reach_target: pyround(reach, 4),
      final_p5: pyround(pct(0.05), 2),
      final_p50: pyround(pct(0.50), 2),
      final_p95: pyround(pct(0.95), 2),
      expected_final: pyround(sum / iters, 2),
      disclaimer: "蒙特卡洛模拟：结果依赖分布假设(正态月收益)与输入参数，未经验证，请核对；非投资建议。",
    };
  };

  cmd.scenario = function (a) {
    var start = a.start, monthly = a.monthly, years = a.years;
    if (years <= 0) throw new Error("years must be > 0");
    var rets = [a.r_worst, a.r_base, a.r_best];
    var months = Math.trunc(pyround(years * 12, 0));
    if (months < 1) throw new Error("years too small: need >= 1 month");
    var finals = rets.map(function (r) {
      var rm = r / 100.0 / 12.0;
      var bal = start;
      for (var m = 0; m < months; m++) bal = bal * (1.0 + rm) + monthly;
      return pyround(bal, 2);
    });
    var out = {
      scenario: "deterministic_3point",
      returns_pct: rets,
      final_worst: finals[0], final_base: finals[1], final_best: finals[2],
      range_min: Math.min.apply(null, finals),
      range_max: Math.max.apply(null, finals),
    };
    if (a.target !== null && a.target !== undefined) {
      out.target = a.target;
      out.meets_worst = finals[0] >= a.target;
      out.meets_base = finals[1] >= a.target;
      out.meets_best = finals[2] >= a.target;
    }
    return out;
  };

  cmd.kelly = function (a) {
    var p = a.p, b = a.b;
    if (!(p >= 0 && p <= 1)) throw new Error("p (win prob) must be in [0,1]");
    if (b <= 0) throw new Error("b (net odds, profit per unit stake) must be > 0");
    var q = 1.0 - p;
    var fStar = (b * p - q) / b;
    var fraction = fStar > 0 ? fStar : 0.0;
    return {
      win_prob_p: p, net_odds_b: b,
      edge: pyround(b * p - q, 6),
      fraction: pyround(fraction, 6),
      fraction_pct: pyround(fraction * 100, 4),
      note: fStar <= 0 ? "f*<=0: 无优势，不下注" : "按 f* 比例下注以最大化对数财富增长",
    };
  };

  cmd.ruin = function (a) {
    var i = a.i, N = a.N, p = a.p;
    if (i <= 0) return { start: i, target: N, win_prob_per_step: p, prob_reach_target: 0.0, prob_ruin: 1.0 };
    if (i >= N) return { start: i, target: N, win_prob_per_step: p, prob_reach_target: 1.0, prob_ruin: 0.0 };
    if (!(p >= 0 && p <= 1)) throw new Error("p must be in [0,1]");
    if (N <= 0) throw new Error("N (target) must be > 0");
    var P;
    if (p === 0.5) P = i / N;
    else {
      var q = 1.0 - p;
      var r = q / p;
      P = (1.0 - Math.pow(r, i)) / (1.0 - Math.pow(r, N));
    }
    return {
      start: i, target: N, win_prob_per_step: p,
      prob_reach_target: pyround(P, 6), prob_ruin: pyround(1.0 - P, 6),
    };
  };

  cmd.pareto = function (a) {
    var alpha = a.alpha, q = a.q;
    if (alpha <= 0) throw new Error("alpha (shape) must be > 0");
    if (!(q >= 0 && q <= 1)) throw new Error("q (top fraction) must be in [0,1]");
    var share;
    if (q <= 0.0) share = 0.0;
    else if (q >= 1.0) share = 1.0;
    else share = Math.pow(q, 1.0 - 1.0 / alpha);
    return {
      alpha: alpha, top_fraction: q, top_share: pyround(share, 6),
      note: "α越小越不平等; α≈1.16且q=0.2时约为80/20",
    };
  };

  // ---------------------------------------------------------------- 入口
  var SUBCOMMANDS = Object.keys(cmd);

  function run(name, args) {
    var fn = cmd[name];
    if (!fn) throw new Error("unknown subcommand: " + name);
    return fn(args || {});
  }

  // CLI：按 compute-spec.json 解析 argv（镜像 argparse 语义）
  function parseCliArgs(specEntry, argv) {
    var out = {};
    var posIdx = 0;
    function coerce(opt, raw) {
      if (opt.action === "store_true" || opt.action === "store_false" || opt.type === "bool") return raw === "true";
      if (opt.type === "float") { var f = parseFloat(raw); if (!isFinite(f)) throw new Error("invalid float for " + opt.flag + ": " + raw); return f; }
      if (opt.type === "int") { var i = parseInt(raw, 10); if (!isFinite(i)) throw new Error("invalid int for " + opt.flag + ": " + raw); return i; }
      return raw;
    }
    // 默认值
    specEntry.options.forEach(function (opt) {
      if (opt.action === "store_true") out[opt.dest] = false;
      else if (opt.action === "store_false") out[opt.dest] = true;
      else if (opt.default !== null && opt.default !== undefined) out[opt.dest] = opt.default;
      else out[opt.dest] = null;
    });
    for (var i = 0; i < argv.length; i++) {
      var tok = argv[i];
      if (tok === "--") { // argparse：-- 之后全部按位置参数
        for (var p2 = i + 1; p2 < argv.length; p2++) {
          if (posIdx < specEntry.positionals.length) {
            out[specEntry.positionals[posIdx].name] = argv[p2];
            posIdx++;
          } else throw new Error("unexpected argument: " + argv[p2]);
        }
        break;
      }
      if (tok.indexOf("--") === 0) {
        var flag = tok, inlineVal = null;
        var eq = tok.indexOf("=");
        if (eq > -1) { flag = tok.slice(0, eq); inlineVal = tok.slice(eq + 1); }
        var opt = null;
        for (var o = 0; o < specEntry.options.length; o++) {
          if (specEntry.options[o].flag === flag) { opt = specEntry.options[o]; break; }
        }
        if (!opt) throw new Error("unknown option: " + flag);
        if (opt.action === "store_true") out[opt.dest] = true;
        else if (opt.action === "store_false") out[opt.dest] = false;
        else if (opt.type === "bool") out[opt.dest] = inlineVal === null ? true : coerce(opt, inlineVal);
        else {
          var raw = inlineVal !== null ? inlineVal : argv[++i];
          if (raw === undefined) throw new Error("option " + flag + " requires a value");
          out[opt.dest] = coerce(opt, raw);
        }
      } else if (tok === "-h" || tok === "--help") {
        throw new Error("__HELP__");
      } else {
        if (posIdx < specEntry.positionals.length) {
          out[specEntry.positionals[posIdx].name] = tok;
          posIdx++;
        } else throw new Error("unexpected argument: " + tok);
      }
    }
    // required 检查
    specEntry.options.forEach(function (opt) {
      if (opt.required && (out[opt.dest] === null || out[opt.dest] === undefined))
        throw new Error("the following arguments are required: " + opt.flag);
    });
    specEntry.positionals.forEach(function (p) {
      if (p.required && (out[p.name] === null || out[p.name] === undefined))
        throw new Error("the following arguments are required: " + p.name);
    });
    return out;
  }

  return {
    run: run,
    safeEval: safeEval,
    pyround: pyround,
    parseCliArgs: parseCliArgs,
    SUBCOMMANDS: SUBCOMMANDS,
    _internals: { MT19937: MT19937, limitDenominator: limitDenominator, normCdf: normCdf },
  };
});
