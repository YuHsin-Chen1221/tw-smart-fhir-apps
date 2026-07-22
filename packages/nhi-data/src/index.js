// 健保藥品資料查詢層：由官方「健保用藥品項查詢項目檔」建立的索引提供
// 成分辨識、ATC 分類、支付價與給付規定章節。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = JSON.parse(readFileSync(join(HERE, "..", "data", "nhi-index.json"), "utf8"));

export const NHI_SOURCE = INDEX.source;

/** 依成分關鍵字長度倒序，避免 "insulin" 蓋過 "insulin glargine" */
const INGREDIENTS = Object.keys(INDEX.ingredients).sort((a, b) => b.length - a.length);

/**
 * 由藥品文字（品名或成分）辨識健保成分。
 * thas 的 MedicationRequest display 是台灣品牌名（Bokey / Plavix / Cozaar…），
 * 因此除了學名，也比對常見品牌名。
 */
const BRAND_TO_INGREDIENT = {
  bokey: "aspirin", 伯基: "aspirin",
  plavix: "clopidogrel", 保栓通: "clopidogrel",
  cozaar: "losartan", 可悅您: "losartan",
  januvia: "sitagliptin", 佳糖維: "sitagliptin",
  lantus: "insulin glargine", 蘭德仕: "insulin glargine",
  lipitor: "atorvastatin", 立普妥: "atorvastatin",
  crestor: "rosuvastatin", 冠脂妥: "rosuvastatin",
  norvasc: "amlodipine", 脈優: "amlodipine",
  glucophage: "metformin", 庫魯化: "metformin",
  zestril: "lisinopril", 捷賜瑞: "lisinopril",
  coumadin: "warfarin", 可邁丁: "warfarin",
  xarelto: "rivaroxaban", 拜瑞妥: "rivaroxaban",
  eliquis: "apixaban", 艾必克凝: "apixaban",
  pradaxa: "dabigatran", 普栓達: "dabigatran",
  brilinta: "ticagrelor", 百無凝: "ticagrelor",
  jardiance: "empagliflozin", 恩排糖: "empagliflozin",
  forxiga: "dapagliflozin", 福適佳: "dapagliflozin",
  nexium: "esomeprazole", 耐適恩: "esomeprazole",
  repatha: "evolocumab", 瑞百安: "evolocumab",
  praluent: "alirocumab", 保脂靈: "alirocumab",
};

/** 從任意藥品文字辨識成分名；找不到回 null */
export function identifyIngredient(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  for (const [brand, ing] of Object.entries(BRAND_TO_INGREDIENT)) {
    if (t.includes(brand)) return ing;
  }
  return INGREDIENTS.find((k) => t.includes(k)) || null;
}

/** 取得成分的健保資料（類別、ATC、中位支付價、給付章節、代表品項） */
export function lookupIngredient(ingredient) {
  if (!ingredient) return null;
  const rec = INDEX.ingredients[ingredient];
  return rec ? { ingredient, ...rec } : null;
}

/** 由文字擷取劑量數值（mg / mcg / IU），用於挑選最相符的健保品項 */
function doseOf(text) {
  const m = String(text || "").match(/(\d+(?:\.\d+)?)\s*(mg|mcg|iu|u)\b/i);
  return m ? parseFloat(m[1]) : null;
}
/** 劑型辨識：由處方文字或品項描述判斷給藥途徑 */
const FORM_PATTERNS = {
  injection: /注射|針劑|inject|vial|ampoule|ampul|\biv\b|\bim\b|\bsc\b/i,
  inhalation: /吸入|噴|inhal|nebul|puff/i,
  topical:    /外用|軟膏|乳膏|貼片|topical|cream|ointment|patch|gel\b/i,
  suppository:/栓劑|塞劑|supposit/i,
  syrup:      /糖漿|口服液|懸液|syrup|solution|suspension|elixir/i,
  oral:       /膜衣錠|糖衣錠|錠|膠囊|tablet|capsule|\bf\.c\b/i,
};
/** 回傳處方文字所屬劑型；判斷不出來時預設口服（門診處方最常見） */
function formOf(text, { fallback = "oral" } = {}) {
  const t = String(text || "");
  for (const [k, re] of Object.entries(FORM_PATTERNS)) if (re.test(t)) return k;
  return fallback;
}

/**
 * 從該成分的品項中挑最能代表處方的一筆：
 * 劑型相符 > 劑量相符 > 第一筆。
 * 劑型優先於劑量，因為「Ibuprofen injection 400mg」若挑到口服錠劑，
 * 申報的品項就完全錯了（給藥途徑不同、支付價也不同）。
 */
function pickItem(items, text) {
  if (!items?.length) return null;
  const wantDose = doseOf(text);
  const wantForm = formOf(text, { fallback: null });
  const scored = items.map((it) => {
    const desc = `${it.form || ""} ${it.zh || ""} ${it.en || ""}`;
    const itForm = formOf(desc);
    const d = doseOf(it.en) ?? doseOf(it.zh) ?? doseOf(it.ingredient);
    let s = 0;
    if (wantForm && itForm === wantForm) s += 20;          // 劑型相符最重要
    else if (!wantForm && itForm === "oral") s += 5;        // 處方沒寫劑型 → 偏好口服
    else if (wantForm && itForm !== wantForm) s -= 10;      // 劑型不符扣分
    if (wantDose != null && d != null && Math.abs(d - wantDose) < 0.01) s += 10;
    return { it, s, itForm, doseMatch: wantDose != null && d != null && Math.abs(d - wantDose) < 0.01 };
  });
  scored.sort((a, b) => b.s - a.s);
  const best = scored[0];
  return {
    item: best.it,
    // 索引每成分僅保留代表性品項，若處方劑型（如注射劑）不在其中，
    // 必須明示不符，不可默默以口服品項充數。
    formMatch: !wantForm || best.itForm === wantForm,
    wantForm,
    pickedForm: best.itForm,
    doseMatch: best.doseMatch,
  };
}

/**
 * 一站式：由藥品文字取得健保資訊。
 * 回傳 { ingredient, class, atc, price, chapter, chapterUrl, example } 或 null。
 * price 為該成分現行有效單方品項的中位支付價（點）；
 * example 是依劑量與劑型挑出的代表品項（含健保藥品代號與中文品名）。
 */
export function lookupDrug(text) {
  const ing = identifyIngredient(text);
  const rec = lookupIngredient(ing);
  if (!rec) return null;
  const picked = pickItem(rec.items, text);
  const item = picked?.item;
  return {
    ingredient: ing,
    class: rec.class,
    atc: rec.atc,
    price: rec.medianPrice,
    chapter: rec.chapter || null,
    chapterUrl: rec.chapterUrl || null,
    itemCount: rec.count,
    example: item && { code: item.code, zh: item.zh, en: item.en, price: item.price },
    // 品項比對品質 — 申報端必須據此決定是否可直接送出
    match: picked && {
      form: picked.formMatch,      // 劑型是否相符
      dose: picked.doseMatch,      // 劑量是否相符
      wantForm: picked.wantForm,
      pickedForm: picked.pickedForm,
      // 劑型不符時給出明確理由，供 UI 標示「需人工確認」
      note: picked.formMatch ? null
        : `處方為${FORM_ZH[picked.wantForm] || picked.wantForm}，索引代表品項為${FORM_ZH[picked.pickedForm] || picked.pickedForm}，需人工核對健保品項`,
    },
  };
}

const FORM_ZH = {
  oral: "口服", injection: "注射劑", inhalation: "吸入劑",
  topical: "外用", suppository: "栓劑", syrup: "口服液",
};

/** 該成分是否屬於指定藥理類別 */
export function isClass(text, cls) {
  return lookupDrug(text)?.class === cls;
}

/** 索引涵蓋的所有類別 */
export function allClasses() {
  return [...new Set(Object.values(INDEX.ingredients).map((v) => v.class))].sort();
}
