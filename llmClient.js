// llmClient.js
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;

if (!FIRECRAWL_API_KEY) {
  console.warn('[Firecrawl] FIRECRAWL_API_KEY not set. Will use fallback detection.');
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

// Lista de termos jurídicos válidos
const LEGAL_TERMS = [
  'accident', 'injury', 'personal injury', 'car accident', 'truck accident', 'motorcycle',
  'wrongful death', 'catastrophic', 'brain injury', 'spinal cord', 'slip and fall',
  'premises liability', 'product liability', 'medical malpractice', 'nursing home',
  'dog bite', 'bicycle accident', 'pedestrian', 'uber', 'lyft',
  'criminal', 'dui', 'dwi', 'drug crime', 'domestic violence', 'assault', 'battery',
  'theft', 'robbery', 'burglary', 'felony', 'misdemeanor', 'expungement',
  'divorce', 'custody', 'child support', 'spousal support', 'alimony', 'separation',
  'prenuptial', 'adoption', 'paternity', 'guardianship',
  'estate planning', 'wills', 'trusts', 'probate', 'elder law', 'medicaid',
  'asset protection', 'power of attorney', 'living will', 'conservatorship',
  'immigration', 'visa', 'green card', 'citizenship', 'deportation', 'asylum',
  'business', 'corporate', 'contract', 'litigation', 'employment', 'wrongful termination',
  'discrimination', 'harassment', 'wage', 'whistleblower',
  'real estate', 'landlord', 'tenant', 'eviction', 'foreclosure', 'property',
  'bankruptcy', 'chapter 7', 'chapter 13', 'debt relief', 'foreclosure defense',
  'civil rights', 'police brutality', 'construction', 'workers compensation',
  'social security', 'disability', 'veterans', 'toxic tort', 'mass tort',
  'class action', 'securities', 'insurance bad faith', 'wildfire', 'data breach'
];

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

// ✅ Detecta prática do markdown
function detectPracticeFromContent(markdown) {
  const text = markdown.toLowerCase();

  // Contagem de mentions por prática
  const scores = {
    'Personal Injury': 0,
    'Real Estate Law': 0,
    'Family Law': 0,
    'Estate Planning': 0,
    'Criminal Defense': 0,
    'Business Law': 0,
    'Immigration': 0,
    'Employment Law': 0,
    'Bankruptcy': 0
  };

  // Palavras-chave por prática
  if (text.match(/personal injury|car accident|truck accident|wrongful death|catastrophic injury/gi)) scores['Personal Injury'] += 5;
  if (text.match(/real estate|property law|landlord|tenant|foreclosure/gi)) scores['Real Estate Law'] += 5;
  if (text.match(/family law|divorce|custody|child support|spousal support/gi)) scores['Family Law'] += 5;
  if (text.match(/estate planning|wills|trusts|probate|elder law/gi)) scores['Estate Planning'] += 5;
  if (text.match(/criminal defense|dui|dwi|drug crime|felony/gi)) scores['Criminal Defense'] += 5;
  if (text.match(/business law|corporate|commercial litigation|contract/gi)) scores['Business Law'] += 5;
  if (text.match(/immigration|visa|green card|citizenship|deportation/gi)) scores['Immigration'] += 5;
  if (text.match(/employment law|wrongful termination|discrimination|harassment/gi)) scores['Employment Law'] += 5;
  if (text.match(/bankruptcy|chapter 7|chapter 13|debt relief/gi)) scores['Bankruptcy'] += 5;

  // Retorna a prática com maior score
  const sortedPractices = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return sortedPractices[0][1] > 0 ? sortedPractices[0][0] : 'Personal Injury';
}

// ✅ Extrai keywords do markdown
function extractKeywordsFromMarkdown(markdown) {
  const keywords = new Set();
  const lines = markdown.split('\n');

  for (const line of lines) {
    const text = line.trim().toLowerCase();

    // Pula linhas muito curtas ou longas
    if (text.length < 10 || text.length > 100) continue;

    // Pula headers genéricos
    if (/^#+\s*(home|about|contact|blog|news|team)/i.test(line)) continue;

    // Checa se contém termo jurídico
    const hasLegalTerm = LEGAL_TERMS.some(term => text.includes(term));
    if (!hasLegalTerm) continue;

    // Extrai texto limpo (remove markdown syntax)
    let cleanText = line
      .replace(/^#+\s*/, '') // Remove headers
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // Remove links, mantém texto
      .replace(/[*_`]/g, '') // Remove formatação
      .trim();

    if (cleanText.length < 10 || cleanText.length > 80) continue;

    keywords.add(cleanText);

    // Limite de 15 keywords encontradas
    if (keywords.size >= 15) break;
  }

  return Array.from(keywords);
}

// ✅ Normaliza keywords para formato padrão
function normalizeKeywords(rawKeywords, city) {
  return rawKeywords.slice(0, 10).map(kw => {
    let normalized = kw;

    // Remove "law firm", "law group", etc
    normalized = normalized.replace(/\b(law firm|law group|aplc|pc|llp|llc)\b/gi, '').trim();

    // Adiciona "lawyer" ou "attorney" se não tiver
    if (!/\b(lawyer|attorney)\b/i.test(normalized)) {
      normalized = normalized + ' lawyer';
    }

    // Adiciona cidade se não tiver
    if (!normalized.toLowerCase().includes(city.toLowerCase())) {
      normalized = `${normalized} in ${city}`;
    }

    // Title case
    normalized = normalized
      .toLowerCase()
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    return normalized;
  });
}

// ✅ FUNÇÃO PRINCIPAL: Extrai keywords com Firecrawl
async function extractKeywordsWithGemini(firmName, website, city, state, googleTypes = []) {
  console.log(`[Keyword Extractor] Analyzing ${firmName}...`);

  // Tenta scrape com Firecrawl
  const markdown = await scrapeWithFirecrawl(website);

  if (markdown) {
    // ✅ Sucesso! Usa conteúdo real do site
    const practiceArea = detectPracticeFromContent(markdown);
    const rawKeywords = extractKeywordsFromMarkdown(markdown);

    if (rawKeywords.length >= 5) {
      const keywords = normalizeKeywords(rawKeywords, city);
      console.log(`[Keyword Extractor] ✅ Found ${practiceArea}, ${keywords.length} real keywords from site`);

      return {
        practiceArea,
        keywords
      };
    }
  }

  // ❌ Fallback: Firecrawl falhou ou não achou keywords suficientes
  console.log('[Keyword Extractor] ⚠️ Using fallback generic keywords');

  // Detecta prática pelo nome
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