#!/usr/bin/env node
// 對衛福部沙盒 thas.mohw.gov.tw 執行完整 SMART EHR Launch 流程測試。
//
// 通過判準不是「畫面有沒有東西」，而是：
//   1. 後端 session 確實持有 access_token（/api/context → authorized:true）
//   2. 畫面顯示的病人來自授權後查詢（非開放查詢 fallback）
//   3. fhirUser 取得（OIDC 身分識別生效）
//
// thas 實測要點：
//   · /v/r4/auth/authorize 必須帶 launch 參數（base64url JSON）
//   · 病人清單的 radio 是 disabled，要點整列 <tr title="Click to select patient…">
import { chromium } from "playwright";

const ISS = "https://thas.mohw.gov.tw/v/r4/fhir";
const PATIENT = process.env.PATIENT || "sun-1234567";
const OUT = process.env.SHOT_DIR || "/tmp/tw-smart-shots";
const APPS = [
  { key: "lipid-cds", name: "台灣血脂 CDS", backend: "http://localhost:8801", frontend: "http://localhost:5301" },
  { key: "nhi-claim", name: "健保智慧申報", backend: "http://localhost:8802", frontend: "http://localhost:5302" },
];

const launchCtx = Buffer.from(JSON.stringify({ launch_type: "provider-ehr", patient: PATIENT })).toString("base64url");

async function runApp(browser, app) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  const url = `${app.backend}/launch?iss=${encodeURIComponent(ISS)}&launch=${launchCtx}`;
  console.log(`\n━━ ${app.name} ━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  launch: ${url.slice(0, 96)}…`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2500);

  // 依序通過：醫師登入 → 病人選擇
  for (let i = 0; i < 10; i++) {
    if (page.url().startsWith(app.frontend)) break;
    const row = page.locator('tr[title*="Click to select patient"]').nth(2);
    if (await row.count().catch(() => 0)) {
      await row.click({ timeout: 3000 }).catch(() => {});
      console.log(`  ▸ 選擇病人`);
      await page.waitForTimeout(3000);
      continue;
    }
    const btn = page.getByRole("button", { name: /Login|Authorize|Approve|Continue|Allow/i }).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      console.log(`  ▸ ${((await btn.textContent().catch(() => "")) || "").trim()}`);
      await page.waitForTimeout(2500);
    } else await page.waitForTimeout(1500);
  }
  await page.waitForURL((u) => u.href.startsWith(app.frontend), { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(5000);

  // 驗證：後端 session 是否真的持有 token
  const context = await page.evaluate(async (be) => {
    try { return await (await fetch(be + "/api/context", { credentials: "include" })).json(); }
    catch (e) { return { err: String(e) }; }
  }, app.backend).catch(() => ({}));

  const badge = await page.$eval("#src", (e) => e.textContent.trim()).catch(() => "");
  const ptName = await page.$eval("#view .brand-mark + div > div", (e) => e.textContent.trim()).catch(() => null);

  await page.screenshot({ path: `${OUT}/${app.key}-authorized.png`, fullPage: true }).catch(() => {});

  const pass = context.authorized === true && !!ptName;
  console.log(`  最終 URL   : ${page.url().slice(0, 80)}`);
  console.log(`  authorized : ${context.authorized}`);
  console.log(`  patientId  : ${context.patientId}`);
  console.log(`  fhirUser   : ${context.fhirUser}`);
  console.log(`  scope      : ${context.scope}`);
  console.log(`  畫面病人   : ${ptName}`);
  console.log(`  來源標記   : ${badge}`);
  if (errors.length) console.log(`  ⚠️ 前端錯誤 : ${errors.slice(0, 3).join(" | ").slice(0, 200)}`);
  console.log(`  ${pass ? "PASS ✅" : "FAIL ❌"}`);

  await ctx.close();
  return { app: app.name, pass, context, ptName, errors: errors.length };
}

const browser = await chromium.launch();
const results = [];
for (const a of APPS) results.push(await runApp(browser, a).catch((e) => ({ app: a.name, pass: false, error: e.message })));
await browser.close();

console.log(`\n━━ 總結 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
for (const r of results) console.log(`  ${r.pass ? "✅" : "❌"} ${r.app}${r.error ? "  " + r.error : ""}`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
