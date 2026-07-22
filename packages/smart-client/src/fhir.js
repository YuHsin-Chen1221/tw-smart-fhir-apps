// FHIR R4 讀取與正規化 — 依衛福部 thas.mohw.gov.tw 實際資料特性設計。
//
// thas 資料實況（2026-07-21 實測）：
//   · Condition 只有 SNOMED CT，沒有 ICD-10  → 比對走 SNOMED code + display text
//   · Observation 用 LOINC，但 LDL 是 2089-1（非國際常見的 18262-6）→ 需別名表
//   · MedicationRequest 用 http://rxnorm.info，display 是台灣品牌名
//   · Patient 有中文 name.text（陳大明）與身分證 identifier

/** 檢驗項目的 LOINC 別名。thas 與國際 sandbox 用碼不同，兩者都要認。 */
export const LOINC = {
  ldl:  ["2089-1", "18262-6", "13457-7"],          // LDL-C（thas 用 2089-1）
  hdl:  ["2085-9"],
  tc:   ["2093-3"],
  tg:   ["2571-8"],
  hba1c:["4548-4", "17856-6"],
  glucoseAC: ["1558-6", "2339-0"],
  sbp:  ["8480-6"],
  dbp:  ["8462-4"],
  bp:   ["55284-4", "85354-9"],                    // 血壓面板（值在 component）
  creatinine: ["2160-0", "38483-4"],
  egfr: ["48642-3", "33914-3", "62238-1"],
  potassium: ["6298-4", "2823-3"],
  inr:  ["6301-6", "34714-6"],
  weight: ["29463-7"], height: ["8302-2"], bmi: ["39156-5"],
};

/** 檢驗項目的中文名 */
export const LAB_ZH = {
  ldl: "低密度膽固醇 LDL-C", hdl: "高密度膽固醇 HDL-C", tc: "總膽固醇", tg: "三酸甘油酯",
  hba1c: "糖化血色素 HbA1c", glucoseAC: "空腹血糖", sbp: "收縮壓", dbp: "舒張壓",
  creatinine: "肌酸酐", egfr: "腎絲球過濾率 eGFR", potassium: "血鉀", inr: "凝血酶原時間 INR",
  weight: "體重", height: "身高", bmi: "身體質量指數 BMI",
};

const round1 = (v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v);

/** 建立帶 token 的 FHIR 讀取器 */
export function fhirClient({ base, token }) {
  const root = base.replace(/\/+$/, "");
  async function get(path, params) {
    const url = new URL(root + path);
    for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, v);
    const r = await fetch(url, {
      headers: {
        accept: "application/fhir+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!r.ok) throw new Error(`FHIR ${path} 回應 ${r.status}`);
    return r.json();
  }
  const entries = (bundle) => (bundle?.entry || []).map((e) => e.resource).filter(Boolean);
  return { get, entries, base: root };
}

/** Patient → 中文優先的病人基本資料 */
export function normalizePatient(p) {
  if (!p) return null;
  const n = (p.name || [])[0] || {};
  const zhName = n.text && /[一-鿿]/.test(n.text) ? n.text : null;
  const enName = [n.given?.join(" "), n.family].filter(Boolean).join(" ").trim();
  const idOf = (re) => (p.identifier || []).find((i) => re.test(i.system || ""))?.value;
  const age = p.birthDate
    ? Math.floor((Date.now() - new Date(p.birthDate)) / 31557600000)
    : null;
  return {
    id: p.id,
    name: zhName || enName || p.id,
    nameEn: enName || null,
    gender: { male: "男", female: "女", other: "其他", unknown: "不明" }[p.gender] || p.gender || "—",
    birthDate: p.birthDate || null,
    age,
    // 台灣：身分證字號（內政部/外交部 system）、病歷號 MR
    nationalId: idOf(/moi\.gov\.tw|boca\.gov\.tw/i) || null,
    mrn: (p.identifier || []).find((i) => i.type?.coding?.some((c) => c.code === "MR"))?.value || null,
  };
}

/** Condition → 診斷（thas 只有 SNOMED，保留原始 system 與 display） */
export function normalizeCondition(c) {
  const cc = c.code || {};
  const cod = (cc.coding || [])[0] || {};
  return {
    id: c.id,
    system: cod.system || null,
    code: cod.code || null,
    display: cod.display || cc.text || "",
    text: cc.text || cod.display || "",
    onset: c.onsetDateTime || c.recordedDate || null,
    status: c.clinicalStatus?.coding?.[0]?.code || null,
  };
}

/** MedicationRequest → 處方（保留原始編碼供申報轉換） */
export function normalizeMedication(m) {
  const mc = m.medicationCodeableConcept || {};
  const cod = (mc.coding || [])[0] || {};
  return {
    id: m.id,
    name: mc.text || cod.display || "",
    system: cod.system || null,
    code: cod.code || null,
    status: m.status || null,
    authoredOn: m.authoredOn || null,
    dosage: m.dosageInstruction?.[0]?.text || null,
    quantity: m.dispenseRequest?.quantity?.value ?? null,
    daysSupply: m.dispenseRequest?.expectedSupplyDuration?.value ?? null,
  };
}

/** 由 Observation 陣列取某檢驗項目的時間序列（新到舊） */
export function labSeries(observations, key) {
  const codes = new Set(LOINC[key] || []);
  const out = [];
  for (const o of observations) {
    const hit = (o.code?.coding || []).some((c) => codes.has(c.code));
    if (!hit) continue;
    const when = o.effectiveDateTime || o.issued || null;
    if (o.valueQuantity) {
      out.push({ when, value: round1(o.valueQuantity.value), unit: o.valueQuantity.unit || "" });
    } else if (o.component?.length) {
      // 血壓面板：由 component 取 SBP/DBP
      for (const comp of o.component) {
        const cc = (comp.code?.coding || [])[0]?.code;
        if (codes.has(cc) && comp.valueQuantity) {
          out.push({ when, value: round1(comp.valueQuantity.value), unit: comp.valueQuantity.unit || "" });
        }
      }
    }
  }
  return out.sort((a, b) => new Date(b.when || 0) - new Date(a.when || 0));
}

/** 取最新一筆檢驗值 */
export function latestLab(observations, key) {
  return labSeries(observations, key)[0] || null;
}

/** 血壓：SBP 在 8480-6，也可能藏在 55284-4 面板的 component 內 */
export function latestBP(observations) {
  const sbp = latestLab(observations, "sbp");
  const dbp = latestLab(observations, "dbp");
  return sbp || dbp ? { sbp: sbp?.value ?? null, dbp: dbp?.value ?? null, when: sbp?.when || dbp?.when } : null;
}

/** 依 authoredOn 去重（同一藥品只留最新一筆處方） */
export function dedupeMeds(meds) {
  const seen = new Map();
  for (const m of [...meds].sort((a, b) => new Date(b.authoredOn || 0) - new Date(a.authoredOn || 0))) {
    const key = (m.code || m.name || "").toLowerCase().trim();
    if (key && !seen.has(key)) seen.set(key, m);
  }
  return [...seen.values()];
}

/** 一次抓齊一位病人的臨床資料 */
export async function fetchPatientBundle(client, patientId) {
  const [pt, cond, obs, meds] = await Promise.all([
    client.get(`/Patient/${patientId}`),
    client.get("/Condition", { patient: patientId, _count: 100 }).catch(() => ({})),
    client.get("/Observation", { patient: patientId, _count: 200, _sort: "-date" }).catch(() => ({})),
    client.get("/MedicationRequest", { patient: patientId, _count: 100 }).catch(() => ({})),
  ]);
  return {
    patient: normalizePatient(pt),
    conditions: client.entries(cond).map(normalizeCondition),
    observations: client.entries(obs),
    medications: dedupeMeds(client.entries(meds).map(normalizeMedication)),
  };
}
