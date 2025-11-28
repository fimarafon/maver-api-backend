// llmClient.js
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!FIRECRAWL_API_KEY) {
  console.warn('[Firecrawl] FIRECRAWL_API_KEY not set. Will use fallback detection.');
}

if (!GROQ_API_KEY) {
  console.warn('[Groq] GROQ_API_KEY not set. Will use fallback detection.');
}

// Mapa de fallback por área de prática
const PRACTICE_KEYWORDS = {
  'Personal Injury': [
    'personal injury lawyer',
    'car accident lawyer',
    'truck accident attorney',
    'wrongful death attorney',
    'catastrophic injury lawyer',
    'slip and fall lawyer',
    'dog bite attorney',
    'brain injury attorney',
    'pedestrian accident lawyer',
    'motorcycle accident lawyer'
  ],
  'Real Estate Law': [
    'real estate lawyer',
    'real estate attorney',
    'property lawyer',
    'commercial real estate attorney',
    'residential real estate lawyer',
    'landlord tenant lawyer',
    'real estate litigation attorney',
    'property dispute lawyer',
    'foreclosure defense lawyer',
    'real estate contract attorney'
  ],
  'Family Law': [
    'family law attorney',
    'divorce lawyer',
    'child custody attorney',
    'child support lawyer',
    'spousal support attorney',
    'alimony lawyer',
    'adoption lawyer',
    'paternity attorney',
    'domestic violence lawyer',
    'prenuptial agreement lawyer'
  ],
  'Estate Planning': [
    'estate planning lawyer',
    'wills and trusts lawyer',
    'probate attorney',
    'trust attorney',
    'estate attorney',
    'asset protection lawyer',
    'living trust attorney',
    'probate lawyer',
    'elder law attorney',
    'guardianship lawyer'
  ],
  'Criminal Defense': [
    'criminal defense lawyer',
    'DUI lawyer',
    'felony defense lawyer',
    'drug crime attorney',
    'domestic violence defense lawyer',
    'assault defense attorney',
    'expungement lawyer',
    'misdemeanor lawyer',
    'sex crime defense attorney',
    'theft defense lawyer'
  ],
  'Business Law': [
    'business lawyer',
    'business attorney',
    'corporate lawyer',
    'business litigation attorney',
    'contract lawyer',
    'commercial litigation lawyer',
    'partnership dispute attorney',
    'business contract lawyer',
    'corporate attorney',
    'employment lawyer'
  ],
  'Immigration': [
    'immigration lawyer',
    'visa lawyer',
    'green card attorney',
    'citizenship lawyer',
    'deportation defense attorney',
    'asylum lawyer',
    'work permit attorney',
    'naturalization lawyer',
    'family immigration lawyer',
    'business immigration attorney'
  ],
  'Employment Law': [
    'employment lawyer',
    'wrongful termination lawyer',
    'workplace discrimination attorney',
    'wage dispute lawyer',
    'sexual harassment attorney',
    'labor law attorney',
    'employee rights lawyer',
    'whistleblower attorney',
    'severance lawyer',
    'FMLA lawyer'
  ],
  'Bankruptcy': [
    'bankruptcy lawyer',
    'chapter 7 lawyer',
    'chapter 13 attorney',
    'debt relief lawyer',
    'foreclosure defense lawyer',
    'debt settlement attorney',
    'bankruptcy filing lawyer',
    'chapter 11 attorney',
    'debt consolidation lawyer',
    'creditor harassment lawyer'
  ]
};

// ✅ Scrape com Firecrawl
async function scrapeWithFirecrawl(url) {
  if (!FIRECRAWL_API_KEY) return null;

  try {
    console.log(`[Firecrawl] Scraping ${url}...`);

    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${FIRECRAWL_API_KEY}`
      },
      body: JSON.stringify({
        url: url,
        formats: ['markdown'],
        onlyMainContent: true
      })
    });

    if (!response.ok) {
      console.error('[Firecrawl] HTTP error:', response.status);
      return null;
    }

    const data = await response.json();
    const markdown = data?.data?.markdown || '';

    if (!markdown) {
      console.log('[Firecrawl] No markdown content received');
      return null;
    }

    console.log(`[Firecrawl] ✅ Scraped ${markdown.length} chars`);
    return markdown;

  } catch (err) {
    console.error('[Firecrawl] Error:', err.message);
    return null;
  }
}

// ✅ Analisa com Groq (Llama 3.1)
async function analyzeWithGroq(markdown, firmName, city) {
  if (!GROQ_API_KEY) return null;

  try {
    console.log(`[Groq] Analyzing with Llama 3.1...`);

    const prompt = `You are a legal marketing expert analyzing a law firm's website.

Firm Name: ${firmName}
Location: ${city}

Website Content (Markdown):
${markdown.substring(0, 8000)}

Task: Extract ALL legal practice areas and services mentioned on this website.

Instructions:
1. Identify the PRIMARY practice area (the most prominent one)
2. List 10 high-intent keywords that potential clients would search for
3. Include EVERY service mentioned (e.g., "Financial Elder Abuse", "Wildfire Litigation")
4. ALWAYS include "${city}" in every keyword
5. Use natural search language (e.g., "car accident lawyer in ${city}")

Return ONLY valid JSON:
{
  "practiceArea": "Primary Practice Area",
  "keywords": [
    "keyword 1 in ${city}",
    "keyword 2 in ${city}",
    ...exactly 10 keywords
  ]
}`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.1-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'You are a legal marketing expert. Always respond with valid JSON only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Groq] HTTP error:', response.status, errorText);
      return null;
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;

    if (!content) {
      console.log('[Groq] No content in response');
      return null;
    }

    const parsed = JSON.parse(content);

    console.log(`[Groq] ✅ Extracted: ${parsed.practiceArea}, ${parsed.keywords?.length || 0} keywords`);

    return {
      practiceArea: parsed.practiceArea || 'Personal Injury',
      keywords: (parsed.keywords || []).slice(0, 10)
    };

  } catch (err) {
    console.error('[Groq] Error:', err.message);
    return null;
  }
}

// ✅ FUNÇÃO PRINCIPAL: Firecrawl + Groq
async function extractKeywordsWithGemini(firmName, website, city, state, googleTypes = []) {
  console.log(`[Keyword Extractor] Analyzing ${firmName} with AI...`);

  // Tenta scrape com Firecrawl
  const markdown = await scrapeWithFirecrawl(website);

  if (markdown && GROQ_API_KEY) {
    // ✅ Usa Groq pra analisar o conteúdo REAL
    const result = await analyzeWithGroq(markdown, firmName, city);

    if (result && result.keywords && result.keywords.length >= 5) {
      console.log(`[Keyword Extractor] ✅ SUCCESS with AI analysis`);
      return result;
    }
  }

  // ❌ Fallback: Usa detecção simples
  console.log('[Keyword Extractor] ⚠️ Using fallback generic keywords');

  const practiceArea = detectPracticeByName(firmName, googleTypes);
  const baseKeywords = PRACTICE_KEYWORDS[practiceArea] || PRACTICE_KEYWORDS['Personal Injury'];

  // Adiciona cidade
  const keywords = baseKeywords.slice(0, 10).map(kw => `${kw} in ${city}`);

  return {
    practiceArea,
    keywords
  };
}

// Helper: Detecta prática pelo nome (fallback)
function detectPracticeByName(firmName, googleTypes = []) {
  const name = firmName.toLowerCase();
  const types = googleTypes.join(' ').toLowerCase();

  if (name.includes('real estate') || types.includes('real_estate')) return 'Real Estate Law';
  if (name.includes('family') || name.includes('divorce')) return 'Family Law';
  if (name.includes('estate planning') || name.includes('trust')) return 'Estate Planning';
  if (name.includes('criminal') || name.includes('dui')) return 'Criminal Defense';
  if (name.includes('immigration')) return 'Immigration';
  if (name.includes('bankruptcy')) return 'Bankruptcy';
  if (name.includes('employment')) return 'Employment Law';
  if (name.includes('business') || name.includes('corporate')) return 'Business Law';

  return 'Personal Injury';
}

// Função de insights (simplificada)
async function summarizeFirmAnalysis(payload) {
  return [
    "Add structured data (Schema.org) to improve AI visibility",
    "Optimize content for location-specific search terms",
    "Build review volume to 100+ for better AI recommendations"
  ];
}

module.exports = {
  extractKeywordsWithGemini,
  summarizeFirmAnalysis,
};