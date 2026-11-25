import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  PROJECT_ROOT,
  API_ACCESS_KEY,
  PANEL_PASSWORD,
  PUBLIC_BASE_URL,
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_REDIRECT_URIS,
  OAUTH_SIGNING_SECRET,
  OAUTH_REQUIRED,
  dbPool,
  getStorageItem,
  setStorageItem,
  verifySessionToken,
  parseCookies,
  setCorsHeaders,
  sendJson,
  readFormOrJsonBody,
  addDebugLog
} from "./store.js";
import { getHtmlIconLinks } from "./icons.js";

const OAUTH_FILE = path.join(PROJECT_ROOT, "mcp-oauth.json");
const DEFAULT_SCOPE = "mcp:tools";
const ACCESS_TOKEN_TTL_SECONDS = 86400;
const REFRESH_TOKEN_TTL_SECONDS = 90 * 86400;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const PENDING_TX_TTL_MS = 10 * 60 * 1000;
const MAX_DCR_CLIENTS = 200;

const oauthState = {
  signingSecret: "",
  allowedRedirectUris: [],
  clients: {}
};

const pendingAuthorizations = new Map();
const authorizationCodes = new Map();
const revokedJtis = new Map();

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""), "utf8");
  const bufB = Buffer.from(String(b ?? ""), "utf8");
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}

function firstHeaderValue(value) {
  return String(value || "").split(",")[0].trim();
}

function parseRedirectUriList(input) {
  if (Array.isArray(input)) {
    return input.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return String(input || "")
    .split(/[\r\n,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isValidRedirectUri(uri) {
  const raw = String(uri || "").trim();
  if (!raw || raw.length > 2048) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.hash) return false;
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  }
  return false;
}

function getSigningKey() {
  if (OAUTH_SIGNING_SECRET) {
    return crypto.createHash("sha256").update(`mcp-ai-oauth-secret:${OAUTH_SIGNING_SECRET}`).digest();
  }
  if (PANEL_PASSWORD || API_ACCESS_KEY) {
    return crypto.createHash("sha256").update(`mcp-ai-oauth-derived:${PANEL_PASSWORD}:${API_ACCESS_KEY}`).digest();
  }
  if (!oauthState.signingSecret) {
    oauthState.signingSecret = crypto.randomBytes(32).toString("hex");
  }
  return crypto.createHash("sha256").update(`mcp-ai-oauth-stored:${oauthState.signingSecret}`).digest();
}

function hmacHex(purpose, value = "") {
  return crypto.createHmac("sha256", getSigningKey()).update(`${purpose}:${value}`).digest("hex");
}

function hmacBase64Url(data) {
  return crypto.createHmac("sha256", getSigningKey()).update(data).digest("base64url");
}

async function saveOAuthStateToStorage() {
  try {
    fs.writeFileSync(OAUTH_FILE, JSON.stringify(oauthState, null, 2), "utf8");
  } catch {}
  await setStorageItem("oauth_state", oauthState);
}

export async function loadOAuthStateFromStorage() {
  let stored = dbPool ? await getStorageItem("oauth_state") : null;
  if (!stored && fs.existsSync(OAUTH_FILE)) {
    try {
      stored = JSON.parse(fs.readFileSync(OAUTH_FILE, "utf8"));
    } catch {}
  }
  let changed = false;
  if (stored && typeof stored === "object") {
    if (typeof stored.signingSecret === "string" && stored.signingSecret) {
      oauthState.signingSecret = stored.signingSecret;
    }
    if (Array.isArray(stored.allowedRedirectUris)) {
      oauthState.allowedRedirectUris = stored.allowedRedirectUris.filter((item) => isValidRedirectUri(item));
    }
    if (stored.clients && typeof stored.clients === "object" && !Array.isArray(stored.clients)) {
      oauthState.clients = stored.clients;
    }
  }
  if (!OAUTH_SIGNING_SECRET && !PANEL_PASSWORD && !API_ACCESS_KEY && !oauthState.signingSecret) {
    oauthState.signingSecret = crypto.randomBytes(32).toString("hex");
    changed = true;
  }
  if (changed) await saveOAuthStateToStorage();
}

export function isMcpAuthRequired() {
  return Boolean(API_ACCESS_KEY || OAUTH_CLIENT_ID || OAUTH_CLIENT_SECRET || OAUTH_REQUIRED);
}

export function getPublicOrigin(request) {
  if (PUBLIC_BASE_URL) {
    try {
      return new URL(PUBLIC_BASE_URL).origin;
    } catch {}
  }
  const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]);
  const host = forwardedHost || firstHeaderValue(request.headers.host) || "localhost";
  let proto = firstHeaderValue(request.headers["x-forwarded-proto"] || request.headers["x-forwarded-scheme"]).toLowerCase();
  if (!proto && request.headers.forwarded) {
    const match = String(request.headers.forwarded).match(/proto=(https?)/i);
    if (match) proto = match[1].toLowerCase();
  }
  if (!proto && request.headers["cf-visitor"]) {
    try {
      const visitor = JSON.parse(String(request.headers["cf-visitor"]));
      if (visitor?.scheme === "https" || visitor?.scheme === "http") proto = visitor.scheme;
    } catch {}
  }
  if (!proto && (firstHeaderValue(request.headers["x-forwarded-ssl"]).toLowerCase() === "on" || firstHeaderValue(request.headers["front-end-https"]).toLowerCase() === "on")) {
    proto = "https";
  }
  if (proto !== "http" && proto !== "https") {
    proto = request.socket?.encrypted ? "https" : "http";
  }
  return `${proto}://${host}`;
}

function getStaticClient() {
  const clientId = OAUTH_CLIENT_ID || `mcp-ai-${hmacHex("default-client-id").slice(0, 16)}`;
  const clientSecret = OAUTH_CLIENT_SECRET || (
    OAUTH_CLIENT_ID
      ? `mcpcs_${hmacHex("static-secret", OAUTH_CLIENT_ID).slice(0, 40)}`
      : `mcpcs_${hmacHex("default-client-secret").slice(0, 40)}`
  );
  const envRedirects = parseRedirectUriList(OAUTH_REDIRECT_URIS).filter((uri) => isValidRedirectUri(uri));
  const storedRedirects = oauthState.allowedRedirectUris.filter((uri) => isValidRedirectUri(uri));
  const redirectUris = Array.from(new Set([...envRedirects, ...storedRedirects]));
  return {
    clientId,
    clientSecret,
    clientName: "MCP OAuth 客户端",
    redirectUris,
    isStatic: true,
    isPublic: false,
    tokenEndpointAuthMethod: "client_secret_post"
  };
}

function deriveDcrSecret(clientId) {
  return `mcpdcr_${hmacHex("dcr-secret", clientId).slice(0, 40)}`;
}

function createDcrClientId(isPublic) {
  const prefix = isPublic ? "dcrp" : "dcrc";
  const body = crypto.randomBytes(12).toString("hex");
  const sig = hmacHex("dcr-id", `${prefix}_${body}`).slice(0, 16);
  return `${prefix}_${body}.${sig}`;
}

function parseStatelessDcrClientId(clientId) {
  const match = String(clientId || "").match(/^(dcr[pc])_([0-9a-f]{24})\.([0-9a-f]{16})$/);
  if (!match) return null;
  const [, prefix, body, sig] = match;
  const expectedSig = hmacHex("dcr-id", `${prefix}_${body}`).slice(0, 16);
  if (!safeEqual(sig, expectedSig)) return null;
  const isPublic = prefix === "dcrp";
  return {
    clientId,
    clientSecret: isPublic ? "" : deriveDcrSecret(clientId),
    clientName: "已注册的 MCP 客户端",
    redirectUris: [],
    isStatic: false,
    isPublic,
    statelessFallback: true,
    tokenEndpointAuthMethod: isPublic ? "none" : "client_secret_post"
  };
}

function lookupClient(clientId) {
  const id = String(clientId || "").trim();
  if (!id) return null;
  const staticClient = getStaticClient();
  if (safeEqual(id, staticClient.clientId)) return staticClient;
  const stored = oauthState.clients[id];
  if (stored && typeof stored === "object") {
    const isPublic = stored.token_endpoint_auth_method === "none";
    return {
      clientId: id,
      clientSecret: isPublic ? "" : deriveDcrSecret(id),
      clientName: String(stored.client_name || id),
      redirectUris: Array.isArray(stored.redirect_uris) ? stored.redirect_uris : [],
      isStatic: false,
      isPublic,
      statelessFallback: false,
      tokenEndpointAuthMethod: stored.token_endpoint_auth_method || (isPublic ? "none" : "client_secret_basic")
    };
  }
  return parseStatelessDcrClientId(id);
}

function cleanupExpiredMaps() {
  const now = Date.now();
  for (const [key, value] of pendingAuthorizations.entries()) {
    if (value.expiresAt <= now) pendingAuthorizations.delete(key);
  }
  for (const [key, value] of authorizationCodes.entries()) {
    if (value.expiresAt <= now) authorizationCodes.delete(key);
  }
  for (const [key, expMs] of revokedJtis.entries()) {
    if (expMs <= now) revokedJtis.delete(key);
  }
}

function signToken(prefix, payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = hmacBase64Url(`${prefix}.${encoded}`);
  return `${prefix}.${encoded}.${sig}`;
}

function verifyToken(token, expectedPrefix) {
  cleanupExpiredMaps();
  const raw = String(token || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== expectedPrefix) return null;
  const expectedSig = hmacBase64Url(`${parts[0]}.${parts[1]}`);
  if (!safeEqual(parts[2], expectedSig)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= nowSec) return null;
  if (payload.jti && revokedJtis.has(payload.jti)) return null;
  return payload;
}

function normalizeResourceUrl(value, origin) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.origin !== origin) return null;
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${cleanPath}`;
}

function isResourceMatchingRequest(tokenResource, reqUrl, origin) {
  if (!tokenResource) return true;
  let parsed;
  try {
    parsed = new URL(tokenResource);
  } catch {
    return false;
  }
  if (parsed.origin !== origin) return false;
  const resPath = parsed.pathname.replace(/\/+$/, "").toLowerCase();
  const reqPath = reqUrl.pathname.replace(/\/+$/, "").toLowerCase();
  if (!resPath || resPath === "/" || resPath === "/mcp") return true;
  return reqPath === resPath || reqPath.startsWith(`${resPath}/`);
}

export function verifyMcpBearerAuth(request, reqUrl) {
  const queryToken = (reqUrl.searchParams.get("key") || reqUrl.searchParams.get("token") || reqUrl.searchParams.get("api_key") || "").trim();
  const headerKey = String(request.headers["x-api-key"] || request.headers["api-key"] || request.headers["x-goog-api-key"] || "").trim();
  const authHeader = String(request.headers.authorization || "").trim();
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const bearerToken = bearerMatch ? bearerMatch[1].trim() : "";

  if (API_ACCESS_KEY) {
    if (queryToken && safeEqual(queryToken, API_ACCESS_KEY)) {
      return { authorized: true, method: "api_key" };
    }
    if (headerKey && safeEqual(headerKey, API_ACCESS_KEY)) {
      return { authorized: true, method: "api_key" };
    }
    if (bearerToken && safeEqual(bearerToken, API_ACCESS_KEY)) {
      return { authorized: true, method: "api_key" };
    }
  }

  if (bearerToken && bearerToken.startsWith("mcpat.")) {
    const payload = verifyToken(bearerToken, "mcpat");
    if (!payload) {
      return {
        authorized: false,
        error: "invalid_token",
        errorDescription: "Access token is invalid or expired"
      };
    }
    const origin = getPublicOrigin(request);
    if (!isResourceMatchingRequest(payload.res, reqUrl, origin)) {
      return {
        authorized: false,
        error: "invalid_token",
        errorDescription: "Access token is not valid for this resource"
      };
    }
    return { authorized: true, method: "oauth", tokenPayload: payload };
  }

  if (!isMcpAuthRequired()) {
    return { authorized: true, method: "none" };
  }

  if (bearerToken || queryToken || headerKey) {
    return {
      authorized: false,
      error: "invalid_token",
      errorDescription: "Credentials are invalid or expired"
    };
  }

  return {
    authorized: false,
    error: "",
    errorDescription: ""
  };
}

export function buildWwwAuthenticateHeader(request, reqUrl, error = "", errorDescription = "") {
  const origin = getPublicOrigin(request);
  const normalizedPath = reqUrl.pathname.replace(/\/+$/, "") || "/mcp";
  const resourceMetadata = `${origin}/.well-known/oauth-protected-resource${normalizedPath}`;
  const parts = [
    `realm="mcp"`,
    `resource_metadata="${resourceMetadata}"`,
    `scope="${DEFAULT_SCOPE}"`
  ];
  if (error) parts.push(`error="${error.replace(/"/g, "")}"`);
  if (errorDescription) parts.push(`error_description="${errorDescription.replace(/"/g, "")}"`);
  return `Bearer ${parts.join(", ")}`;
}

function sendOAuthError(response, statusCode, error, errorDescription = "") {
  const body = { error };
  if (errorDescription) body.error_description = errorDescription;
  if (response.headersSent) return;
  setCorsHeaders(response);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Pragma: "no-cache"
  });
  response.end(JSON.stringify(body));
}

function sendRedirect(response, targetUrl) {
  setCorsHeaders(response);
  response.writeHead(302, {
    Location: targetUrl,
    "Cache-Control": "no-store",
    Pragma: "no-cache"
  });
  response.end();
}

function buildRedirectWithParams(redirectUri, params) {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      target.searchParams.set(key, String(value));
    }
  }
  return target.toString();
}

function renderHtmlPage(response, statusCode, html) {
  setCorsHeaders(response);
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; frame-ancestors 'none'"
  });
  response.end(html);
}

function renderOAuthErrorPage(response, title, detail) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>授权请求失败</title>
  ${getHtmlIconLinks()}
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 28px 24px; width: 100%; max-width: 420px; box-shadow: 0 4px 12px rgba(15, 23, 42, 0.06); }
    h1 { font-size: 18px; color: #b91c1c; margin-bottom: 10px; }
    p { font-size: 14px; color: #475569; line-height: 1.6; word-break: break-word; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
  </div>
</body>
</html>`;
  renderHtmlPage(response, 400, html);
}

function renderAuthorizePage(response, { txId, tx, requirePassword, hasPanelSession, errorMessage = "" }) {
  let redirectHost = tx.redirectUri;
  try {
    redirectHost = new URL(tx.redirectUri).host;
  } catch {}
  const passwordLabel = PANEL_PASSWORD ? "管理密码" : "访问密钥";
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP 授权确认</title>
  ${getHtmlIconLinks()}
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 28px 24px; width: 100%; max-width: 440px; box-shadow: 0 6px 20px rgba(15, 23, 42, 0.06); }
    h1 { font-size: 19px; font-weight: 700; margin-bottom: 8px; }
    .subtitle { font-size: 13px; color: #64748b; margin-bottom: 18px; line-height: 1.5; }
    .meta { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 14px; margin-bottom: 18px; font-size: 13px; }
    .meta-row { display: flex; flex-direction: column; margin-bottom: 10px; }
    .meta-row:last-child { margin-bottom: 0; }
    .meta-label { font-size: 11px; color: #64748b; margin-bottom: 2px; }
    .meta-value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #0f172a; word-break: break-all; font-size: 12px; }
    .session-ok { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; border-radius: 8px; padding: 8px 12px; font-size: 12px; margin-bottom: 16px; }
    label { display: block; font-size: 13px; font-weight: 500; color: #334155; margin-bottom: 6px; }
    input[type="password"] { width: 100%; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px 12px; font-size: 14px; margin-bottom: 14px; outline: none; }
    input[type="password"]:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12); }
    .err { background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; border-radius: 8px; padding: 8px 12px; font-size: 12px; margin-bottom: 14px; }
    .actions { display: flex; gap: 10px; margin-top: 6px; }
    button { flex: 1; border-radius: 8px; padding: 10px 14px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; }
    .btn-approve { background: #2563eb; color: #fff; }
    .btn-deny { background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; }
  </style>
</head>
<body>
  <div class="card">
    <h1>授权 MCP 客户端连接</h1>
    <p class="subtitle">外部应用正在请求访问你的 MCP 工具服务，请确认回调目标无误后再允许授权。</p>
    <div class="meta">
      <div class="meta-row">
        <span class="meta-label">客户端</span>
        <span class="meta-value">${escapeHtml(tx.clientName)} (${escapeHtml(tx.clientId)})</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">回调目标</span>
        <span class="meta-value">${escapeHtml(redirectHost)}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">重定向地址</span>
        <span class="meta-value">${escapeHtml(tx.redirectUri)}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">访问范围</span>
        <span class="meta-value">${escapeHtml(tx.resource || tx.scope)}</span>
      </div>
    </div>
    ${errorMessage ? `<div class="err">${escapeHtml(errorMessage)}</div>` : ""}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="tx_id" value="${escapeHtml(txId)}">
      <input type="hidden" name="csrf_token" value="${escapeHtml(tx.csrfToken)}">
      ${requirePassword
        ? (hasPanelSession
          ? `<div class="session-ok">已识别当前管理员会话，可直接确认授权。</div>`
          : `<label for="oauth-password">请输入${escapeHtml(passwordLabel)}</label><input id="oauth-password" name="password" type="password" autocomplete="current-password" placeholder="输入${escapeHtml(passwordLabel)}" required autofocus>`)
        : ""}
      <div class="actions">
        <button class="btn-deny" type="submit" name="decision" value="deny" formnovalidate>拒绝</button>
        <button class="btn-approve" type="submit" name="decision" value="approve">允许授权</button>
      </div>
    </form>
  </div>
</body>
</html>`;
  renderHtmlPage(response, 200, html);
}

function extractClientCredentials(request, body) {
  let headerClientId = "";
  let headerClientSecret = "";
  const authHeader = String(request.headers.authorization || "").trim();
  const basicMatch = authHeader.match(/^Basic\s+(.+)$/i);
  if (basicMatch) {
    try {
      const decoded = Buffer.from(basicMatch[1].trim(), "base64").toString("utf8");
      const colonIdx = decoded.indexOf(":");
      if (colonIdx >= 0) {
        const rawId = decoded.slice(0, colonIdx);
        const rawSecret = decoded.slice(colonIdx + 1);
        try {
          headerClientId = decodeURIComponent(rawId.replace(/\+/g, "%20"));
        } catch {
          headerClientId = rawId;
        }
        try {
          headerClientSecret = decodeURIComponent(rawSecret.replace(/\+/g, "%20"));
        } catch {
          headerClientSecret = rawSecret;
        }
      }
    } catch {}
  }
  const bodyClientId = String(body?.client_id || "").trim();
  const bodyClientSecret = String(body?.client_secret || "").trim();
  if (headerClientId && bodyClientId && headerClientId !== bodyClientId) {
    return { mismatch: true };
  }
  return {
    mismatch: false,
    clientId: headerClientId || bodyClientId,
    clientSecret: headerClientSecret || bodyClientSecret
  };
}

function issueTokenPair({ clientId, scope, resource }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const accessPayload = {
    typ: "at",
    jti: crypto.randomUUID(),
    cid: clientId,
    scp: scope || DEFAULT_SCOPE,
    res: resource || "",
    iat: nowSec,
    exp: nowSec + ACCESS_TOKEN_TTL_SECONDS
  };
  const refreshPayload = {
    typ: "rt",
    jti: crypto.randomUUID(),
    cid: clientId,
    scp: scope || DEFAULT_SCOPE,
    res: resource || "",
    iat: nowSec,
    exp: nowSec + REFRESH_TOKEN_TTL_SECONDS
  };
  return {
    access_token: signToken("mcpat", accessPayload),
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: signToken("mcprt", refreshPayload),
    scope: accessPayload.scp
  };
}

function buildProtectedResourceMetadata(origin, resourcePath) {
  const cleanPath = String(resourcePath || "").replace(/\/+$/, "");
  const resource = cleanPath && cleanPath !== "/" ? `${origin}${cleanPath}` : origin;
  return {
    resource,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: [DEFAULT_SCOPE]
  };
}

function buildAuthorizationServerMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [DEFAULT_SCOPE]
  };
}

function pruneStoredClients() {
  const entries = Object.entries(oauthState.clients);
  if (entries.length <= MAX_DCR_CLIENTS) return;
  entries.sort((a, b) => (Number(a[1]?.created_at) || 0) - (Number(b[1]?.created_at) || 0));
  const removeCount = entries.length - MAX_DCR_CLIENTS;
  for (let i = 0; i < removeCount; i += 1) {
    delete oauthState.clients[entries[i][0]];
  }
}

async function handleDynamicClientRegistration(request, response) {
  let body;
  try {
    body = await readFormOrJsonBody(request, 256 * 1024);
  } catch (error) {
    sendOAuthError(response, error.statusCode || 400, "invalid_client_metadata", error.message || "Invalid JSON");
    return;
  }
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (redirectUris.length === 0 || redirectUris.length > 20 || !redirectUris.every((uri) => isValidRedirectUri(uri))) {
    sendOAuthError(response, 400, "invalid_redirect_uri", "redirect_uris must be a non-empty array of valid HTTPS or localhost URIs");
    return;
  }
  const requestedAuthMethod = String(body.token_endpoint_auth_method || "client_secret_basic").trim();
  const allowedAuthMethods = new Set(["none", "client_secret_post", "client_secret_basic"]);
  const tokenEndpointAuthMethod = allowedAuthMethods.has(requestedAuthMethod) ? requestedAuthMethod : "client_secret_basic";
  const isPublic = tokenEndpointAuthMethod === "none";
  const clientId = createDcrClientId(isPublic);
  const clientSecret = isPublic ? "" : deriveDcrSecret(clientId);
  const issuedAt = Math.floor(Date.now() / 1000);
  const clientName = String(body.client_name || "MCP Client").trim().slice(0, 120) || "MCP Client";
  const grantTypes = Array.isArray(body.grant_types) && body.grant_types.length
    ? body.grant_types.map((g) => String(g)).filter((g) => g === "authorization_code" || g === "refresh_token")
    : ["authorization_code", "refresh_token"];
  if (!grantTypes.includes("authorization_code")) grantTypes.unshift("authorization_code");
  const responseTypes = ["code"];

  oauthState.clients[clientId] = {
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    created_at: issuedAt
  };
  pruneStoredClients();
  await saveOAuthStateToStorage();

  addDebugLog("OAUTH_DCR", `动态注册 OAuth 客户端: ${clientName}`, {
    clientId,
    tokenEndpointAuthMethod,
    redirectUris
  });

  const payload = {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: tokenEndpointAuthMethod
  };
  if (!isPublic) {
    payload.client_secret = clientSecret;
    payload.client_secret_expires_at = 0;
  }

  setCorsHeaders(response);
  response.writeHead(201, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Pragma: "no-cache"
  });
  response.end(JSON.stringify(payload));
}

function handleAuthorizeGet(request, response, reqUrl) {
  cleanupExpiredMaps();
  const origin = getPublicOrigin(request);
  const clientId = (reqUrl.searchParams.get("client_id") || "").trim();
  const rawRedirectUri = (reqUrl.searchParams.get("redirect_uri") || "").trim();
  const responseType = (reqUrl.searchParams.get("response_type") || "").trim();
  const state = reqUrl.searchParams.get("state") || "";
  const scope = (reqUrl.searchParams.get("scope") || "").trim() || DEFAULT_SCOPE;
  const codeChallenge = (reqUrl.searchParams.get("code_challenge") || "").trim();
  const codeChallengeMethod = (reqUrl.searchParams.get("code_challenge_method") || "").trim();
  const rawResource = (reqUrl.searchParams.get("resource") || "").trim();

  const client = lookupClient(clientId);
  if (!client) {
    renderOAuthErrorPage(response, "无效的客户端 ID", "未识别的 OAuth client_id，请核对配置或重新注册客户端。");
    return;
  }
  const redirectUri = rawRedirectUri || (client.redirectUris.length === 1 ? client.redirectUris[0] : "");
  if (!isValidRedirectUri(redirectUri)) {
    renderOAuthErrorPage(response, "无效的重定向地址", "redirect_uri 必须为合法的 HTTPS 或本地回调地址。");
    return;
  }
  if (client.redirectUris.length > 0 && !client.redirectUris.includes(redirectUri)) {
    renderOAuthErrorPage(response, "重定向地址未授权", "请求的 redirect_uri 与客户端注册的地址不匹配。");
    return;
  }

  if (responseType !== "code") {
    sendRedirect(response, buildRedirectWithParams(redirectUri, {
      error: "unsupported_response_type",
      error_description: "Only response_type=code is supported",
      state
    }));
    return;
  }

  if (codeChallenge) {
    if (codeChallengeMethod !== "S256") {
      sendRedirect(response, buildRedirectWithParams(redirectUri, {
        error: "invalid_request",
        error_description: "Only S256 code_challenge_method is supported",
        state
      }));
      return;
    }
  } else if (client.isPublic) {
    sendRedirect(response, buildRedirectWithParams(redirectUri, {
      error: "invalid_request",
      error_description: "PKCE code_challenge is required for public clients",
      state
    }));
    return;
  }

  let resource = "";
  if (rawResource) {
    const normalizedResource = normalizeResourceUrl(rawResource, origin);
    if (normalizedResource === null) {
      sendRedirect(response, buildRedirectWithParams(redirectUri, {
        error: "invalid_target",
        error_description: "Resource indicator does not match this server",
        state
      }));
      return;
    }
    resource = normalizedResource;
  }

  const txId = crypto.randomBytes(18).toString("base64url");
  const csrfToken = crypto.randomBytes(18).toString("base64url");
  const tx = {
    csrfToken,
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUri,
    hasExplicitRedirectUri: Boolean(rawRedirectUri),
    state,
    scope,
    resource,
    codeChallenge,
    codeChallengeMethod: codeChallenge ? "S256" : "",
    createdAt: Date.now(),
    expiresAt: Date.now() + PENDING_TX_TTL_MS
  };
  pendingAuthorizations.set(txId, tx);

  const requirePassword = Boolean(PANEL_PASSWORD || API_ACCESS_KEY);
  const hasPanelSession = Boolean(PANEL_PASSWORD && verifySessionToken(parseCookies(request).panel_auth));
  renderAuthorizePage(response, { txId, tx, requirePassword, hasPanelSession });
}

async function handleAuthorizePost(request, response) {
  cleanupExpiredMaps();
  let body;
  try {
    body = await readFormOrJsonBody(request, 64 * 1024);
  } catch {
    renderOAuthErrorPage(response, "请求格式错误", "无法解析授权表单数据。");
    return;
  }
  const txId = String(body.tx_id || "").trim();
  const csrfToken = String(body.csrf_token || "").trim();
  const decision = String(body.decision || "").trim();
  const password = String(body.password || "").trim();

  const tx = pendingAuthorizations.get(txId);
  if (!tx || tx.expiresAt <= Date.now() || !safeEqual(tx.csrfToken, csrfToken)) {
    renderOAuthErrorPage(response, "授权会话已失效", "授权确认页面已超时或重复提交，请返回客户端重新发起连接。");
    return;
  }

  if (decision !== "approve") {
    pendingAuthorizations.delete(txId);
    addDebugLog("OAUTH_AUTH", `拒绝 OAuth 授权: ${tx.clientName}`, { clientId: tx.clientId, redirectUri: tx.redirectUri });
    sendRedirect(response, buildRedirectWithParams(tx.redirectUri, {
      error: "access_denied",
      error_description: "The resource owner denied the request",
      state: tx.state
    }));
    return;
  }

  const requirePassword = Boolean(PANEL_PASSWORD || API_ACCESS_KEY);
  const hasPanelSession = Boolean(PANEL_PASSWORD && verifySessionToken(parseCookies(request).panel_auth));
  if (requirePassword && !hasPanelSession) {
    const validPanelPassword = Boolean(PANEL_PASSWORD && safeEqual(password, PANEL_PASSWORD));
    const validApiKey = Boolean(API_ACCESS_KEY && safeEqual(password, API_ACCESS_KEY));
    if (!validPanelPassword && !validApiKey) {
      renderAuthorizePage(response, {
        txId,
        tx,
        requirePassword,
        hasPanelSession: false,
        errorMessage: "密码验证失败，请重新输入。"
      });
      return;
    }
  }

  pendingAuthorizations.delete(txId);
  const code = `mcpc_${crypto.randomBytes(24).toString("base64url")}`;
  authorizationCodes.set(code, {
    clientId: tx.clientId,
    redirectUri: tx.redirectUri,
    hasExplicitRedirectUri: tx.hasExplicitRedirectUri,
    scope: tx.scope,
    resource: tx.resource,
    codeChallenge: tx.codeChallenge,
    codeChallengeMethod: tx.codeChallengeMethod,
    createdAt: Date.now(),
    expiresAt: Date.now() + AUTH_CODE_TTL_MS
  });

  addDebugLog("OAUTH_AUTH", `已批准 OAuth 授权: ${tx.clientName}`, {
    clientId: tx.clientId,
    redirectUri: tx.redirectUri,
    resource: tx.resource || "(all)"
  });

  sendRedirect(response, buildRedirectWithParams(tx.redirectUri, {
    code,
    state: tx.state
  }));
}

async function handleTokenPost(request, response) {
  cleanupExpiredMaps();
  let body;
  try {
    body = await readFormOrJsonBody(request, 128 * 1024);
  } catch (error) {
    sendOAuthError(response, error.statusCode || 400, "invalid_request", error.message || "Invalid request body");
    return;
  }

  const origin = getPublicOrigin(request);
  const grantType = String(body.grant_type || "").trim();
  const creds = extractClientCredentials(request, body);
  if (creds.mismatch) {
    sendOAuthError(response, 401, "invalid_client", "Conflicting client_id values");
    return;
  }

  if (grantType === "authorization_code") {
    const code = String(body.code || "").trim();
    const redirectUri = String(body.redirect_uri || "").trim();
    const codeVerifier = String(body.code_verifier || "").trim();
    const rawResource = String(body.resource || "").trim();

    if (!code || !creds.clientId) {
      sendOAuthError(response, 400, "invalid_request", "Missing required parameters");
      return;
    }

    const record = authorizationCodes.get(code);
    authorizationCodes.delete(code);
    if (!record || record.expiresAt <= Date.now()) {
      sendOAuthError(response, 400, "invalid_grant", "Authorization code is invalid or expired");
      return;
    }
    if (!safeEqual(record.clientId, creds.clientId)) {
      sendOAuthError(response, 400, "invalid_grant", "Authorization code does not match client_id");
      return;
    }
    if ((record.hasExplicitRedirectUri || redirectUri) && record.redirectUri !== redirectUri) {
      sendOAuthError(response, 400, "invalid_grant", "redirect_uri mismatch");
      return;
    }

    const client = lookupClient(creds.clientId);
    if (!client) {
      sendOAuthError(response, 401, "invalid_client", "Unknown client");
      return;
    }
    if (!client.isPublic) {
      if (!creds.clientSecret || !safeEqual(creds.clientSecret, client.clientSecret)) {
        sendOAuthError(response, 401, "invalid_client", "Client authentication failed");
        return;
      }
    }

    if (record.codeChallenge) {
      if (!codeVerifier) {
        sendOAuthError(response, 400, "invalid_grant", "Missing code_verifier");
        return;
      }
      const computed = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
      if (!safeEqual(computed, record.codeChallenge)) {
        sendOAuthError(response, 400, "invalid_grant", "Invalid PKCE code_verifier");
        return;
      }
    } else if (client.isPublic) {
      sendOAuthError(response, 400, "invalid_grant", "PKCE is required");
      return;
    }

    let resource = record.resource;
    if (rawResource) {
      const normalized = normalizeResourceUrl(rawResource, origin);
      if (normalized === null) {
        sendOAuthError(response, 400, "invalid_target", "Invalid resource indicator");
        return;
      }
      if (resource && resource.toLowerCase() !== normalized.toLowerCase()) {
        sendOAuthError(response, 400, "invalid_target", "Resource indicator mismatch");
        return;
      }
      resource = normalized;
    }

    const tokenPair = issueTokenPair({
      clientId: client.clientId,
      scope: record.scope,
      resource
    });
    addDebugLog("OAUTH_TOKEN", `签发 OAuth Token (authorization_code)`, {
      clientId: client.clientId,
      resource: resource || "(all)"
    });
    setCorsHeaders(response);
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Pragma: "no-cache"
    });
    response.end(JSON.stringify(tokenPair));
    return;
  }

  if (grantType === "refresh_token") {
    const refreshToken = String(body.refresh_token || "").trim();
    if (!refreshToken) {
      sendOAuthError(response, 400, "invalid_request", "Missing refresh_token");
      return;
    }
    const payload = verifyToken(refreshToken, "mcprt");
    if (!payload) {
      sendOAuthError(response, 400, "invalid_grant", "Refresh token is invalid or expired");
      return;
    }
    const clientId = creds.clientId || String(payload.cid || "");
    if (!clientId || !safeEqual(clientId, payload.cid)) {
      sendOAuthError(response, 400, "invalid_grant", "Refresh token client mismatch");
      return;
    }
    const client = lookupClient(clientId);
    if (!client) {
      sendOAuthError(response, 401, "invalid_client", "Unknown client");
      return;
    }
    if (!client.isPublic) {
      if (!creds.clientSecret || !safeEqual(creds.clientSecret, client.clientSecret)) {
        sendOAuthError(response, 401, "invalid_client", "Client authentication failed");
        return;
      }
    }
    const rawResource = String(body.resource || "").trim();
    let resource = String(payload.res || "");
    if (rawResource) {
      const normalized = normalizeResourceUrl(rawResource, origin);
      if (normalized === null) {
        sendOAuthError(response, 400, "invalid_target", "Invalid resource indicator");
        return;
      }
      if (resource && resource.toLowerCase() !== normalized.toLowerCase()) {
        sendOAuthError(response, 400, "invalid_target", "Resource indicator mismatch");
        return;
      }
      resource = normalized;
    }

    const tokenPair = issueTokenPair({
      clientId: client.clientId,
      scope: payload.scp || DEFAULT_SCOPE,
      resource
    });
    addDebugLog("OAUTH_TOKEN", `刷新 OAuth Token (refresh_token)`, {
      clientId: client.clientId,
      resource: resource || "(all)"
    });
    setCorsHeaders(response);
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Pragma: "no-cache"
    });
    response.end(JSON.stringify(tokenPair));
    return;
  }

  sendOAuthError(response, 400, "unsupported_grant_type", "Supported grant types are authorization_code and refresh_token");
}

async function handleRevokePost(request, response) {
  let body = {};
  try {
    body = await readFormOrJsonBody(request, 64 * 1024);
  } catch {}
  const token = String(body.token || "").trim();
  if (token) {
    const parsed = verifyToken(token, "mcpat") || verifyToken(token, "mcprt");
    if (parsed?.jti && Number.isFinite(parsed.exp)) {
      revokedJtis.set(parsed.jti, parsed.exp * 1000);
    }
  }
  setCorsHeaders(response);
  response.writeHead(200, { "Cache-Control": "no-store" });
  response.end();
}

export async function handleOAuthRequest(request, response, reqUrl) {
  const pathname = reqUrl.pathname;
  const origin = getPublicOrigin(request);

  const prmMatch = pathname.match(/^\/\.well-known\/oauth-protected-resource(\/.*)?$/);
  if (prmMatch && (request.method === "GET" || request.method === "HEAD")) {
    const metadata = buildProtectedResourceMetadata(origin, prmMatch[1] || "");
    setCorsHeaders(response);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? "" : JSON.stringify(metadata));
    return true;
  }

  const isAsMetadataPath = pathname === "/.well-known/oauth-authorization-server"
    || pathname.startsWith("/.well-known/oauth-authorization-server/")
    || pathname === "/.well-known/openid-configuration"
    || pathname.startsWith("/.well-known/openid-configuration/")
    || /^\/mcp(?:\/[^/]+)?\/\.well-known\/(?:oauth-authorization-server|openid-configuration)\/?$/.test(pathname);
  if (isAsMetadataPath && (request.method === "GET" || request.method === "HEAD")) {
    const metadata = buildAuthorizationServerMetadata(origin);
    setCorsHeaders(response);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? "" : JSON.stringify(metadata));
    return true;
  }

  if (pathname === "/oauth/register") {
    if (request.method !== "POST") {
      sendOAuthError(response, 405, "invalid_request", "Method not allowed");
      return true;
    }
    await handleDynamicClientRegistration(request, response);
    return true;
  }

  if (pathname === "/oauth/authorize") {
    if (request.method === "GET") {
      handleAuthorizeGet(request, response, reqUrl);
      return true;
    }
    if (request.method === "POST") {
      await handleAuthorizePost(request, response);
      return true;
    }
    sendOAuthError(response, 405, "invalid_request", "Method not allowed");
    return true;
  }

  if (pathname === "/oauth/token") {
    if (request.method !== "POST") {
      sendOAuthError(response, 405, "invalid_request", "Method not allowed");
      return true;
    }
    await handleTokenPost(request, response);
    return true;
  }

  if (pathname === "/oauth/revoke") {
    if (request.method !== "POST") {
      sendOAuthError(response, 405, "invalid_request", "Method not allowed");
      return true;
    }
    await handleRevokePost(request, response);
    return true;
  }

  return false;
}

export function getOAuthPanelInfo(request) {
  const origin = getPublicOrigin(request);
  const staticClient = getStaticClient();
  return {
    authRequired: isMcpAuthRequired(),
    issuer: origin,
    mcpUrl: `${origin}/mcp`,
    githubMcpUrl: `${origin}/mcp/github`,
    clientId: staticClient.clientId,
    clientSecret: staticClient.clientSecret,
    envLockedCredentials: Boolean(OAUTH_CLIENT_ID || OAUTH_CLIENT_SECRET),
    allowedRedirectUris: oauthState.allowedRedirectUris,
    envRedirectUris: parseRedirectUriList(OAUTH_REDIRECT_URIS).filter((uri) => isValidRedirectUri(uri)),
    dynamicClientCount: Object.keys(oauthState.clients).length
  };
}

export async function updateOAuthSettings({ allowedRedirectUris }) {
  const list = parseRedirectUriList(allowedRedirectUris);
  const invalid = list.filter((uri) => !isValidRedirectUri(uri));
  if (invalid.length > 0) {
    throw new Error(`无效的重定向 URI：${invalid[0]}`);
  }
  oauthState.allowedRedirectUris = Array.from(new Set(list));
  await saveOAuthStateToStorage();
  return oauthState.allowedRedirectUris;
}
