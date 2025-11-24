const express = require('express');
const cors = require('cors');

// --- Polyfill de fetch para Node 16/18/20 ---
// Usa fetch nativo se existir; senão, carrega node-fetch dinamicamente.
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) =>
    import('node-fetch').then(({ default: fetch }) => fetch(...args));
}
const fetch = fetchFn;

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

// === HELPERS BÁSICOS ===
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

function extractInternalLinks(html, baseUrl) {
  const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>/gi;
  const links = new Set();
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    let href = match[1];
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    if (href.startsWith('http') && !href.includes(baseUrl)) continue;

    if (href.startsWith('/')) {
      href = baseUrl + href;
    } else if (!href.startsWith('http')) {
      href = baseUrl + '/' + href;
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

async function analyzePage(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    clearTimeout(timeoutId);
    if (!response || !response.ok) {
      console.warn('[analyzePage] Non-OK response for', url, response && response.status);
      return null;
    }

    const html = await response.text();
    const htmlLower = html.toLowerCase();

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1] : '';

    const h1Regex = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
    const h1Tags = [];
    let h1Match;
    while ((h1Match = h1Regex.exec(html)) !== null) {
      h1Tags.push(extractText(h1Match[1]));
    }

    const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
    const h2Tags = [];
    let h2Match;
    while ((h2Match = h2Regex.exec(html)) !== null) {
      h2Tags.push(extractText(h2Match[1]));
    }

    const text = extractText(html);
    const wordCount = countWords(text);
    const hasSchema = htmlLower.includes('schema.org') || htmlLower.includes('"@type"');

    return { url, title, wordCount, h1Tags, h2Tags, hasSchema };
  } catch (e) {
    console.error('[analyzePage ERROR]', url, e.message || e);
    return null;
  }
}

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

// === ANALISAR FIRMA (FULL MODE) ===
async function analyzeFirm(url, keywords, rating, reviews) {
  let baseUrl = url.startsWith('http') ? url : `https://${url}`;
  if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

  const homepage = await analyzePage(baseUrl);
  if (!homepage) {
    console.warn('[analyzeFirm] Homepage analysis failed, returning minimal scores for', baseUrl);
    return { overallScore: 5, keywordScores: [], analysis: null };
  }

  const homepageResponse = await fetch(baseUrl).catch((e) => {
    console.error('[analyzeFirm] fetch homepage HTML failed', baseUrl, e.message || e);
    return null;
  });

  const homepageHtml = homepageResponse ? await homepageResponse.text() : '';
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

  const avgKeywordScore = keywordScores.length
    ? keywordScores.reduce((sum, k) => sum + k.googleRankingEstimate, 0) / keywordScores.length
    : 0;

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

// === KEYWORDS DEFAULT (fallback) ===
const PRACTICE_KEYWORDS = {
  "Personal Injury": [
    "Personal Injury Lawyer", "Car Accident Lawyer", "Truck Accident Lawyer",
    "Wrongful Death Lawyer", "Catastrophic Injury Lawyer", "Premises Liability Lawyer",
    "Product Liability Lawyer", "Medical Malpractice Lawyer", "Slip and Fall Lawyer", "Dog Bite Lawyer"
  ]
};

// === DETECTAR PRÁTICA A PARTIR DO TEXTO + GOOGLE TYPES ===
const PRACTICE_PATTERNS = {
  "Personal Injury": [
    /personal injury/i,
    /car accident|auto accident|motor vehicle/i,
    /truck accident|trucking accident|18[- ]wheeler/i,
    /slip and fall|trip and fall|premises liability/i,
    /wrongful death/i,
    /dog bite|animal attack/i,
    /medical malpractice|birth injury/i
  ],
  "Criminal Defense": [
    /criminal defense|criminal law/i,
    /felony/i,
    /misdemeanor/i,
    /dui|dwi|driving under the influence/i,
    /drug crime|drug offense|drug charges/i,
    /domestic violence/i,
    /traffic infraction|traffic violation|traffic ticket/i,
    /theft|shoplifting|larceny/i,
    /assault|battery/i
  ],
  "Family Law": [
    /family law/i,
    /divorce/i,
    /child custody/i,
    /child support/i,
    /spousal support|alimony/i,
    /paternity/i
  ],
  "Immigration": [
    /immigration/i,
    /green card/i,
    /visa/i,
    /citizenship/i,
    /deportation/i,
    /asylum/i
  ],
  "Estate Planning": [
    /estate planning/i,
    /wills? and trusts?/i,
    /trusts?/i,
    /probate/i,
    /elder law/i,
    /special needs trust/i
  ],
  "Business Litigation": [
    /business litigation/i,
    /commercial litigation/i,
    /contract dispute/i,
    /partnership dispute/i,
    /shareholder dispute/i
  ],
  "Real Estate": [
    /real estate law/i,
    /landlord[- ]tenant/i,
    /eviction/i,
    /foreclosure/i
  ],
  "Employment Law": [
    /employment law/i,
    /wrongful termination/i,
    /wage and hour/i,
    /discrimination/i,
    /harassment/i
  ],
  "Bankruptcy": [
    /bankruptcy/i,
    /chapter 7/i,
    /chapter 13/i,
    /debt relief/i
  ]
};

function detectPracticeFromSignals(pageText, googleTypes = []) {
  const typesText = (googleTypes || []).join(' ').toLowerCase();
  const text = (pageText || '') + ' ' + typesText;

  let bestPractice = 'Personal Injury';
  let bestScore = 0;

  for (const [practice, patterns] of Object.entries(PRACTICE_PATTERNS)) {
    let score = 0;
    for (const pattern of patterns) {
      if (pattern.test(text)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPractice = practice;
    }
  }

  return bestPractice;
}

// === GERAR KEYWORDS POR PRÁTICA (tipo concorrente) ===
function generateKeywordsFromPractice(practice, pageText, googleTypes = []) {
  const text = (pageText || '') + ' ' + (googleTypes || []).join(' ').toLowerCase();
  const kws = new Set();

  const addRuleSet = (rules) => {
    for (const rule of rules) {
      if (rule.match.test(text)) {
        rule.keywords.forEach(k => kws.add(k));
      }
    }
  };

  if (practice === 'Criminal Defense') {
    addRuleSet([
      {
        match: /criminal defense|criminal law/i,
        keywords: [
          'Criminal Defense Lawyer',
          'Felony Defense Attorney',
          'Misdemeanor Defense Lawyer'
        ]
      },
      {
        match: /domestic violence/i,
        keywords: ['Domestic Violence Lawyer']
      },
      {
        match: /drug offense|drug crime|drug charges/i,
        keywords: ['Drug Offense Lawyer']
      },
      {
        match: /dui|dwi|driving under the influence|driving offenses?/i,
        keywords: ['DUI Defense Attorney', 'Driving Under the Influence Lawyer']
      },
      {
        match: /traffic infractions?|traffic violations?|traffic tickets?/i,
        keywords: ['Traffic Violation Defense Attorney']
      },
      {
        match: /theft|shoplifting|larceny/i,
        keywords: ['Theft Defense Attorney']
      },
      {
        match: /assault|battery/i,
        keywords: ['Assault Defense Attorney']
      }
    ]);
  } else if (practice === 'Personal Injury') {
    addRuleSet([
      {
        match: /car accident|auto accident|motor vehicle/i,
        keywords: ['Car Accident Lawyer', 'Auto Accident Attorney']
      },
      {
        match: /truck accident|trucking accident|18[- ]wheeler/i,
        keywords: ['Truck Accident Lawyer', 'Commercial Truck Accident Attorney']
      },
      {
        match: /wrongful death/i,
        keywords: ['Wrongful Death Lawyer']
      },
      {
        match: /slip and fall|trip and fall|premises liability/i,
        keywords: ['Slip and Fall Lawyer', 'Premises Liability Lawyer']
      },
      {
        match: /dog bite|animal attack/i,
        keywords: ['Dog Bite Lawyer']
      },
      {
        match: /medical malpractice|birth injury/i,
        keywords: ['Medical Malpractice Lawyer']
      },
      {
        match: /product liability|defective product/i,
        keywords: ['Product Liability Lawyer']
      }
    ]);
  } else if (practice === 'Family Law') {
    addRuleSet([
      { match: /divorce/i, keywords: ['Divorce Attorney'] },
      { match: /child custody/i, keywords: ['Child Custody Lawyer'] },
      { match: /child support/i, keywords: ['Child Support Attorney'] },
      { match: /spousal support|alimony/i, keywords: ['Spousal Support Lawyer'] },
      { match: /prenup|prenuptial/i, keywords: ['Prenuptial Agreement Lawyer'] }
    ]);
  } else if (practice === 'Immigration') {
    addRuleSet([
      { match: /green card/i, keywords: ['Green Card Lawyer'] },
      { match: /visa/i, keywords: ['Visa Lawyer'] },
      { match: /citizenship/i, keywords: ['Citizenship Attorney'] },
      { match: /deportation|removal defense/i, keywords: ['Deportation Defense Lawyer'] }
    ]);
  } else if (practice === 'Estate Planning') {
    addRuleSet([
      { match: /estate planning/i, keywords: ['Estate Planning Lawyer'] },
      { match: /wills? and trusts?|trusts?/i, keywords: ['Wills and Trusts Attorney'] },
      { match: /special needs trust/i, keywords: ['Special Needs Trusts Attorney'] },
      { match: /elder law/i, keywords: ['Elder Law Attorney'] },
      { match: /living will/i, keywords: ['Living Wills Lawyer'] }
    ]);
  } else if (practice === 'Business Litigation') {
    addRuleSet([
      { match: /business litigation|commercial litigation/i, keywords: ['Business Litigation Attorney'] },
      { match: /contract dispute/i, keywords: ['Contract Dispute Lawyer'] },
      { match: /partnership dispute/i, keywords: ['Partnership Dispute Attorney'] }
    ]);
  } else if (practice === 'Real Estate') {
    addRuleSet([
      { match: /real estate law/i, keywords: ['Real Estate Lawyer'] },
      { match: /landlord[- ]tenant/i, keywords: ['Landlord Tenant Attorney'] },
      { match: /eviction/i, keywords: ['Eviction Defense Lawyer'] }
    ]);
  } else if (practice === 'Employment Law') {
    addRuleSet([
      { match: /wrongful termination/i, keywords: ['Wrongful Termination Lawyer'] },
      { match: /wage and hour/i, keywords: ['Wage and Hour Attorney'] },
      { match: /discrimination/i, keywords: ['Employment Discrimination Lawyer'] },
      { match: /harassment/i, keywords: ['Workplace Harassment Attorney'] }
    ]);
  } else if (practice === 'Bankruptcy') {
    addRuleSet([
      { match: /chapter 7/i, keywords: ['Chapter 7 Bankruptcy Attorney'] },
      { match: /chapter 13/i, keywords: ['Chapter 13 Bankruptcy Attorney'] },
      { match: /debt relief/i, keywords: ['Debt Relief Lawyer'] }
    ]);
  }

  return Array.from(kws);
}

// === API ENDPOINT ===
app.post('/api/analyze', async (req, res) => {
  const startTime = Date.now();

  try {
    const { url, firmName, city, keywords, rating, reviews, mode, competitors, googleTypes } = req.body;

    if (!url || !firmName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const isQuickMode = mode === 'quick';

    console.log(`[START] ${isQuickMode ? 'QUICK' : 'FULL'} analysis for ${firmName}`);

    // === QUICK MODE ===
    if (isQuickMode) {
      console.log('[QUICK] Body.url:', url);
      console.log('[QUICK] googleTypes:', googleTypes);

      let baseUrl = url.startsWith('http') ? url : `https://${url}`;
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

      console.log('[QUICK] Analyzing homepage:', baseUrl);
      const homepage = await analyzePage(baseUrl);

      // Construir texto base
      const textParts = [];
      if (homepage) {
        textParts.push(homepage.title);
        textParts.push(...homepage.h1Tags);
        textParts.push(...homepage.h2Tags);
      }
      const pageText = textParts.join(' ').toLowerCase();

      // 1) Detectar prática global
      const detectedPractice = detectPracticeFromSignals(pageText, googleTypes);

      // 2) Gerar keywords específicas por prática
      const practiceKeywords = generateKeywordsFromPractice(detectedPractice, pageText, googleTypes);

      // 3) Adicionar headings que já têm termos legais
      const headingKeywords = new Set();
      if (homepage) {
        const legalTerms = ['lawyer', 'attorney', 'law', 'legal'];
        for (const heading of [...homepage.h1Tags, ...homepage.h2Tags]) {
          const headingLower = heading.toLowerCase();
          if (!legalTerms.some(t => headingLower.includes(t))) continue;

          let cleaned = heading.replace(/\s+/g, ' ').trim();
          if (!/lawyer|attorney/i.test(cleaned) && cleaned.length < 80) {
            cleaned += ' Lawyer';
          }
          cleaned = cleaned
            .split(' ')
            .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(' ');

          if (cleaned.length > 10 && cleaned.length < 100) {
            headingKeywords.add(cleaned);
          }
        }
      }

      const extractedKeywords = new Set([
        ...practiceKeywords,
        ...headingKeywords
      ]);

      // 4) Fallback se ainda não achou nada
      if (extractedKeywords.size === 0) {
        console.warn('[QUICK] No specific keywords found, using generic practice list');
        const fallback =
          PRACTICE_KEYWORDS[detectedPractice] || PRACTICE_KEYWORDS['Personal Injury'];
        fallback.forEach(k => extractedKeywords.add(k));
      }

      const finalKeywords = Array.from(extractedKeywords).slice(0, 10);

      return res.json({
        detectedPractice,
        suggestedKeywords: finalKeywords,
        quickAnalysis: true,
        hasSchema: homepage ? homepage.hasSchema : false,
        processingTime: Math.round((Date.now() - startTime) / 1000)
      });
    }

    // === FULL MODE ===
    console.log('[FULL] Analyzing main firm...');
    const firmAnalysis = await analyzeFirm(url, keywords, rating, reviews);

    const insights = [];

    if (firmAnalysis.analysis) {
      const { pagesAnalyzed, avgWords, hasSchema } = firmAnalysis.analysis;

      if (!hasSchema) {
        insights.push(`Sem Schema LocalBusiness em nenhuma das ${pagesAnalyzed} páginas analisadas.`);
      }

      if (avgWords < 800) {
        insights.push(`Páginas têm média de ${avgWords} palavras. Competidores top em ${city} têm 1500-2000 palavras.`);
      }

      const keywordsInTitles = firmAnalysis.keywordScores.filter(k => k.foundInTitle).length;
      if (keywordsInTitles < (keywords ? keywords.length / 3 : 0)) {
        insights.push(`Apenas ${keywordsInTitles} de ${keywords.length} keywords aparecem em títulos de página.`);
      }
    }

    // Analyze competitors
    const competitorScores = [];

    if (competitors && competitors.length > 0) {
      console.log(`[COMPETITORS] Analyzing ${competitors.length} competitors...`);

      const top3 = competitors.slice(0, 3).filter(c => c.website);
      const top3Promises = top3.map(async (comp) => {
        console.log(`[COMPETITOR] Analyzing ${comp.name}...`);
        const analysis = await analyzeFirm(comp.website, keywords, comp.rating || 4.5, comp.reviews || 100);
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
      detectedPractice: 'Personal Injury', // se quiser podemos melhorar depois e usar detectPracticeFromSignals aqui também
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

    console.log(`[COMPLETE] Score: ${firmAnalysis.overallScore} (${response.processingTime}s)`);

    res.json(response);

  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Analysis failed', overallScore: 5 });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Maver API running on port ${PORT}`);
});
