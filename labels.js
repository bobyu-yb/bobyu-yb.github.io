/* 数学人生 PWA — 中文化标签层（纯展示映射，不影响计算契约）
 *
 * CMD_NAMES   38 个子命令的中文名（CLI 命令名保持英文，作为技术对照）
 * CMD_SCENES  按生活场景分组，让用户按意图找工具而不是记命令
 * FLAG_LABELS 参数旗标的中文标签（同名不同义的取通用标签，精确含义看 help 提示）
 */
(function (root) {
  "use strict";

  var CMD_NAMES = {
    "expr": "算式求值",
    "compound": "复利计算",
    "expected": "期望值决策",
    "prob-at-least-one": "至少发生一次的概率",
    "present-value": "现值折算",
    "stats": "基础统计",
    "irr": "内部收益率",
    "geomean": "几何平均收益",
    "sharpe": "夏普比率",
    "pmt": "每期付款测算",
    "tco": "油车 vs 电车总成本",
    "dca": "定投 vs 一次性投入",
    "prepay": "提前还款划算吗",
    "eoq": "经济订货量",
    "combo": "排列组合计数",
    "prob-shared": "生日悖论 / 撞库概率",
    "markov": "马尔可夫链",
    "mcdm": "多准则决策评分",
    "lp": "两变量线性规划",
    "queue": "排队等待测算",
    "ci": "置信区间",
    "bayes": "贝叶斯后验",
    "hypergeom": "不放回抽奖概率",
    "binomial": "二项分布概率",
    "odds": "赔率 ↔ 概率换算",
    "poisson": "泊松过程与等待",
    "decay": "半衰期与衰减",
    "regress": "线性回归与相关",
    "nash": "博弈均衡分析",
    "mix": "加权平均",
    "rule72": "72 法则翻倍估算",
    "ma": "移动平均平滑",
    "trend": "趋势拟合与预测",
    "mcgoal": "储蓄目标达成概率",
    "scenario": "三档情景推演",
    "kelly": "凯利公式仓位",
    "ruin": "赌徒破产概率",
    "pareto": "帕累托顶部份额",
  };

  var CMD_SCENES = {
    "算钱的基础": ["expr", "compound", "present-value", "rule72", "mix", "decay"],
    "贷款与还款": ["pmt", "prepay", "irr", "tco", "dca"],
    "投资与风险": ["sharpe", "geomean", "kelly", "ruin", "mcgoal", "scenario", "pareto"],
    "概率与中奖": ["prob-at-least-one", "prob-shared", "hypergeom", "binomial", "poisson", "odds", "expected", "bayes"],
    "统计与推断": ["stats", "ci", "regress", "trend", "ma"],
    "决策与运筹": ["mcdm", "lp", "queue", "eoq", "combo", "nash", "markov"],
  };

  var FLAG_LABELS = {
    // 通用
    "expr": "算式", "p": "概率 p", "n": "次数 n", "k": "命中数 k", "t": "时间 t",
    "N": "总数 N", "K": "目标数 K", "q": "占比 q", "i": "起始本金", "b": "净赔率 b",
    "alpha": "参数 α", "level": "置信水平", "mode": "方式", "x": "X 序列", "y": "Y 序列",
    "data": "数据序列", "window": "窗口大小", "values": "数值列表", "weights": "权重列表",
    "probs": "概率列表", "returns": "收益率序列", "matrix": "矩阵", "criteria": "准则方向",
    "labels": "备选标签", "steps": "步数", "start": "初始分布", "iters": "模拟次数", "seed": "随机种子",
    // 钱
    "rate": "年化利率", "years": "年限", "freq": "每年期数", "principal": "本金",
    "present": "贷款本金", "future": "目标终值", "amount": "每期金额", "monthly": "每月投入",
    "lump": "一次性投入额", "target": "目标金额", "prepay": "提前还款额",
    "mean": "年化期望收益 %", "vol": "年化波动率 %", "r_worst": "最差年化收益 %",
    "r_base": "基准年化收益 %", "r_best": "最好年化收益 %", "risk_free": "无风险利率",
    "flows": "现金流序列", "eval_q": "测算批量",
    // 概率
    "prior": "先验概率", "lik": "似然 P(E|H)", "lik_neg": "假阳率 P(E|¬H)",
    "lam": "平均发生率 λ", "odds": "赔率 a:b", "prob": "概率 P", "days": "可能取值数",
    "arrival": "到达率 λ", "service": "服务率 μ",
    // 统计
    "stdev": "标准差", "forecast": "预测期数", "type": "平滑类型",
    // 衰减
    "initial": "初始量", "half": "半衰期", "remaining": "剩余量",
    // TCO
    "oil_car_price": "油车车价", "ev_car_price": "电车车价",
    "oil_consumption": "油车百公里油耗(L)", "ev_consumption": "电车百公里电耗(kWh)",
    "oil_price": "油价(元/L)", "home_rate": "家充电价(元/kWh)",
    "public_rate": "公共桩电价(元/kWh)", "public_share": "公共充电占比",
    "annual_km": "年行驶里程(km)", "oil_maintenance": "油车年保养(元)",
    "ev_maintenance": "电车年保养(元)", "oil_insurance": "油车年保险(元)",
    "ev_insurance": "电车年保险(元)", "oil_purchase_tax": "油车购置税比例",
    "ev_purchase_tax": "电车购置税比例",
    // EOQ
    "annual_demand": "年需求量", "order_cost": "每次订货成本", "holding_cost": "单位年持有成本",
    // LP / combo
    "max": "最大化目标系数", "min": "最小化目标系数", "constraints": "约束条件",
    // nash
    "row": "行玩家收益", "col": "列玩家收益",
  };

  root.LMLabels = {
    CMD_NAMES: CMD_NAMES,
    CMD_SCENES: CMD_SCENES,
    FLAG_LABELS: FLAG_LABELS,
    cmdName: function (cmd) { return CMD_NAMES[cmd] || cmd; },
    flagLabel: function (dest, flag) {
      return FLAG_LABELS[dest] || FLAG_LABELS[String(flag || "").replace(/^--/, "")] || null;
    },
  };
})(typeof self !== "undefined" ? self : globalThis);
