const PROMPT = [
  "Edit this input photo into a natural, peaceful scene where the same person or people from the source photo are together with Jesus.",
  "Preserve the source person's identity, face, expression, hairstyle, body shape, pose, clothing, glasses, and number of people as faithfully as possible.",
  "Depict Jesus as a humble first-century Palestinian Jewish man with simple clothing and a calm, compassionate expression, standing or walking naturally beside the photographed person or people.",
  "Keep the scene warm, safe, reverent, and believable. Avoid fantasy effects, exaggerated halos, text, logos, captions, or watermarks. Do not add any Bible verse text inside the generated image."
].join(" ");

function json(res, status, body) {
  res.status(status).json(body);
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

  let response = null;
  let payload = {};
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form
    });
    lastStatus = response.status;
    payload = await response.json().catch(() => ({}));
    if (response.ok) break;

    const code = payload?.error?.code || payload?.error?.type || "";
    const transient = response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503 || code === "server_is_overloaded" || code === "rate_limit_error" || code === "slow_down";
    if (!transient || attempt === 2) break;
    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1200 * (attempt + 1);
    await new Promise(r => setTimeout(r, Math.min(waitMs, 5000)));
  }
  if (!response?.ok) {
    const code = payload?.error?.code || payload?.error?.type || "";
    let detail = payload?.error?.message || `OpenAI API ${lastStatus || 500}`;
    if (code === "insufficient_quota" || code === "project_spend_limit_exceeded" || code === "organization_spend_limit_exceeded" || code === "organization_usage_limit_exceeded") {
      detail = "OpenAI 사용 한도 또는 결제 한도에 도달했습니다. OpenAI API 사용량과 결제 설정을 확인해 주세요.";
    } else if (lastStatus === 401) {
      detail = "OPENAI_API_KEY가 올바르지 않거나 만료되었습니다.";
    } else if (lastStatus === 503 || code === "server_is_overloaded") {
      detail = "OpenAI 이미지 서버가 잠시 혼잡합니다. 잠시 후 다시 시도해 주세요.";
    } else if (lastStatus === 429 || code === "rate_limit_error" || code === "slow_down") {
      detail = "이미지 생성 요청이 너무 빠르게 들어왔습니다. 잠시 후 다시 시도해 주세요.";
    }
    const err = new Error(detail);
    err.status = lastStatus;
    err.code = code;
    throw err;
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
    const status = Number(err?.status) || 502;
    return json(res, status >= 400 && status < 600 ? status : 502, { ok: false, error: err?.message || "AI 생성에 실패했습니다.", code: err?.code || null });
  }
};
