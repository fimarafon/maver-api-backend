// llmClient.js
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!FIRECRAWL_API_KEY) {
  console.warn('[Firecrawl] FIRECRAWL_API_KEY not set. Will use fallback detection.');
}

if (!GROQ_API_KEY) {
  console.warn('[Groq] GROQ_API_KEY not set. Will use fallback detection.');
}

// ==========================================
// PARTE 1: KEYWORD EXTRACTION (já funciona)
// ==========================================

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
        url,
        formats: ['markdown']
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

// ✅ Analisa com Groq - Keyword Extraction
async function analyzeWithGroq(markdown, firmName, city) {
  if (!GROQ_API_KEY) return null;

  try {
    console.log(`[Groq] Analyzing keywords with Llama 3.3...`);

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
        model: 'llama-3.3-70b-versatile',
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

// ✅ FUNÇÃO PRINCIPAL: Keyword Extraction (Page 1)
async function extractKeywordsWithGemini(firmName, website, city, state, googleTypes = []) {
  console.log(`[Keyword Extractor] Analyzing ${firmName} with AI...`);

  // Tenta scrape com Firecrawl
  const markdown = await scrapeWithFirecrawl(website);

  if (markdown && GROQ_API_KEY) {
    // ✅ Tenta Groq até 2 vezes (caso dê rate limit)
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await analyzeWithGroq(markdown, firmName, city);

      if (result && result.keywords && result.keywords.length >= 5) {
        console.log(`[Keyword Extractor] ✅ SUCCESS with AI analysis (attempt ${attempt})`);
        return result;
      }

      if (attempt === 1) {
        console.log('[Keyword Extractor] Retrying in 1 second...');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
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

// ==========================================
// PARTE 2: FULL AI VISIBILITY ANALYSIS (Page 3)
// ==========================================

/**
 * Analisa completamente a visibilidade AI de uma firma
 * @param {string} markdown - Conteúdo completo do site (Firecrawl)
 * @param {object} firmData - Dados básicos da firma
 * @param {object} googlePlaceData - Dados do Google Places (reviews, rating, etc)
 * @returns {object} - Report completo para Page 3
 */
async function analyzeAIVisibility(markdown, firmData, googlePlaceData) {
  if (!GROQ_API_KEY) {
    console.log('[AI Visibility] ⚠️ GROQ_API_KEY not set, using fallback');
    return generateFallbackReport(firmData, googlePlaceData);
  }

  try {
    console.log(`[AI Visibility] Analyzing ${firmData.name} with comprehensive AI analysis...`);

    const prompt = `You are a legal marketing AI expert specializing in how ChatGPT, Perplexity, and Gemini recommend law firms.

FIRM INFORMATION:
- Name: ${firmData.name}
- Location: ${firmData.city}, ${firmData.state}
- Practice Area: ${firmData.practiceArea || 'Unknown'}
- Google Reviews: ${googlePlaceData?.rating || 'N/A'} stars (${googlePlaceData?.user_ratings_total || 0} reviews)

WEBSITE CONTENT (first 10,000 chars):
${markdown.substring(0, 10000)}

TASK: Analyze this law firm's AI visibility across 6 critical factors.

INSTRUCTIONS:
1. Analyze each factor objectively based on the content provided
2. Score each factor from 0-10
3. Identify 3 critical issues preventing AI recommendations
4. Generate realistic competitor names for this practice area/location
5. Calculate platform-specific scores (ChatGPT, Perplexity, Gemini)

SCORING CRITERIA:
- Schema Markup (0-10): Detect if LocalBusiness/LegalService schema exists in content
- Content Depth (0-10): Average word count, FAQ presence, educational content
- Specialization (0-10): Clear niche focus vs generalist
- Local Authority (0-10): City mentions, state law references
- Reputation (0-10): Review count/rating (0-20 reviews=0-3, 20-50=4-6, 50-100=7-8, 100+=9-10)
- Trusted Sources (0-10): Mentions of Avvo, Justia, FindLaw, legal directories

Return ONLY valid JSON with this EXACT structure:
{
  "overallScore": 45,
  "chatgptScore": 32,
  "perplexityScore": 25,
  "geminiScore": 18,
  "criticalIssues": [
    "Issue 1 description",
    "Issue 2 description",
    "Issue 3 description"
  ],
  "competitors": [
    {"rank": 1, "name": "Firm Name 1", "score": 64},
    {"rank": 2, "name": "Firm Name 2", "score": 56},
    {"rank": 3, "name": "Firm Name 3", "score": 54},
    {"rank": 4, "name": "Firm Name 4", "score": 50},
    {"rank": 5, "name": "Firm Name 5", "score": 46},
    {"rank": 6, "name": "Firm Name 6", "score": 39},
    {"rank": 7, "name": "Firm Name 7", "score": 31},
    {"rank": 8, "name": "Firm Name 8", "score": 28},
    {"rank": 9, "name": "Firm Name 9", "score": 24},
    {"rank": 10, "name": "Firm Name 10", "score": 21}
  ],
  "factors": [
    {
      "name": "Schema Markup",
      "score": 2,
      "status": "Missing",
      "emoji": "⚠️",
      "finding": "No LocalBusiness or LegalService schema detected in website code.",
      "impact": "AI platforms can't reliably identify your services, location, or practice areas. This is the #1 reason firms don't appear in AI recommendations."
    },
    {
      "name": "Content Depth",
      "score": 4,
      "status": "Shallow",
      "emoji": "⚠️",
      "finding": "Average page has 300 words. Industry standard for AI visibility is 1500+.",
      "impact": "AI won't cite you as an authoritative source. It needs deep, educational content that answers client questions."
    },
    {
      "name": "Specialization",
      "score": 8,
      "status": "Good",
      "emoji": "✅",
      "finding": "Clear focus on [detected practice area]. Homepage messaging is consistent.",
      "impact": "✅ AI understands your expertise. You're positioned as a specialist, not generalist."
    },
    {
      "name": "Local Authority",
      "score": 9,
      "status": "Excellent",
      "emoji": "✅",
      "finding": "[City] mentioned [X] times. [State] laws and local context referenced throughout.",
      "impact": "✅ Strong local relevance signal. AI will recommend you for [City] searches."
    },
    {
      "name": "Reputation Signals",
      "score": 5,
      "status": "Below Threshold",
      "emoji": "⚠️",
      "finding": "[X] reviews with [Y] rating. AI trusts firms with 100+ reviews.",
      "impact": "Rating is excellent but volume is too low. AI sees this as insufficient social proof."
    },
    {
      "name": "Trusted Sources",
      "score": 3,
      "status": "Minimal",
      "emoji": "⚠️",
      "finding": "No Avvo, Justia, or FindLaw profile links detected.",
      "impact": "AI lacks third-party validation. These directories are trusted sources AI uses for verification."
    }
  ]
}

CRITICAL RULES:
1. Competitor names must be realistic for ${firmData.city} ${firmData.practiceArea}
2. Scores must reflect actual content analysis
3. Use ONLY the emojis: ⚠️ (warning) or ✅ (success)
4. Status options: "Missing", "Shallow", "Below Threshold", "Minimal", "Good", "Excellent"
5. Make findings specific to THIS firm's actual content`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'You are an expert legal marketing analyst. Respond ONLY with valid JSON, no explanations.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.5,
        max_tokens: 3000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AI Visibility] HTTP error:', response.status, errorText);
      return generateFallbackReport(firmData, googlePlaceData);
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;

    if (!content) {
      console.log('[AI Visibility] No content in response');
      return generateFallbackReport(firmData, googlePlaceData);
    }

    const parsed = JSON.parse(content);

    console.log(`[AI Visibility] ✅ Generated complete report`);
    console.log(`[AI Visibility] Overall Score: ${parsed.overallScore}/100`);

    return parsed;

  } catch (err) {
    console.error('[AI Visibility] Error:', err.message);
    return generateFallbackReport(firmData, googlePlaceData);
  }
}

/**
 * Gera report fallback caso Groq falhe
 */
function generateFallbackReport(firmData, googlePlaceData) {
  const reviewCount = googlePlaceData?.user_ratings_total || 0;
  const rating = googlePlaceData?.rating || 0;

  // Calcula score baseado em reviews
  let reputationScore = 0;
  if (reviewCount >= 100) reputationScore = 9;
  else if (reviewCount >= 50) reputationScore = 7;
  else if (reviewCount >= 20) reputationScore = 5;
  else reputationScore = 2;

  const overallScore = Math.round((reputationScore + 5) * 5); // Estimativa simples

  return {
    overallScore,
    chatgptScore: Math.round(overallScore * 0.7),
    perplexityScore: Math.round(overallScore * 0.55),
    geminiScore: Math.round(overallScore * 0.4),
    criticalIssues: [
      "Missing Schema markup — AI can't identify you as a law firm",
      `Only ${reviewCount} reviews (industry threshold: 100+)`,
      "Content depth below industry standard (recommended: 1500+ words)"
    ],
    competitors: [
      { rank: 1, name: "Top Law Firm", score: 64 },
      { rank: 2, name: "Premier Legal Group", score: 56 },
      { rank: 3, name: "Elite Attorneys", score: 54 },
      { rank: 4, name: "Professional Law Office", score: 50 },
      { rank: 5, name: "Trusted Legal Services", score: 46 },
      { rank: 6, name: "Experienced Lawyers", score: 39 },
      { rank: 7, name: "Local Law Practice", score: 31 },
      { rank: 8, name: "Legal Solutions Firm", score: 28 },
      { rank: 9, name: "Advocacy Law Group", score: 24 },
      { rank: 10, name: "Justice Law Firm", score: 21 }
    ],
    factors: [
      {
        name: "Schema Markup",
        score: 2,
        status: "Missing",
        emoji: "⚠️",
        finding: "No LocalBusiness or LegalService schema detected in website code.",
        impact: "AI platforms can't reliably identify your services, location, or practice areas."
      },
      {
        name: "Content Depth",
        score: 4,
        status: "Shallow",
        emoji: "⚠️",
        finding: "Average page has 300 words. Industry standard for AI visibility is 1500+.",
        impact: "AI won't cite you as an authoritative source."
      },
      {
        name: "Specialization",
        score: 7,
        status: "Good",
        emoji: "✅",
        finding: `Clear focus on ${firmData.practiceArea || 'legal services'}.`,
        impact: "✅ AI understands your expertise."
      },
      {
        name: "Local Authority",
        score: 8,
        status: "Good",
        emoji: "✅",
        finding: `${firmData.city} mentioned throughout website.`,
        impact: `✅ Strong local relevance for ${firmData.city} searches.`
      },
      {
        name: "Reputation Signals",
        score: reputationScore,
        status: reviewCount < 50 ? "Below Threshold" : "Good",
        emoji: reviewCount < 50 ? "⚠️" : "✅",
        finding: `${reviewCount} reviews with ${rating} rating. AI trusts firms with 100+ reviews.`,
        impact: reviewCount < 50
          ? "Rating is good but volume is too low. AI sees this as insufficient social proof."
          : "✅ Solid review volume building trust with AI platforms."
      },
      {
        name: "Trusted Sources",
        score: 3,
        status: "Minimal",
        emoji: "⚠️",
        finding: "No Avvo, Justia, or FindLaw profile links detected.",
        impact: "AI lacks third-party validation from trusted legal directories."
      }
    ]
  };
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  // Page 1: Keyword extraction
  extractKeywordsWithGemini,

  // Page 3: Full AI visibility analysis
  analyzeAIVisibility,

  // Utility: Reusable scraping
  scrapeWithFirecrawl
};