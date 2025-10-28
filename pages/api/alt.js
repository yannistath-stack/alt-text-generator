// /pages/api/alt.js
// Hugging Face BLIP image captioning (free tier) → compose SEO alt text
// Body can be either:
// { imageDataUrl: "data:image/jpeg;base64,...", meta: {...} }
//   or
// { imageBase64: "<BASE64 ONLY>", contentType: "image/jpeg", meta: {...} }

export const config = { api: { bodyParser: { sizeLimit: "25mb" } } };

const HF_ENDPOINT =
  "https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-large";

/* ------------------ helpers ------------------ */

function decodeDataUrl(dataUrl) {
  // Accepts "data:image/<type>;base64,<payload>"
  if (!dataUrl || typeof dataUrl !== "string") return null;
  if (dataUrl.startsWith("blob:")) {
    // This is a frontend bug: server cannot read browser blob: URLs
    throw Object.assign(new Error("Received a blob: URL. Send a data:image/... URL instead."), { status: 400 });
  }
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return null;
  const header = dataUrl.slice(0, comma).toLowerCase();
  const base64 = dataUrl.slice(comma + 1);
  if (!header.startsWith("data:image/")) return null;
  return Buffer.from(base64, "base64");
}

function decodeBase64Only(imageBase64) {
  if (!imageBase64 || typeof imageBase64 !== "string") return null;
  try {
    return Buffer.from(imageBase64, "base64");
  } catch {
    return null;
  }
}

function normalizeMake(make) {
  if (!make) return "";
  const m = String(make).trim().toLowerCase();
  if (m === "acura") return "Acura";
  if (m === "honda") return "Honda";
  return String(make).trim();
}

function normalizeModel(model) {
  if (!model) return "";
  const upper = new Set(["MDX", "RDX", "TLX", "ILX", "RLX", "NSX", "ZDX", "CDX", "RSX", "TSX", "CL", "EL", "INTEGRA"]);
  const s = String(model).trim();
  const up = s.toUpperCase();
  if (upper.has(up)) return up;
  // common Acura typed lowercase
  const acuraLower = ["mdx","rdx","tlx","ilx","zdx","nsx","rsx","tsx","rlx"];
  if (acuraLower.includes(s.toLowerCase())) return s.toUpperCase();
  return s;
}

function pickEnvironment(caption = "") {
  const t = caption.toLowerCase();
  if (t.includes("night") || t.includes("evening")) return "night street";
  if (t.includes("tunnel")) return "tunnel";
  if (t.includes("snow")) return "snow";
  if (t.includes("rain")) return "rain";
  if (t.includes("desert")) return "desert";
  if (t.includes("mountain")) return "mountain road";
  if (t.includes("garage") || t.includes("showroom") || t.includes("indoors")) return "indoor showroom";
  if (t.includes("parking")) return "parking lot";
  if (t.includes("highway") || t.includes("road")) return "daylight road";
  if (t.includes("city") || t.includes("street")) return "daylight street";
  return "daylight";
}

function isInterior(caption = "") {
  const t = caption.toLowerCase();
  return (
    t.includes("interior") ||
    t.includes("dashboard") ||
    t.includes("steering wheel") ||
    t.includes("cockpit") ||
    t.includes("center console") ||
    t.includes("gear") ||
    t.includes("shifter") ||
    t.includes("seat")
  );
}

function inferAngle(caption = "", hint = "") {
  const h = String(hint || "").toLowerCase().trim();
  if (h) return h;
  const t = caption.toLowerCase();
  if (t.includes("rear")) return "rear view";
  if (t.includes("side") || t.includes("profile")) return "profile view";
  if (t.includes("front")) return "front view";
  if (t.includes("high angle")) return "high-angle view";
  if (t.includes("low angle")) return "low-angle view";
  return ""; // unknown
}

function composeAlt({ caption, meta = {} }) {
  const { year, make, model, trim, color, angle_hint } = meta || {};
  const Make = normalizeMake(make);
  const Model = normalizeModel(model);

  const env = pickEnvironment(caption);
  const interior = isInterior(caption);
  const angle = inferAngle(caption, angle_hint);

  const tokens = [];
  if (interior) {
    tokens.push(angle || "interior detail");
    tokens.push("interior");
  } else {
    tokens.push(angle || "exterior view");
    tokens.push(`in ${env}`);
  }

  const vehicleBits = [year, Make, Model].filter(Boolean).join(" ");
  if (vehicleBits) tokens.push(vehicleBits);
  if (trim) tokens.push(String(trim).trim());
  if (color) tokens.push(String(color).trim());

  // one detail if found
  const lower = caption.toLowerCase();
  const details = [
    ["gear shifter", ["shifter", "gear"]],
    ["steering wheel", ["steering wheel"]],
    ["center console", ["center console"]],
    ["dashboard", ["dashboard"]],
    ["LED headlights", ["headlight", "headlights"]],
    ["wheel close-up", ["rim", "wheel", "tire"]],
    ["seat upholstery", ["seat", "leather", "stitch"]],
  ];
  for (const [label, keys] of details) {
    if (keys.some((k) => lower.includes(k))) {
      tokens.push(label);
      break;
    }
  }

  const alt = Array.from(new Set(tokens.filter(Boolean)))
    .join(", ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    alt,
    environment: env,
    interior,
    angle: angle || (interior ? "interior" : "exterior"),
    raw_caption: caption,
  };
}

// Small retry for HF cold starts / loading
async function hfCaptionWithRetry(buf, tries = 3) {
  let lastText = "";
  for (let i = 0; i < tries; i++) {
    const r = await fetch(HF_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
        "Content-Type": "application/octet-stream",
      },
      body: buf,
    });

    const text = await r.text();
    lastText = text;

    try {
      const parsed = JSON.parse(text);

      // Loading / cold start
      if (parsed?.error && /loading/i.test(parsed.error)) {
        await new Promise((res) => setTimeout(res, 1200 + i * 600));
        continue;
      }

      // Standard BLIP array form: [{ generated_text: "..." }]
      if (Array.isArray(parsed) && parsed[0]?.generated_text) {
        return String(parsed[0].generated_text);
      }

      // Other error form
      if (parsed?.error) {
        throw Object.assign(new Error(parsed.error), { status: 502 });
      }
    } catch {
      // If not JSON, treat plain text as a best-effort caption
      if (text && text.length > 0) return String(text).slice(0, 280);
    }

    // If we got here without returning, pause then retry
    await new Promise((res) => setTimeout(res, 800));
  }

  throw Object.assign(new Error("Empty caption from Hugging Face"), { status: 502, debug: lastText?.slice(0, 120) });
}

/* ------------------ handler ------------------ */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { imageDataUrl, imageBase64, contentType, meta } = body;

    if (!process.env.HF_TOKEN) {
      return res.status(500).json({ ok: false, error: "Missing HF_TOKEN environment variable" });
    }

    // Prefer full data URL
    let buf = null;
    if (imageDataUrl) {
      buf = decodeDataUrl(imageDataUrl);
      if (!buf) {
        return res.status(400).json({
          ok: false,
          error: "Invalid or missing image data URL",
          hint: "Ensure client sends a data:image/...;base64,<payload> string (not blob: URL).",
          sample: String(imageDataUrl).slice(0, 40),
        });
      }
    } else if (imageBase64) {
      // Fallback: raw base64 + contentType
      if (!contentType || !/^image\//i.test(contentType)) {
        return res.status(400).json({ ok: false, error: "contentType must be set when using imageBase64 (e.g., image/jpeg)" });
      }
      const b = decodeBase64Only(imageBase64);
      if (!b) {
        return res.status(400).json({ ok: false, error: "imageBase64 is not valid base64" });
      }
      buf = b;
    } else {
      return res.status(400).json({ ok: false, error: "Provide imageDataUrl or imageBase64" });
    }

    // Call HF (with small retry)
    const caption = await hfCaptionWithRetry(buf, 3);

    const composed = composeAlt({ caption, meta });

    return res.status(200).json({
      ok: true,
      alt: composed.alt,
      meta: {
        ...composed,
        vehicle: {
          year: meta?.year || "",
          make: normalizeMake(meta?.make || ""),
          model: normalizeModel(meta?.model || ""),
          trim: meta?.trim || "",
          color: meta?.color || "",
        },
      },
    });
  } catch (err) {
    const status = err?.status || err?.response?.status || 500;
    const message = err?.message || "Server error in /api/alt";
    console.error("ALT_API_ERROR", status, message);
    return res.status(status).json({ ok: false, error: message });
  }
}
