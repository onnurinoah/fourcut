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
 *   node photo/server/print-server.js --lan          # 폰이 QR 로 사진을 받아 갈 수 있게
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
const LAN = argv.includes("--lan");
const HOST = arg("host", LAN ? "0.0.0.0" : "127.0.0.1");
const SHARE_TTL = 30 * 60 * 1000;   // QR 주소가 살아 있는 시간
const SHARE_MAX = 60;               // 동시에 들고 있을 사진 수
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

/* ── 이 컴퓨터의 랜 주소 ── */
function lanAddress() {
  const nets = os.networkInterfaces();
  const pick = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family !== "IPv4" && n.family !== 4) continue;
      if (n.internal) continue;
      pick.push(n.address);
    }
  }
  // 공유기가 주는 사설 주소를 먼저 고릅니다. 폰이 같은 와이파이에 있을 때 닿는 주소입니다.
  const priv = pick.filter(a => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
  return priv[0] || pick[0] || "";
}
const LAN_IP = lanAddress();
const SHARE_ON = LAN && !!LAN_IP;
function shareBase() { return "http://" + LAN_IP + ":" + PORT; }

/* ── 폰으로 넘겨줄 사진을 잠깐 들고 있습니다. 디스크에는 쓰지 않습니다. ── */
const SHARES = new Map();
function sweepShares() {
  const now = Date.now();
  for (const [id, it] of SHARES) if (now - it.at > SHARE_TTL) SHARES.delete(id);
  while (SHARES.size > SHARE_MAX) SHARES.delete(SHARES.keys().next().value);
}
function newShareId() {
  let id;
  do { id = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6); }
  while (SHARES.has(id));
  return id;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

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
    return json(res, 200, {
      ok: true, platform: process.platform, printers, defaultPrinter: def,
      share: SHARE_ON, shareBase: SHARE_ON ? shareBase() : "", lanIp: LAN_IP
    });
  }

  /* ── 사진을 잠깐 맡아 두고, 폰이 열 주소를 돌려줍니다 ── */
  if (url.startsWith("/share") && req.method === "POST") {
    if (!SHARE_ON) {
      return json(res, 503, { ok: false, error: LAN
        ? "이 컴퓨터의 랜 주소를 찾지 못했습니다. 와이파이나 랜선이 연결되어 있는지 보세요."
        : "QR 로 받으려면 인쇄 서버를 --lan 옵션으로 띄워야 합니다." });
    }
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString("utf8"));
      const m = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(String(body.image || ""));
      if (!m) return json(res, 400, { ok: false, error: "이미지를 찾지 못했습니다" });

      sweepShares();
      const id = newShareId();
      SHARES.set(id, {
        buf: Buffer.from(m[2], "base64"),
        type: m[1] === "png" ? "image/png" : "image/jpeg",
        ext: m[1] === "png" ? "png" : "jpg",
        at: Date.now()
      });
      console.log(new Date().toLocaleTimeString("ko-KR"), `QR 공유 ${shareBase()}/s/${id}`);
      return json(res, 200, { ok: true, id, url: shareBase() + "/s/" + id, ttl: SHARE_TTL });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  /* ── 폰이 여는 주소 ── */
  const sm = /^\/s\/([a-z0-9]{6,16})(\.(?:png|jpg))?(?:\?|$)/.exec(url);
  if (sm) {
    sweepShares();
    const it = SHARES.get(sm[1]);
    if (!it) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      return res.end('<!doctype html><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<body style="font-family:system-ui;background:#0B0B0D;color:#F2F0EC;'
        + 'display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">'
        + '<p>사진이 사라졌습니다.<br><small style="opacity:.6">30분이 지나면 지워집니다. 부스에서 다시 QR 을 띄워 주세요.</small></p>');
    }
    if (sm[2]) {
      res.writeHead(200, {
        "Content-Type": it.type,
        "Content-Length": it.buf.length,
        "Cache-Control": "no-store",
        "Content-Disposition": 'inline; filename="fourcut-' + sm[1] + '.' + it.ext + '"'
      });
      return res.end(it.buf);
    }
    const src = "/s/" + sm[1] + "." + it.ext;
    const left = Math.max(0, Math.round((SHARE_TTL - (Date.now() - it.at)) / 60000));
    const page = '<!doctype html><html lang="ko"><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>인생네컷</title><style>'
      + 'body{margin:0;background:#0B0B0D;color:#F2F0EC;font-family:system-ui,-apple-system,"Noto Sans KR",sans-serif;'
      + 'font-weight:300;display:flex;flex-direction:column;align-items:center;gap:18px;padding:26px 18px 40px}'
      + 'h1{font-size:15px;letter-spacing:.3em;color:#E8C27A;font-weight:400;margin:4px 0 0}'
      + 'img{width:100%;max-width:440px;height:auto;border-radius:12px;display:block;'
      + 'box-shadow:0 18px 50px rgba(0,0,0,.6)}'
      + 'a.dl{display:block;width:100%;max-width:440px;text-align:center;background:#E8C27A;color:#15140F;'
      + 'text-decoration:none;padding:17px;border-radius:12px;font-size:16px;letter-spacing:.06em}'
      + 'p{font-size:13px;line-height:1.8;color:rgba(242,240,236,.55);text-align:center;margin:0;max-width:440px}'
      + '</style><h1>인생네컷</h1>'
      + '<img src="' + esc(src) + '" alt="인생네컷 사진">'
      + '<a class="dl" href="' + esc(src) + '" download="fourcut-' + esc(sm[1]) + '.' + it.ext + '">사진 저장</a>'
      + '<p>저장이 안 되면 사진을 길게 눌러 <b>이미지 저장</b> 을 고르세요.<br>'
      + '이 주소는 ' + left + '분 뒤에 사라집니다.</p></html>';
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(page);
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
  if (SHARE_ON) {
    console.log("  폰       " + shareBase() + "  (같은 와이파이에서 QR 로 사진 받기)");
  } else if (LAN) {
    console.log("  폰       랜 주소를 찾지 못해 QR 공유는 꺼져 있습니다");
  } else {
    console.log("  폰       꺼짐 — --lan 을 붙여 띄우면 QR 로 사진을 받을 수 있습니다");
  }
  console.log("  ────────────────────────────────");
  console.log("  이 창을 닫으면 자동 인쇄도 멈춥니다. Ctrl+C 로 종료.");
  console.log("");
});
