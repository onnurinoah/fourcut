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
const TUNNEL = argv.includes("--tunnel");
let PUBLIC = String(arg("public", "")).replace(/\/+$/, "");
const HOST = arg("host", LAN ? "0.0.0.0" : "127.0.0.1");
const SHARE_TTL = 30 * 60 * 1000;   // 사진 한 장이 남아 있는 시간
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
let TUNNEL_STATE = TUNNEL ? "starting" : "off";
/* 공개 주소가 있으면 그쪽이 먼저입니다. 다른 망에 있는 폰도 닿습니다. */
function shareBase() { return PUBLIC || ("http://" + LAN_IP + ":" + PORT); }
function shareOn() { return !!PUBLIC || (LAN && !!LAN_IP); }

/* cloudflared 가 깔려 있으면 대신 띄워 주고, 찍히는 주소를 받아 씁니다.
   사진은 여전히 이 컴퓨터에서만 나갑니다 — 터널은 길만 내줍니다. */
function startTunnel() {
  const { spawn } = require("child_process");
  let cp;
  try {
    cp = spawn("cloudflared", ["tunnel", "--url", "http://127.0.0.1:" + PORT], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    TUNNEL_STATE = "missing";
    return;
  }
  cp.on("error", () => {
    TUNNEL_STATE = "missing";
    console.log("  cloudflared 를 찾지 못했습니다. https://developers.cloudflare.com/cloudflared 에서 받으세요.");
  });
  const look = buf => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(String(buf));
    if (m && !PUBLIC) {
      PUBLIC = m[0];
      TUNNEL_STATE = "on";
      console.log("");
      console.log("  터널 열림  " + PUBLIC + "/d   (아무 망에서나 열립니다)");
      console.log("  부스 화면을 새로고침하면 QR 이 이 주소로 바뀝니다.");
      console.log("");
    }
  };
  cp.stdout.on("data", look);
  cp.stderr.on("data", look);
  cp.on("exit", () => { if (!PUBLIC) TUNNEL_STATE = "failed"; });
  process.on("exit", () => { try { cp.kill(); } catch (e) {} });
}

/* ── 폰으로 넘겨줄 "지금 사진" 한 장. 디스크에는 쓰지 않습니다. ──
   주소를 /s 하나로 고정해 두면 QR 도 하나로 고정됩니다. 부스에 붙여 둔 QR 을
   손님이 아무 때나 찍으면 그 순간의 사진이 나옵니다. 다음 사람이 찍으면
   앞 사진은 그 자리에서 지워집니다. */
let CURRENT = null;              // { buf, type, ext, at, ver }
let VER = 0;
function currentPhoto() {
  if (CURRENT && Date.now() - CURRENT.at > SHARE_TTL) CURRENT = null;   // 오래되면 스스로 사라집니다
  return CURRENT;
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

/* ── 사진을 그림으로 바꾸기 (외부 이미지 생성 AI) ──
   업체마다 요청 모양이 달라서, 코드에 박지 않고 설정 파일로 받습니다.
   server/toon.config.json 이 없으면 이 기능은 꺼진 채로 둡니다 — 그때는
   페이지가 자기 안에서 도는 청사진 필터를 그대로 씁니다. */
const TOON_FILE = path.join(__dirname, "toon.config.json");
function toonConfig() {
  try { return JSON.parse(fs.readFileSync(TOON_FILE, "utf8")); } catch (e) { return null; }
}

/* ${NAME} 자리를 채웁니다. 값이 통째로 ${...} 하나면 타입을 살려 넣습니다. */
function fill(node, vars) {
  if (typeof node === "string") {
    const whole = /^\$\{([A-Z0-9_]+)\}$/.exec(node);
    if (whole) return whole[1] in vars ? vars[whole[1]] : node;
    return node.replace(/\$\{([A-Z0-9_]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }
  if (Array.isArray(node)) return node.map(v => fill(v, vars));
  if (node && typeof node === "object") {
    const out = {};
    for (const k of Object.keys(node)) out[k] = fill(node[k], vars);
    return out;
  }
  return node;
}

/* "output.0" 같은 경로로 응답 속을 파고듭니다. */
function dig(obj, pathStr) {
  if (!pathStr) return obj;
  let cur = obj;
  for (const part of String(pathStr).split(".")) {
    if (cur == null) return undefined;
    cur = cur[/^\d+$/.test(part) ? Number(part) : part];
  }
  return cur;
}

async function toBuffer(out, form) {
  if (typeof out !== "string") throw new Error("결과 이미지를 찾지 못했습니다");
  if (form === "url" || /^https?:\/\//.test(out)) {
    const r = await fetch(out);
    if (!r.ok) throw new Error("결과 이미지를 내려받지 못했습니다 (" + r.status + ")");
    return Buffer.from(await r.arrayBuffer());
  }
  const m = /^data:image\/\w+;base64,(.+)$/s.exec(out);
  return Buffer.from(m ? m[1] : out, "base64");
}

async function toonify(dataUrl) {
  const cfg = toonConfig();
  if (!cfg || !cfg.endpoint) throw new Error("toon.config.json 이 없습니다");

  const m = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(dataUrl);
  if (!m) throw new Error("이미지를 찾지 못했습니다");
  const vars = Object.assign({}, process.env, {
    IMAGE_DATA_URL: dataUrl,
    IMAGE_B64: m[2],
    PROMPT: cfg.prompt || ""
  });

  const headers = fill(cfg.headers || { "Content-Type": "application/json" }, vars);
  let r = await fetch(fill(cfg.endpoint, vars), {
    method: cfg.method || "POST",
    headers,
    body: JSON.stringify(fill(cfg.body || {}, vars))
  });
  let j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("이미지 AI 가 " + r.status + " 를 돌려주었습니다: " + JSON.stringify(j).slice(0, 300));

  /* 바로 안 주고 "만드는 중" 을 돌려주는 업체는 다 될 때까지 물어봅니다. */
  if (cfg.poll && cfg.poll.urlPath) {
    const until = Date.now() + (cfg.poll.timeoutMs || 90000);
    const wait = cfg.poll.everyMs || 1500;
    let statusUrl = dig(j, cfg.poll.urlPath);
    if (!statusUrl) throw new Error("진행 상황을 볼 주소를 찾지 못했습니다");
    for (;;) {
      const state = String(dig(j, cfg.poll.statusPath) || "");
      if (state === (cfg.poll.doneValue || "succeeded")) break;
      if (cfg.poll.failValues && cfg.poll.failValues.indexOf(state) >= 0) {
        throw new Error("이미지 AI 가 실패했습니다: " + state);
      }
      if (Date.now() > until) throw new Error("이미지 AI 가 제때 끝내지 못했습니다");
      await new Promise(s => setTimeout(s, wait));
      const rr = await fetch(statusUrl, { headers });
      j = await rr.json().catch(() => ({}));
    }
  }

  const out = dig(j, cfg.imagePath);
  const buf = await toBuffer(out, cfg.imageForm);
  return "data:image/png;base64," + buf.toString("base64");
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
      toon: !!toonConfig(),
      share: shareOn(), shareBase: shareOn() ? shareBase() + "/d" : "",
      lanIp: LAN_IP, public: PUBLIC, tunnel: TUNNEL_STATE
    });
  }

  /* ── 사진 한 장을 그림으로 바꿔 돌려줍니다 ── */
  if (url.startsWith("/toon") && req.method === "POST") {
    if (!toonConfig()) {
      return json(res, 503, { ok: false, error: "AI 변환이 꺼져 있습니다 (server/toon.config.json 없음)" });
    }
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString("utf8"));
      const t0 = Date.now();
      const image = await toonify(String(body.image || ""));
      console.log(new Date().toLocaleTimeString("ko-KR"),
        `AI 변환 한 장 (${Math.round((Date.now() - t0) / 1000)}초)`);
      return json(res, 200, { ok: true, image });
    } catch (e) {
      console.error("AI 변환 실패:", e.message);
      return json(res, 502, { ok: false, error: String(e.message || e) });
    }
  }

  /* ── 앞 사진을 버립니다 (새로 찍기 시작할 때) ── */
  if (url.startsWith("/share/clear") && req.method === "POST") {
    CURRENT = null; VER++;
    return json(res, 200, { ok: true, ver: VER });
  }

  /* ── 지금 사진을 맡깁니다. 앞 사진은 이 자리에서 버려집니다 ── */
  if (url.startsWith("/share") && req.method === "POST") {
    if (!shareOn()) {
      return json(res, 503, { ok: false, error: LAN
        ? "이 컴퓨터의 랜 주소를 찾지 못했습니다. 와이파이나 랜선이 연결되어 있는지 보세요."
        : "QR 로 받으려면 인쇄 서버를 --lan (같은 와이파이) 또는 --tunnel (아무 망) 로 띄워야 합니다." });
    }
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString("utf8"));
      const m = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(String(body.image || ""));
      if (!m) return json(res, 400, { ok: false, error: "이미지를 찾지 못했습니다" });

      VER++;
      CURRENT = {
        buf: Buffer.from(m[2], "base64"),
        type: m[1] === "png" ? "image/png" : "image/jpeg",
        ext: m[1] === "png" ? "png" : "jpg",
        at: Date.now(),
        ver: VER
      };
      console.log(new Date().toLocaleTimeString("ko-KR"), `폰으로 받을 사진 갱신 (${VER}) — ${shareBase()}/d`);
      return json(res, 200, { ok: true, url: shareBase() + "/d", ver: VER, ttl: SHARE_TTL });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  /* ── 폰이 여는 고정 주소 ── */
  if (/^\/s\/ver(?:\?|$)/.test(url)) {
    const it = currentPhoto();
    return json(res, 200, { ver: it ? it.ver : 0, has: !!it });
  }

  if (/^\/s\/photo\.(?:png|jpg)(?:\?|$)/.test(url)) {
    const it = currentPhoto();
    if (!it) { cors(res); res.writeHead(404); return res.end(); }
    // ?dl 이 붙으면 폰이 열어 보지 않고 곧바로 내려받습니다.
    const dl = /[?&]dl\b/.test(url);
    cors(res);
    res.writeHead(200, {
      "Content-Type": it.type,
      "Content-Length": it.buf.length,
      "Cache-Control": "no-store",
      "Content-Disposition": (dl ? "attachment" : "inline")
        + '; filename="fourcut-' + it.ver + '.' + it.ext + '"'
    });
    return res.end(it.buf);
  }

  /* QR 이 가리키는 주소. 사진이 있으면 페이지를 거치지 않고 바로 내려받습니다. */
  if (/^\/d(?:\/)?(?:\?|$)/.test(url)) {
    const it = currentPhoto();
    res.writeHead(302, {
      "Location": it ? ("/s/photo." + it.ext + "?dl&v=" + it.ver) : "/s",
      "Cache-Control": "no-store"
    });
    return res.end();
  }

  if (/^\/s(?:\/)?(?:\?|$)/.test(url)) {
    const it = currentPhoto();
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
      + '.wait{padding:60px 0;font-size:15px;color:rgba(242,240,236,.5);text-align:center;line-height:2}'
      + '[hidden]{display:none}'
      + '</style><h1>인생네컷</h1>'
      + '<div class="wait" id="wait">아직 사진이 없습니다.<br><small>부스에서 찍고 나면 이 화면에 바로 뜹니다.</small></div>'
      + '<img id="ph" hidden alt="인생네컷 사진">'
      + '<a class="dl" id="dl" hidden href="/s/photo.png" download="fourcut.png">사진 저장</a>'
      + '<p id="tip" hidden>저장이 안 되면 사진을 길게 눌러 <b>이미지 저장</b> 을 고르세요.<br>'
      + '다음 사람이 찍으면 이 사진은 사라집니다.</p>'
      + '<script>(function(){'
      + 'var ver=-1;'
      + 'var first=true;'
      + 'function draw(v,has){'
      + 'if(v===ver) return;'
      + 'if(has && !first){ location.href="/s/photo.png?dl&v="+v; return; }'   // 기다리다 사진이 오면 바로 받기
      + 'ver=v; first=false;'
      + 'var ph=document.getElementById("ph"),dl=document.getElementById("dl");'
      + 'if(!has){ph.hidden=dl.hidden=document.getElementById("tip").hidden=true;'
      + 'document.getElementById("wait").hidden=false;return;}'
      + 'ph.src="/s/photo.png?v="+v; ph.hidden=false;'
      + 'dl.href="/s/photo.png?v="+v; dl.download="fourcut-"+v+".png"; dl.hidden=false;'
      + 'document.getElementById("tip").hidden=false;'
      + 'document.getElementById("wait").hidden=true;}'
      + 'draw(' + (it ? it.ver : 0) + ',' + (it ? 'true' : 'false') + ');first=false;'
      + 'setInterval(function(){fetch("/s/ver",{cache:"no-store"}).then(function(r){return r.json();})'
      + '.then(function(j){draw(j.ver,j.has);}).catch(function(){});},2000);'
      + '})();</scr' + 'ipt></html>';
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(page);
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
  if (TUNNEL) startTunnel();
  if (PUBLIC) {
    console.log("  폰       " + shareBase() + "/d  (아무 망에서나 열립니다)");
  } else if (TUNNEL) {
    console.log("  폰       터널 여는 중… 주소가 잡히면 여기에 찍힙니다");
  } else if (shareOn()) {
    console.log("  폰       " + shareBase() + "/d  (같은 와이파이에서만)");
  } else if (LAN) {
    console.log("  폰       랜 주소를 찾지 못해 QR 공유는 꺼져 있습니다");
  } else {
    console.log("  폰       꺼짐 — --lan (같은 와이파이) 또는 --tunnel (아무 망) 을 붙여 띄우세요");
  }
  console.log("  ────────────────────────────────");
  console.log("  이 창을 닫으면 자동 인쇄도 멈춥니다. Ctrl+C 로 종료.");
  console.log("");
});
