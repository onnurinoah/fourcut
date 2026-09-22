const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 6;
const seen = globalThis.__blueprintRate || (globalThis.__blueprintRate = new Map());

const PROMPT = [
  "Edit this input photo into a natural, peaceful scene where the same person or people from the source photo are together with Jesus.",
  "Preserve the source person's identity, face, expression, hairstyle, body shape, pose, clothing, glasses, and number of people as faithfully as possible.",
  "Depict Jesus as a humble first-century Palestinian Jewish man with simple clothing and a calm, compassionate expression, standing or walking naturally beside the photographed person or people.",
  "Keep the scene warm, safe, reverent, and believable. Avoid fantasy effects, exaggerated halos, text, logos, captions, or watermarks. Do not add any Bible verse text inside the generated image."
].join(" ");

function json(res, status, body) {
  res.status(status).json(body);
}

function clientIp(req) {
  const x = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown";
  return String(x).split(",")[0].trim().slice(0, 80);
}

function allowed(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const old = seen.get(ip) || [];
  const fresh = old.filter(t => now - t < WINDOW_MS);
  if (fresh.length >= MAX_REQUESTS) {
    seen.set(ip, fresh);
    return false;
  }
  fresh.push(now);
  seen.set(ip, fresh);
  return true;
}

function parseBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 24 * 1024 * 1024) return reject(new Error("사진이 너무 큽니다."));
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("요청 형식이 올바르지 않습니다.")); }
    });
    req.on("error", reject);
  });
}

async function editImage(dataUrl, prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Vercel 환경변수 OPENAI_API_KEY가 없습니다.");
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/s.exec(String(dataUrl || ""));
  if (!match) throw new Error("원본 사진 데이터가 없습니다.");

  const mime = match[1] === "png" ? "image/png" : match[1] === "webp" ? "image/webp" : "image/jpeg";
  const ext = match[1] === "png" ? "png" : match[1] === "webp" ? "webp" : "jpg";
  const bytes = Buffer.from(match[2], "base64");

  const form = new FormData();
  form.append("model", process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-flare");
  form.append("image[]", new Blob([bytes], { type: mime }), `blueprint-source.${ext}`);
  form.append("prompt", prompt);
  form.append("quality", process.env.OPENAI_IMAGE_QUALITY || "low");
  form.append("output_format", "jpeg");
  form.append("output_compression", "80");

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.error?.message || `OpenAI API ${response.status}`;
    throw new Error(detail);
  }
  const b64 = payload?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI가 이미지 결과를 반환하지 않았습니다.");
  return `data:image/jpeg;base64,${b64}`;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST만 허용됩니다." });
  if (!allowed(req)) return json(res, 429, { ok: false, error: "잠시 후 다시 시도해 주세요." });

  try {
    const body = await parseBody(req);
    const image = String(body?.image || "");
    if (!image) return json(res, 400, { ok: false, error: "원본 사진이 없습니다." });

    const started = Date.now();
    const jesus = await editImage(image, PROMPT);

    return json(res, 200, {
      ok: true,
      jesus,
      elapsedMs: Date.now() - started
    });
  } catch (err) {
    console.error("blueprint api error", err);
    return json(res, 502, { ok: false, error: err?.message || "AI 생성에 실패했습니다." });
  }
};
