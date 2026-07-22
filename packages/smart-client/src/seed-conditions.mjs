#!/usr/bin/env node
// 為衛福部沙盒（thas.mohw.gov.tw）的示範病人補齊診斷資源。
//
// 依據：官方《1014_SMART測試環境與上架流程》第 58 頁明示
//   「預設測試資料集…執行團隊無法保證其資料完整性，啟動測試前，
//     先使用 API 測試工具匯入符合 APP 使用情境之測試資料。」
//
// 三筆診斷均與該病人「既有的檢驗值與處方」一致，非虛構：
//   第2型糖尿病  ← HbA1c 7.7% / 飯前血糖 195.3 / Metformin+Januvia+Insulin Glargine
//   高血壓       ← 收縮壓 148.4 / Cozaar+Amlodipine+Lisinopril
//   高血脂       ← LDL-C 158.8 / Atorvastatin
//
// 所有資源標 meta.tag = tw-smart-apps-seed，便於日後辨識與清除。

const BASE = process.env.FHIR_BASE || "https://thas.mohw.gov.tw/v/r4/fhir";
const PATIENT = process.env.PATIENT_ID || "sun-1234567";
const DRY = process.argv.includes("--dry-run");

const SEED_TAG = {
  system: "https://vtr.tw/fhir/tags",
  code: "tw-smart-apps-seed",
  display: "TW SMART Apps 提案測試資料",
};

const CONDITIONS = [
  {
    id: `${PATIENT}-dx-dm2`,
    snomed: "44054006",
    display: "Diabetes mellitus type 2 (disorder)",
    zh: "第2型糖尿病",
    onset: "2021-06-15",
    basis: "HbA1c 7.7% · 飯前血糖 195.3 mg/dL · Metformin/Januvia/Insulin Glargine",
  },
  {
    id: `${PATIENT}-dx-htn`,
    snomed: "38341003",
    display: "Hypertensive disorder, systemic arterial (disorder)",
    zh: "高血壓",
    onset: "2020-03-10",
    basis: "收縮壓 148.4 mmHg · Cozaar/Amlodipine/Lisinopril",
  },
  {
    id: `${PATIENT}-dx-lipid`,
    snomed: "55822004",
    display: "Hyperlipidemia (disorder)",
    zh: "高血脂",
    onset: "2021-01-08",
    basis: "LDL-C 158.8 mg/dL · Atorvastatin",
  },
];

const build = (c) => ({
  resourceType: "Condition",
  id: c.id,
  meta: { tag: [SEED_TAG] },
  clinicalStatus: {
    coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active", display: "Active" }],
  },
  verificationStatus: {
    coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed", display: "Confirmed" }],
  },
  category: [{
    coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "problem-list-item", display: "Problem List Item" }],
  }],
  code: {
    coding: [{ system: "http://snomed.info/sct", code: c.snomed, display: c.display }],
    text: c.zh,
  },
  subject: { reference: `Patient/${PATIENT}` },
  onsetDateTime: c.onset,
  recordedDate: c.onset,
  note: [{ text: `依據：${c.basis}（TW SMART Apps 提案測試資料）` }],
});

async function main() {
  console.log(`目標 FHIR Server : ${BASE}`);
  console.log(`病人             : Patient/${PATIENT}`);
  console.log(`模式             : ${DRY ? "DRY-RUN（不寫入）" : "實際寫入 (PUT upsert)"}\n`);

  // 先確認病人存在
  const p = await fetch(`${BASE}/Patient/${PATIENT}`, { headers: { accept: "application/fhir+json" } });
  if (!p.ok) { console.error(`✗ 找不到病人（HTTP ${p.status}），中止`); process.exit(1); }
  const pj = await p.json();
  console.log(`✓ 病人確認：${pj.name?.[0]?.text || pj.id}\n`);

  for (const c of CONDITIONS) {
    const body = build(c);
    if (DRY) {
      console.log(`[DRY] ${c.zh} (SNOMED ${c.snomed}) → Condition/${c.id}`);
      continue;
    }
    // PUT = upsert，重複執行不會產生重複資源
    const r = await fetch(`${BASE}/Condition/${c.id}`, {
      method: "PUT",
      headers: { "content-type": "application/fhir+json", accept: "application/fhir+json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) console.log(`✓ ${c.zh.padEnd(8)} SNOMED ${c.snomed}  →  Condition/${j.id} (HTTP ${r.status})`);
    else console.log(`✗ ${c.zh.padEnd(8)} HTTP ${r.status}  ${JSON.stringify(j).slice(0, 200)}`);
  }

  // 驗證
  const v = await fetch(`${BASE}/Condition?patient=${PATIENT}&_count=20`, { headers: { accept: "application/fhir+json" } });
  const vj = await v.json();
  console.log(`\n=== 驗證：Patient/${PATIENT} 現有診斷 ${vj.total ?? (vj.entry || []).length} 筆 ===`);
  for (const e of vj.entry || []) {
    const cc = e.resource.code || {};
    console.log(`  ${(cc.text || "").padEnd(12)} ${cc.coding?.[0]?.code}  ${cc.coding?.[0]?.display}`);
  }
}
main().catch((e) => { console.error("錯誤：", e.message); process.exit(1); });
