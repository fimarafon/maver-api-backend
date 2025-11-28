const express = require('express');
const cors = require('cors');

const app = express();

// CORS configuration - allow Vercel domain
app.use(cors({
  origin: [
    'https://maver-app.vercel.app',
    'https://maver-app-git-main-filipes-projects-a9bf9d30.vercel.app',
    'http://localhost:3000',
    /\.vercel\.app$/  // Allow all Vercel preview URLs
  ],
  credentials: true
}));

app.use(express.json());

const PORT = process.env.PORT || 3001;

// ------------------------------------------------------
// Helpers básicos
// ------------------------------------------------------
function extractText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(text) {
  return text.split(/\s+/).filter(word => word.length > 0).length;
}

function extractMetaDescription(html) {
  const metaMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i
  );
  if (metaMatch) return metaMatch[1].trim();
  const ogMatch = html.match(
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i
  );
  return ogMatch ? ogMatch[1].trim() : '';
}

function extractInternalLinks(html, baseHostname) {
  const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>/gi;
  const links = new Set();
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    let href = match[1];
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    if (href.startsWith('http') && !href.includes(baseHostname)) continue;

    if (href.startsWith('/')) {
      href = `https://${baseHostname}${href}`;
    } else if (!href.startsWith('http')) {
      href = `https://${baseHostname}/${href}`;
    }

    const lowerHref = href.toLowerCase();
    if (
      lowerHref.includes('practice') || lowerHref.includes('service') ||
      lowerHref.includes('area') || lowerHref.includes('attorney') ||
      lowerHref.includes('lawyer') || lowerHref.includes('legal')
    ) {
      links.add(href);
    }
  }

  return Array.from(links).slice(0, 5);
}

// ------------------------------------------------------
// Crawling simples de página
// ------------------------------------------------------
async function analyzePage(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    clearTimeout(timeoutId);
    if (!response.ok) return null;

    const html = await response.text();
    const htmlLower = html.toLowerCase();

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    const h1Regex = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
    const h1Tags = [];
    let h1Match;
    while ((h1Match = h1Regex.exec(html)) !== null) {
      const clean = h1Match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (clean) h1Tags.push(clean);
    }

    const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
    const h2Tags = [];
    let h2Match;
    while ((h2Match = h2Regex.exec(html)) !== null) {
      const clean = h2Match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (clean) h2Tags.push(clean);
    }

    const text = extractText(html);
    const wordCount = countWords(text);
    const hasSchema = htmlLower.includes('schema.org') || htmlLower.includes('"@type"');
    const metaDescription = extractMetaDescription(html);

    return { url, title, wordCount, h1Tags, h2Tags, hasSchema, metaDescription };
  } catch (e) {
    console.error('[analyzePage error]', url, e.message);
    return null;
  }
}

// ------------------------------------------------------
// Scoring Google & LLM
// ------------------------------------------------------
function estimateGoogleRanking(keyword, pages, rating, reviews) {
  const cleanKw = keyword.toLowerCase().replace(' lawyer', '').replace(' attorney', '').trim();
  let score = 0;

  const inTitle = pages.some(p => p.title.toLowerCase().includes(cleanKw));
  if (inTitle) score += 35;

  const dedicatedPage = pages.find(p => {
    const urlMatch = p.url.toLowerCase().includes(cleanKw);
    const h1Match = p.h1Tags.some(h1 => h1.toLowerCase().includes(cleanKw));
    return urlMatch && h1Match && p.wordCount > 500;
  });
  if (dedicatedPage) {
    score += 30;
    if (dedicatedPage.wordCount > 1500) score += 10;
    else if (dedicatedPage.wordCount > 1000) score += 5;
  }

  if (pages.some(p => p.hasSchema)) score += 20;
  else score = Math.round(score * 0.4);

  if (rating >= 4.8 && reviews >= 150) score += 15;
  else if (rating >= 4.5 && reviews >= 100) score += 12;
  else if (rating >= 4.5 && reviews >= 50) score += 8;
  else if (rating >= 4.0 && reviews >= 20) score += 4;

  return Math.min(score, 100);
}

function scoreToLLMVisibility(score) {
  if (score >= 75) return { chatgpt: true, perplexity: true, gemini: true };
  if (score >= 60) return { chatgpt: true, perplexity: true, gemini: false };
  if (score >= 45) return { chatgpt: true, perplexity: false, gemini: false };
  if (score >= 30) return { chatgpt: Math.random() > 0.7, perplexity: false, gemini: false };
  return { chatgpt: false, perplexity: false, gemini: false };
}

// ------------------------------------------------------
// Banco de keywords por prática (para completar, não para tudo)
// ------------------------------------------------------
const PRACTICE_KEYWORDS = {
  'Personal Injury': [
    'Personal Injury Lawyer',
    'Car Accident Lawyer',
    'Truck Accident Lawyer',
    'Wrongful Death Lawyer',
    'Catastrophic Injury Lawyer',
    'Premises Liability Lawyer',
    'Product Liability Lawyer',
    'Medical Malpractice Lawyer',
    'Slip and Fall Lawyer',
    'Dog Bite Lawyer'
  ],
  'Family Law': [
    'Family Law Attorney',
    'Divorce Lawyer',
    'Child Custody Lawyer',
    'Child Support Attorney',
    'Spousal Support Lawyer',
    'Prenuptial Agreement Lawyer'
  ],
  'Criminal Defense': [
    'Criminal Defense Lawyer',
    'DUI Attorney',
    'Drug Crime Lawyer',
    'Felony Defense Attorney',
    'Domestic Violence Defense Lawyer'
  ],
  'Immigration Law': [
    'Immigration Attorney',
    'Visa Lawyer',
    'Green Card Lawyer',
    'Citizenship Attorney',
    'Deportation Defense Lawyer'
  ],
  'Estate Planning': [
    'Estate Planning Attorney',
    'Wills and Trusts Lawyer',
    'Trust Administration Attorney',
    'Probate Lawyer',
    'Special Needs Trusts Attorney',
    'Living Will Lawyer'
  ],
  'Elder Law': [
    'Elder Law Attorney',
    'Medicaid Planning Lawyer',
    'Nursing Home Planning Attorney',
    'Guardianship Lawyer'
  ],
  'Business Litigation': [
    'Business Litigation Attorney',
    'Commercial Litigation Lawyer',
    'Contract Dispute Lawyer',
    'Shareholder Dispute Attorney'
  ],
  'Employment Law': [
    'Employment Lawyer',
    'Wrongful Termination Attorney',
    'Workplace Discrimination Lawyer',
    'Wage and Hour Lawyer'
  ],
  'Real Estate Law': [
    'Real Estate Attorney',
    'Landlord Tenant Lawyer',
    'Property Dispute Lawyer',
    'Real Estate Litigation Attorney'
  ],
  'Bankruptcy': [
    'Bankruptcy Attorney',
    'Chapter 7 Bankruptcy Lawyer',
    'Chapter 13 Bankruptcy Lawyer',
    'Debt Relief Lawyer'
  ],
  'General Practice': [
    'General Practice Attorney',
    'Civil Litigation Lawyer',
    'Small Business Lawyer',
    'Local Attorney'
  ]
};

// ------------------------------------------------------
// Detectar prática com base em Google Types + texto do site
// ------------------------------------------------------
function detectPractice(googleTypes = [], combinedText = '') {
  const text = combinedText.toLowerCase();
  const typesLower = googleTypes.map(t => t.toLowerCase());

  const hasType = (t) => typesLower.some(x => x.includes(t));

  // PERSONAL INJURY
  if (
    hasType('personal_injury') ||
    text.includes('personal injury') ||
    text.includes('car accident') ||
    text.includes('auto accident') ||
    text.includes('truck accident') ||
    text.includes('wrongful death')
  ) {
    return 'Personal Injury';
  }

  // CRIMINAL DEFENSE
  if (
    hasType('criminal') ||
    text.includes('criminal defense') ||
    text.includes('dui') ||
    text.includes('drunk driving') ||
    text.includes('felony') ||
    text.includes('misdemeanor')
  ) {
    return 'Criminal Defense';
  }

  // FAMILY LAW
  if (
    hasType('family_law') ||
    text.includes('family law') ||
    text.includes('divorce') ||
    text.includes('child custody') ||
    text.includes('spousal support')
  ) {
    return 'Family Law';
  }

  // ESTATE PLANNING
  if (
    hasType('estate_planning') ||
    text.includes('estate planning') ||
    text.includes('wills and trusts') ||
    text.includes('trust administration') ||
    text.includes('probate')
  ) {
    return 'Estate Planning';
  }

  // ELDER LAW
  if (
    hasType('elder_law') ||
    text.includes('elder law') ||
    text.includes('medicaid planning') ||
    text.includes('nursing home')
  ) {
    return 'Elder Law';
  }

  // IMMIGRATION
  if (
    hasType('immigration') ||
    text.includes('immigration') ||
    text.includes('green card') ||
    text.includes('visa') ||
    text.includes('citizenship')
  ) {
    return 'Immigration Law';
  }

  // EMPLOYMENT
  if (
    text.includes('employment law') ||
    text.includes('wrongful termination') ||
    text.includes('workplace discrimination') ||
    text.includes('wage and hour')
  ) {
    return 'Employment Law';
  }

  // BUSINESS / COMMERCIAL
  if (
    text.includes('business law') ||
    text.includes('commercial litigation') ||
    text.includes('business litigation') ||
    text.includes('corporate law')
  ) {
    return 'Business Litigation';
  }

  // REAL ESTATE
  if (
    hasType('real_estate') ||
    text.includes('real estate law') ||
    text.includes('landlord tenant') ||
    text.includes('property dispute')
  ) {
    return 'Real Estate Law';
  }

  // BANKRUPTCY
  if (
    hasType('bankruptcy') ||
    text.includes('bankruptcy') ||
    text.includes('chapter 7') ||
    text.includes('chapter 13')
  ) {
    return 'Bankruptcy';
  }

  return 'General Practice';
}

// ------------------------------------------------------
// Extrair keywords dos Google Types + headings do site
// ------------------------------------------------------
function extractKeywordsFromTypes(googleTypes = []) {
  const keywords = new Set();
  const typesLower = googleTypes.map(t => t.toLowerCase());

  const push = (kw) => {
    const clean = kw.trim();
    if (clean.length > 0 && clean.length <= 80) keywords.add(clean);
  };

  typesLower.forEach(t => {
    if (t.includes('personal_injury')) {
      push('Personal Injury Lawyer');
      push('Car Accident Lawyer');
      push('Truck Accident Lawyer');
      push('Wrongful Death Lawyer');
    }
    if (t.includes('criminal')) {
      push('Criminal Defense Lawyer');
      push('DUI Attorney');
      push('Drug Crime Lawyer');
    }
    if (t.includes('family')) {
      push('Family Law Attorney');
      push('Divorce Lawyer');
      push('Child Custody Lawyer');
    }
    if (t.includes('estate')) {
      push('Estate Planning Attorney');
      push('Wills and Trusts Lawyer');
      push('Trust Administration Attorney');
    }
    if (t.includes('elder')) {
      push('Elder Law Attorney');
      push('Medicaid Planning Lawyer');
    }
    if (t.includes('immigration')) {
      push('Immigration Attorney');
      push('Green Card Lawyer');
      push('Visa Lawyer');
    }
    if (t.includes('real_estate')) {
      push('Real Estate Attorney');
      push('Landlord Tenant Lawyer');
    }
    if (t.includes('bankruptcy')) {
      push('Bankruptcy Attorney');
      push('Chapter 7 Bankruptcy Lawyer');
    }
    if (t.includes('lawyer') || t.includes('attorney') || t.includes('law_firm')) {
      push('Local Lawyer');
      push('Local Attorney');
    }
  });

  return Array.from(keywords);
}

function extractKeywordsFromHeadings(homepage) {
  if (!homepage) return [];
  const headings = [...(homepage.h1Tags || []), ...(homepage.h2Tags || [])];
  const keywords = new Set();

  const legalTriggers = [
    'lawyer', 'attorney', 'law firm', 'law office',
    'defense', 'injury', 'accident', 'estate', 'trust',
    'probate', 'divorce', 'custody', 'immigration',
    'criminal', 'dui', 'elder', 'employment', 'real estate',
    'bankruptcy'
  ];

  const push = (kw) => {
    let clean = kw.replace(/\s+/g, ' ').trim();
    if (clean.length < 5 || clean.length > 90) return;

    clean = clean.split(' ').map(w => {
      if (!w) return '';
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');

    keywords.add(clean);
  };

  headings.forEach(h => {
    const lower = h.toLowerCase();
    if (!legalTriggers.some(t => lower.includes(t))) return;

    // 1) heading inteiro (ex: "Orange County Estate Planning & Elder Law Attorneys")
    push(h);

    // 2) quebrar por "&", " and "
    const parts = h.split(/&|,|\/| and /i).map(p => p.trim()).filter(Boolean);
    parts.forEach(p => {
      const pLower = p.toLowerCase();
      if (legalTriggers.some(t => pLower.includes(t))) {
        push(p);
      } else if (
        pLower.includes('estate') ||
        pLower.includes('elder') ||
        pLower.includes('injury') ||
        pLower.includes('accident') ||
        pLower.includes('divorce') ||
        pLower.includes('custody')
      ) {
        // adicionar "Lawyer" pra virar keyword
        push(p + ' Lawyer');
      }
    });
  });

  // Também olhar meta description se mencionar algo jurídico
  if (homepage.metaDescription) {
    const desc = homepage.metaDescription;
    const lower = desc.toLowerCase();
    if (legalTriggers.some(t => lower.includes(t))) {
      // pegar frases maiores separadas por ponto
      desc.split(/[.!?]/).forEach(sentence => {
        const sLower = sentence.toLowerCase();
        if (legalTriggers.some(t => sLower.includes(t))) {
          push(sentence);
        }
      });
    }
  }

  return Array.from(keywords);
}

// Junta tudo pra quick mode
function buildKeywordList(googleTypes, homepage, detectedPractice) {
  const fromTypes = extractKeywordsFromTypes(googleTypes);
  const fromHeadings = extractKeywordsFromHeadings(homepage);

  const combined = new Set();

  fromTypes.forEach(k => combined.add(k));
  fromHeadings.forEach(k => combined.add(k));

  // Se ainda tiver pouco, completar com banco daquela prática
  const base = PRACTICE_KEYWORDS[detectedPractice] || PRACTICE_KEYWORDS['General Practice'];
  base.forEach(k => combined.add(k));

  // Priorizar: headings > types > banco
  const ordered = [];

  // 1) headings que não sejam genéricas
  extractKeywordsFromHeadings(homepage).forEach(k => {
    if (!ordered.includes(k)) ordered.push(k);
  });

  // 2) types
  extractKeywordsFromTypes(googleTypes).forEach(k => {
    if (!ordered.includes(k)) ordered.push(k);
  });

  // 3) banco da prática
  base.forEach(k => {
    if (!ordered.includes(k)) ordered.push(k);
  });

  return ordered.slice(0, 12); // até 12 keywords
}

// ------------------------------------------------------
// Análise completa da firma (full mode)
// ------------------------------------------------------
async function analyzeFirm(url, keywords, rating, reviews) {
  let baseUrl = url && url.startsWith('http') ? url : (url ? `https://${url}` : null);
  if (!baseUrl) {
    return { overallScore: 5, keywordScores: [], analysis: null };
  }
  if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

  const homepage = await analyzePage(baseUrl);
  if (!homepage) {
    return { overallScore: 5, keywordScores: [], analysis: null };
  }

  let homepageHtml = '';
  try {
    const homepageResponse = await fetch(baseUrl);
    homepageHtml = await homepageResponse.text();
  } catch (e) {
    homepageHtml = '';
  }

  const internalLinks = homepageHtml
    ? extractInternalLinks(homepageHtml, new URL(baseUrl).hostname)
    : [];

  const pages = [homepage];

  for (let i = 0; i < Math.min(internalLinks.length, 5); i++) {
    const pageAnalysis = await analyzePage(internalLinks[i]);
    if (pageAnalysis) pages.push(pageAnalysis);
  }

  const totalWords = pages.reduce((sum, p) => sum + p.wordCount, 0);
  const avgWords = Math.round(totalWords / pages.length);
  const hasSchema = pages.some(p => p.hasSchema);
  const dedicatedPages = pages.filter(p => p.url !== baseUrl && p.wordCount > 400).length;

  const keywordScores = [];

  for (const keyword of keywords || []) {
    const cleanKw = keyword.toLowerCase().replace(' lawyer', '').replace(' attorney', '').trim();

    const foundInTitle = pages.some(p => p.title.toLowerCase().includes(cleanKw));
    const hasDedicatedPage = pages.some(p => {
      const urlMatch = p.url.toLowerCase().includes(cleanKw);
      const h1Match = p.h1Tags.some(h1 => h1.toLowerCase().includes(cleanKw));
      return urlMatch && h1Match;
    });

    let totalMentions = 0;
    pages.forEach(p => {
      const pageText = `${p.title} ${p.h1Tags.join(' ')} ${p.h2Tags.join(' ')}`.toLowerCase();
      const matches = (pageText.match(new RegExp(cleanKw, 'g')) || []).length;
      totalMentions += matches;
    });

    const googleScore = estimateGoogleRanking(keyword, pages, rating, reviews);
    const llmVisibility = scoreToLLMVisibility(googleScore);

    keywordScores.push({
      keyword,
      googleRankingEstimate: googleScore,
      foundInTitle,
      hasDedicatedPage,
      totalMentions,
      ...llmVisibility
    });
  }

  const avgKeywordScore =
    keywordScores.length > 0
      ? keywordScores.reduce((sum, k) => sum + k.googleRankingEstimate, 0) / keywordScores.length
      : 10;

  let overallScore = Math.round(avgKeywordScore * 0.6);

  if (!hasSchema) overallScore = Math.round(overallScore * 0.5);
  if (avgWords < 600) overallScore = Math.round(overallScore * 0.8);
  if (dedicatedPages < 3) overallScore = Math.round(overallScore * 0.85);
  if (reviews < 50) overallScore = Math.round(overallScore * 0.9);

  overallScore = Math.max(overallScore, 5);
  overallScore = Math.min(overallScore, 73);

  return {
    overallScore,
    keywordScores,
    analysis: { pagesAnalyzed: pages.length, totalWords, avgWords, hasSchema, dedicatedPages }
  };
}

// ------------------------------------------------------
// ENDPOINT PRINCIPAL
// ------------------------------------------------------
app.post('/api/analyze', async (req, res) => {
  const startTime = Date.now();

  try {
    const { url, firmName, city, keywords, rating, reviews, mode, competitors, googleTypes = [] } = req.body;

    if (!url || !firmName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const isQuickMode = mode === 'quick';

    console.log(`[START] ${isQuickMode ? 'QUICK' : 'FULL'} analysis for ${firmName}`);

    // --------------- QUICK MODE ---------------
    if (isQuickMode) {
      // Normalizar URL
      let baseUrl = url.startsWith('http') ? url : `https://${url}`;
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

      // Tentar pegar homepage
      const homepage = await analyzePage(baseUrl);

      // Texto combinado pra detectar prática
      const combinedText = homepage
        ? [
          homepage.title || '',
          ...(homepage.h1Tags || []),
          ...(homepage.h2Tags || []),
          homepage.metaDescription || ''
        ].join(' ')
        : '';

      const detectedPractice = detectPractice(googleTypes, combinedText);
      const suggestedKeywords = buildKeywordList(googleTypes, homepage, detectedPractice);

      return res.json({
        detectedPractice,
        suggestedKeywords,
        quickAnalysis: true,
        hasSchema: homepage ? homepage.hasSchema : false,
        processingTime: Math.round((Date.now() - startTime) / 1000)
      });
    }

    // --------------- FULL MODE ---------------
    console.log('[FULL] Analyzing main firm...');
    const firmAnalysis = await analyzeFirm(url, keywords || [], rating || 0, reviews || 0);

    const insights = [];

    if (firmAnalysis.analysis) {
      const { pagesAnalyzed, avgWords, hasSchema } = firmAnalysis.analysis;

      if (!hasSchema) {
        insights.push(`Missing Schema (LocalBusiness/LegalService) on the ${pagesAnalyzed} pages analyzed.`);
      }

      if (avgWords < 800) {
        insights.push(
          `Average page length is ${avgWords} words. Top-performing firms in ${city} often have 1,500–2,000 words per key practice page.`
        );
      }

      const keywordsInTitles = firmAnalysis.keywordScores.filter(k => k.foundInTitle).length;
      if (keywordsInTitles < (keywords || []).length / 3) {
        insights.push(
          `Only ${keywordsInTitles} out of ${(keywords || []).length} target keywords appear in page titles.`
        );
      }
    }

    // Analyze competitors (mantém lógica leve actual)
    const competitorScores = [];

    if (competitors && competitors.length > 0) {
      console.log(`[COMPETITORS] Analyzing ${competitors.length} competitors...`);

      const top3 = competitors.slice(0, 3).filter(c => c.website);
      const top3Promises = top3.map(async (comp) => {
        console.log(`[COMPETITOR] Analyzing ${comp.name}...`);
        const analysis = await analyzeFirm(comp.website, keywords || [], comp.rating || 4.5, comp.reviews || 100);
        return {
          name: comp.name,
          score: analysis.overallScore,
          website: comp.website
        };
      });

      const top3Results = await Promise.all(top3Promises);
      competitorScores.push(...top3Results);

      const rest = competitors.slice(3, 10);
      for (const comp of rest) {
        if (comp.website) {
          const homepage = await analyzePage(comp.website);
          let score = 25;
          if (homepage) {
            if (homepage.hasSchema) score += 15;
            if (homepage.wordCount > 800) score += 10;
          }
          if (comp.rating >= 4.5 && comp.reviews >= 100) score += 8;

          competitorScores.push({
            name: comp.name,
            score: Math.min(score, 65)
          });
        } else {
          let score = 20;
          if (comp.rating >= 4.8 && comp.reviews >= 150) score += 15;
          else if (comp.rating >= 4.5) score += 10;

          competitorScores.push({
            name: comp.name,
            score: Math.min(score, 45)
          });
        }
      }
    }

    const avgKeywordScore =
      firmAnalysis.keywordScores && firmAnalysis.keywordScores.length
        ? firmAnalysis.keywordScores.reduce((sum, k) => sum + k.googleRankingEstimate, 0) /
        firmAnalysis.keywordScores.length
        : 10;

    // Platform scores derivados do overall
    const baseOverall = firmAnalysis.overallScore || 10;
    const response = {
      detectedPractice: 'N/A', // prática principal é usada no front pelo quick mode
      suggestedKeywords: keywords || [],
      keywordScores: firmAnalysis.keywordScores,
      overallScore: firmAnalysis.overallScore,
      platformScores: {
        chatgpt: Math.min(baseOverall + 2, 73),
        perplexity: Math.max(Math.round(baseOverall * 0.9), 0),
        gemini: Math.max(Math.round(baseOverall * 0.85), 0)
      },
      analysis: firmAnalysis.analysis,
      insights,
      competitors: competitorScores.sort((a, b) => b.score - a.score),
      processingTime: Math.round((Date.now() - startTime) / 1000)
    };

    console.log(`[COMPLETE] Score: ${firmAnalysis.overallScore} (${response.processingTime}s)`);

    res.json(response);

  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Analysis failed', overallScore: 5 });
  }
});

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Maver API running on port ${PORT}`);
});
