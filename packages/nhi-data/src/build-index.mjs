#!/usr/bin/env node
// 由健保署「健保用藥品項查詢項目檔」建立精簡索引。
// 來源：政府資料開放平臺 dataset 23715（月更新，政府資料開放授權條款）
//       https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-E41001-001
//
// 原始檔 224,455 筆 / 96MB → 依「成分關鍵字」抽出臨床常用品項，
// 產出 nhi-index.json 供兩個 App 共用（藥品代號、中文名、支付價、ATC、給付章節）。
import { createReadStream } from "node:fs";
import { writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "data", "nhi_drug_full.csv");
const OUT = join(HERE, "..", "data", "nhi-index.json");

// 我們規則庫涵蓋的成分（小寫比對 `成分` 欄）。key = 正規化學名。
const INGREDIENTS = {
  // 降血脂
  atorvastatin: "statin", rosuvastatin: "statin", simvastatin: "statin",
  pravastatin: "statin", fluvastatin: "statin", pitavastatin: "statin", lovastatin: "statin",
  ezetimibe: "ezetimibe", fenofibrate: "fibrate", gemfibrozil: "fibrate",
  evolocumab: "pcsk9", alirocumab: "pcsk9",
  // 降血壓 / 心血管
  lisinopril: "acei", enalapril: "acei", captopril: "acei", ramipril: "acei", perindopril: "acei",
  losartan: "arb", valsartan: "arb", irbesartan: "arb", candesartan: "arb", telmisartan: "arb", olmesartan: "arb",
  amlodipine: "ccb", felodipine: "ccb", nifedipine: "ccb", diltiazem: "ccb", verapamil: "ccb",
  hydrochlorothiazide: "thiazide", indapamide: "thiazide", chlorthalidone: "thiazide",
  bisoprolol: "beta_blocker", metoprolol: "beta_blocker", carvedilol: "beta_blocker", propranolol: "beta_blocker",
  furosemide: "loop_diuretic", spironolactone: "mra",
  // 糖尿病
  metformin: "biguanide",
  sitagliptin: "dpp4", linagliptin: "dpp4", saxagliptin: "dpp4", vildagliptin: "dpp4",
  empagliflozin: "sglt2", dapagliflozin: "sglt2", canagliflozin: "sglt2",
  glimepiride: "sulfonylurea", gliclazide: "sulfonylurea", glipizide: "sulfonylurea", glibenclamide: "sulfonylurea",
  liraglutide: "glp1", dulaglutide: "glp1", semaglutide: "glp1",
  "insulin glargine": "insulin", "insulin aspart": "insulin", "insulin detemir": "insulin",
  "insulin degludec": "insulin", "insulin lispro": "insulin", "insulin human": "insulin",
  // 抗凝 / 抗血小板
  warfarin: "anticoagulant", rivaroxaban: "anticoagulant", apixaban: "anticoagulant",
  dabigatran: "anticoagulant", edoxaban: "anticoagulant",
  clopidogrel: "antiplatelet", ticagrelor: "antiplatelet", prasugrel: "antiplatelet",
  aspirin: "antiplatelet", "acetylsalicylic": "antiplatelet",
  // 腸胃 / 止痛
  omeprazole: "ppi", esomeprazole: "ppi", pantoprazole: "ppi", lansoprazole: "ppi", rabeprazole: "ppi",
  ibuprofen: "nsaid", naproxen: "nsaid", diclofenac: "nsaid", celecoxib: "nsaid", meloxicam: "nsaid",
  morphine: "opioid", fentanyl: "opioid", oxycodone: "opioid", tramadol: "opioid", codeine: "opioid",
  acetaminophen: "analgesic", paracetamol: "analgesic",
  // 精神科 / 神經
  escitalopram: "ssri", sertraline: "ssri", fluoxetine: "ssri", paroxetine: "ssri", citalopram: "ssri",
  venlafaxine: "snri", duloxetine: "snri", mirtazapine: "antidepressant_other", bupropion: "antidepressant_other",
  risperidone: "antipsychotic", olanzapine: "antipsychotic", quetiapine: "antipsychotic",
  aripiprazole: "antipsychotic", haloperidol: "antipsychotic", paliperidone: "antipsychotic",
  diazepam: "benzodiazepine", lorazepam: "benzodiazepine", alprazolam: "benzodiazepine",
  clonazepam: "benzodiazepine", estazolam: "benzodiazepine",
  zolpidem: "z_hypnotic", zopiclone: "z_hypnotic", zaleplon: "z_hypnotic",
  lithium: "mood_stabilizer", valproate: "anticonvulsant", "valproic": "anticonvulsant",
  lamotrigine: "anticonvulsant", levetiracetam: "anticonvulsant", carbamazepine: "anticonvulsant",
  phenytoin: "anticonvulsant", gabapentin: "anticonvulsant", pregabalin: "anticonvulsant",
  donepezil: "dementia", memantine: "dementia", rivastigmine: "dementia",
  // 常見抗生素
  amoxicillin: "penicillin", ampicillin: "penicillin",
  cephalexin: "cephalosporin", cefuroxime: "cephalosporin", ceftriaxone: "cephalosporin",
  azithromycin: "macrolide", clarithromycin: "macrolide", erythromycin: "macrolide",
  levofloxacin: "quinolone", ciprofloxacin: "quinolone", moxifloxacin: "quinolone",
  doxycycline: "tetracycline", vancomycin: "glycopeptide", clindamycin: "lincosamide",
  // 呼吸道
  salbutamol: "saba", albuterol: "saba", formoterol: "laba", salmeterol: "laba",
  budesonide: "ics", fluticasone: "ics", tiotropium: "lama", montelukast: "ltra",
  // 其他常見
  allopurinol: "gout", febuxostat: "gout", colchicine: "gout",
  levothyroxine: "thyroid", methimazole: "antithyroid",
  alendronate: "bisphosphonate", denosumab: "bone_other",
  tamsulosin: "alpha_blocker", finasteride: "5ari", sildenafil: "pde5",
  loratadine: "antihistamine", cetirizine: "antihistamine", fexofenadine: "antihistamine",
  prednisolone: "corticosteroid", dexamethasone: "corticosteroid", methylprednisolone: "corticosteroid",
};
const KEYS = Object.keys(INGREDIENTS).sort((a, b) => b.length - a.length);

// 極簡 CSV 解析（支援引號內逗號）
function parseLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur); return out;
}

const num = (s) => { const v = parseFloat(String(s).replace(/[^\d.]/g, "")); return Number.isFinite(v) ? v : null; };
// 判定是否為單方（成分欄只有一個 "+" 分隔項）
const isSingle = (ing) => !ing.includes("+");

async function main() {
  const rl = createInterface({ input: createReadStream(SRC, { encoding: "utf8" }), crlfDelay: Infinity });
  let header = null, idx = {}, total = 0;
  const byIngredient = new Map(); // 學名 → 品項陣列

  for await (const raw of rl) {
    const line = raw.replace(/^﻿/, "");
    if (!line.trim()) continue;
    if (!header) {
      header = parseLine(line);
      header.forEach((h, i) => (idx[h.trim()] = i));
      continue;
    }
    total++;
    const f = parseLine(line);
    const g = (name) => (f[idx[name]] ?? "").trim();

    const ing = g("成分").toLowerCase();
    if (!ing) continue;
    const hit = KEYS.find((k) => ing.includes(k));
    if (!hit) continue;

    // 只收現行有效品項（有效迄日為空或未過期）
    const end = g("有效迄日");
    if (end && /^\d{7,8}$/.test(end)) {
      // 民國年 yyyMMdd → 西元
      const y = 1911 + parseInt(end.slice(0, end.length - 4), 10);
      const d = new Date(`${y}-${end.slice(-4, -2)}-${end.slice(-2)}`);
      if (!isNaN(d) && d < new Date()) continue;
    }

    const rec = {
      code: g("藥品代號"),
      en: g("藥品英文名稱"),
      zh: g("藥品中文名稱"),
      ingredient: g("成分"),
      price: num(g("支付價")),
      atc: g("ATC代碼"),
      form: g("劑型"),
      group: g("分類分組名稱"),
      chapter: g("給付規定章節"),
      chapterUrl: g("給付規定章節連結"),
      single: isSingle(ing),
    };
    // 支付價 0 = 已停止給付／不支付品項，排除以免拉低中位數
    if (!rec.code || rec.price === null || rec.price <= 0) continue;
    if (!byIngredient.has(hit)) byIngredient.set(hit, []);
    byIngredient.get(hit).push(rec);
  }

  // 每個學名：單方優先、支付價中位數代表、保留前 20 筆品項
  const out = { source: {
      name: "健保用藥品項查詢項目檔",
      dataset: "https://data.gov.tw/dataset/23715",
      api: "https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-E41001-001",
      licence: "政府資料開放授權條款",
      retrieved: new Date().toISOString().slice(0, 10),
      totalRows: total,
    }, ingredients: {} };

  for (const [ing, list] of byIngredient) {
    const singles = list.filter((r) => r.single);
    const pool = singles.length ? singles : list;
    const prices = pool.map((r) => r.price).sort((a, b) => a - b);
    out.ingredients[ing] = {
      class: INGREDIENTS[ing],
      count: list.length,
      singleCount: singles.length,
      medianPrice: prices[Math.floor(prices.length / 2)] ?? null,
      atc: pool[0]?.atc || list[0]?.atc || "",
      chapter: (pool.find((r) => r.chapter)?.chapter) || "",
      chapterUrl: (pool.find((r) => r.chapterUrl)?.chapterUrl) || "",
      items: pool.slice(0, 20).map(({ single, ...r }) => r),
    };
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 1), "utf8");
  const n = Object.keys(out.ingredients).length;
  console.log(`掃描 ${total} 筆 → 命中 ${n} 種成分`);
  for (const [k, v] of Object.entries(out.ingredients).sort()) {
    console.log(`  ${k.padEnd(22)} ${String(v.class).padEnd(14)} 品項${String(v.count).padStart(4)} 單方${String(v.singleCount).padStart(4)} 中位價 ${String(v.medianPrice).padStart(8)} ATC ${v.atc}`);
  }
  console.log(`\n輸出 → ${OUT}`);
}
main();
