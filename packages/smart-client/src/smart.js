// SMART on FHIR App Launch — 授權流程（discovery / PKCE / token / refresh）
// 針對衛福部 thas.mohw.gov.tw（SMART-LAUNCHER-V2 部署）實測相容。
import crypto from "node:crypto";

const b64url = (buf) => buf.toString("base64url");
export const randomState = () => b64url(crypto.randomBytes(16));

/** PKCE：產生 verifier 與 S256 challenge */
export function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * 探索授權端點。優先 .well-known/smart-configuration，
 * 失敗則退回 CapabilityStatement 的 oauth-uris extension。
 */
export async function discover(iss) {
  const base = iss.replace(/\/+$/, "");
  try {
    const r = await fetch(`${base}/.well-known/smart-configuration`, {
      headers: { accept: "application/json" },
    });
    if (r.ok) {
      const c = await r.json();
      if (c.authorization_endpoint && c.token_endpoint) {
        return {
          authorizeUrl: c.authorization_endpoint,
          tokenUrl: c.token_endpoint,
          capabilities: c.capabilities || [],
          scopesSupported: c.scopes_supported || [],
          authMethods: c.token_endpoint_auth_methods_supported || [],
        };
      }
    }
  } catch { /* 退回 CapabilityStatement */ }

  const r = await fetch(`${base}/metadata`, { headers: { accept: "application/fhir+json" } });
  if (!r.ok) throw new Error(`discovery 失敗：${base} 回應 ${r.status}`);
  const cs = await r.json();
  const ext = cs.rest?.[0]?.security?.extension?.find(
    (e) => e.url === "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris"
  );
  const pick = (u) => ext?.extension?.find((x) => x.url === u)?.valueUri;
  const authorizeUrl = pick("authorize"), tokenUrl = pick("token");
  if (!authorizeUrl || !tokenUrl) throw new Error(`${base} 未提供 OAuth 端點`);
  return { authorizeUrl, tokenUrl, capabilities: [], scopesSupported: [], authMethods: [] };
}

/**
 * 組出授權導向網址。
 * 注意：thas 與 launch.smarthealthit.org 的 /v/r4/auth/authorize
 * 必要時需帶 launch 參數（base64url 的 JSON 模擬設定），
 * 由 EHR 於 EHR-Launch 時提供；standalone 則自動移除 launch scope。
 */
export function buildAuthorizeUrl({ authorizeUrl, clientId, redirectUri, scope, state, challenge, aud, launch }) {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: launch ? scope : scope.replace(/\blaunch\b\s*/g, "").trim(),
    state,
    aud,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (launch) p.set("launch", launch);
  return `${authorizeUrl}?${p}`;
}

/** code → access_token（public client + PKCE） */
export async function exchangeToken({ tokenUrl, clientId, redirectUri, code, verifier }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`token 交換失敗 ${r.status}：${j.error_description || j.error || ""}`);
  return j;
}

/** refresh_token → 新 access_token */
export async function refreshToken({ tokenUrl, clientId, refresh_token }) {
  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id: clientId }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`refresh 失敗 ${r.status}：${j.error_description || j.error || ""}`);
  return j;
}

/** 解析 id_token 取 fhirUser（僅取 claims；正式部署應以 issuer JWKS 驗簽） */
export function parseIdToken(idToken) {
  try {
    const [, payload] = String(idToken).split(".");
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch { return null; }
}
