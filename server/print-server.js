#!/usr/bin/env node
/*
 * 인생네컷 — 로컬 인쇄 서버
 *
 * 브라우저에는 "말없이 프린터로 보내는" 기능이 없습니다. 그래서 사진을 이 작은 서버로
 * 보내고, 서버가 운영체제의 인쇄 명령(lp / mspaint)을 대신 실행합니다.
 * 설치할 것은 없습니다. Node 18 이상이면 그냥 돕니다.
 *
 *   node photo/server/print-server.js
 *   node photo/server/print-server.js --port 8787 --printer "Selphy CP1500"
 *
 * 이 서버는 photo/index.html 도 같이 띄워 줍니다. http://localhost:8787 로 열면
 * 카메라 권한(보안 컨텍스트)과 자동 인쇄가 한 번에 해결됩니다.
 */

"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

/* ── 실행 옵션 ── */
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
}
const PORT = Number(arg("port", process.env.PORT || 8787));
const HOST = arg("host", "127.0.0.1");
const WEBROOT = path.resolve(arg("dir", path.join(__dirname, "..")));
const FIXED_PRINTER = arg("printer", "");
const NO_FIT = argv.includes("--no-fit");
const MAX_BODY = 48 * 1024 * 1024;
const WIN = process.platform === "win32";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp"
};

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, Object.assign({ windowsHide: true, timeout: 120000 }, opts || {}),
      (err, stdout, stderr) => {
        if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
        resolve(String(stdout || ""));
      });
  });
}

/* ── 프린터 목록 ── */
async function listPrinters() {
  try {
    if (WIN) {
      const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "Get-Printer | Select-Object -ExpandProperty Name"]);
      return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }
    const out = await run("lpstat", ["-a"]);
    return out.split(/\r?\n/).map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
  } catch (e) {
    return [];
  }
}

async function defaultPrinter() {
  if (FIXED_PRINTER) return FIXED_PRINTER;
  try {
    if (WIN) {
      const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "(Get-CimInstance -Class Win32_Printer -Filter 'Default=True').Name"]);
      return out.trim();
    }
    const out = await run("lpstat", ["-d"]);           // "system default destination: NAME"
    const m = out.match(/:\s*(\S+)/);
    return m ? m[1] : "";
  } catch (e) {
    return "";
  }
}

/* ── 실제 인쇄 ── */
async function printFile(file, { printer, copies, media }) {
  copies = Math.max(1, Math.min(50, Number(copies) || 1));

  if (WIN) {
    // mspaint 는 매수 옵션이 없어 장수만큼 반복합니다.
    const target = printer || (await defaultPrinter());
    for (let i = 0; i < copies; i++) {
      await run("mspaint.exe", ["/pt", file, target]);
    }
    return { printer: target || "(기본 프린터)", copies, how: "mspaint" };
  }

  const args = [];
  if (printer) args.push("-d", printer);
  args.push("-n", String(copies));
  if (media && media.w && media.h) {
    // CUPS 사용자 정의 용지. 프린터가 정확한 규격을 이미 갖고 있으면 그쪽이 우선합니다.
    args.push("-o", `media=Custom.${media.w}x${media.h}mm`);
  }
  if (!NO_FIT) args.push("-o", "fit-to-page");
  args.push("-o", "print-quality=5");
  args.push(file);

  let out;
  try {
    out = await run("lp", args);
  } catch (e) {
    // 사용자 정의 용지를 거부하는 프린터가 있어, 한 번은 옵션 없이 다시 시도합니다.
    const plain = [];
    if (printer) plain.push("-d", printer);
    plain.push("-n", String(copies), file);
    out = await run("lp", plain);
  }
  return {
    printer: printer || (await defaultPrinter()) || "(기본 프린터)",
    copies,
    how: "lp",
    job: (out.match(/request id is (\S+)/) || [])[1] || ""
  };
}

/* ── HTTP ── */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("사진이 너무 큽니다")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.join(WEBROOT, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ""));
  if (!file.startsWith(WEBROOT)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("없는 주소입니다"); }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || "/";

  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

  if (url.startsWith("/health")) {
    const [printers, def] = await Promise.all([listPrinters(), defaultPrinter()]);
    return json(res, 200, { ok: true, platform: process.platform, printers, defaultPrinter: def });
  }

  if (url.startsWith("/printers")) {
    return json(res, 200, { printers: await listPrinters(), defaultPrinter: await defaultPrinter() });
  }

  if (url.startsWith("/print") && req.method === "POST") {
    let file = "";
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString("utf8"));
      const m = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(String(body.image || ""));
      if (!m) return json(res, 400, { ok: false, error: "이미지를 찾지 못했습니다" });

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fourcut-"));
      file = path.join(dir, (String(body.name || "fourcut").replace(/[^\w.-]/g, "") || "fourcut") + "." + (m[1] === "png" ? "png" : "jpg"));
      fs.writeFileSync(file, Buffer.from(m[2], "base64"));

      const info = await printFile(file, {
        printer: FIXED_PRINTER || String(body.printer || "").trim(),
        copies: body.copies,
        media: body.media
      });
      console.log(new Date().toLocaleTimeString("ko-KR"),
        `인쇄 ${info.copies}장 → ${info.printer}${info.job ? " (" + info.job + ")" : ""}`);

      // 인쇄 큐가 파일을 다 읽을 시간을 주고 지웁니다.
      setTimeout(() => { try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch (e) {} }, 60000);
      return json(res, 200, Object.assign({ ok: true }, info));
    } catch (e) {
      console.error("인쇄 실패:", e.stderr || e.message);
      return json(res, 500, { ok: false, error: String(e.stderr || e.message || e) });
    }
  }

  if (req.method !== "GET") { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, async () => {
  const printers = await listPrinters();
  const def = await defaultPrinter();
  console.log("");
  console.log("  인생네컷 인쇄 서버");
  console.log("  ────────────────────────────────");
  console.log("  페이지   http://localhost:" + PORT);
  console.log("  폴더     " + WEBROOT);
  console.log("  프린터   " + (printers.length ? printers.join(", ") : "(찾지 못함 — 연결과 드라이버를 확인하세요)"));
  console.log("  기본     " + (def || "(없음)"));
  console.log("  ────────────────────────────────");
  console.log("  이 창을 닫으면 자동 인쇄도 멈춥니다. Ctrl+C 로 종료.");
  console.log("");
});
