// 台灣血脂決策支援 — 治療目標判定
//
// 依據：
//  · 2022 台灣高血壓、高血脂及糖尿病治療指引（中華民國心臟學會 / 台灣高血壓學會）
//  · 2019 ESC/EAS Guidelines for the management of dyslipidaemias (doi:10.1093/eurheartj/ehz455)
//  · 中央健康保險署 藥品給付規定 第 2.6.1 節（降血脂藥物）
//
// 本模組僅做「風險分層 → LDL 目標 → 現值差距」的對照，
// 不做治療方案建議；用藥決策仍屬醫師職權。

/** 健保給付規定 2.6.1：降血脂藥物給付條件（節錄，實際以健保署最新公告為準） */
export const NHI_LIPID_RULE = {
  chapter: "2.6.1.",
  title: "降血脂藥物給付規定",
  url: "https://www.nhi.gov.tw/ch/lp-2466-1.html",
  summary: [
    "須先經飲食控制及生活型態調整 3–6 個月無效後始得使用",
    "用藥後應每 3–6 個月追蹤血脂值",
    "治療性生活型態改變 (TLC) 應同時持續進行",
  ],
};

/** 風險分層對應的 LDL-C 治療目標（mg/dL） */
export const LDL_TARGETS = {
  veryHigh: { max: 55, label: "極高風險", desc: "確診 ASCVD、糖尿病合併標的器官損傷、重度 CKD" },
  high:     { max: 70, label: "高風險",   desc: "糖尿病、中度 CKD、單一危險因子顯著升高" },
  moderate: { max: 100, label: "中風險",  desc: "多重危險因子" },
  low:      { max: 116, label: "低風險",  desc: "無或單一危險因子" },
};

/** SNOMED CT 診斷比對（thas 的 Condition 只有 SNOMED，無 ICD-10） */
const DX = {
  ascvd: {
    snomed: ["53741008", "22298006", "194828000", "230690007", "399957001", "440417009"],
    text: ["coronary", "myocardial infarction", "ischemic heart", "atheroscler", "stroke",
           "cerebral infarction", "peripheral arter", "冠心", "心肌梗塞", "中風", "動脈硬化"],
  },
  diabetes: {
    snomed: ["44054006", "46635009", "73211009"],
    text: ["diabetes", "diabetic", "糖尿病"],
  },
  ckd: {
    snomed: ["709044004", "431855005", "431856006", "433144002", "431857002"],
    text: ["chronic kidney", "renal insufficiency", "慢性腎"],
  },
  fh: {
    snomed: ["398036000"],
    text: ["familial hypercholesterolemia", "家族性高膽固醇"],
  },
  hypertension: {
    snomed: ["38341003"],
    text: ["hypertens", "高血壓"],
  },
  hyperlipidemia: {
    snomed: ["55822004", "267434003"],
    text: ["hyperlipid", "hypercholesterol", "dyslipid", "高血脂", "高膽固醇"],
  },
};

/** 以 SNOMED code 或診斷文字比對是否具備某類診斷 */
function hasDx(conditions, key) {
  const spec = DX[key];
  if (!spec) return null;
  return conditions.find((c) => {
    const code = String(c.code || "");
    const disp = `${c.display || ""} ${c.text || ""}`.toLowerCase();
    return spec.snomed.includes(code) || spec.text.some((t) => disp.includes(t.toLowerCase()));
  }) || null;
}

/**
 * 風險分層。回傳 { level, target, label, reasons[] }。
 * 分層僅依「已編碼的診斷」，不足以判定時明確標示，不臆測。
 */
export function stratify(conditions = []) {
  const reasons = [];
  const ascvd = hasDx(conditions, "ascvd");
  const dm = hasDx(conditions, "diabetes");
  const ckd = hasDx(conditions, "ckd");
  const fh = hasDx(conditions, "fh");
  const htn = hasDx(conditions, "hypertension");
  const lipid = hasDx(conditions, "hyperlipidemia");

  let level;
  if (ascvd) { level = "veryHigh"; reasons.push({ dx: ascvd.text || ascvd.display, why: "確診動脈硬化性心血管疾病 (ASCVD)" }); }
  else if (dm && (ckd || htn)) {
    level = "veryHigh";
    reasons.push({ dx: dm.text || dm.display, why: "糖尿病合併其他標的器官風險" });
    if (ckd) reasons.push({ dx: ckd.text || ckd.display, why: "慢性腎臟病" });
    if (htn) reasons.push({ dx: htn.text || htn.display, why: "高血壓" });
  }
  else if (dm) { level = "high"; reasons.push({ dx: dm.text || dm.display, why: "糖尿病" }); }
  else if (ckd) { level = "high"; reasons.push({ dx: ckd.text || ckd.display, why: "慢性腎臟病" }); }
  else if (fh) { level = "high"; reasons.push({ dx: fh.text || fh.display, why: "家族性高膽固醇血症" }); }
  else if (htn && lipid) {
    level = "moderate";
    reasons.push({ dx: htn.text || htn.display, why: "高血壓" });
    reasons.push({ dx: lipid.text || lipid.display, why: "血脂異常" });
  }
  else if (htn || lipid) {
    level = "moderate";
    const d = htn || lipid;
    reasons.push({ dx: d.text || d.display, why: "單一心血管危險因子" });
  }
  else { level = "low"; }

  return {
    level,
    ...LDL_TARGETS[level],
    reasons,
    // 沒有任何編碼診斷時，分層不可靠 — 明確告知而非給出假的低風險結論
    insufficient: conditions.length === 0,
  };
}

/**
 * 血脂評估：現值 vs 目標。
 * labs 為 { ldl, hdl, tc, tg, hba1c } 的最新值物件（可為 null）。
 */
export function assess({ conditions = [], labs = {} } = {}) {
  const risk = stratify(conditions);
  const ldl = labs.ldl?.value ?? null;

  let status = "unknown", gap = null, pct = null;
  if (ldl != null) {
    gap = Math.round((ldl - risk.max) * 10) / 10;
    pct = Math.round((ldl / risk.max) * 100);
    status = ldl <= risk.max ? "atGoal" : "aboveGoal";
  }

  return {
    risk,
    ldl,
    target: risk.max,
    status,          // atGoal | aboveGoal | unknown
    gap,             // 高於目標多少 mg/dL（負值代表已達標）
    pctOfTarget: pct,
    labs,
    guideline: {
      name: "2022 台灣高血壓、高血脂及糖尿病治療指引 · 2019 ESC/EAS Dyslipidaemias",
      esc: "https://doi.org/10.1093/eurheartj/ehz455",
      targets: LDL_TARGETS,
    },
    nhi: NHI_LIPID_RULE,
    disclaimer: "本結果為指引門檻對照，僅供臨床參考，不構成治療建議；用藥決策由醫師依個別狀況判斷。",
  };
}
