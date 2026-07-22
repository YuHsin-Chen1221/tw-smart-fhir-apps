import "../../../../packages/ui/theme.css";
import * as echarts from "echarts";

const API = import.meta.env.VITE_API || "http://localhost:8801";
const $ = (s, r = document) => r.querySelector(s);
const api = (p) => fetch(API + p, { credentials: "include" }).then((r) => r.json());
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const state = { patientId: null, data: null, ctx: null };
const charts = [];
const disposeCharts = () => { charts.splice(0).forEach((c) => c.dispose()); };

// ── 生命週期顯示：request → processing → 回傳 → 顯示 ──
function renderSteps(active, note = "") {
  const steps = ["向 FHIR Server 發出請求", "取得病人／診斷／檢驗／處方", "比對指引門檻與健保藥品檔", "呈現結果"];
  $("#view").innerHTML = `<div class="card" style="max-width:520px;margin:60px auto">
    <div class="card-title">查詢中<span class="meta">SMART ON FHIR</span></div>
    <div class="steps">${steps.map((s, i) => `
      <div class="step ${i < active ? "done" : i === active ? "on" : ""}">
        <span class="n">${i < active ? "✓" : i + 1}</span><span>${s}</span>
      </div>`).join("")}</div>
    ${note ? `<div class="note">${esc(note)}</div>` : ""}
  </div>`;
}

function renderError(msg) {
  $("#view").innerHTML = `<div class="card" style="max-width:560px;margin:60px auto">
    <div class="card-title" style="color:var(--fail)">查詢失敗</div>
    <div style="font-size:14px;color:var(--ink-2)">${esc(msg)}</div>
    <div class="note">請確認 FHIR Server 可連線，或改選其他病人。本系統不使用離線快取，
      畫面上的每一筆資料都來自即時查詢。</div>
    <button class="btn primary" style="margin-top:14px" onclick="location.reload()">重新載入</button>
  </div>`;
}

// ── 頁面 ──────────────────────────────────────────────
const PAGES = {
  overview: (d) => {
    const a = d.assessment, r = a.risk;
    const cls = a.status === "atGoal" ? "ok" : a.status === "aboveGoal" ? "fail" : "";
    const statusText = a.status === "atGoal" ? "已達標" : a.status === "aboveGoal" ? "未達標" : "無 LDL 檢驗資料";
    return `
    <h1 class="page-title">血脂評估</h1>
    <p class="page-sub">依 2022 台灣高血壓、高血脂及糖尿病治療指引與 2019 ESC/EAS 進行風險分層與目標對照</p>
    ${ptHeader(d)}
    <div class="grid cols-3" style="margin-bottom:16px">
      <div class="card">
        <div class="stat-label">心血管風險分層</div>
        <div class="stat-value">${esc(r.label)}</div>
        <div class="stat-note">${esc(r.desc)}</div>
      </div>
      <div class="card">
        <div class="stat-label">LDL-C 治療目標</div>
        <div class="stat-value">&lt; ${r.max}<span class="unit">mg/dL</span></div>
        <div class="stat-note">依風險分層決定</div>
      </div>
      <div class="card">
        <div class="stat-label">目前 LDL-C</div>
        <div class="stat-value" style="color:var(--${a.status === "atGoal" ? "ok" : "fail"})">
          ${a.ldl ?? "—"}<span class="unit">mg/dL</span></div>
        <div class="stat-note"><span class="pill ${cls}"><span class="dot"></span>${statusText}</span>
          ${a.gap > 0 ? ` 高於目標 ${a.gap} mg/dL` : ""}</div>
      </div>
    </div>
    <div class="grid cols-2">
      <div class="card">
        <div class="card-title">分層依據<span class="meta">SNOMED CT</span></div>
        ${r.insufficient
          ? `<div class="note"><strong>此病人無編碼診斷</strong>，無法可靠分層。
             以下目標值僅為預設低風險門檻，不應作為臨床判斷依據。</div>`
          : r.reasons.map((x) => `<div class="row">
              <div class="row-main"><div class="row-name">${esc(x.dx)}</div>
                <div class="row-sub">${esc(x.why)}</div></div></div>`).join("") ||
            `<div class="empty">無符合的危險因子診斷</div>`}
      </div>
      <div class="card">
        <div class="card-title">LDL-C 現值 vs 目標<span class="meta">LOINC 2089-1</span></div>
        <div id="c-gap" class="chart" style="height:220px"></div>
      </div>
    </div>
    ${lipidMedCard(d)}
    <div class="note">
      <strong>指引依據</strong>：${esc(a.guideline.name)}
      <a href="${a.guideline.esc}" target="_blank" rel="noopener">ESC/EAS 原文</a><br />
      <strong>健保給付規定 ${esc(a.nhi.chapter)}</strong>：${a.nhi.summary.map(esc).join("；")}
      <a href="${a.nhi.url}" target="_blank" rel="noopener">健保署</a><br />
      ${esc(a.disclaimer)}
    </div>`;
  },

  labs: (d) => `
    <h1 class="page-title">檢驗趨勢</h1>
    <p class="page-sub">即時取自 FHIR Observation；LOINC 代碼於不同院所可能不同，本系統以別名表對應</p>
    ${ptHeader(d)}
    <div class="grid cols-3" style="margin-bottom:16px">
      ${Object.entries(d.labs).map(([k, v]) => `
        <div class="card"><div class="stat-label">${esc(v.label)}</div>
          <div class="stat-value">${v.value}<span class="unit">${esc(v.unit)}</span></div>
          <div class="stat-note">${String(v.when || "").slice(0, 10)}</div></div>`).join("") ||
        `<div class="card"><div class="empty">無檢驗資料</div></div>`}
    </div>
    <div class="grid cols-2">
      <div class="card"><div class="card-title">LDL-C 趨勢<span class="meta">mg/dL</span></div><div id="c-ldl" class="chart"></div></div>
      <div class="card"><div class="card-title">HbA1c 趨勢<span class="meta">%</span></div><div id="c-a1c" class="chart"></div></div>
    </div>`,

  meds: (d) => `
    <h1 class="page-title">用藥與健保對應</h1>
    <p class="page-sub">處方藥品即時對應健保署「健保用藥品項查詢項目檔」之藥品代號、支付價與 ATC 分類</p>
    ${ptHeader(d)}
    <div class="card">
      <div class="card-title">處方清單（${d.medications.length} 筆）<span class="meta">FHIR MedicationRequest</span></div>
      <table class="tbl"><thead><tr>
        <th>處方藥品</th><th>健保藥品代號</th><th>健保品名</th><th>ATC</th><th class="num">支付價</th><th>比對</th>
      </tr></thead><tbody>
      ${d.medications.map((m) => {
        const n = m.nhi;
        if (!n) return `<tr><td>${esc(m.name)}</td><td colspan="5" style="color:var(--ink-3)">未收錄於本索引</td></tr>`;
        const q = n.match?.form && n.match?.dose ? `<span class="pill ok"><span class="dot"></span>相符</span>`
          : n.match?.form ? `<span class="pill warn"><span class="dot"></span>劑量待確認</span>`
          : `<span class="pill fail"><span class="dot"></span>劑型不符</span>`;
        return `<tr>
          <td><div class="row-name">${esc(m.name)}</div>${m.isLipidDrug ? `<span class="pill teal" style="margin-top:4px">血脂用藥</span>` : ""}</td>
          <td class="mono">${esc(n.example.code)}</td>
          <td>${esc(n.example.zh)}</td>
          <td class="mono">${esc(n.atc)}</td>
          <td class="num">${n.example.price}</td>
          <td>${q}${n.match?.note ? `<div class="row-sub" style="color:var(--fail)">${esc(n.match.note)}</div>` : ""}</td>
        </tr>`;
      }).join("")}
      </tbody></table>
      <div class="note">支付價為健保署公告點數。標示「劑型不符」者代表處方劑型與索引代表品項不同，
        送出前需人工核對正確健保品項。</div>
    </div>`,

  source: (d) => `
    <h1 class="page-title">資料來源</h1>
    <p class="page-sub">本系統所有畫面資料均為即時查詢結果，不使用離線快取或範例資料</p>
    <div class="grid cols-2">
      <div class="card">
        <div class="card-title">FHIR Server<span class="meta">即時查詢</span></div>
        <div class="row"><div class="row-main"><div class="row-name">端點</div>
          <div class="row-sub">${esc(d.source.iss)}</div></div></div>
        <div class="row"><div class="row-main"><div class="row-name">授權狀態</div>
          <div class="row-sub">${d.source.authorized ? "SMART 授權 Session（access_token 僅存後端）" : "開放查詢（未經授權流程）"}</div></div></div>
        <div class="row"><div class="row-main"><div class="row-name">查詢時間</div>
          <div class="row-sub">${esc(d.source.fetchedAt)}　耗時 ${d.source.elapsedMs} ms</div></div></div>
        <div class="row"><div class="row-main"><div class="row-name">取用資源</div>
          <div class="row-sub">Patient · Condition · Observation · MedicationRequest</div></div></div>
      </div>
      <div class="card">
        <div class="card-title">健保藥品資料<span class="meta">政府資料開放平臺</span></div>
        <div class="row"><div class="row-main"><div class="row-name">健保用藥品項查詢項目檔</div>
          <div class="row-sub">中央健康保險署 · 每月更新</div></div></div>
        <div class="row"><div class="row-main"><div class="row-name">授權</div>
          <div class="row-sub">政府資料開放授權條款</div></div></div>
        <div class="row"><div class="row-main"><div class="row-name">用途</div>
          <div class="row-sub">藥品代號 · 中文品名 · 支付價 · ATC 分類 · 給付規定章節</div></div></div>
        <a class="btn" style="margin-top:12px;display:inline-block;text-decoration:none"
           href="https://data.gov.tw/dataset/23715" target="_blank" rel="noopener">資料集頁面</a>
      </div>
    </div>
    <div class="note"><strong>臨床指引</strong>：2022 台灣高血壓、高血脂及糖尿病治療指引（中華民國心臟學會／台灣高血壓學會）、
      2019 ESC/EAS Guidelines for the management of dyslipidaemias (doi:10.1093/eurheartj/ehz455)。<br />
      <strong>免責</strong>：本系統為臨床決策參考工具，不構成醫療建議；實際給付以中央健康保險署最新公告為準。</div>`,
};

function ptHeader(d) {
  const p = d.patient;
  return `<div class="card" style="margin-bottom:16px">
    <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
      <div class="brand-mark" style="width:44px;height:44px;font-size:18px">${esc((p.name || "?")[0])}</div>
      <div style="flex:1;min-width:180px">
        <div style="font-size:18px;font-weight:640">${esc(p.name)}</div>
        <div class="row-sub">${esc(p.gender)} · ${p.age ?? "?"}歲 · 身分證 ${esc(p.nationalId || "—")} · 病歷號 ${esc(p.mrn || "—")}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${d.conditions.map((c) => `<span class="pill teal">${esc(c.text || c.display)}</span>`).join("") ||
          `<span class="pill">無編碼診斷</span>`}
      </div>
    </div></div>`;
}

function lipidMedCard(d) {
  if (!d.lipidMeds.length) {
    return `<div class="card" style="margin-top:16px"><div class="card-title">血脂用藥</div>
      <div class="empty">目前無降血脂藥物處方</div></div>`;
  }
  return `<div class="card" style="margin-top:16px">
    <div class="card-title">血脂用藥與健保給付<span class="meta">健保用藥品項查詢項目檔</span></div>
    ${d.lipidMeds.map((m) => `<div class="row">
      <div class="row-main">
        <div class="row-name">${esc(m.name)}</div>
        <div class="row-sub">${esc(m.nhi.example.code)} · ${esc(m.nhi.example.zh)} · ATC ${esc(m.nhi.atc)}</div>
      </div>
      <div class="row-value">${m.nhi.example.price} 點
        ${m.nhi.chapter ? `<div class="row-sub">給付規定 ${esc(m.nhi.chapter)}</div>` : ""}</div>
    </div>`).join("")}</div>`;
}

// ── 圖表 ──────────────────────────────────────────────
const AXIS = { axisLine: { lineStyle: { color: "#e2e8e6" } }, axisLabel: { color: "#6b807c", fontSize: 11 }, splitLine: { lineStyle: { color: "#eef2f1" } } };

function drawGap(d) {
  const el = $("#c-gap"); if (!el) return;
  const a = d.assessment;
  if (a.ldl == null) { el.innerHTML = `<div class="empty">此病人無 LDL-C 檢驗資料</div>`; return; }
  const c = echarts.init(el); charts.push(c);
  c.setOption({
    grid: { left: 70, right: 30, top: 20, bottom: 30 },
    xAxis: { type: "value", ...AXIS, max: Math.max(a.ldl, a.target) * 1.2 },
    yAxis: { type: "category", data: ["治療目標", "目前值"], ...AXIS },
    series: [{
      type: "bar", barWidth: 26,
      data: [
        { value: a.target, itemStyle: { color: "#14a89a", borderRadius: [0, 6, 6, 0] } },
        { value: a.ldl, itemStyle: { color: a.status === "atGoal" ? "#15803d" : "#b91c1c", borderRadius: [0, 6, 6, 0] } },
      ],
      label: { show: true, position: "right", formatter: "{c} mg/dL", color: "#3d5450", fontSize: 12 },
    }],
  });
}

function drawSeries(id, series, unit, color) {
  const el = $("#" + id); if (!el) return;
  if (!series?.length) { el.innerHTML = `<div class="empty">無資料</div>`; return; }
  const c = echarts.init(el); charts.push(c);
  c.setOption({
    grid: { left: 48, right: 20, top: 20, bottom: 34 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: series.map((p) => String(p.when || "").slice(0, 10)), ...AXIS },
    yAxis: { type: "value", ...AXIS, scale: true },
    series: [{
      type: "line", smooth: true, symbolSize: 6, data: series.map((p) => p.value),
      lineStyle: { color, width: 2.2 }, itemStyle: { color },
      areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: color + "26" }, { offset: 1, color: color + "00" }] } },
    }],
  });
}

// ── 路由與載入 ────────────────────────────────────────
function route() { return (location.hash.replace("#/", "") || "overview"); }

function render() {
  const page = route();
  document.querySelectorAll(".nav-item").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#/${page}`));
  if (!state.data) return;
  disposeCharts();
  $("#view").innerHTML = (PAGES[page] || PAGES.overview)(state.data);
  if (page === "overview") drawGap(state.data);
  if (page === "labs") {
    drawSeries("c-ldl", state.data.series.ldl, "mg/dL", "#0f766e");
    drawSeries("c-a1c", state.data.series.hba1c, "%", "#b45309");
  }
}

async function load(id) {
  if (!id) return;
  state.patientId = id;
  renderSteps(0);
  const t0 = performance.now();
  try {
    renderSteps(1);
    const d = await api(`/api/lipid/${encodeURIComponent(id)}`);
    if (d.error) throw new Error(d.error);
    renderSteps(3, `後端查詢耗時 ${d.source.elapsedMs} ms`);
    state.data = d;
    $("#src").innerHTML = `<span class="dot"></span>即時 · ${new URL(d.source.iss).host}`;
    $("#conn").className = "pill ok";
    $("#conn").innerHTML = `<span class="dot"></span>已連線 (${Math.round(performance.now() - t0)}ms)`;
    render();
  } catch (e) { renderError(e.message); }
}

async function loadPatients(q) {
  const d = await api(`/api/patients${q ? `?q=${encodeURIComponent(q)}` : ""}`).catch(() => ({ patients: [] }));
  const sel = $("#picker");
  sel.innerHTML = (d.patients || []).map((p) =>
    `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.gender)}${p.age != null ? " " + p.age + "歲" : ""}</option>`).join("");
  return d.patients || [];
}

async function boot() {
  const ctx = await api("/api/context").catch(() => ({ authorized: false }));
  state.ctx = ctx;
  const list = await loadPatients();
  // EHR Launch 帶入的病人優先；否則用示範病人；再否則清單第一位
  const target = ctx.patientId || ctx.demoPatient || list[0]?.id;
  if (target && !list.some((p) => p.id === target)) {
    $("#picker").insertAdjacentHTML("afterbegin", `<option value="${esc(target)}">（啟動帶入）${esc(target)}</option>`);
  }
  $("#picker").value = target || "";
  await load(target);
}

$("#picker").addEventListener("change", (e) => load(e.target.value));
$("#reload").addEventListener("click", () => load(state.patientId));
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
