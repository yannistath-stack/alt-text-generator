// pages/api/alt.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { image, meta } = req.body || {};
  if (!image) return res.status(400).json({ error: 'Missing image base64' });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'Missing OPENAI_API_KEY env var' });
  }

  // Canonical descriptor whitelist (AIO AHM v2.5)
  const DESCRIPTORS = [
    // Views
    'front three-quarter view',
    'rear three-quarter view',
    'side profile',
    'front view',
    'rear view',
    'top view',
    // Interior parts
    'gear shifter detail',
    'detail of paddle shifter',
    'steering wheel detail',
    'instrument cluster detail',
    'infotainment screen detail',
    'center console detail',
    'seat stitching detail',
    'interior detail',
    // Exterior parts
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

  const instruction = `
You are an automotive vision assistant for alt text generation.
Return ONE descriptor from the whitelist exactly, nothing else.

Rules:
- Choose the most specific match first (e.g., "gear shifter detail" beats "interior detail").
- If it's an interior shot with a visible part, pick that part.
- If it's exterior and a clear angle, pick a view like "front three-quarter view".
- Avoid confusing shiny knobs for "side mirror". Mirrors are exterior and mounted outside the door.
- Output ONLY strict JSON: {"descriptor":"<one of the whitelist>"}
- No extra text.

Whitelist:
${DESCRIPTORS.map(d => `- ${d}`).join('\n')}
`;

  // Build OpenAI request
  const payload = {
    model: 'gpt-4o-mini', // vision-capable, efficient
    messages: [
      { role: 'system', content: instruction },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Vehicle context: ${meta?.year || ''} ${meta?.make || ''} ${meta?.model || ''}`.trim() },
          { type: 'image_url', image_url: `data:image/jpeg;base64,${image}` }
        ]
      }
    ],
    temperature: 0
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

    // Parse strict JSON; fall back to a safe view if parsing fails
    let descriptor = null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.descriptor === 'string' && DESCRIPTORS.includes(parsed.descriptor)) {
        descriptor = parsed.descriptor;
      }
    } catch {
      // sometimes model wraps code-blocks; strip and re-parse
      const cleaned = raw.replace(/```json|```/g, '').trim();
      try {
        const parsed2 = JSON.parse(cleaned);
        if (parsed2 && typeof parsed2.descriptor === 'string' && DESCRIPTORS.includes(parsed2.descriptor)) {
          descriptor = parsed2.descriptor;
        }
      } catch { /* ignore */ }
    }

    if (!descriptor) descriptor = 'front three-quarter view';
    return res.status(200).json({ descriptor });
  } catch (err) {
    console.error('Server error', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

