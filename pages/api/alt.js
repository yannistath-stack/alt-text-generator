// pages/api/alt.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageDataUrl, meta } = req.body || {};
  if (!imageDataUrl) return res.status(400).json({ error: 'Missing imageDataUrl' });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return res.status(500).json({ error: 'Missing OPENAI_API_KEY env var' });

  // Canonical descriptor whitelist (AIO)
  const DESCRIPTORS = [
    // Views (simplified per your request)
    'front view',
    'rear view',
    'profile view',
    'high-angle front view',
    'high-angle rear view',

    // Interior / details
    'gear shifter detail',
    'detail of paddle shifter',
    'steering wheel detail',
    'instrument cluster detail',
    'infotainment screen detail',
    'center console detail',
    'seat stitching detail',
    'interior detail',

    // Exterior details
    'detail of wheel',
    'detail of brake caliper',
    'headlight detail',
    'taillight detail',
    'detail of grille with emblem',
    'detail of badge',
    'detail of door handle',
    'side mirror detail',
    'detail of spoiler',
    'detail of sunroof',
    'detail of fog light',
    'detail of exhaust tip',
    'detail of rear diffuser'
  ];

  // Optional environment phrases (only when obvious)
  const ENVIRONMENTS = [
    'on a city street',
    'in an urban setting',
    'on a racetrack',
    'on a mountain road',
    'on a desert road',
    'in a showroom',
    'in a studio setting',
    'in snowy conditions',
    'at night'
  ];

  const instruction = `
You are an automotive vision assistant for alt text generation.

OUTPUT:
Return strict JSON only:
{"descriptor":"<one value from DESCRIPTORS>","environment":"<one value from ENVIRONMENTS or empty string>"}

RULES:
- Choose EXACTLY ONE "descriptor" from DESCRIPTORS (no custom text).
- Prefer specific interior parts when visible (e.g., "gear shifter detail").
- If clearly exterior and angle is obvious, use one of: front view, rear view, profile view, high-angle front view, high-angle rear view.
- Never use "three-quarter" phrasing.
- "side mirror detail" is exterior only; do NOT confuse shiny interior knobs as mirrors.
- "environment" is optional: include it ONLY if unmistakable. Otherwise return "".
- Keep responses strictly to valid whitelist values.

DESCRIPTORS:
${DESCRIPTORS.map(d => `- ${d}`).join('\n')}

ENVIRONMENTS (optional):
${ENVIRONMENTS.map(d => `- ${d}`).join('\n')}
`.trim();

  const payload = {
    model: 'gpt-4o-mini',
    temperature: 0,
    messages: [
      { role: 'system', content: instruction },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Vehicle context: ${(meta?.year || '')} ${(meta?.make || '')} ${(meta?.model || '')}`.trim() },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      }
    ]
  };

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const t = await r.text();
      console.error('OpenAI error', r.status, t);
      return res.status(502).json({ error: 'Vision API error' });
    }

    const json = await r.json();
    const raw = json?.choices?.[0]?.message?.content || '';

    // Robust parse (handles code fences)
    const tryParse = (txt) => {
      try {
        const clean = txt.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        return parsed;
      } catch { return null; }
    };

    let parsed = tryParse(raw);
    if (!parsed) {
      const match = raw.match(/"descriptor"\s*:\s*"([^"]+)"[^}]*"environment"\s*:\s*"([^"]*)"/i);
      if (match) {
        parsed = { descriptor: match[1], environment: match[2] };
      }
    }

    let descriptor = 'front view';
    let environment = '';

    if (parsed && typeof parsed.descriptor === 'string' && DESCRIPTORS.includes(parsed.descriptor)) {
      descriptor = parsed.descriptor;
    }
    if (parsed && typeof parsed.environment === 'string' && (ENVIRONMENTS.includes(parsed.environment) || parsed.environment === '')) {
      environment = parsed.environment;
    }

    return res.status(200).json({ descriptor, environment });
  } catch (err) {
    console.error('Server error', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
