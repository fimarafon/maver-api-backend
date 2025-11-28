// llmClient.js
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.warn('[Gemini] GEMINI_API_KEY not set. AI summaries will be skipped.');
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) return null;

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=' + GEMINI_API_KEY;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ]
      })
    });

    if (!resp.ok) {
      console.error('[Gemini] HTTP error:', resp.status, await resp.text());
      return null;
    }

    const data = await resp.json();

    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || '')
        .join(' ')
        .trim() || '';

    if (!text) return null;
    return text;
  } catch (err) {
    console.error('[Gemini] Error calling API:', err);
    return null;
  }
}

// Gera 1–3 bullets de “insights” de marketing a partir do JSON do relatório
async function summarizeFirmAnalysis(payload) {
  const prompt = `
You are a law firm marketing strategist.

Given the following JSON about a law firm's AI visibility and website signals,
write 2–3 short bullet-point insights (max 25 words each, English).
Focus on opportunities/risks the firm should fix to get more cases.

Return ONLY the bullets, one per line, no numbering.

JSON:
${JSON.stringify(payload, null, 2)}
`;

  const text = await callGemini(prompt);
  if (!text) return null;

  // quebra em linhas não vazias
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^[-•*\d\.\s]+/, '').trim())
    .filter((l) => l.length > 0)
    .slice(0, 3);

  return lines.length ? lines : [text];
}

module.exports = {
  summarizeFirmAnalysis,
};
