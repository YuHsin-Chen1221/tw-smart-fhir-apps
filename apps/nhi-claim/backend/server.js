// 健保智慧申報 — SMART on FHIR App（後端）
// 核心功能：EHR 處方 → 健保藥品代號／支付價 → FHIR Claim 資源
import express from "express";
import session from "express-session";
import { discover, pkce, randomState, buildAuthorizeUrl, exchangeToken, parseIdToken } from "@tw-smart/smart-client/smart";
import { fhirClient, fetchPatientBundle } from "@tw-smart/smart-client/fhir";
import { convertMedication, buildClaim, summarize } from "./claim.js";

const cfg = {
  port: Number(process.env.PORT || 8802),
  clientId: process.env.SMART_CLIENT_ID || "tw-nhi-claim",
  scope: process.env.SMART_SCOPE || "launch openid fhirUser profile patient/*.read",
  backendUrl: process.env.BACKEND_URL || "http://localhost:8802",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5302",
  defaultIss: process.env.FHIR_BASE || "https://thas.mohw.gov.tw/v/r4/fhir",
  demoPatient: process.env.DEMO_PATIENT || "sun-1234567",
  isProd: process.env.NODE_ENV === "production",
};
const redirectUri = () => `${cfg.backendUrl}/callback`;

const app = express();
app.set("trust proxy", 1);
app.use(session({
  secret: process.env.SESSION_SECRET || "dev-nhi-claim",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: cfg.isProd, maxAge: 3600e3 },
}));
app.use((_q, res, next) => {
  res.set({ "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });
  next();
});
app.use((_q, res, next) => {
  res.set("access-control-allow-origin", cfg.frontendUrl);
  res.set("access-control-allow-credentials", "true");
  next();
});

app.get("/health", (_q, r) => r.json({ ok: true, app: "tw-nhi-claim", clientId: cfg.clientId, iss: cfg.defaultIss }));

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
      ...s, token: tok.access_token, patientId: tok.patient || null,
      fhirUser: parseIdToken(tok.id_token)?.fhirUser || null, scope: tok.scope || null,
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
    res.json({
      patients: client.entries(b).map((p) => {
        const n = (p.name || [])[0] || {};
        const zh = n.text && /[一-鿿]/.test(n.text) ? n.text : null;
        return {
          id: p.id,
          name: zh || [n.given?.join(" "), n.family].filter(Boolean).join(" ") || p.id,
          gender: { male: "男", female: "女" }[p.gender] || "—",
          age: p.birthDate ? Math.floor((Date.now() - new Date(p.birthDate)) / 31557600000) : null,
        };
      }),
      source: client.base,
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── 申報轉換 ──────────────────────────────────────────
app.get("/api/claim/:patientId", async (req, res) => {
  const t0 = Date.now();
  try {
    const { client, authorized, iss } = clientFor(req);
    const b = await fetchPatientBundle(client, req.params.patientId);
    const days = Number(req.query.days || 28);

    const items = b.medications.map((m) => convertMedication(m, { days }));
    const claim = buildClaim({ patient: b.patient, conditions: b.conditions, items });
    const summary = summarize(items);

    res.json({
      source: { iss, authorized, fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - t0 },
      patient: b.patient,
      conditions: b.conditions,
      items, summary, claim,
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.listen(cfg.port, () => {
  console.log(`[健保智慧申報] 後端 http://localhost:${cfg.port}`);
  console.log(`  FHIR   ${cfg.defaultIss}`);
  console.log(`  Launch ${cfg.backendUrl}/launch?iss=<iss>&launch=<ctx>`);
});
