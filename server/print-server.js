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
const MAX_BODY = 64 * 1024 * 1024;
const WIN = process.platform === "win32";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst";

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
let CURRENT = null;              // { items:[{buf,type,ext,label}], at, ver }
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

async function openAIEdit(dataUrl, prompt) {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY가 설정되지 않았습니다");
  const m = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(String(dataUrl || ""));
  if (!m) throw new Error("이미지를 찾지 못했습니다");

  const bytes = Buffer.from(m[2], "base64");
  const ext = m[1] === "png" ? "png" : "jpg";
  const mime = m[1] === "png" ? "image/png" : "image/jpeg";
  const form = new FormData();
  form.append("model", OPENAI_IMAGE_MODEL);
  form.append("image[]", new Blob([bytes], { type: mime }), "blueprint-source." + ext);
  form.append("prompt", prompt);
  form.append("quality", process.env.OPENAI_IMAGE_QUALITY || "medium");
  form.append("output_format", "png");

  const r = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: "Bearer " + OPENAI_KEY },
    body: form
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("OpenAI 이미지 생성 오류 " + r.status + ": " + JSON.stringify(j).slice(0, 500));
  const out = j && j.data && j.data[0] && j.data[0].b64_json;
  if (!out) throw new Error("OpenAI가 이미지를 반환하지 않았습니다");
  return "data:image/png;base64," + out;
}

const BLUEPRINT_PROMPT = [
  "사진 속 인물의 얼굴, 표정, 헤어스타일, 체형, 포즈, 옷차림과 인물 수를 최대한 정확하게 유지합니다.",
  "사진 속 실제 사람이 따뜻하고 평온한 표정의 예수님과 같은 공간에 자연스럽게 함께 있는 장면으로 재구성합니다.",
  "예수님은 1세기 팔레스타인 유대인 남성의 모습으로, 소박한 긴 옷과 자연스러운 모습으로 표현합니다. 과장된 후광이나 판타지 효과는 사용하지 않습니다.",
  "두 사람이 안전하고 다정한 분위기에서 함께 서 있거나 걷는 장면처럼 자연스럽게 보이게 합니다.",
  "사진 안에 글자, 로고, 워터마크, 성경구절 텍스트를 넣지 않습니다."
].join(" ");

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

function escHtml(value) {
  return String(value || "").replace(/[&<>"]/g, function(ch) { return {"&":"&amp;","<":"&lt;",">":"&gt;","":"&quot;"}[ch]; });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || "/";

  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

  if (url.startsWith("/health")) {
    const [printers, def] = await Promise.all([listPrinters(), defaultPrinter()]);
    return json(res, 200, {
      ok: true, platform: process.platform, printers, defaultPrinter: def,
      toon: !!toonConfig(),
      blueprintAI: !!OPENAI_KEY,
      imageModel: OPENAI_IMAGE_MODEL,
      share: shareOn(), shareBase: shareOn() ? shareBase() + "/d" : "",
      lanIp: LAN_IP, public: PUBLIC, tunnel: TUNNEL_STATE
    });
  }

  /* ── 청사진: 한 장으로 두 가지 AI 장면을 만듭니다 ── */
  if (url.startsWith("/blueprint") && req.method === "POST") {
    if (!OPENAI_KEY) {
      return json(res, 503, { ok:false, error:"OPENAI_API_KEY가 없어 AI 청사진 기능이 꺼져 있습니다." });
    }
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString("utf8"));
      const source = String(body.image || "");
      if (!source) return json(res, 400, { ok:false, error:"원본 사진이 없습니다." });
      const t0 = Date.now();
      const jesus = await openAIEdit(source, BLUEPRINT_PROMPT);
      console.log(new Date().toLocaleTimeString("ko-KR"),
        `청사진 AI 완료 (${Math.round((Date.now() - t0) / 1000)}초, ${OPENAI_IMAGE_MODEL})`);
      return json(res, 200, { ok:true, jesus });
    } catch (e) {
      console.error("청사진 AI 실패:", e.message);
      return json(res, 502, { ok:false, error:String(e.message || e) });
    }
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

  /* ── 지금 사진(또는 청사진 3장)을 맡깁니다. 앞 사람 사진은 이 자리에서 버립니다 ── */
  if (url.startsWith("/share") && req.method === "POST") {
    if (!shareOn()) {
      return json(res, 503, { ok: false, error: LAN
        ? "이 컴퓨터의 랜 주소를 찾지 못했습니다. 와이파이나 랜선이 연결되어 있는지 보세요."
        : "QR 로 받으려면 인쇄 서버를 --lan (같은 와이파이) 또는 --tunnel (아무 망) 로 띄워야 합니다." });
    }
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString("utf8"));
      const incoming = Array.isArray(body.images)
        ? body.images
        : (body.image ? [{ image: body.image, label: "인화 사진" }] : []);
      if (!incoming.length) return json(res, 400, { ok:false, error:"이미지를 찾지 못했습니다" });

      const items = incoming.slice(0, 6).map((item, idx) => {
        const m = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(String(item && item.image || ""));
        if (!m) throw new Error("이미지 " + (idx + 1) + " 형식이 올바르지 않습니다");
        return {
          buf: Buffer.from(m[2], "base64"),
          type: m[1] === "png" ? "image/png" : "image/jpeg",
          ext: m[1] === "png" ? "png" : "jpg",
          label: String(item.label || (idx + 1) + "번째 사진").slice(0, 60)
        };
      });

      VER++;
      CURRENT = { items, at:Date.now(), ver:VER };
      console.log(new Date().toLocaleTimeString("ko-KR"), `폰으로 받을 사진 ${items.length}장 갱신 (${VER}) — ${shareBase()}/d`);
      return json(res, 200, { ok:true, url:shareBase()+"/d", ver:VER, ttl:SHARE_TTL, count:items.length });
    } catch (e) {
      return json(res, 500, { ok:false, error:String(e.message || e) });
    }
  }

  /* ── 폰이 여는 고정 주소 ── */
  if (/^\/s\/ver(?:\?|$)/.test(url)) {
    const it = currentPhoto();
    return json(res, 200, { ver: it ? it.ver : 0, has: !!it });
  }

  if (/^\/s\/photo(?:-\d+)?\.(?:png|jpg)(?:\?|$)/.test(url)) {
    const it = currentPhoto();
    if (!it || !it.items || !it.items.length) { cors(res); res.writeHead(404); return res.end(); }
    const match = url.match(/^\/s\/photo(?:-(\d+))?\./);
    const idx = match && match[1] ? Number(match[1]) : 0;
    const photo = it.items[idx] || it.items[0];
    // ?dl 이 붙으면 폰이 열어 보지 않고 곧바로 내려받습니다.
    const dl = /[?&]dl\b/.test(url);
    cors(res);
    res.writeHead(200, {
      "Content-Type": photo.type,
      "Content-Length": photo.buf.length,
      "Cache-Control": "no-store",
      "Content-Disposition": (dl ? "attachment" : "inline")
        + '; filename="blueprint-' + it.ver + '-' + (idx + 1) + '.' + photo.ext + '"'
    });
    return res.end(photo.buf);
  }

  /* QR 이 가리키는 주소. 사진이 있으면 페이지를 거치지 않고 바로 내려받습니다. */
  if (/^\/d(?:\/)?(?:\?|$)/.test(url)) {
    const it = currentPhoto();
    const multi = it && it.items && it.items.length > 1;
    res.writeHead(302, {
      "Location": it ? (multi ? "/s" : ("/s/photo." + it.items[0].ext + "?dl&v=" + it.ver)) : "/s",
      "Cache-Control": "no-store"
    });
    return res.end();
  }

  if (/^\/s(?:\/)?(?:\?|$)/.test(url)) {
    const it = currentPhoto();
    const items = it && it.items ? it.items : [];
    const cards = items.map((photo, idx) => {
      const src = "/s/photo-" + idx + "." + photo.ext + "?v=" + it.ver;
      const dl = "/s/photo-" + idx + "." + photo.ext + "?dl&v=" + it.ver;
      return '<article class="card"><div class="label">' + escHtml(photo.label) + '</div>'
        + '<img src="' + src + '" alt="' + escHtml(photo.label) + '">'
        + '<a class="dl" href="' + dl + '">사진 저장</a></article>';
    }).join("");
    const empty = items.length ? "" : '<div class="wait" id="wait">아직 사진이 없습니다.<br><small>부스에서 사진을 만들면 이 화면에 바로 뜹니다.</small></div>';
    const saveAll = items.length > 1 ? '<button class="dl" id="allBtn">사진 3장 저장하기</button>' : '';
    const page = '<!doctype html><html lang="ko"><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>CH+ BLUEPRINT</title><style>'
      + 'body{margin:0;background:#0B0B0D;color:#F2F0EC;font-family:system-ui,-apple-system,"Noto Sans KR",sans-serif;display:flex;flex-direction:column;align-items:center;padding:24px 16px 40px}'
      + 'h1{font-size:13px;letter-spacing:.28em;color:#E8C27A;font-weight:500;margin:3px 0 22px}.sub{color:rgba(242,240,236,.58);font-size:13px;margin:-10px 0 22px;text-align:center;line-height:1.7}'
      + '.grid{width:100%;max-width:700px;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}'
      + '.card{background:#141418;border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:12px;box-sizing:border-box}.card .label{font-size:14px;color:#F2F0EC;padding:4px 4px 11px}.card img{width:100%;display:block;border-radius:12px;box-shadow:0 12px 34px rgba(0,0,0,.5)}'
      + 'a.dl,button.dl{display:block;width:100%;box-sizing:border-box;margin-top:10px;text-align:center;background:#E8C27A;color:#15140F;text-decoration:none;border:0;padding:14px;border-radius:11px;font-size:15px;cursor:pointer}'
      + '.all{width:100%;max-width:700px}.all button{font:inherit}.wait{padding:72px 8px;text-align:center;color:rgba(242,240,236,.52);line-height:2}.tip{max-width:600px;color:rgba(242,240,236,.42);font-size:12px;text-align:center;line-height:1.7;margin-top:20px}'
      + '</style><h1>CH+ BLUEPRINT</h1><div class="sub">원본 사진과 완성된 청사진을 한 번에 받아가세요.</div>'
      + '<div class="grid">' + (empty || cards) + '</div>'
      + (saveAll ? '<div class="all">' + saveAll + '</div>' : '')
      + '<div class="tip">사진은 일정 시간이 지나면 자동으로 삭제됩니다.</div>'
      + '<script>(function(){var ver=' + (it ? it.ver : 0) + ';'
      + 'var all=' + JSON.stringify(items.map((photo,idx)=>({href:"/s/photo-"+idx+"."+photo.ext+"?dl&v="+(it?it.ver:0),name:"blueprint-"+(idx+1)+"."+photo.ext}))) + ';'
      + 'var b=document.getElementById("allBtn");if(b)b.onclick=function(){all.forEach(function(x){var a=document.createElement("a");a.href=x.href;a.download=x.name;document.body.appendChild(a);a.click();a.remove();});};'
      + 'setInterval(function(){fetch("/s/ver",{cache:"no-store"}).then(function(r){return r.json();}).then(function(j){if(j.ver && j.ver!==ver) location.reload();}).catch(function(){});},2500);'
      + '})();</script></html>';
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
