// 台灣血脂 CDS — SMART on FHIR App（後端）
// 授權流程走 BFF：access_token 僅存後端 session，不進瀏覽器。
import express from "express";
import session from "express-session";
import { discover, pkce, randomState, buildAuthorizeUrl, exchangeToken, parseIdToken } from "@tw-smart/smart-client/smart";
import { fhirClient, fetchPatientBundle, latestLab, latestBP, labSeries, LAB_ZH } from "@tw-smart/smart-client/fhir";
import { lookupDrug } from "@tw-smart/nhi-data";
import { assess } from "./lipid.js";

const cfg = {
  port: Number(process.env.PORT || 8801),
  clientId: process.env.SMART_CLIENT_ID || "tw-lipid-cds",
  scope: process.env.SMART_SCOPE || "launch openid fhirUser profile patient/*.read",
  backendUrl: process.env.BACKEND_URL || "http://localhost:8801",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5301",
  defaultIss: process.env.FHIR_BASE || "https://thas.mohw.gov.tw/v/r4/fhir",
  demoPatient: process.env.DEMO_PATIENT || "sun-1234567",
  isProd: process.env.NODE_ENV === "production",
};
const redirectUri = () => `${cfg.backendUrl}/callback`;

const app = express();
app.set("trust proxy", 1);
app.use(session({
  secret: process.env.SESSION_SECRET || "dev-lipid-cds",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: cfg.isProd, maxAge: 3600e3 },
}));
app.use((_req, res, next) => {
  res.set({ "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });
  next();
});
app.use((req, res, next) => {
  res.set("access-control-allow-origin", cfg.frontendUrl);
  res.set("access-control-allow-credentials", "true");
  next();
});

app.get("/health", (_q, r) => r.json({ ok: true, app: "tw-lipid-cds", clientId: cfg.clientId, iss: cfg.defaultIss }));

// ── SMART App Launch ──────────────────────────────────
app.get("/launch", async (req, res) => {
  try {
    const iss = String(req.query.iss || cfg.defaultIss);
    const launch = req.query.launch ? String(req.query.launch) : null;
    const d = await discover(iss);
    const { verifier, challenge } = pkce();
    const state = randomState();
    req.session.smart = { iss, tokenUrl: d.tokenUrl, verifier, state };
    res.redirect(buildAuthorizeUrl({
      authorizeUrl: d.authorizeUrl, clientId: cfg.clientId, redirectUri: redirectUri(),
      scope: cfg.scope, state, challenge, aud: iss, launch,
    }));
  } catch (e) { res.status(500).send(`Launch 失敗：${e.message}`); }
});

app.get("/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) throw new Error(`${error}: ${error_description || ""}`);
    const s = req.session.smart;
    if (!s || state !== s.state) throw new Error("state 不符（可能為 CSRF 或 session 過期）");
    const tok = await exchangeToken({
      tokenUrl: s.tokenUrl, clientId: cfg.clientId, redirectUri: redirectUri(),
      code: String(code), verifier: s.verifier,
    });
    req.session.smart = {
      ...s,
      token: tok.access_token,
      patientId: tok.patient || null,
      fhirUser: parseIdToken(tok.id_token)?.fhirUser || null,
      scope: tok.scope || null,
      expiresAt: Date.now() + (tok.expires_in || 3600) * 1000,
    };
    res.redirect(`${cfg.frontendUrl}/?launched=1`);
  } catch (e) { res.status(500).send(`授權失敗：${e.message}`); }
});

app.get("/api/context", (req, res) => {
  const s = req.session.smart;
  res.json(s?.token
    ? { authorized: true, patientId: s.patientId, iss: s.iss, fhirUser: s.fhirUser, scope: s.scope }
    : { authorized: false, iss: cfg.defaultIss, demoPatient: cfg.demoPatient });
});

// ── 資料 API ──────────────────────────────────────────
/** 建立 FHIR client：優先用授權 session，未授權則以公開讀取（thas 開放查詢） */
function clientFor(req) {
  const s = req.session.smart;
  return s?.token
    ? { client: fhirClient({ base: s.iss, token: s.token }), authorized: true, iss: s.iss }
    : { client: fhirClient({ base: cfg.defaultIss, token: null }), authorized: false, iss: cfg.defaultIss };
}

app.get("/api/patients", async (req, res) => {
  try {
    const { client } = clientFor(req);
    const q = req.query.q ? String(req.query.q) : null;
    const b = await client.get("/Patient", { _count: 30, ...(q ? { name: q } : {}) });
    const list = client.entries(b).map((p) => {
      const n = (p.name || [])[0] || {};
      const zh = n.text && /[一-鿿]/.test(n.text) ? n.text : null;
      return {
        id: p.id,
        name: zh || [n.given?.join(" "), n.family].filter(Boolean).join(" ") || p.id,
        gender: { male: "男", female: "女" }[p.gender] || "—",
        age: p.birthDate ? Math.floor((Date.now() - new Date(p.birthDate)) / 31557600000) : null,
      };
    });
    res.json({ patients: list, source: client.base });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/lipid/:patientId", async (req, res) => {
  const t0 = Date.now();
  try {
    const { client, authorized, iss } = clientFor(req);
    const b = await fetchPatientBundle(client, req.params.patientId);

    const labs = {};
    for (const k of ["ldl", "hdl", "tc", "tg", "hba1c", "glucoseAC", "creatinine", "egfr"]) {
      const v = latestLab(b.observations, k);
      if (v) labs[k] = { ...v, label: LAB_ZH[k] };
    }
    const bp = latestBP(b.observations);

    // 血脂用藥（statin / ezetimibe / fibrate / PCSK9）＋健保資訊
    const lipidClasses = new Set(["statin", "ezetimibe", "fibrate", "pcsk9"]);
    const meds = b.medications.map((m) => {
      const nhi = lookupDrug(m.name);
      return { ...m, nhi, isLipidDrug: nhi ? lipidClasses.has(nhi.class) : false };
    });

    res.json({
      source: { iss, authorized, fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - t0 },
      patient: b.patient,
      conditions: b.conditions,
      labs, bp,
      series: {
        ldl: labSeries(b.observations, "ldl").slice(0, 12).reverse(),
        hba1c: labSeries(b.observations, "hba1c").slice(0, 12).reverse(),
        sbp: labSeries(b.observations, "sbp").slice(0, 12).reverse(),
      },
      medications: meds,
      lipidMeds: meds.filter((m) => m.isLipidDrug),
      assessment: assess({ conditions: b.conditions, labs }),
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.listen(cfg.port, () => {
  console.log(`[台灣血脂 CDS] 後端 http://localhost:${cfg.port}`);
  console.log(`  FHIR   ${cfg.defaultIss}`);
  console.log(`  Launch ${cfg.backendUrl}/launch?iss=<iss>&launch=<ctx>`);
});
