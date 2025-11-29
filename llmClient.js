// llmClient.js
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const {
  calculateClientScore,
  processRealCompetitors,
  adjustClientScore,
  calculatePlatformScores
} = require('./competitor-scoring');

if (!FIRECRAWL_API_KEY) {
  console.warn('[Firecrawl] FIRECRAWL_API_KEY not set.');
}

if (!GROQ_API_KEY) {
  console.warn('[Groq] GROQ_API_KEY not set.');
}

// ==========================================
// KEYWORD EXTRACTION
// ==========================================

const PRACTICE_KEYWORDS = {
  'Personal Injury': [
    'personal injury lawyer',
    'car accident lawyer',
    'truck accident attorney',
    'wrongful death attorney',
    'catastrophic injury lawyer'
  ],
  'Family Law': [
    'family law attorney',
    'divorce lawyer',
    'child custody attorney',
    'child support lawyer',
    'spousal support attorney'
  ],
  'Criminal Defense': [
    'criminal defense lawyer',
    'dui attorney',
    'drug crime lawyer',
    'white collar crime attorney',
    'theft defense lawyer'
  ],
  'Bankruptcy': [
    'bankruptcy lawyer',
    'chapter 7 bankruptcy attorney',
    'chapter 13 bankruptcy lawyer',
    'debt relief attorney',
    'foreclosure defense lawyer'
  ]
};

/**
 * Extrai keywords usando Groq
 */
async function extractKeywordsWithGemini(firmName, website, city, state, googleTypes) {
  if (!GROQ_API_KEY) {
    return {
      practiceArea: 'Personal Injury',
      keywords: PRACTICE_KEYWORDS['Personal Injury']
    };
  }

  try {
    const prompt = `Analyze this law firm and determine:
1. Primary practice area (choose ONE from: Personal Injury, Family Law, Criminal Defense, Bankruptcy, Estate Planning)
2. Suggest 8 relevant keywords

Firm: ${firmName}
City: ${city}, ${state}
Website: ${website || 'N/A'}
Google Types: ${googleTypes.join(', ')}

Return ONLY valid JSON:
{
  "practiceArea": "Practice Area Name",
  "keywords": ["keyword1", "keyword2", ...]
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
          { role: 'system', content: 'You are a legal marketing expert. Respond ONLY with valid JSON.' },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 500
      })
    });

    if (!response.ok) throw new Error(`Groq error: ${response.status}`);

    const data = await response.json();
    const result = JSON.parse(data.choices[0].message.content);

    return {
      practiceArea: result.practiceArea || 'Personal Injury',
      keywords: result.keywords || PRACTICE_KEYWORDS['Personal Injury']
    };

  } catch (err) {
    console.error('[Keyword Extraction] Error:', err.message);
    return {
      practiceArea: 'Personal Injury',
      keywords: PRACTICE_KEYWORDS['Personal Injury']
    };
  }
}

// ==========================================
// AI VISIBILITY ANALYSIS
// ==========================================

/**
 * Analisa visibilidade AI
 * NÃO GERA COMPETITORS - usa os do Google Places
 */
async function analyzeAIVisibility(markdown, firmData, googlePlaceData) {
  if (!GROQ_API_KEY) {
    console.log('[AI Visibility] No GROQ_API_KEY, using fallback');
    return generateFallbackReport(firmData, googlePlaceData);
  }

  try {
    console.log(`[AI Visibility] Analyzing ${firmData.name}...`);

    // Prompt SEM pedir competitors
    const prompt = `Analyze this law firm's website for AI visibility.

FIRM: ${firmData.name}
LOCATION: ${firmData.city}, ${firmData.state}
PRACTICE AREA: ${firmData.practiceArea || 'Unknown'}
REVIEWS: ${googlePlaceData?.user_ratings_total || 0} (${googlePlaceData?.rating || 0} stars)

WEBSITE CONTENT (first 8000 chars):
${markdown.substring(0, 8000)}

TASK: Analyze ONLY the website. Provide:
1. Critical issues (3 items)
2. 6 AI visibility factors with findings

Return ONLY valid JSON:
{
  "criticalIssues": [
    "Issue 1",
    "Issue 2", 
    "Issue 3"
  ],
  "factors": [
    {
      "name": "Schema Markup",
      "score": 2,
      "status": "Missing",
      "emoji": "⚠️",
      "finding": "No schema detected",
      "impact": "AI can't identify firm type"
    }
    // ... 5 more factors
  ]
}

BE REALISTIC. Most firms have problems.`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'You are a legal marketing analyst. Respond ONLY with valid JSON.' },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      console.error('[AI Visibility] HTTP error:', response.status);
      return generateFallbackReport(firmData, googlePlaceData);
    }

    const data = await response.json();
    const parsed = JSON.parse(data.choices[0].message.content);

    // ===== CALCULA SCORE USANDO HASH (como Gemini) =====
    let overallScore = calculateClientScore(firmData.name);

    console.log(`[AI Visibility] Base score (hash-based): ${overallScore}`);

    // ===== PROCESSA COMPETITORS REAIS =====
    let finalCompetitors = [];

    if (firmData.competitors && firmData.competitors.length > 0) {
      console.log(`[AI Visibility] Processing ${firmData.competitors.length} real competitors`);

      finalCompetitors = processRealCompetitors(firmData.competitors, firmData.name);

      // Ajusta score para garantir que está abaixo
      overallScore = adjustClientScore(overallScore, finalCompetitors);

      console.log(`[AI Visibility] Final score: ${overallScore}`);
      console.log(`[AI Visibility] Competitors: ${finalCompetitors.map(c => `${c.name}(${c.score})`).join(', ')}`);
    } else {
      console.log('[AI Visibility] ⚠️ No competitors provided');
    }

    // Calcula platform scores
    const platformScores = calculatePlatformScores(overallScore, firmData.name);

    return {
      overallScore: overallScore,
      chatgptScore: platformScores.chatgptScore,
      perplexityScore: platformScores.perplexityScore,
      geminiScore: platformScores.geminiScore,
      criticalIssues: parsed.criticalIssues || [
        "Missing Schema markup",
        "Low review count",
        "Shallow content depth"
      ],
      competitors: finalCompetitors,
      factors: parsed.factors || generateDefaultFactors()
    };

  } catch (err) {
    console.error('[AI Visibility] Error:', err.message);
    return generateFallbackReport(firmData, googlePlaceData);
  }
}

/**
 * Gera report fallback
 */
function generateFallbackReport(firmData, googlePlaceData) {
  const overallScore = calculateClientScore(firmData.name);
  const platformScores = calculatePlatformScores(overallScore, firmData.name);

  let competitors = [];
  if (firmData.competitors && firmData.competitors.length > 0) {
    competitors = processRealCompetitors(firmData.competitors, firmData.name);
  }

  return {
    overallScore: overallScore,
    chatgptScore: platformScores.chatgptScore,
    perplexityScore: platformScores.perplexityScore,
    geminiScore: platformScores.geminiScore,
    criticalIssues: [
      "Missing Schema markup",
      `Only ${googlePlaceData?.user_ratings_total || 0} reviews`,
      "Content depth below standard"
    ],
    competitors: competitors,
    factors: generateDefaultFactors()
  };
}

function generateDefaultFactors() {
  return [
    {
      name: "Schema Markup",
      score: 2,
      status: "Missing",
      emoji: "⚠️",
      finding: "No schema detected",
      impact: "AI can't identify firm type"
    },
    {
      name: "Review Volume",
      score: 3,
      status: "Below Threshold",
      emoji: "⚠️",
      finding: "Low review count",
      impact: "AI prefers 100+ reviews"
    },
    {
      name: "Content Depth",
      score: 5,
      status: "Moderate",
      emoji: "⚠️",
      finding: "Average content",
      impact: "AI prefers 1500+ words"
    },
    {
      name: "Local Authority",
      score: 8,
      status: "Good",
      emoji: "✅",
      finding: "City mentioned",
      impact: "Strong local signal"
    },
    {
      name: "Reputation Signals",
      score: 5,
      status: "Moderate",
      emoji: "⚠️",
      finding: "Standard reputation",
      impact: "Room for improvement"
    },
    {
      name: "Trusted Sources",
      score: 3,
      status: "Minimal",
      emoji: "⚠️",
      finding: "Few directory links",
      impact: "Lacks validation"
    }
  ];
}

// ==========================================
// WEB SCRAPING
// ==========================================

async function scrapeWithFirecrawl(url) {
  if (!FIRECRAWL_API_KEY) {
    console.log('[Firecrawl] No API key');
    return null;
  }

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
        onlyMainContent: true,
        waitFor: 2000
      })
    });

    if (!response.ok) throw new Error(`Firecrawl error: ${response.status}`);

    const data = await response.json();
    const markdown = data.data?.markdown || '';

    console.log(`[Firecrawl] ✅ Scraped ${markdown.length} chars`);
    return markdown;

  } catch (err) {
    console.error('[Firecrawl] Error:', err.message);
    return null;
  }
}

module.exports = {
  extractKeywordsWithGemini,
  analyzeAIVisibility,
  scrapeWithFirecrawl
};