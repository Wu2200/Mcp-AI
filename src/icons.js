import zlib from "node:zlib";
import { SITE_ICON_URL, setCorsHeaders } from "./store.js";

const GITHUB_MARK_PATH = "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12Z";

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -2.703 30 30" width="128" height="128"><rect x="-3" y="-2.703" width="30" height="30" fill="#181717"/><circle cx="12" cy="12.297" r="11.88" fill="#ffffff"/><path fill="#181717" d="${GITHUB_MARK_PATH}"/></svg>`;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, crcInput, crcBuf]);
}

function encodeRgbaToPng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + stride);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makePngChunk("IHDR", ihdr),
    makePngChunk("IDAT", compressed),
    makePngChunk("IEND", Buffer.alloc(0))
  ]);
}

function buildMarkPolygon() {
  const tokens = GITHUB_MARK_PATH.match(/[MmCcZz]|[-+]?(?:\d+\.\d*|\.\d+|\d+)/g) || [];
  const poly = [];
  let index = 0;
  let cmd = "";
  let cx = 0;
  let cy = 0;
  const steps = 24;

  const sampleCubic = (x0, y0, x1, y1, x2, y2, x3, y3) => {
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      const mt = 1 - t;
      const px = mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
      const py = mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
      poly.push([px, py]);
    }
  };

  while (index < tokens.length) {
    const tok = tokens[index];
    if (/^[A-Za-z]$/.test(tok)) {
      cmd = tok;
      index += 1;
      if (cmd === "Z" || cmd === "z") break;
      continue;
    }
    if (cmd === "M") {
      cx = Number(tokens[index]);
      cy = Number(tokens[index + 1]);
      poly.push([cx, cy]);
      index += 2;
      cmd = "L";
    } else if (cmd === "C") {
      const x1 = Number(tokens[index]);
      const y1 = Number(tokens[index + 1]);
      const x2 = Number(tokens[index + 2]);
      const y2 = Number(tokens[index + 3]);
      const x = Number(tokens[index + 4]);
      const y = Number(tokens[index + 5]);
      sampleCubic(cx, cy, x1, y1, x2, y2, x, y);
      cx = x;
      cy = y;
      index += 6;
    } else if (cmd === "c") {
      const x1 = cx + Number(tokens[index]);
      const y1 = cy + Number(tokens[index + 1]);
      const x2 = cx + Number(tokens[index + 2]);
      const y2 = cy + Number(tokens[index + 3]);
      const x = cx + Number(tokens[index + 4]);
      const y = cy + Number(tokens[index + 5]);
      sampleCubic(cx, cy, x1, y1, x2, y2, x, y);
      cx = x;
      cy = y;
      index += 6;
    } else {
      index += 1;
    }
  }
  return poly;
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

const MARK_POLYGON = buildMarkPolygon();

function renderGitHubIconPng(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const minX = -3;
  const minY = -2.703;
  const span = 30;
  const centerX = 12;
  const centerY = 12.297;
  const radiusSq = 11.88 * 11.88;
  const bgR = 0x18;
  const bgG = 0x17;
  const bgB = 0x17;
  const grid = 4;
  const totalSamples = grid * grid;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let fgHits = 0;
      for (let sy = 0; sy < grid; sy += 1) {
        const vy = minY + ((py + (sy + 0.5) / grid) / size) * span;
        const dy = vy - centerY;
        const dySq = dy * dy;
        for (let sx = 0; sx < grid; sx += 1) {
          const vx = minX + ((px + (sx + 0.5) / grid) / size) * span;
          const dx = vx - centerX;
          if (dx * dx + dySq <= radiusSq && !pointInPolygon(vx, vy, MARK_POLYGON)) {
            fgHits += 1;
          }
        }
      }
      const ratio = fgHits / totalSamples;
      const offset = (py * size + px) * 4;
      rgba[offset] = Math.round(bgR + (255 - bgR) * ratio);
      rgba[offset + 1] = Math.round(bgG + (255 - bgG) * ratio);
      rgba[offset + 2] = Math.round(bgB + (255 - bgB) * ratio);
      rgba[offset + 3] = 255;
    }
  }
  return encodeRgbaToPng(size, size, rgba);
}

function buildIcoFromPngs(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const dirBuffers = [];
  let offset = 6 + entries.length * 16;
  for (const { size, png } of entries) {
    const dir = Buffer.alloc(16);
    dir[0] = size >= 256 ? 0 : size;
    dir[1] = size >= 256 ? 0 : size;
    dir[2] = 0;
    dir[3] = 0;
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(png.length, 8);
    dir.writeUInt32LE(offset, 12);
    dirBuffers.push(dir);
    offset += png.length;
  }
  return Buffer.concat([header, ...dirBuffers, ...entries.map((item) => item.png)]);
}

const ICON_PNG_32 = renderGitHubIconPng(32);
const ICON_PNG_64 = renderGitHubIconPng(64);
const ICON_PNG_128 = renderGitHubIconPng(128);
const ICON_PNG_180 = renderGitHubIconPng(180);
const ICON_ICO = buildIcoFromPngs([
  { size: 32, png: ICON_PNG_32 },
  { size: 64, png: ICON_PNG_64 }
]);
const ICON_SVG_BUFFER = Buffer.from(ICON_SVG, "utf8");

const ROBOTS_TXT = Buffer.from(
  "User-agent: *\nAllow: /favicon.ico\nAllow: /favicon.png\nAllow: /favicon.svg\nAllow: /apple-touch-icon.png\nDisallow: /api/\nDisallow: /mcp\n",
  "utf8"
);

function getCustomIconUrl() {
  if (!SITE_ICON_URL) return "";
  try {
    const parsed = new URL(SITE_ICON_URL);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.toString();
    }
  } catch {}
  return "";
}

function escapeAttr(value) {
  return String(value || "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[ch]);
}

export function getHtmlIconLinks() {
  const customUrl = getCustomIconUrl();
  if (customUrl) {
    const safe = escapeAttr(customUrl);
    return `<link rel="icon" href="${safe}">\n  <link rel="shortcut icon" href="${safe}">\n  <link rel="apple-touch-icon" href="${safe}">`;
  }
  return [
    `<link rel="icon" type="image/png" sizes="128x128" href="/favicon.png">`,
    `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`,
    `<link rel="shortcut icon" href="/favicon.ico">`,
    `<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">`
  ].join("\n  ");
}

export function getMcpServerIcons(origin) {
  const customUrl = getCustomIconUrl();
  if (customUrl) {
    return [{ src: customUrl }];
  }
  return [
    { src: `${origin}/favicon.png`, mimeType: "image/png", sizes: ["128x128"] },
    { src: `${origin}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] }
  ];
}

function sendStaticAsset(request, response, contentType, buffer) {
  setCorsHeaders(response);
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": buffer.length,
    "Cache-Control": "public, max-age=3600"
  });
  response.end(request.method === "HEAD" ? undefined : buffer);
}

export function handleIconRequest(request, response, reqUrl) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const pathname = reqUrl.pathname.toLowerCase();
  if (pathname === "/favicon.ico") {
    sendStaticAsset(request, response, "image/x-icon", ICON_ICO);
    return true;
  }
  if (pathname === "/favicon.png" || pathname === "/icon.png") {
    sendStaticAsset(request, response, "image/png", ICON_PNG_128);
    return true;
  }
  if (pathname === "/favicon.svg" || pathname === "/icon.svg") {
    sendStaticAsset(request, response, "image/svg+xml; charset=utf-8", ICON_SVG_BUFFER);
    return true;
  }
  if (pathname === "/apple-touch-icon.png" || pathname === "/apple-touch-icon-precomposed.png") {
    sendStaticAsset(request, response, "image/png", ICON_PNG_180);
    return true;
  }
  if (pathname === "/robots.txt") {
    sendStaticAsset(request, response, "text/plain; charset=utf-8", ROBOTS_TXT);
    return true;
  }
  return false;
}
