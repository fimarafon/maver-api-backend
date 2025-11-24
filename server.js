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

// AbortController em Node mais antigo (só por segurança)
if (typeof AbortController === 'undefined') {
  const { AbortController: AbortControllerPolyfill } = require('abort-controller');
  global.AbortController = AbortControllerPolyfill;
}

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

// Helper functions
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

const PRACTICE_KEYWORDS = {
  "Personal Injury": [
    "Personal Injury Lawyer", "Car Accident Lawyer", "Truck Accident Lawyer",
    "Wrongful Death Lawyer", "Catastrophic Injury Lawyer", "Premises Liability Lawyer",
    "Product Liability Lawyer", "Medical Malpractice Lawyer", "Slip and Fall Lawyer", "Dog Bite Lawyer"
  ]
};

// API Endpoint
app.post('/api/analyze', async (req, res) => {
  const startTime = Date.now();

  try {
    const { url, firmName, city, keywords, rating, reviews, mode, competitors } = req.body;

    if (!url || !firmName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const isQuickMode = mode === 'quick';

    console.log(`[START] ${isQuickMode ? 'QUICK' : 'FULL'} analysis for ${firmName}`);

    // === QUICK MODE ===
    if (isQuickMode) {
      const { googleTypes } = req.body;
      console.log('[QUICK] Body.url:', url);
      console.log('[QUICK] googleTypes:', googleTypes);

      // PRIORIDADE 1: Usar categories do Google Places se disponível
      if (googleTypes && googleTypes.length > 0) {
        console.log('[QUICK] Using Google Places categories for keyword extraction');

        // Transformar types do Google em keywords legíveis
        const keywordMap = {
          'lawyer': 'Lawyer',
          'attorney': 'Attorney',
          'legal': 'Legal Services',
          'estate_planning': 'Estate Planning',
          'elder_law': 'Elder Law',
          'family_law': 'Family Law',
          'divorce': 'Divorce',
          'criminal': 'Criminal Defense',
          'dui': 'DUI Defense',
          'immigration': 'Immigration',
          'personal_injury': 'Personal Injury',
          'accident': 'Accident',
          'medical_malpractice': 'Medical Malpractice',
          'business_law': 'Business Law',
          'real_estate': 'Real Estate Law'
        };

        const extractedKeywords = new Set();

        // Processar cada type do Google
        for (const type of googleTypes) {
          const typeLower = type.toLowerCase().replace(/_/g, ' ');

          // Se já é uma categoria legal, adicionar
          if (typeLower.includes('lawyer') || typeLower.includes('attorney') || typeLower.includes('legal')) {
            const formatted = typeLower
              .split(' ')
              .map(w => w.charAt(0).toUpperCase() + w.slice(1))
              .join(' ');

            extractedKeywords.add(formatted);
          }

          // Mapear types conhecidos
          for (const [key, value] of Object.entries(keywordMap)) {
            if (typeLower.includes(key)) {
              if (!value.includes('Lawyer') && !value.includes('Attorney')) {
                extractedKeywords.add(value + ' Lawyer');
                extractedKeywords.add(value + ' Attorney');
              } else {
                extractedKeywords.add(value);
              }
            }
          }
        }

        console.log('[QUICK] extractedKeywords from googleTypes:', extractedKeywords);

        // Antes exigia >= 3; isso quase nunca acontecia.
        if (extractedKeywords.size > 0) {
          const suggestedKeywords = Array.from(extractedKeywords).slice(0, 10);

          // Detectar prática baseado nas keywords
          const keywordsText = suggestedKeywords.join(' ').toLowerCase();
          let detectedPractice = 'Personal Injury';
          if (keywordsText.includes('estate') || keywordsText.includes('elder')) {
            detectedPractice = 'Estate Planning';
          } else if (keywordsText.includes('family') || keywordsText.includes('divorce')) {
            detectedPractice = 'Family Law';
          } else if (keywordsText.includes('criminal') || keywordsText.includes('dui')) {
            detectedPractice = 'Criminal Defense';
          } else if (keywordsText.includes('immigration')) {
            detectedPractice = 'Immigration';
          } else if (keywordsText.includes('business')) {
            detectedPractice = 'Business Law';
          }

          return res.json({
            detectedPractice,
            suggestedKeywords,
            quickAnalysis: true,
            hasSchema: true,
            processingTime: Math.round((Date.now() - startTime) / 1000)
          });
        }
      }

      // FALLBACK: Analisar o website se Google types não der resultado
      let baseUrl = url.startsWith('http') ? url : `https://${url}`;
      if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

      console.log('[QUICK] Falling back to homepage analysis for', baseUrl);
      const homepage = await analyzePage(baseUrl);

      if (!homepage) {
        console.warn('[QUICK] Homepage analysis failed, returning Personal Injury fallback keywords');
        return res.json({
          detectedPractice: 'Personal Injury',
          suggestedKeywords: PRACTICE_KEYWORDS['Personal Injury'],
          quickAnalysis: true,
          hasSchema: false,
          processingTime: Math.round((Date.now() - startTime) / 1000)
        });
      }

      // Detectar prática E extrair keywords REAIS do site
      const pageText = `${homepage.title} ${homepage.h1Tags.join(' ')} ${homepage.h2Tags.join(' ')}`.toLowerCase();

      let detectedPractice = 'Personal Injury';
      if (pageText.includes('divorce') || pageText.includes('custody') || pageText.includes('family law')) {
        detectedPractice = 'Family Law';
      } else if (pageText.includes('criminal') || pageText.includes('dui') || pageText.includes('defense')) {
        detectedPractice = 'Criminal Defense';
      } else if (pageText.includes('immigration') || pageText.includes('visa')) {
        detectedPractice = 'Immigration';
      } else if (pageText.includes('business') || pageText.includes('corporate') || pageText.includes('contract')) {
        detectedPractice = 'Business Litigation';
      }

      // EXTRAIR keywords REAIS do site (H1s e H2s que mencionam serviços)
      const allHeadings = [...homepage.h1Tags, ...homepage.h2Tags];
      const extractedKeywords = new Set();

      const legalTerms = ['lawyer', 'attorney', 'law', 'legal'];

      for (const heading of allHeadings) {
        const headingLower = heading.toLowerCase();

        if (legalTerms.some(term => headingLower.includes(term))) {
          let cleaned = heading
            .replace(/\s+/g, ' ')
            .trim();

          if (!cleaned.match(/lawyer|attorney/i)) {
            if (cleaned.length < 50) {
              cleaned += ' Lawyer';
            }
          }

          cleaned = cleaned
            .split(' ')
            .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(' ');

          if (cleaned.length > 10 && cleaned.length < 100) {
            extractedKeywords.add(cleaned);
          }
        }
      }

      let suggestedKeywords = Array.from(extractedKeywords).slice(0, 10);

      if (suggestedKeywords.length < 5) {
        const practiceKeywords = PRACTICE_KEYWORDS[detectedPractice] || PRACTICE_KEYWORDS['Personal Injury'];
        suggestedKeywords = [
          ...suggestedKeywords,
          ...practiceKeywords.filter(k => !suggestedKeywords.includes(k))
        ].slice(0, 10);
      }

      return res.json({
        detectedPractice,
        suggestedKeywords,
        quickAnalysis: true,
        hasSchema: homepage.hasSchema,
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
      detectedPractice: 'Personal Injury',
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
