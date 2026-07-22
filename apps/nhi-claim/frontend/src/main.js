import "../../../../packages/ui/theme.css";
import * as echarts from "echarts";

const API = import.meta.env.VITE_API || "http://localhost:8802";
const $ = (s, r = document) => r.querySelector(s);
const api = (p) => fetch(API + p, { credentials: "include" }).then((r) => r.json());
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const nf = (n) => (n == null ? "—" : Number(n).toLocaleString("zh-TW", { maximumFractionDigits: 2 }));

const state = { patientId: null, data: null, days: 28 };
const charts = [];
const disposeCharts = () => charts.splice(0).forEach((c) => c.dispose());

const QUALITY = {
  exact:          { pill: "ok",   label: "相符" },
  doseUnverified: { pill: "warn", label: "劑量待確認" },
  formMismatch:   { pill: "fail", label: "劑型不符" },
  unmapped:       { pill: "",     label: "未對應" },
};

function renderSteps(active, note = "") {
  const steps = ["向 FHIR Server 發出請求", "取得病人／診斷／處方", "比對健保藥品檔（代號・支付價・ATC）", "產出 FHIR Claim"];
  $("#view").innerHTML = `<div class="card" style="max-width:540px;margin:60px auto">
    <div class="card-title">轉換中<span class="meta">SMART ON FHIR</span></div>
    <div class="steps">${steps.map((s, i) => `
      <div class="step ${i < active ? "done" : i === active ? "on" : ""}">
        <span class="n">${i < active ? "✓" : i + 1}</span><span>${s}</span></div>`).join("")}</div>
    ${note ? `<div class="note">${esc(note)}</div>` : ""}</div>`;
}

const renderError = (msg) => {
  $("#view").innerHTML = `<div class="card" style="max-width:560px;margin:60px auto">
    <div class="card-title" style="color:var(--fail)">轉換失敗</div>
    <div style="font-size:14px;color:var(--ink-2)">${esc(msg)}</div>
    <div class="note">本系統不使用離線快取，畫面資料均為即時查詢；請確認 FHIR Server 可連線。</div>
    <button class="btn primary" style="margin-top:14px" onclick="location.reload()">重新載入</button></div>`;
};

function ptHeader(d) {
  const p = d.patient;
  return `<div class="card" style="margin-bottom:16px"><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
    <div class="brand-mark" style="width:44px;height:44px;font-size:18px">${esc((p.name || "?")[0])}</div>
    <div style="flex:1;min-width:180px">
      <div style="font-size:18px;font-weight:640">${esc(p.name)}</div>
      <div class="row-sub">${esc(p.gender)} · ${p.age ?? "?"}歲 · 身分證 ${esc(p.nationalId || "—")} · 病歷號 ${esc(p.mrn || "—")}</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${d.conditions.map((c) => `<span class="pill teal">${esc(c.text || c.display)}</span>`).join("") || `<span class="pill">無編碼診斷</span>`}
    </div></div></div>`;
}

const PAGES = {
  convert: (d) => {
    const s = d.summary;
    return `
    <h1 class="page-title">申報轉換</h1>
    <p class="page-sub">EHR 處方即時對應健保署藥品代號與支付價，產出可送出的申報品項</p>
    ${ptHeader(d)}
    <div class="grid cols-3" style="margin-bottom:16px">
      <div class="card"><div class="stat-label">申報總點數</div>
        <div class="stat-value">${nf(s.totalPoints)}<span class="unit">點</span></div>
        <div class="stat-note">${s.pricedCount} / ${s.itemCount} 項可定價 · 療程 ${state.days} 天</div></div>
      <div class="card"><div class="stat-label">可直接送出比例</div>
        <div class="stat-value" style="color:var(--${s.readyRatio >= 80 ? "ok" : s.readyRatio >= 50 ? "warn" : "fail"})">${s.readyRatio}<span class="unit">%</span></div>
        <div class="stat-note">${s.quality.exact} 項代號與劑量劑型皆相符</div></div>
      <div class="card"><div class="stat-label">需人工介入</div>
        <div class="stat-value">${s.quality.formMismatch + s.quality.doseUnverified + s.quality.unmapped}<span class="unit">項</span></div>
        <div class="stat-note">劑型不符 ${s.quality.formMismatch} · 劑量待確認 ${s.quality.doseUnverified} · 未對應 ${s.quality.unmapped}</div></div>
    </div>
    <div class="grid cols-2" style="margin-bottom:16px">
      <div class="card"><div class="card-title">品項點數分佈<span class="meta">依藥理類別</span></div><div id="c-class" class="chart"></div></div>
      <div class="card"><div class="card-title">對應品質<span class="meta">CONVERSION QUALITY</span></div><div id="c-qual" class="chart"></div></div>
    </div>
    <div class="card">
      <div class="card-title">申報品項明細（${d.items.length} 筆）<span class="meta">健保用藥品項查詢項目檔</span></div>
      <table class="tbl"><thead><tr>
        <th>EHR 處方</th><th>健保藥品代號</th><th>健保品名</th><th>ATC</th>
        <th class="num">支付價</th><th class="num">數量</th><th class="num">小計</th><th>品質</th>
      </tr></thead><tbody>
      ${d.items.map((it) => {
        const q = QUALITY[it.quality];
        return `<tr>
          <td><div class="row-name">${esc(it.source.name)}</div>
              <div class="row-sub">${esc(String(it.source.system || "").replace(/^https?:\/\//, ""))} ${esc(it.source.code || "")}</div></td>
          <td class="mono">${it.nhi ? esc(it.nhi.code) : "—"}</td>
          <td>${it.nhi ? esc(it.nhi.name) : `<span style="color:var(--ink-3)">${esc(it.note || "")}</span>`}
              ${it.nhi?.chapter ? `<div class="row-sub">給付 ${esc(it.nhi.chapter)}</div>` : ""}</td>
          <td class="mono">${it.nhi ? esc(it.nhi.atc) : "—"}</td>
          <td class="num">${nf(it.nhi?.unitPrice)}</td>
          <td class="num">${it.quantity}</td>
          <td class="num"><strong>${nf(it.net)}</strong></td>
          <td><span class="pill ${q.pill}">${q.pill ? '<span class="dot"></span>' : ""}${q.label}</span></td>
        </tr>`;
      }).join("")}
      </tbody></table>
      <div class="note"><strong>${esc(s.disclaimer)}</strong><br />
        支付價取自 ${esc(s.source.name)}（${esc(s.source.retrieved)} 版，每月更新，共 ${nf(s.source.totalRows)} 筆）。
        標示「劑型不符」或「未對應」者不計入總點數，須人工核對後方可送出。</div>
    </div>`;
  },

  claim: (d) => `
    <h1 class="page-title">FHIR Claim 資源</h1>
    <p class="page-sub">符合 HL7 FHIR R4 Claim 規格，藥品同時帶健保藥品代號與原始 EHR 編碼</p>
    ${ptHeader(d)}
    <div class="grid cols-3" style="margin-bottom:16px">
      <div class="card"><div class="stat-label">資源類型</div><div class="stat-value" style="font-size:22px">Claim</div>
        <div class="stat-note">FHIR R4 · use=claim · status=draft</div></div>
      <div class="card"><div class="stat-label">品項數</div><div class="stat-value">${d.claim.item.length}</div>
        <div class="stat-note">diagnosis ${d.claim.diagnosis.length} 筆</div></div>
      <div class="card"><div class="stat-label">total</div>
        <div class="stat-value">${nf(d.claim.total.value)}<span class="unit">TWD</span></div>
        <div class="stat-note">依健保署支付價試算</div></div>
    </div>
    <div class="card"><div class="card-title">Claim JSON<span class="meta">可直接送交申報系統</span></div>
      <pre class="mono" style="margin:0;max-height:560px;overflow:auto;background:var(--line-2);padding:14px;border-radius:8px;font-size:11.5px;line-height:1.6">${esc(JSON.stringify(d.claim, null, 2))}</pre>
    </div>`,

  source: (d) => `
    <h1 class="page-title">資料來源</h1>
    <p class="page-sub">所有畫面資料均為即時查詢結果，不使用離線快取或範例資料</p>
    <div class="grid cols-2">
      <div class="card"><div class="card-title">FHIR Server<span class="meta">即時查詢</span></div>
        <div class="row"><div class="row-main"><div class="row-name">端點</div><div class="row-sub">${esc(d.source.iss)}</div></div></div>
        <div class="row"><div class="row-main"><div class="row-name">授權狀態</div>
          <div class="row-sub">${d.source.authorized ? "SMART 授權 Session（access_token 僅存後端）" : "開放查詢（未經授權流程）"}</div></div></div>
        <div class="row"><div class="row-main"><div class="row-name">查詢時間</div>
          <div class="row-sub">${esc(d.source.fetchedAt)}　耗時 ${d.source.elapsedMs} ms</div></div></div>
      </div>
      <div class="card"><div class="card-title">健保藥品資料<span class="meta">政府資料開放平臺</span></div>
        <div class="row"><div class="row-main"><div class="row-name">${esc(d.summary.source.name)}</div>
          <div class="row-sub">中央健康保險署 · 每月更新 · ${nf(d.summary.source.totalRows)} 筆</div></div></div>
        <div class="row"><div class="row-main"><div class="row-name">授權條款</div>
          <div class="row-sub">${esc(d.summary.source.licence)}</div></div></div>
        <div class="row"><div class="row-main"><div class="row-name">取用欄位</div>
          <div class="row-sub">藥品代號 · 中文品名 · 支付價 · ATC 代碼 · 給付規定章節</div></div></div>
        <a class="btn" style="margin-top:12px;display:inline-block;text-decoration:none"
           href="${esc(d.summary.source.dataset)}" target="_blank" rel="noopener">資料集頁面</a>
      </div>
    </div>
    <div class="note"><strong>範圍界線</strong>：本系統執行「臨床資料 → 健保申報格式」之轉換與點數試算，
      不進行給付核准判定。是否給付與實際核付金額，以中央健康保險署審查結果為準。</div>`,
};

const AXIS = { axisLine: { lineStyle: { color: "#e2e8e6" } }, axisLabel: { color: "#6b807c", fontSize: 11 }, splitLine: { lineStyle: { color: "#eef2f1" } } };
const CLASS_ZH = {
  statin: "降血脂", biguanide: "雙胍類", dpp4: "DPP-4", insulin: "胰島素", arb: "ARB", acei: "ACEI",
  ccb: "鈣離子阻斷劑", antiplatelet: "抗血小板", anticoagulant: "抗凝血", ssri: "SSRI",
  antipsychotic: "抗精神病", benzodiazepine: "BZD", z_hypnotic: "安眠藥", nsaid: "NSAID",
  ppi: "制酸劑", sulfonylurea: "磺醯脲素", sglt2: "SGLT2", thiazide: "利尿劑", beta_blocker: "乙型阻斷劑",
};

function drawClass(d) {
  const el = $("#c-class"); if (!el) return;
  const rows = d.summary.byClass;
  if (!rows.length) { el.innerHTML = `<div class="empty">無可定價品項</div>`; return; }
  const c = echarts.init(el); charts.push(c);
  c.setOption({
    grid: { left: 92, right: 46, top: 12, bottom: 26 },
    xAxis: { type: "value", ...AXIS },
    yAxis: { type: "category", data: rows.map(([k]) => CLASS_ZH[k] || k).reverse(), ...AXIS },
    series: [{
      type: "bar", barWidth: 16, data: rows.map(([, v]) => v).reverse(),
      itemStyle: { color: "#0f766e", borderRadius: [0, 5, 5, 0] },
      label: { show: true, position: "right", formatter: (p) => nf(p.value) + " 點", color: "#3d5450", fontSize: 11 },
    }],
  });
}

function drawQuality(d) {
  const el = $("#c-qual"); if (!el) return;
  const q = d.summary.quality;
  const data = [
    { name: "相符", value: q.exact, itemStyle: { color: "#15803d" } },
    { name: "劑量待確認", value: q.doseUnverified, itemStyle: { color: "#b45309" } },
    { name: "劑型不符", value: q.formMismatch, itemStyle: { color: "#b91c1c" } },
    { name: "未對應", value: q.unmapped, itemStyle: { color: "#c4cfcc" } },
  ].filter((x) => x.value > 0);
  const c = echarts.init(el); charts.push(c);
  c.setOption({
    legend: { bottom: 0, textStyle: { color: "#3d5450", fontSize: 11.5 }, icon: "circle", itemWidth: 8, itemHeight: 8 },
    series: [{
      type: "pie", radius: ["48%", "72%"], center: ["50%", "44%"], data,
      label: { show: true, formatter: "{c}", color: "#10231f", fontSize: 13, fontWeight: 600 },
      labelLine: { length: 8, length2: 8 },
    }],
  });
}

const route = () => location.hash.replace("#/", "") || "convert";

function render() {
  const page = route();
  document.querySelectorAll(".nav-item").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#/${page}`));
  if (!state.data) return;
  disposeCharts();
  $("#view").innerHTML = (PAGES[page] || PAGES.convert)(state.data);
  if (page === "convert") { drawClass(state.data); drawQuality(state.data); }
}

async function load(id) {
  if (!id) return;
  state.patientId = id;
  renderSteps(0);
  const t0 = performance.now();
  try {
    renderSteps(2);
    const d = await api(`/api/claim/${encodeURIComponent(id)}?days=${state.days}`);
    if (d.error) throw new Error(d.error);
    renderSteps(3, `後端查詢與轉換耗時 ${d.source.elapsedMs} ms`);
    state.data = d;
    $("#src").innerHTML = `<span class="dot"></span>即時 · ${new URL(d.source.iss).host}`;
    $("#conn").className = "pill ok";
    $("#conn").innerHTML = `<span class="dot"></span>已連線 (${Math.round(performance.now() - t0)}ms)`;
    render();
  } catch (e) { renderError(e.message); }
}

async function loadPatients(q) {
  const d = await api(`/api/patients${q ? `?q=${encodeURIComponent(q)}` : ""}`).catch(() => ({ patients: [] }));
  $("#picker").innerHTML = (d.patients || []).map((p) =>
    `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.gender)}${p.age != null ? " " + p.age + "歲" : ""}</option>`).join("");
  return d.patients || [];
}

async function boot() {
  const ctx = await api("/api/context").catch(() => ({ authorized: false }));
  const list = await loadPatients();
  const target = ctx.patientId || ctx.demoPatient || list[0]?.id;
  if (target && !list.some((p) => p.id === target)) {
    $("#picker").insertAdjacentHTML("afterbegin", `<option value="${esc(target)}">（啟動帶入）${esc(target)}</option>`);
  }
  $("#picker").value = target || "";
  await load(target);
}

$("#picker").addEventListener("change", (e) => load(e.target.value));
$("#reload").addEventListener("click", () => load(state.patientId));
$("#days").addEventListener("change", (e) => { state.days = Math.max(1, Number(e.target.value) || 28); load(state.patientId); });
let timer;
$("#q").addEventListener("input", (e) => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const list = await loadPatients(e.target.value.trim());
    if (list[0]) load(list[0].id);
  }, 400);
});
window.addEventListener("hashchange", render);
window.addEventListener("resize", () => charts.forEach((c) => c.resize()));
boot();
