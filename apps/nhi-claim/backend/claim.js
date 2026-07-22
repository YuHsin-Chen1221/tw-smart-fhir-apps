// 健保智慧申報 — 臨床資料 → FHIR Claim 格式轉換
//
// 核心價值：把 EHR 的處方（RxNorm／院內品名）轉成健保申報所需的
// 「健保藥品代號 + 支付價 + ATC」，並產出符合 FHIR R4 的 Claim 資源。
//
// 資料依據：
//  · 中央健康保險署「健保用藥品項查詢項目檔」（政府資料開放平臺 dataset 23715，月更新）
//  · HL7 FHIR R4 Claim  http://hl7.org/fhir/R4/claim.html
//
// 明確界線：本模組只做「格式轉換與點數試算」，不做給付核准判定。
// 是否給付、核付多少，以健保署實際審查為準。

import { lookupDrug, NHI_SOURCE } from "@tw-smart/nhi-data";

/** 健保藥品代號的 CodeSystem（依 TW Core / NHI 慣用命名） */
export const NHI_DRUG_SYSTEM = "https://nhicore.nhi.gov.tw/CodeSystem/nhi-drug-code";

/** 轉換單筆處方 → 申報品項 */
export function convertMedication(med, { days = 28 } = {}) {
  const nhi = lookupDrug(med.name);
  const qty = med.quantity ?? days;          // 未載數量時以療程天數估算
  const unitPrice = nhi?.example?.price ?? null;
  const net = unitPrice != null ? Math.round(unitPrice * qty * 100) / 100 : null;

  // 比對品質：決定此筆是否可直接送出
  let quality = "unmapped";
  if (nhi) {
    if (nhi.match?.form && nhi.match?.dose) quality = "exact";
    else if (nhi.match?.form) quality = "doseUnverified";
    else quality = "formMismatch";
  }

  return {
    source: {
      name: med.name,
      system: med.system,            // 原始編碼（thas 為 http://rxnorm.info）
      code: med.code,
      authoredOn: med.authoredOn,
      dosage: med.dosage,
    },
    nhi: nhi && {
      code: nhi.example.code,        // 健保藥品代號
      name: nhi.example.zh,          // 健保中文品名
      nameEn: nhi.example.en,
      atc: nhi.atc,
      ingredient: nhi.ingredient,
      class: nhi.class,
      unitPrice,
      chapter: nhi.chapter,
      chapterUrl: nhi.chapterUrl,
    },
    quantity: qty,
    net,
    quality,                          // exact | doseUnverified | formMismatch | unmapped
    note: nhi?.match?.note || (nhi ? null : "此成分未收錄於本索引，需人工對應健保藥品代號"),
  };
}

/** 產出 FHIR R4 Claim 資源 */
export function buildClaim({ patient, conditions = [], items, providerRef = "Organization/tw-demo-hospital" }) {
  const priced = items.filter((i) => i.net != null);
  const total = Math.round(priced.reduce((s, i) => s + i.net, 0) * 100) / 100;

  return {
    resourceType: "Claim",
    meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Claim"] },
    status: "draft",
    type: {
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/claim-type", code: "pharmacy", display: "Pharmacy" }],
    },
    use: "claim",
    patient: { reference: `Patient/${patient.id}`, display: patient.name },
    created: new Date().toISOString(),
    provider: { reference: providerRef },
    priority: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/processpriority", code: "normal" }] },
    insurance: [{
      sequence: 1, focal: true,
      coverage: { display: "全民健康保險" },
    }],
    // 診斷：沿用來源編碼（thas 為 SNOMED CT）
    diagnosis: conditions.map((c, i) => ({
      sequence: i + 1,
      diagnosisCodeableConcept: {
        coding: c.code ? [{ system: c.system, code: c.code, display: c.display }] : [],
        text: c.text || c.display,
      },
    })),
    item: items.map((it, i) => ({
      sequence: i + 1,
      productOrService: {
        coding: [
          ...(it.nhi ? [{ system: NHI_DRUG_SYSTEM, code: it.nhi.code, display: it.nhi.name }] : []),
          ...(it.source.code ? [{ system: it.source.system, code: it.source.code, display: it.source.name }] : []),
        ],
        text: it.nhi?.name || it.source.name,
      },
      quantity: { value: it.quantity },
      ...(it.nhi?.unitPrice != null ? { unitPrice: { value: it.nhi.unitPrice, currency: "TWD" } } : {}),
      ...(it.net != null ? { net: { value: it.net, currency: "TWD" } } : {}),
      // 未能定價者以 extension 標示原因，不靜默略過
      ...(it.net == null ? {
        extension: [{
          url: "https://vtr.tw/fhir/StructureDefinition/nhi-mapping-note",
          valueString: it.note || "未能對應健保藥品代號",
        }],
      } : {}),
    })),
    total: { value: total, currency: "TWD" },
  };
}

/** 申報摘要（供 UI 呈現） */
export function summarize(items) {
  const by = (q) => items.filter((i) => i.quality === q).length;
  const priced = items.filter((i) => i.net != null);
  const total = Math.round(priced.reduce((s, i) => s + i.net, 0) * 100) / 100;

  // 依藥理類別彙總點數
  const byClass = {};
  for (const i of priced) {
    const k = i.nhi?.class || "其他";
    byClass[k] = Math.round(((byClass[k] || 0) + i.net) * 100) / 100;
  }

  return {
    itemCount: items.length,
    pricedCount: priced.length,
    unmappedCount: by("unmapped"),
    totalPoints: total,
    quality: {
      exact: by("exact"),
      doseUnverified: by("doseUnverified"),
      formMismatch: by("formMismatch"),
      unmapped: by("unmapped"),
    },
    // 可直接送出的比例 —— 誠實呈現需人工介入的部分
    readyRatio: items.length ? Math.round((by("exact") / items.length) * 100) : 0,
    byClass: Object.entries(byClass).sort((a, b) => b[1] - a[1]),
    source: NHI_SOURCE,
    disclaimer: "點數為依健保署公告支付價之試算，非實際核付金額；實際給付以健保署審查結果為準。",
  };
}
