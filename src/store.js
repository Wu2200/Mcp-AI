import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
export const PROJECT_ROOT = path.resolve(path.dirname(__filename), "..");

export const PORT = Number(process.env.PORT || 10000);
export const PROXY_API_KEY = (process.env.PROXY_API_KEY || "").trim();
export const PANEL_PASSWORD = (process.env.PANEL_PASSWORD || "").trim();
export const DATABASE_URL = (process.env.DATABASE_URL || "").trim();

const DATA_FILE = path.join(PROJECT_ROOT, "mcp-config.json");
const SETTINGS_FILE = path.join(PROJECT_ROOT, "mcp-settings.json");

export const mcpServers = new Map();
export const mcpToolRegistry = new Map();
export let loggingEnabled = true;
export const MAX_LOGS = 1000;
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
  dbPool = new Pool({
    connectionString,
    ssl: DATABASE_URL.includes("sslmode=disable") ? false : { rejectUnauthorized: false }
  });
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
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

export function isProxyAuthorized(request) {
  if (!PROXY_API_KEY) return true;
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const queryToken = requestUrl.searchParams.get("key") || requestUrl.searchParams.get("token") || requestUrl.searchParams.get("api_key") || "";
  if (queryToken.trim() === PROXY_API_KEY) return true;
  const headerToken = request.headers["x-goog-api-key"] || request.headers["x-api-key"] || request.headers["api-key"] || "";
  if (headerToken.trim() === PROXY_API_KEY) return true;
  return (request.headers.authorization || "").replace(/^Bearer\s+/i, "").trim() === PROXY_API_KEY;
}

export function isPanelAuthorized(request) {
  if (!PANEL_PASSWORD) return true;
  if (verifySessionToken(parseCookies(request).panel_auth)) return true;
  return String(request.headers["x-panel-password"] || "").trim() === PANEL_PASSWORD;
}

const SESSION_SECRET = PANEL_PASSWORD
  ? crypto.createHash("sha256").update(`mcp-proxy-session:${PANEL_PASSWORD}`).digest("hex")
  : crypto.randomBytes(32).toString("hex");
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateSessionToken() {
  const payload = `auth:${PANEL_PASSWORD}:${Date.now()}`;
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}:${signature}`).toString("base64url");
}

export function verifySessionToken(token) {
  if (!PANEL_PASSWORD) return true;
  if (!token) return false;
  try {
    const parts = Buffer.from(token, "base64url").toString("utf8").split(":");
    if (parts.length !== 4 || parts[0] !== "auth" || parts[1] !== PANEL_PASSWORD) return false;
    const issuedAt = Number(parts[2]);
    const now = Date.now();
    if (!Number.isFinite(issuedAt) || issuedAt <= 0 || now - issuedAt > SESSION_TTL_MS || issuedAt > now + 60000) return false;
    const payload = `${parts[0]}:${parts[1]}:${parts[2]}`;
    const expected = Buffer.from(crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex"));
    const actual = Buffer.from(parts[3]);
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

export function readRequestBody(request, limit = 30 * 1024 * 1024) {
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
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error("无效 JSON"), { statusCode: 400 }));
      }
    };
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("close", onClose);
  });
}
