// llmClient.js
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.warn('[Gemini] GEMINI_API_KEY not set. AI features will fail.');
}

// Inicializa o cliente
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Configuração do Schema para garantir resposta JSON perfeita
const ANALYSIS_SCHEMA = {
  description: "Analysis of a law firm based on search results",
  type: SchemaType.OBJECT,
  properties: {
    practiceArea: {
      type: SchemaType.STRING,
      description: "The primary legal practice area (e.g., Personal Injury, Family Law, Real Estate Law)",
      nullable: false,
    },
    keywords: {
      type: SchemaType.ARRAY,
      description: "List of 10 high-intent keywords with location included",
      items: { type: SchemaType.STRING },
      nullable: false,
    },
  },
  required: ["practiceArea", "keywords"],
};

// ✅ Função usando SDK oficial com Google Search
async function extractKeywordsWithGemini(firmName, website, city, state) {
  if (!GEMINI_API_KEY) return null;

  try {
    // Usa gemini-1.5-flash (estável e suporta Google Search)
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      tools: [
        { googleSearch: {} } // ✅ Google Search Nativo
      ],
      generationConfig: {
        responseMimeType: "application/json", // ✅ Força JSON
        responseSchema: ANALYSIS_SCHEMA,      // ✅ Garante estrutura
      }
    });

    const prompt = `
I need to analyze a law firm named "${firmName}" located in ${city}, ${state}.
Their website is: ${website}.

Please use Google Search to find:
1. Their PRIMARY practice area (choose ONE from: Personal Injury, Family Law, Estate Planning, Criminal Defense, Immigration, Business Litigation, Bankruptcy, Employment Law, Real Estate Law, Elder Law)
2. 10 high-intent keywords potential clients use to find them (ALWAYS include "${city}" in EVERY keyword)

Examples of good keywords:
- "car accident lawyer in ${city}"
- "best personal injury attorney ${city}"
- "real estate lawyer ${city}"

Based on the search results, return structured JSON.
`;

    console.log(`[Gemini SDK] Analyzing ${firmName} with Google Search...`);

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    // Como definimos responseMimeType: "application/json", o text já é JSON válido
    const data = JSON.parse(text);

    console.log(`[Gemini SDK] ✅ Success: ${data.practiceArea}, found ${data.keywords?.length} keywords`);

    // Validação básica
    return {
      practiceArea: data.practiceArea || "Personal Injury",
      keywords: (data.keywords || []).slice(0, 10)
    };

  } catch (err) {
    console.error('[Gemini SDK] Error:', err.message);
    return null;
  }
}

// Função de resumo/insights (mantida)
async function summarizeFirmAnalysis(payload) {
  if (!GEMINI_API_KEY) return null;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
You are a law firm marketing strategist.
Based on this JSON analysis of a law firm's visibility:
${JSON.stringify(payload)}

Write exactly 3 short, punchy bullet points (max 20 words each) highlighting opportunities.
Do not use intro text. Just the bullets.
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    // Limpeza simples de bullets
    const lines = text
      .split('\n')
      .map(l => l.replace(/^[-•*\d\.\s]+/, '').trim())
      .filter(l => l.length > 0)
      .slice(0, 3);

    return lines.length ? lines : ["Improve SEO content", "Add Schema Markup", "Get more reviews"];
  } catch (err) {
    console.error('[Gemini SDK] Summarize Error:', err);
    return null;
  }
}

module.exports = {
  extractKeywordsWithGemini,
  summarizeFirmAnalysis,
};