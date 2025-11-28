// llmClient.js
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.warn('[Gemini] GEMINI_API_KEY not set. AI summaries will be skipped.');
}

// Função básica de chamada ao Gemini (sem ferramentas)
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

// ✅ NOVA FUNÇÃO: Gemini com Google Search (igual ao AI Studio)
async function callGeminiWithSearch(prompt) {
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
        ],
        tools: [
          {
            googleSearch: {}  // ✅ Habilita Google Search
          }
        ]
      })
    });

    if (!resp.ok) {
      console.error('[Gemini Search] HTTP error:', resp.status, await resp.text());
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
    console.error('[Gemini Search] Error calling API:', err);
    return null;
  }
}

// ✅ NOVA FUNÇÃO: Extrair keywords usando Gemini (2 fases como no AI Studio)
async function extractKeywordsWithGemini(firmName, website, city, state, googleTypes = []) {
  if (!GEMINI_API_KEY) return null;

  try {
    // FASE 1: Research com Google Search
    const researchPrompt = `
Research the law firm: "${firmName}" at ${website} (located in ${city}, ${state}).

I need to know:
1. What are their PRIMARY practice areas? (e.g., Personal Injury, Family Law, Real Estate)
2. What are 10 high-intent keywords that potential clients would use to find them on Google?
   - Include the city name in keywords (e.g., "car accident lawyer in ${city}")
   - Focus on specific legal services they offer
   - Use natural language clients would search

Return detailed information about their practice areas and search terms.
`;

    console.log(`[Gemini Research] Researching ${firmName}...`);
    const researchText = await callGeminiWithSearch(researchPrompt);

    if (!researchText) {
      console.log('[Gemini Research] No research results, using fallback');
      return null;
    }

    console.log(`[Gemini Research] Got research data (${researchText.length} chars)`);

    // FASE 2: Estruturar em JSON
    const structurePrompt = `
Extract the following from this research text and return ONLY valid JSON (no markdown, no explanation):

${researchText}

Return a JSON object with this EXACT structure:
{
  "practiceArea": "Primary Practice Area Name",
  "keywords": [
    "keyword 1",
    "keyword 2",
    ...up to 10 keywords
  ]
}

Requirements:
- practiceArea should be ONE of: Personal Injury, Family Law, Estate Planning, Criminal Defense, Immigration, Business Litigation, Bankruptcy, Employment Law, Real Estate Law, Elder Law
- keywords should be 10 specific search terms clients would use, including city name
- Return ONLY the JSON object, nothing else
`;

    console.log('[Gemini Structure] Formatting into JSON...');
    const structuredText = await callGemini(structurePrompt);

    if (!structuredText) {
      console.log('[Gemini Structure] Failed to structure data');
      return null;
    }

    // Limpar markdown se presente
    let cleanJson = structuredText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    try {
      const parsed = JSON.parse(cleanJson);
      console.log(`[Gemini Success] Extracted: ${parsed.practiceArea}, ${parsed.keywords?.length || 0} keywords`);
      return parsed;
    } catch (e) {
      console.error('[Gemini Parse Error]:', e.message);
      console.error('Response was:', cleanJson.substring(0, 200));
      return null;
    }

  } catch (err) {
    console.error('[Gemini Extract] Error:', err);
    return null;
  }
}

// Função de insights existente (mantida)
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

  const lines = text
    .split('\n')
    .map((l) => l.replace(/^[-•*\d\.\s]+/, '').trim())
    .filter((l) => l.length > 0)
    .slice(0, 3);

  return lines.length ? lines : [text];
}

module.exports = {
  callGemini,
  callGeminiWithSearch,
  extractKeywordsWithGemini,
  summarizeFirmAnalysis,
};