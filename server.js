// server.js
// MAVER API - Law Firm AI Grader Backend (versão revisada)

// ================== SETUP BÁSICO ==================
const express = require('express');
const cors = require('cors');

const app = express();

// CORS – permite seu app da Vercel e localhost
app.use(cors({
  origin: [
    'https://maver-app.vercel.app',
    /\.vercel\.app$/,
    'http://localhost:3000'
  ],
  credentials: true
}));

app.use(express.json());

const PORT = process.env.PORT || 3001;

// ================== HELPERS GERAIS ==================

function extractText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(text) {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

function extractInternalLinks(html, baseHost) {
  const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>/gi;
  const links = new Set();
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    let href = match[1];
    if (!href) continue;
    href = href.trim();
    if (!href) continue;

    // Ignorar anchors, mailto, tel
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;

    // Se for URL completa de outro domínio, pula
    if (href.startsWith('http') && !href.includes(baseHost)) continue;

    // Normalizar URL interna
    if (href.startsWith('/')) {
      href = `https://${baseHost}${href}`;
    } else if (!href.startsWith('http')) {
      href = `https://${baseHost}/${href}`;
    }

    const lower = href.toLowerCase();
    if (
      lower.includes('practice') ||
      lower.includes('service') ||
      lower.includes('area') ||
      lower.includes('attorney') ||
      lower.includes('lawyer') ||
      lower.includes('legal')
    ) {
      links.add(href);
    }
  }

  return Array.from(links).slice(0, 5);
}

async function analyzePage(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
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
      const text = h1Match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) h1Tags.push(text);
    }

    const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
    const h2Tags = [];
    let h2Match;
    while ((h2Match = h2Regex.exec(html)) !== null) {
      const text = h2Match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) h2Tags.push(text);
    }

    const text = extractText(html);
    const wordCount = countWords(text);
    const hasSchema = htmlLower.includes('schema.org') || htmlLower.includes('"@type"');

    return { url, title, wordCount, h1Tags, h2Tags, hasSchema };
  } catch (e) {
    return null;
  }
}

function estimateGoogleRanking(keyword, pages, rating, reviews) {
  const cleanKw = keyword.toLowerCase().replace(/(lawyer|attorney)/g, '').trim();
  let score = 0;

  // Keyword em title
  const inTitle = pages.some(p => p.title.toLowerCase().includes(cleanKw));
  if (inTitle) score += 35;

  // Página dedicada
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

  // Schema
  if (pages.some(p => p.hasSchema)) score += 20;
  else score = Math.round(score * 0.4);

  // Reviews
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

async function analyzeFirm(url, keywords, rating, reviews) {
  let baseUrl = url.startsWith('http') ? url : `https://${url}`;
  if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

  const homepage = await analyzePage(baseUrl);
  if (!homepage) {
    return { overallScore: 5, keywordScores: [], analysis: null };
  }

  // Buscar links internos
  const homepageResponse = await fetch(baseUrl).catch(() => ({ text: () => '' }));
  const homepageHtml = await homepageResponse.text();
  const internalLinks = extractInternalLinks(homepageHtml, new URL(baseUrl).hostname);

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

  for (const keyword of keywords) {
    const cleanKw = keyword.toLowerCase().replace(/(lawyer|attorney)/g, '').trim();

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

  const avgKeywordScore = keywordScores.length
    ? keywordScores.reduce((sum, k) => sum + k.googleRankingEstimate, 0) / keywordScores.length
    : 5;

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

// ================== PRACTICE AREAS & KEYWORDS ==================

// Perfis de prática – usados para detectar a área principal e gerar keywords
const PRACTICE_PROFILES = [
  {
    id: 'personal_injury',
    label: 'Personal Injury',
    typeSignals: [
      'personal_injury',
      'car_accident',
      'motorcycle',
      'truck',
      'injury_law',
      'trial_attorney'
    ],
    textSignals: [
      'personal injury',
      'car accident',
      'auto accident',
      'truck accident',
      'motorcycle accident',
      'wrongful death',
      'slip and fall',
      'premises liability',
      'catastrophic injury',
      'dog bite',
      'product liability',
      'medical malpractice'
    ],
    keywords: [
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
    ]
  },
  {
    id: 'criminal_defense',
    label: 'Criminal Defense',
    typeSignals: [
      'criminal_defense',
      'dui_lawyer',
      'criminal_justice'
    ],
    textSignals: [
      'criminal defense',
      'dui',
      'dwi',
      'drunk driving',
      'felony',
      'misdemeanor',
      'domestic violence',
      'drug crime',
      'theft offense',
      'burglary'
    ],
    keywords: [
      'Criminal Defense Lawyer',
      'DUI Defense Attorney',
      'Felony Defense Lawyer',
      'Misdemeanor Defense Lawyer',
      'Drug Crime Lawyer',
      'Domestic Violence Defense Attorney',
      'Theft Defense Attorney',
      'Assault Defense Attorney',
      'Driving Under the Influence Lawyer',
      'Traffic Violation Defense Attorney'
    ]
  },
  {
    id: 'immigration',
    label: 'Immigration',
    typeSignals: ['immigration'],
    textSignals: [
      'immigration',
      'green card',
      'visa',
      'citizenship',
      'deportation',
      'asylum'
    ],
    keywords: [
      'Immigration Attorney',
      'Green Card Lawyer',
      'Visa Lawyer',
      'Citizenship Attorney',
      'Deportation Defense Lawyer',
      'Asylum Lawyer'
    ]
  },
  {
    id: 'family_law',
    label: 'Family Law',
    typeSignals: ['family_law'],
    textSignals: [
      'family law',
      'divorce',
      'child custody',
      'spousal support',
      'alimony',
      'child support',
      'adoption'
    ],
    keywords: [
      'Family Law Attorney',
      'Divorce Lawyer',
      'Child Custody Lawyer',
      'Child Support Attorney',
      'Spousal Support Lawyer',
      'Domestic Violence Restraining Order Attorney'
    ]
  },
  {
    id: 'estate_planning',
    label: 'Estate Planning',
    typeSignals: ['estate_planning', 'probate'],
    textSignals: [
      'estate planning',
      'wills and trusts',
      'trusts',
      'probate',
      'special needs trust',
      'living will',
      'trust administration'
    ],
    keywords: [
      'Estate Planning Lawyer',
      'Wills and Trusts Attorney',
      'Probate Lawyer',
      'Trust Administration Attorney',
      'Special Needs Trusts Attorney',
      'Living Wills Lawyer'
    ]
  },
  {
    id: 'bankruptcy',
    label: 'Bankruptcy',
    typeSignals: ['bankruptcy'],
    textSignals: [
      'bankruptcy',
      'chapter 7',
      'chapter 13',
      'debt relief'
    ],
    keywords: [
      'Bankruptcy Lawyer',
      'Chapter 7 Bankruptcy Attorney',
      'Chapter 13 Bankruptcy Attorney',
      'Debt Relief Lawyer'
    ]
  },
  {
    id: 'employment',
    label: 'Employment Law',
    typeSignals: ['employment_law'],
    textSignals: [
      'wrongful termination',
      'workplace discrimination',
      'harassment',
      'wage and hour',
      'overtime pay'
    ],
    keywords: [
      'Employment Law Attorney',
      'Wrongful Termination Lawyer',
      'Workplace Discrimination Lawyer',
      'Harassment Attorney',
      'Wage and Hour Lawyer'
    ]
  },
  {
    id: 'business',
    label: 'Business Law',
    typeSignals: ['business_law'],
    textSignals: [
      'business litigation',
      'corporate law',
      'contract dispute',
      'partnership dispute'
    ],
    keywords: [
      'Business Litigation Attorney',
      'Business Law Lawyer',
      'Contract Dispute Lawyer',
      'Corporate Attorney'
    ]
  },
  {
    id: 'general',
    label: 'General Practice',
    typeSignals: ['lawyer', 'law_office', 'law_firm', 'legal_services'],
    textSignals: [
      'law office',
      'attorneys at law',
      'general practice'
    ],
    keywords: [
      'Law Firm Near Me',
      'Local Lawyers',
      'General Practice Attorney',
      'Civil Litigation Lawyer'
    ]
  }
];

// Mapa rápido label -> keywords (usado em fallbacks)
const PRACTICE_KEYWORDS = PRACTICE_PROFILES.reduce((acc, p) => {
  acc[p.label] = p.keywords;
  return acc;
}, {});

// Detectar practice area a partir de google types + texto (nome + headings)
function detectPracticeArea(googleTypes = [], text = '') {
  const typesLower = (googleTypes || []).map(t => t.toLowerCase());
  const fullText = (text || '').toLowerCase();

  let bestProfile = null;
  let bestScore = 0;

  PRACTICE_PROFILES.forEach(profile => {
    let score = 0;

    // Sinais nos google types
    if (profile.typeSignals && profile.typeSignals.length) {
      profile.typeSignals.forEach(sig => {
        if (typesLower.some(t => t.includes(sig))) score += 6;
      });
    }

    // Sinais no texto do site/nome
    if (profile.textSignals && profile.textSignals.length) {
      profile.textSignals.forEach(sig => {
        if (fullText.includes(sig)) score += 3;
      });
    }

    // Se o tipo contém exatamente "criminal_defense_lawyer" etc
    if (profile.id !== 'general') {
      if (typesLower.some(t => t.includes(profile.id))) score += 4;
    }

    if (score > bestScore) {
      bestScore = score;
      bestProfile = profile;
    }
  });

  // Se nada forte o suficiente, cai no "general"
  if (!bestProfile || bestScore < 3) {
    bestProfile = PRACTICE_PROFILES.find(p => p.id === 'general');
  }

  return bestProfile;
}

// Extrair headings do site como possíveis keywords
function extractHeadingKeywords(headings = []) {
  const keywords = new Set();
  (headings || []).forEach(h => {
    const lower = h.toLowerCase();
    if (lower.includes('lawyer') || lower.includes('attorney')) {
      let cleaned = h.replace(/\s+/g, ' ').trim();
      // evitar headings gigantes
      if (cleaned.length >= 8 && cleaned.length <= 80) {
        keywords.add(cleaned);
      }
    }
  });
  return Array.from(keywords);
}

// ================== ENDPOINT PRINCIPAL ==================

app.post('/api/analyze', async (req, res) => {
  const startTime = Date.now();

  try {
    const {
      url,
      firmName,
      city,
      keywords,
      rating,
      reviews,
      mode,
      competitors,
      googleTypes
    } = req.body;

    if (!url || !firmName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const isQuickMode = mode === 'quick';
    console.log(`[START] ${isQuickMode ? 'QUICK' : 'FULL'} analysis for ${firmName}`);

    // ========== QUICK MODE ==========
    if (isQuickMode) {
      let homepage = null;
      let baseUrl = url.startsWith('http') ? url : `https://${url}`;
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

      try {
        homepage = await analyzePage(baseUrl);
      } catch (e) {
        homepage = null;
      }

      const headings = [
        ...(homepage?.h1Tags || []),
        ...(homepage?.h2Tags || [])
      ];

      const combinedText = [
        firmName || '',
        homepage?.title || '',
        ...headings
      ].join(' ');

      // Detectar prática com base em types + texto
      const profile = detectPracticeArea(googleTypes || [], combinedText);

      // Keywords vindas do site (headings com Lawyer/Attorney)
      const siteKeywords = extractHeadingKeywords(headings);

      // Construir lista final de keywords:
      const kwSet = new Set();

      // 1) Keywords canônicas da prática
      (profile.keywords || []).forEach(k => kwSet.add(k));

      // 2) Keywords específicas do site (curtas e limpas)
      siteKeywords.forEach(k => kwSet.add(k));

      // 3) Se ainda tiver poucas (<5), cria 1–2 genéricas da prática
      if (kwSet.size < 5) {
        kwSet.add(`${profile.label} Lawyer`);
        if (city) {
          kwSet.add(`${city} ${profile.label} Lawyer`);
        }
      }

      const suggestedKeywords = Array.from(kwSet).slice(0, 10);

      const responseQuick = {
        detectedPractice: profile.label,
        suggestedKeywords,
        quickAnalysis: true,
        hasSchema: homepage ? homepage.hasSchema : false,
        processingTime: Math.round((Date.now() - startTime) / 1000)
      };

      console.log('[QUICK RESULT]', {
        practice: responseQuick.detectedPractice,
        keywords: responseQuick.suggestedKeywords
      });

      return res.json(responseQuick);
    }

    // ========== FULL MODE ==========
    console.log('[FULL] Analyzing main firm...');
    const firmAnalysis = await analyzeFirm(url, keywords, rating, reviews);

    const insights = [];

    if (firmAnalysis.analysis) {
      const { pagesAnalyzed, avgWords, hasSchema } = firmAnalysis.analysis;

      if (!hasSchema) {
        insights.push(
          `No LocalBusiness / LegalService schema detected on the ${pagesAnalyzed} pages analyzed.`
        );
      }

      if (avgWords < 800) {
        insights.push(
          `Pages have an average of ${avgWords} words. Top firms in ${city} typically have 1,500–2,000 word practice pages.`
        );
      }

      const keywordsInTitles = firmAnalysis.keywordScores.filter(k => k.foundInTitle).length;
      if (keywordsInTitles < (keywords?.length || 0) / 3) {
        insights.push(
          `Only ${keywordsInTitles} of ${keywords.length} target keywords appear in page titles.`
        );
      }
    }

    // Competitors (se vierem no body)
    const competitorScores = [];
    if (competitors && competitors.length > 0) {
      console.log(`[COMPETITORS] Analyzing ${competitors.length} competitors...`);

      const top3 = competitors.slice(0, 3).filter(c => c.website);
      const top3Promises = top3.map(async comp => {
        console.log(`[COMPETITOR] Analyzing ${comp.name}...`);
        const analysis = await analyzeFirm(
          comp.website,
          keywords,
          comp.rating || 4.5,
          comp.reviews || 100
        );
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

    const response = {
      detectedPractice: 'Personal Injury', // o front hoje não usa isso no full mode, mantive neutro
      suggestedKeywords: keywords,
      keywordScores: firmAnalysis.keywordScores,
      overallScore: firmAnalysis.overallScore,
      platformScores: {
        chatgpt: Math.min(firmAnalysis.overallScore + 2, 73),
        perplexity: Math.max(Math.round(firmAnalysis.overallScore * 0.9), 0),
        gemini: Math.max(Math.round(firmAnalysis.overallScore * 0.85), 0)
      },
      analysis: firmAnalysis.analysis,
      insights,
      competitors: competitorScores.sort((a, b) => b.score - a.score),
      processingTime: Math.round((Date.now() - startTime) / 1000)
    };

    console.log(
      `[COMPLETE] Score: ${firmAnalysis.overallScore} (${response.processingTime}s)`
    );

    res.json(response);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Analysis failed', overallScore: 5 });
  }
});

// Healthcheck simples
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Maver API running on port ${PORT}`);
});
