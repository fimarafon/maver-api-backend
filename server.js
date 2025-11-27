const express = require('express');
const cors = require('cors');

const app = express();

// CORS configuration - allow Vercel domain
app.use(
  cors({
    origin: [
      'https://maver-app.vercel.app',
      'https://aigrader.maverstudio.com',
      'http://localhost:3000',
      /\.vercel\.app$/, // Allow all Vercel preview URLs
    ],
    credentials: true,
  })
);

app.use(express.json());

const PORT = process.env.PORT || 3001;

// ===================
// Helper functions
// ===================
function extractText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(text) {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
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
      lowerHref.includes('practice') ||
      lowerHref.includes('service') ||
      lowerHref.includes('area') ||
      lowerHref.includes('attorney') ||
      lowerHref.includes('lawyer') ||
      lowerHref.includes('legal')
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
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    clearTimeout(timeoutId);
    if (!response.ok) return null;

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
    const hasSchema =
      htmlLower.includes('schema.org') || htmlLower.includes('"@type"');

    return { url, title, wordCount, h1Tags, h2Tags, hasSchema };
  } catch (e) {
    return null;
  }
}

// ------------------------
// Ranking / scoring utils
// ------------------------
function estimateGoogleRanking(keyword, pages, rating, reviews) {
  const cleanKw = keyword.toLowerCase().replace(' lawyer', '').replace(' attorney', '').trim();
  let score = 0;

  const inTitle = pages.some((p) => p.title.toLowerCase().includes(cleanKw));
  if (inTitle) score += 35;

  const dedicatedPage = pages.find((p) => {
    const urlMatch = p.url.toLowerCase().includes(cleanKw);
    const h1Match = p.h1Tags.some((h1) => h1.toLowerCase().includes(cleanKw));
    return urlMatch && h1Match && p.wordCount > 500;
  });
  if (dedicatedPage) {
    score += 30;
    if (dedicatedPage.wordCount > 1500) score += 10;
    else if (dedicatedPage.wordCount > 1000) score += 5;
  }

  if (pages.some((p) => p.hasSchema)) score += 20;
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
  if (score >= 30)
    return { chatgpt: Math.random() > 0.7, perplexity: false, gemini: false };
  return { chatgpt: false, perplexity: false, gemini: false };
}

// ------------------------
// Keyword extraction core
// ------------------------

// Title-case helper
function toTitleCase(str) {
  return str
    .split(' ')
    .filter((w) => w.trim().length > 0)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// 1) From Google Places "types"
function keywordsFromGoogleTypes(googleTypes = []) {
  const kws = new Set();

  googleTypes.forEach((t) => {
    if (!t) return;
    const raw = String(t).toLowerCase();

    // Só tipos claramente jurídicos
    if (
      !raw.includes('law') &&
      !raw.includes('attorney') &&
      !raw.includes('lawyer') &&
      !raw.includes('legal')
    ) {
      return;
    }

    let phrase = raw.replace(/_/g, ' ').trim(); // ex: "criminal defense lawyer"

    // Garante sufixo lawyer/attorney
    if (!phrase.includes('lawyer') && !phrase.includes('attorney')) {
      if (phrase.includes('law')) phrase += ' lawyer';
      else phrase += ' attorney';
    }

    phrase = toTitleCase(phrase);

    // Versão principal
    kws.add(phrase);

    // Duplicata Lawyer/Attorney
    const lower = phrase.toLowerCase();
    if (lower.includes('lawyer')) {
      kws.add(phrase.replace(/Lawyer/i, 'Attorney'));
    } else if (lower.includes('attorney')) {
      kws.add(phrase.replace(/Attorney/i, 'Lawyer'));
    }
  });

  return Array.from(kws);
}

// 2) From firm name (ex: "Lemon Law Firm" → "Lemon Law Lawyer")
function keywordsFromFirmName(firmName = '') {
  const kws = new Set();
  const name = firmName.toLowerCase();

  if (!name) return [];

  // Tenta achar padrões tipo "X Law" antes de "Firm" / "Group"
  const match = name.match(/(.+?)\s+law/); // captura "lemon" em "lemon law firm"
  if (match && match[1]) {
    const area = toTitleCase(match[1].trim() + ' law'); // "Lemon Law"
    kws.add(area + ' Lawyer');
    kws.add(area + ' Attorney');
  }

  // Palavras específicas conhecidas
  if (name.includes('criminal')) {
    kws.add('Criminal Defense Lawyer');
    kws.add('Criminal Defense Attorney');
  }
  if (name.includes('injury')) {
    kws.add('Personal Injury Lawyer');
    kws.add('Personal Injury Attorney');
  }
  if (name.includes('immigration')) {
    kws.add('Immigration Lawyer');
    kws.add('Immigration Attorney');
  }
  if (name.includes('family')) {
    kws.add('Family Law Lawyer');
    kws.add('Family Law Attorney');
  }

  return Array.from(kws);
}

// 3) From homepage headings (H1/H2)
//    Pega frases curtas contendo lawyer/attorney/law
function keywordsFromHeadings(page) {
  if (!page) return [];

  const kws = new Set();
  const candidates = [...(page.h1Tags || []), ...(page.h2Tags || [])];

  const legalTerms = ['lawyer', 'attorney', 'law', 'defense', 'injury'];

  candidates.forEach((heading) => {
    const h = heading.trim();
    const lower = h.toLowerCase();

    if (!legalTerms.some((t) => lower.includes(t))) return;
    if (h.length < 5 || h.length > 120) return;

    let cleaned = h.replace(/\s+/g, ' ').trim();

    // Se não termina com Lawyer/Attorney e for relativamente curto, adiciona
    if (!/lawyer|attorney/i.test(cleaned) && cleaned.length < 70) {
      cleaned += ' Lawyer';
    }

    cleaned = toTitleCase(cleaned);
    if (cleaned.length >= 10 && cleaned.length <= 120) {
      kws.add(cleaned);
    }
  });

  return Array.from(kws);
}

// Detectar prática com base no texto de keywords
function detectPracticeFromKeywords(allKeywordsText) {
  const txt = allKeywordsText.toLowerCase();

  if (txt.includes('lemon law')) return 'Lemon Law';
  if (txt.includes('personal injury') || txt.includes('accident'))
    return 'Personal Injury';
  if (txt.includes('criminal') || txt.includes('dui')) return 'Criminal Defense';
  if (txt.includes('family') || txt.includes('divorce')) return 'Family Law';
  if (txt.includes('immigration')) return 'Immigration';
  if (txt.includes('estate') || txt.includes('trust') || txt.includes('probate'))
    return 'Estate Planning';
  if (txt.includes('employment') || txt.includes('labor'))
    return 'Employment Law';

  return 'General Practice';
}

// ====================================
// Main firm analysis (FULL MODE)
// ====================================
async function analyzeFirm(url, keywords, rating, reviews) {
  let baseUrl = url.startsWith('http') ? url : `https://${url}`;
  if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

  const homepage = await analyzePage(baseUrl);
  if (!homepage) {
    return { overallScore: 5, keywordScores: [], analysis: null };
  }

  const homepageResponse = await fetch(baseUrl).catch(() => ({
    text: () => '',
  }));
  const homepageHtml = await homepageResponse.text();
  const internalLinks = extractInternalLinks(
    homepageHtml,
    new URL(baseUrl).hostname
  );

  const pages = [homepage];

  for (let i = 0; i < Math.min(internalLinks.length, 5); i++) {
    const pageAnalysis = await analyzePage(internalLinks[i]);
    if (pageAnalysis) pages.push(pageAnalysis);
  }

  const totalWords = pages.reduce((sum, p) => sum + p.wordCount, 0);
  const avgWords = Math.round(totalWords / pages.length);
  const hasSchema = pages.some((p) => p.hasSchema);
  const dedicatedPages = pages.filter(
    (p) => p.url !== baseUrl && p.wordCount > 400
  ).length;

  const keywordScores = [];

  for (const keyword of keywords) {
    const cleanKw = keyword
      .toLowerCase()
      .replace(' lawyer', '')
      .replace(' attorney', '')
      .trim();

    const foundInTitle = pages.some((p) =>
      p.title.toLowerCase().includes(cleanKw)
    );
    const hasDedicatedPage = pages.some((p) => {
      const urlMatch = p.url.toLowerCase().includes(cleanKw);
      const h1Match = p.h1Tags.some((h1) =>
        h1.toLowerCase().includes(cleanKw)
      );
      return urlMatch && h1Match;
    });

    let totalMentions = 0;
    pages.forEach((p) => {
      const pageText = `${p.title} ${p.h1Tags.join(' ')} ${p.h2Tags.join(
        ' '
      )}`.toLowerCase();
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
      ...llmVisibility,
    });
  }

  const avgKeywordScore =
    keywordScores.reduce((sum, k) => sum + k.googleRankingEstimate, 0) /
    (keywordScores.length || 1);
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
    analysis: {
      pagesAnalyzed: pages.length,
      totalWords,
      avgWords,
      hasSchema,
      dedicatedPages,
    },
  };
}

// ===================
// API Endpoint
// ===================
app.post('/api/analyze', async (req, res) => {
  const startTime = Date.now();

  try {
    const {
      url,
      firmName,
      city,
      keywords,
      rating = 0,
      reviews = 0,
      mode,
      competitors,
      googleTypes,
    } = req.body;

    if (!url || !firmName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const isQuickMode = mode === 'quick';

    console.log(`[START] ${isQuickMode ? 'QUICK' : 'FULL'} analysis for ${firmName}`);

    // ====================
    // QUICK MODE
    // ====================
    if (isQuickMode) {
      // 1) Começa pelas categorias do Google Places
      let suggestedKeywords = keywordsFromGoogleTypes(googleTypes);

      // 2) Complementa com o nome da firma (ex: "Lemon Law Firm")
      suggestedKeywords = [
        ...suggestedKeywords,
        ...keywordsFromFirmName(firmName),
      ];

      // 3) Se ainda tiver muito pouco, tenta H1/H2 do site (homepage)
      let homepage = null;
      if (suggestedKeywords.length < 3) {
        let baseUrl = url.startsWith('http') ? url : `https://${url}`;
        if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
        homepage = await analyzePage(baseUrl);
        suggestedKeywords = [
          ...suggestedKeywords,
          ...keywordsFromHeadings(homepage),
        ];
      }

      // Dedup, remove coisas muito grandes e limita a 10
      const kwSet = new Set(
        suggestedKeywords
          .map((k) => k.trim())
          .filter((k) => k.length >= 4 && k.length <= 120)
      );
      let finalKeywords = Array.from(kwSet).slice(0, 10);

      // 4) Se ainda assim não tiver nada, fallback mínimo (último caso)
      if (finalKeywords.length === 0) {
        finalKeywords = ['Lawyer', 'Attorney'].map(toTitleCase);
      }

      const detectedPractice = detectPracticeFromKeywords(
        finalKeywords.join(' ')
      );

      return res.json({
        detectedPractice,
        suggestedKeywords: finalKeywords,
        quickAnalysis: true,
        // se homepage existir, usa schema real; se não, chutamos false
        hasSchema: homepage ? homepage.hasSchema : false,
        processingTime: Math.round((Date.now() - startTime) / 1000),
      });
    }

    // ====================
    // FULL MODE
    // ====================
    console.log('[FULL] Analyzing main firm...');
    const firmAnalysis = await analyzeFirm(url, keywords, rating, reviews);

    const insights = [];

    if (firmAnalysis.analysis) {
      const { pagesAnalyzed, avgWords, hasSchema } = firmAnalysis.analysis;

      if (!hasSchema) {
        insights.push(
          `Sem Schema LocalBusiness em nenhuma das ${pagesAnalyzed} páginas analisadas.`
        );
      }

      if (avgWords < 800) {
        insights.push(
          `Páginas têm média de ${avgWords} palavras. Competidores top em ${city} têm 1500-2000 palavras.`
        );
      }

      const keywordsInTitles = firmAnalysis.keywordScores.filter(
        (k) => k.foundInTitle
      ).length;
      if (keywordsInTitles < (keywords.length || 1) / 3) {
        insights.push(
          `Apenas ${keywordsInTitles} de ${keywords.length} keywords aparecem em títulos de página.`
        );
      }
    }

    // Analyze competitors (mantém sua lógica existente)
    const competitorScores = [];

    if (competitors && competitors.length > 0) {
      console.log(
        `[COMPETITORS] Analyzing ${competitors.length} competitors...`
      );

      const top3 = competitors.slice(0, 3).filter((c) => c.website);
      const top3Promises = top3.map(async (comp) => {
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
          website: comp.website,
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
            score: Math.min(score, 65),
          });
        } else {
          let score = 20;
          if (comp.rating >= 4.8 && comp.reviews >= 150) score += 15;
          else if (comp.rating >= 4.5) score += 10;

          competitorScores.push({
            name: comp.name,
            score: Math.min(score, 45),
          });
        }
      }
    }

    const response = {
      detectedPractice: 'Personal Injury', // prática usada só no relatório final hoje
      suggestedKeywords: keywords,
      keywordScores: firmAnalysis.keywordScores,
      overallScore: firmAnalysis.overallScore,
      platformScores: {
        chatgpt: Math.min(firmAnalysis.overallScore + 2, 73),
        perplexity: Math.max(Math.round(firmAnalysis.overallScore * 0.9), 0),
        gemini: Math.max(Math.round(firmAnalysis.overallScore * 0.85), 0),
      },
      analysis: firmAnalysis.analysis,
      insights,
      competitors: competitorScores.sort((a, b) => b.score - a.score),
      processingTime: Math.round((Date.now() - startTime) / 1000),
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Maver API running on port ${PORT}`);
});
