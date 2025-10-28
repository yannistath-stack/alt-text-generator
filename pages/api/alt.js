// /pages/api/alt.js
// Uses Hugging Face Inference API (free tier) with BLIP captioning
// Expects a POST body like:
// { imageDataUrl: "data:image/jpeg;base64,...", meta: { year, make, model, trim, color, angle_hint } }

export const config = { api: { bodyParser: { sizeLimit: "20mb" } } };

const HF_ENDPOINT =
  "https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-large";

function dataUrlToBuffer(dataUrl) {
  // Accepts data:image/jpeg;base64,AAA...
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return null;
  const header = dataUrl.slice(0, comma).toLowerCase();
  const base64 = dataUrl.slice(comma + 1);
  // Basic MIME sanity check
  if (!header.startsWith("data:image/")) return null;
  return Buffer.from(base64, "base64");
}

function normalizeMake(make) {
  if (!make) return "";
  const m = make.trim().toLowerCase();
  if (m === "acura") return "Acura";
  if (m === "honda") return "Honda";
  return make.trim();
}

function normalizeModel(model) {
  if (!model) return "";
  // Acura models often uppercase
  const upperModels = new Set(["MDX", "RDX", "TLX", "ILX", "RLX", "NSX", "ZDX", "CDX", "RSX", "TSX", "CL", "EL", "Integra"]);
  const up = model.trim().toUpperCase();
  if (upperModels.has(up)) return up;
  // Honda models: keep case (e.g., Civic, Accord)
  // If the user typed mdx, fix it:
  if (["mdx","rdx","tlx","ilx","zdx","nsx","rsx","tsx"].includes(model.trim().toLowerCase())) return model.trim().toUpperCase();
  return model.trim();
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
  return "daylight"; // default
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

function buildAlt({ caption, meta = {} }) {
  const { year, make, model, trim, color, angle_hint } = meta || {};
  const Make = normalizeMake(make);
  const Model = normalizeModel(model);

  const env = pickEnvironment(caption);
  const interior = isInterior(caption);

  // Angle: prefer hint from client if present; otherwise try to infer a little
  let angle = angle_hint ? String(angle_hint).toLowerCase() : "";
  if (!angle) {
    if (caption.toLowerCase().includes("rear")) angle = "rear view";
    else if (caption.toLowerCase().includes("side")) angle = "profile view";
    else if (caption.toLowerCase().includes("front")) angle = "front view";
  }

  // Compose final, SEO-ready alt
  // Keep it concise, factual, and keyword-rich without stuffing.
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

  // Add one distinct detail from caption if it seems useful
  // (e.g., “gear shifter”, “steering wheel”, “LED headlights”)
  const lower = caption.toLowerCase();
  const details = [
    ["gear shifter", ["shifter", "gear"]],
    ["steering wheel", ["steering wheel"]],
    ["center console", ["center console"]],
    ["dashboard", ["dashboard"]],
    ["LED headlights", ["headlight", "headlights"]],
    ["wheel close-up", ["rim", "wheel close", "tire"]],
    ["seat upholstery", ["seat", "leather", "stitch"]],
  ];
  for (const [label, keys] of details) {
    if (keys.some(k => lower.includes(k))) {
      tokens.push(label);
      break;
    }
  }

  // De-duplicate tokens and clean spaces
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { imageDataUrl, meta } = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const buf = dataUrlToBuffer(imageDataUrl);
    if (!buf) {
      return res.status(400).json({ ok: false, error: "Invalid or missing image data URL" });
    }

    if (!process.env.HF_TOKEN) {
      return res.status(500).json({ ok: false, error: "Missing HF_TOKEN environment variable" });
    }

    // Send raw image bytes to BLIP
    const hfResp = await fetch(HF_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
        "Content-Type": "application/octet-stream",
      },
      body: buf,
    });

    const text = await hfResp.text();
    // BLIP returns JSON like: [ { "generated_text": "a red car on a road" } ]
    let caption = "";
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed[0]?.generated_text) {
        caption = String(parsed[0].generated_text);
      } else if (parsed?.error) {
        // Model may still be loading on free tier; HF returns { error: "...loading..." }
        return res.status(503).json({ ok: false, error: parsed.error });
      }
    } catch {
      // Sometimes HF proxies return plain text — treat it as caption fallback
      caption = text?.slice(0, 280) || "";
    }

    if (!caption) {
      return res.status(502).json({ ok: false, error: "Empty caption from Hugging Face" });
    }

    const composed = buildAlt({ caption, meta });

    return res.status(200).json({
      ok: true,
      alt: composed.alt,
      meta: {
        ...composed,
        // Echo normalized vehicle fields for debugging
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
    // Handle rate limits & common HF errors more clearly
    const status = err?.status || err?.response?.status || 500;
    const message =
      err?.message || err?.response?.data?.error || "Server error in /api/alt (HF)";
    console.error("HF_API_ERROR", status, message);
    return res.status(status).json({ ok: false, error: message });
  }
}
