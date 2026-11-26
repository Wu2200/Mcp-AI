import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
export const PROJECT_ROOT = path.resolve(path.dirname(__filename), "..");

export const PORT = Number(process.env.PORT || 10000);
export const ACCESS_KEY = (process.env.MCP_API_KEY || process.env.PROXY_API_KEY || process.env.PANEL_PASSWORD || "").trim();
export const API_ACCESS_KEY = ACCESS_KEY;
export const PANEL_PASSWORD = ACCESS_KEY;
export const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
export const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || "").trim();
export const GITHUB_API_URL = (process.env.GITHUB_API_URL || "https://api.github.com").trim().replace(/\/+$/, "");
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
export const OAUTH_CLIENT_ID = (process.env.OAUTH_CLIENT_ID || "").trim();
export const OAUTH_CLIENT_SECRET = (process.env.OAUTH_CLIENT_SECRET || "").trim();
export const OAUTH_REDIRECT_URIS = (process.env.OAUTH_REDIRECT_URIS || "").trim();
export const OAUTH_SIGNING_SECRET = (process.env.OAUTH_SIGNING_SECRET || "").trim();
export const OAUTH_REQUIRED = String(process.env.OAUTH_REQUIRED || "").trim().toLowerCase() === "true";

const DATA_FILE = path.join(PROJECT_ROOT, "mcp-config.json");
const SETTINGS_FILE = path.join(PROJECT_ROOT, "mcp-settings.json");
const LEGACY_CHANNELS_FILE = path.join(PROJECT_ROOT, "mcp-channels.json");

export const mcpServers = new Map();
export const mcpToolRegistry = new Map();
export let loggingEnabled = true;
export const MAX_LOGS = 150;
export const mcpCallLogs = [];

export function addDebugLog(type, summary, detail = "") {
  const now = new Date();
  const time = now.toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(now.getMilliseconds()).padStart(3, "0");
  let detailText;
  try {
    detailText = typeof detail === "object" ? JSON.stringify(detail, null, 2) : String(detail);
  } catch {
    detailText = String(detail);
  }
  const entry = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    time,
    type,
    category: "mcp",
    summary: String(summary || ""),
    detail: detailText
  };
  if (type === "ERROR") console.error(`[${time}] [MCP服务-错误] ${entry.summary.slice(0, 200)}`);
  else console.log(`[${time}] [MCP服务] ${entry.summary}`);
  if (!loggingEnabled) return;
  mcpCallLogs.push(entry);
  if (mcpCallLogs.length > MAX_LOGS) mcpCallLogs.shift();
}

export let dbPool = null;
if (DATABASE_URL) {
  let connectionString = DATABASE_URL;
  try {
    const parsedUrl = new URL(DATABASE_URL);
    parsedUrl.searchParams.delete("sslmode");
    connectionString = parsedUrl.toString();
  } catch {}
  dbPool = new Pool({ connectionString, ssl: DATABASE_URL.includes("sslmode=disable") ? false : { rejectUnauthorized: false } });
  dbPool.on("error", (error) => addDebugLog("ERROR", `数据库连接异常: ${error.message}`));
}

export async function initDatabase() {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS mcp_storage (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (error) {
    addDebugLog("ERROR", `数据库初始化失败: ${error.message}`);
  }
}

export async function getStorageItem(key) {
  if (!dbPool) return null;
  try {
    const result = await dbPool.query("SELECT value FROM mcp_storage WHERE key = $1", [key]);
    return result.rows.length ? JSON.parse(result.rows[0].value) : null;
  } catch (error) {
    addDebugLog("ERROR", `读取数据库项失败: ${error.message}`);
    return null;
  }
}

export async function setStorageItem(key, value) {
  if (!dbPool) return;
  try {
    await dbPool.query(
      `INSERT INTO mcp_storage (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
  } catch (error) {
    addDebugLog("ERROR", `写入数据库项失败: ${error.message}`);
  }
}

async function readLocalJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function loadSettingsFromStorage() {
  const settings = (dbPool ? await getStorageItem("settings") : null) || await readLocalJson(SETTINGS_FILE);
  if (typeof settings?.loggingEnabled === "boolean") loggingEnabled = settings.loggingEnabled;
}

export async function saveLoggingConfigToStorage(enabled) {
  loggingEnabled = enabled === true;
  const settings = { loggingEnabled };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
  } catch {}
  await setStorageItem("settings", settings);
}

export async function clearLegacyAiConfiguration() {
  if (dbPool) {
    try {
      await dbPool.query("DELETE FROM mcp_storage WHERE key = $1", ["upstream_channels"]);
    } catch (error) {
      addDebugLog("ERROR", `清理旧上游配置失败: ${error.message}`);
    }
  }
  try {
    if (fs.existsSync(LEGACY_CHANNELS_FILE)) fs.unlinkSync(LEGACY_CHANNELS_FILE);
  } catch {}
  const oldSettings = (dbPool ? await getStorageItem("settings") : null) || await readLocalJson(SETTINGS_FILE);
  if (oldSettings && ("enabledModels" in oldSettings || "activeChannelId" in oldSettings)) {
    const cleanSettings = { loggingEnabled: oldSettings.loggingEnabled !== false };
    loggingEnabled = cleanSettings.loggingEnabled;
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cleanSettings, null, 2), "utf8");
    } catch {}
    await setStorageItem("settings", cleanSettings);
  }
}

export async function getStoredServers() {
  const stored = (dbPool ? await getStorageItem("servers") : null) || await readLocalJson(DATA_FILE);
  return Array.isArray(stored) ? stored : [];
}

export async function saveServerToStorage() {
  const servers = Array.from(mcpServers.values());
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(servers, null, 2), "utf8");
  } catch (error) {
    addDebugLog("ERROR", `写入 MCP 服务配置失败: ${error.message}`);
  }
  await setStorageItem("servers", servers);
}

export async function deleteServerFromStorage() {
  await saveServerToStorage();
}

export function setCorsHeaders(response) {
  if (response.headersSent) return;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, DELETE, OPTIONS");
}

export function sendJson(response, statusCode, body) {
  if (response.headersSent) return;
  setCorsHeaders(response);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""), "utf8");
  const bufB = Buffer.from(String(b ?? ""), "utf8");
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export function isApiAuthorized(request) {
  if (!ACCESS_KEY) return true;
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const queryToken = (requestUrl.searchParams.get("key") || requestUrl.searchParams.get("token") || requestUrl.searchParams.get("api_key") || "").trim();
  if (queryToken && safeEqual(queryToken, ACCESS_KEY)) return true;
  const headerToken = String(request.headers["x-api-key"] || request.headers["api-key"] || request.headers["x-goog-api-key"] || "").trim();
  if (headerToken && safeEqual(headerToken, ACCESS_KEY)) return true;
  const bearerToken = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  return Boolean(bearerToken && safeEqual(bearerToken, ACCESS_KEY));
}

export function isPanelAuthorized(request) {
  if (!ACCESS_KEY) return true;
  if (verifySessionToken(parseCookies(request).panel_auth)) return true;
  const panelHeader = String(request.headers["x-panel-password"] || "").trim();
  if (panelHeader && safeEqual(panelHeader, ACCESS_KEY)) return true;
  const apiHeader = String(request.headers["x-api-key"] || request.headers["api-key"] || "").trim();
  if (apiHeader && safeEqual(apiHeader, ACCESS_KEY)) return true;
  const authHeader = String(request.headers.authorization || "").trim();
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  return Boolean(bearerMatch && safeEqual(bearerMatch[1].trim(), ACCESS_KEY));
}

const SESSION_SECRET = ACCESS_KEY
  ? crypto.createHash("sha256").update(`mcp-ai-session:${ACCESS_KEY}`).digest("hex")
  : crypto.randomBytes(32).toString("hex");
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateSessionToken() {
  const payload = `auth:${Date.now()}`;
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}:${signature}`).toString("base64url");
}

export function verifySessionToken(token) {
  if (!ACCESS_KEY) return true;
  if (!token) return false;
  try {
    const parts = Buffer.from(token, "base64url").toString("utf8").split(":");
    if (parts.length !== 3 || parts[0] !== "auth") return false;
    const issuedAt = Number(parts[1]);
    const now = Date.now();
    if (!Number.isFinite(issuedAt) || issuedAt <= 0 || now - issuedAt > SESSION_TTL_MS || issuedAt > now + 60000) return false;
    const payload = `${parts[0]}:${parts[1]}`;
    const expected = Buffer.from(crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex"));
    const actual = Buffer.from(parts[2]);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function parseCookies(request) {
  const cookies = {};
  for (const cookie of String(request.headers.cookie || "").split(";")) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    const key = cookie.slice(0, separator).trim();
    try {
      cookies[key] = decodeURIComponent(cookie.slice(separator + 1).trim());
    } catch {
      cookies[key] = "";
    }
  }
  return cookies;
}

export function readRawRequestBody(request, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let completed = false;
    const cleanup = () => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("close", onClose);
    };
    const fail = (error) => {
      if (completed) return;
      completed = true;
      cleanup();
      reject(error);
    };
    const onError = (error) => {
      const wrapped = new Error(error?.message || "aborted");
      wrapped.code = error?.code;
      wrapped.isClientAbort = error?.message === "aborted" || error?.code === "ECONNRESET";
      fail(wrapped);
    };
    const onClose = () => {
      if (!request.readableEnded) fail(Object.assign(new Error("aborted"), { isClientAbort: true }));
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = Object.assign(new Error("请求体过大（上限 30MB）"), { statusCode: 413 });
        fail(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (completed) return;
      completed = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("close", onClose);
  });
}

export async function readRequestBody(request, limit = 30 * 1024 * 1024) {
  const text = await readRawRequestBody(request, limit);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("无效 JSON"), { statusCode: 400 });
  }
}

export async function readFormOrJsonBody(request, limit = 2 * 1024 * 1024) {
  const text = await readRawRequestBody(request, limit);
  if (!text.trim()) return {};
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(text);
    const result = {};
    for (const [key, value] of params.entries()) {
      if (!(key in result)) result[key] = value;
    }
    return result;
  }
  try {
    return JSON.parse(text);
  } catch {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && trimmed.includes("=")) {
      const params = new URLSearchParams(trimmed);
      const result = {};
      for (const [key, value] of params.entries()) {
        if (!(key in result)) result[key] = value;
      }
      return result;
    }
    throw Object.assign(new Error("无效请求体格式"), { statusCode: 400 });
  }
}
