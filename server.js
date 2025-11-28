const express = require('express');
const cors = require('cors');
const { summarizeFirmAnalysis } = require('./llmClient');

const app = express();

// CORS – Vercel + localhost
app.use(cors({
  origin: [
    'https://maver-app.vercel.app',
    /\.vercel\.app$/,
    'http://localhost:3000',
    'https://aigrader.maverstudio.com'
  ],
  credentials: true
}));

app.use(express.json());

const PORT = process.env.PORT || 3001;

// =======================
//  HELPERS GERAIS
// =======================

function extractText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(text = '') {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function countWords(text) {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

function toTitleCase(str = '') {
  return str
    .toLowerCase()
    .split(' ')
    .map(w => w ? w[0].toUpperCase() + w.slice(1) : '')
    .join(' ');
}

// =======================
//  PRACTICE / KEYWORDS
// =======================

const PRACTICE_KEYWORDS = {
  "Personal Injury": [
    "Personal Injury Lawyer",
    "Car Accident Lawyer",
    "Truck Accident Lawyer",
    "Wrongful Death Lawyer",
    "Catastrophic Injury Lawyer",
    "Premises Liability Lawyer",
    "Product Liability Lawyer",
    "Medical Malpractice Lawyer",
    "Slip and Fall Lawyer",
    "Dog Bite Lawyer"
  ],
  "Elder Law": [
    "Elder Law Attorney",
    "Estate Planning Lawyer",
    "Medicaid Planning Attorney",
    "Wills and Trusts Lawyer",
    "Guardianship Lawyer",
    "Conservatorship Lawyer",
    "Long-Term Care Planning Lawyer",
    "Asset Protection Lawyer",
    "Probate Attorney",
    "Special Needs Trust Lawyer"
  ],
  "Estate Planning": [
    "Estate Planning Lawyer",
    "Wills and Trusts Lawyer",
    "Trust Administration Attorney",
    "Probate Attorney",
    "Asset Protection Lawyer",
    "Tax Planning Attorney",
    "Wealth Transfer Lawyer"
  ],
  "Criminal Defense": [
    "Criminal Defense Lawyer",
    "DUI Defense Attorney",
    "Drug Crime Lawyer",
    "Felony Defense Attorney",
    "Domestic Violence Defense Lawyer",
    "Theft Defense Attorney"
  ],
  "Family Law": [
    "Family Law Attorney",
    "Divorce Lawyer",
    "Child Custody Lawyer",
    "Child Support Attorney",
    "Spousal Support Lawyer",
    "Prenuptial Agreement Lawyer"
  ],
  "Immigration": [
    "Immigration Lawyer",
    "Visa Attorney",
    "Green Card Lawyer",
    "Citizenship Attorney",
    "Deportation Defense Lawyer"
  ],
  "Business Litigation": [
    "Business Litigation Attorney",
    "Contract Dispute Lawyer",
    "Shareholder Dispute Attorney",
    "Commercial Litigation Lawyer"
  ],
  "Bankruptcy": [
    "Bankruptcy Attorney",
    "Chapter 7 Bankruptcy Lawyer",
    "Chapter 13 Bankruptcy Lawyer",
    "Debt Relief Lawyer"
  ],
  "Employment Law": [
    "Employment Lawyer",
    "Wrongful Termination Attorney",
    "Wage and Hour Dispute Lawyer",
    "Discrimination Lawyer"
  ],
  "Real Estate Law": [
    "Real Estate Attorney",
    "Real Estate Litigation Lawyer",
    "Landlord Tenant Lawyer",
    "Boundary Dispute Attorney"
  ],
  "General Practice": [
    "General Practice Attorney",
    "Civil Litigation Lawyer",
    "Contract Lawyer",
    "Business Law Attorney"
  ]
};

// Detectar prática pela combinação de Google types + conteúdo do site
function detectPractice(googleTypes = [], htmlLower = '') {
  const text = htmlLower || '';
  const types = (googleTypes || []).map(t => t.toLowerCase());

  // 1) Conteúdo do site – MAIS FORTE
  if (text.includes('elder law')) return 'Elder Law';
  if (text.includes('estate planning')) return 'Estate Planning';
  if (text.includes('personal injury') || text.includes('car accident') || text.includes('wrongful death')) {
    return 'Personal Injury';
  }
  if (text.includes('criminal defense') || text.includes('dui') || text.includes('drug crime')) {
    return 'Criminal Defense';
  }
  if (text.includes('family law') || text.includes('divorce') || text.includes('child custody')) {
    return 'Family Law';
  }
  if (text.includes('immigration')) return 'Immigration';
  if (text.includes('bankruptcy')) return 'Bankruptcy';
  if (text.includes('employment law') || text.includes('wrongful termination')) return 'Employment Law';
  if (text.includes('real estate law') || text.includes('real estate attorney')) return 'Real Estate Law';
  if (text.includes('business litigation') || text.includes('commercial litigation')) return 'Business Litigation';

  // 2) Google types – MENOS FORTE (mas ainda ajuda)
  const typeString = types.join(' ');
  if (typeString.includes('elder')) return 'Elder Law';
  if (typeString.includes('estate')) return 'Estate Planning';
  if (typeString.includes('criminal')) return 'Criminal Defense';
  if (typeString.includes('family')) return 'Family Law';
  if (typeString.includes('immigration')) return 'Immigration';
  if (typeString.includes('bankruptcy')) return 'Bankruptcy';
  if (typeString.includes('real_estate')) return 'Real Estate Law';
  if (typeString.includes('employment')) return 'Employment Law';

  // 3) fallback – PI é a prática mais comum
  return 'Personal Injury';
}

// Extrair keywords reais do HTML (menu, practice areas, etc.)
function extractKeywordsFromHtml(html, practice = 'Personal Injury') {
  if (!html) return [];

  const htmlLower = html.toLowerCase();

  // Pegar blocos mais "jurídicos": nav, sections com practice/services, etc.
  const blocks = [];

  const navRegex = /<nav[\s\S]*?<\/nav>/gi;
  let navMatch;
  while ((navMatch = navRegex.exec(html)) !== null) {
    blocks.push(navMatch[0]);
  }

  const sectionRegex = /<(section|div|ul)[^>]+?(practice|service|area|areas-of-practice|practice-areas)[^>]*>[\s\S]*?<\/\1>/gi;
  let secMatch;
  while ((secMatch = sectionRegex.exec(html)) !== null) {
    blocks.push(secMatch[0]);
  }

  // Se nada encontrado, usa HTML inteiro como fallback
  const targetHtml = blocks.length ? blocks.join(' ') : html;

  const rawKeywords = new Set();

  // 1) Textos dos links
  const linkRegex = /<a[^>]*>([\s\S]*?)<\/a>/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(targetHtml)) !== null) {
    let text = decodeEntities(extractText(linkMatch[1] || ''));
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;

    // filtros básicos
    const lower = text.toLowerCase();
    if (lower.length < 3 || lower.length > 80) continue;
    if (/(home|about|contact|blog|faq|team|location|locations|directions)/i.test(lower)) continue;
    if (!/[a-z]/i.test(text)) continue;

    rawKeywords.add(text);
  }

  // 2) Headings h2/h3 dentro desses blocos
  const headingRegex = /<(h2|h3|h4)[^>]*>([\s\S]*?)<\/\1>/gi;
  let hMatch;
  while ((hMatch = headingRegex.exec(targetHtml)) !== null) {
    let text = decodeEntities(extractText(hMatch[2] || ''));
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const lower = text.toLowerCase();
    if (lower.length < 3 || lower.length > 80) continue;
    if (/(results|why choose us|our team|testimonials)/i.test(lower)) continue;

    rawKeywords.add(text);
  }

  // Normalizar para "palavra-chave de advogado"
  const finalSet = new Set();

  for (const raw of rawKeywords) {
    let kw = raw;

    // tirar "Law Firm / Law Group" do final se atrapalhar
    kw = kw.replace(/\b(law firm|law group|attorneys at law)\b/gi, '').trim();
    if (!kw) continue;

    const lower = kw.toLowerCase();

    // se já parece ser keyword de serviço, só padroniza
    let needsSuffix = !/(lawyer|attorney|counsel|law\b)/i.test(kw);

    // se tiver termos bem jurídicos específicos, adiciona "Lawyer" ou "Attorney"
    if (needsSuffix) {
      if (/(planning|trust|probate|guardianship|conservatorship|benefits|medicaid|wills|long-term care)/i.test(lower)) {
        kw = kw + ' Attorney';
      } else if (/(injury|accident|defense|litigation|liability|malpractice|abuse)/i.test(lower)) {
        kw = kw + ' Lawyer';
      } else {
        // genérico mas relacionado – prefere Lawyer
        kw = kw + ' Lawyer';
      }
    }

    kw = toTitleCase(kw);

    // regras finais de filtro
    const kwLower = kw.toLowerCase();
    if (kwLower.length < 10 || kwLower.length > 80) continue;
    if (!/(law|lawyer|attorney)/i.test(kw)) continue;

    finalSet.add(kw);
  }

  const extracted = Array.from(finalSet);

  // completar com keywords da prática, se estiver pobre
  const base = PRACTICE_KEYWORDS[practice] || PRACTICE_KEYWORDS['Personal Injury'];
  const merged = [...extracted];

  for (const k of base) {
    if (merged.length >= 10) break;
    if (!merged.includes(k)) merged.push(k);
  }

  // Se por algum motivo não achou nada, devolve só o fallback
  if (!merged.length) return base.slice(0, 10);

  return merged.slice(0, 10);
}

// =======================
//  ANALYTICS E SCORE
// =======================

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
    const title = titleMatch ? titleMatch[1] : '';

    const h1Regex = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
    const h1Tags = [];
    let h1Match;
    while ((h1Match = h1Regex.exec(html)) !== null) {
      h1Tags.push(decodeEntities(extractText(h1Match[1])));
    }

    const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
    const h2Tags = [];
    let h2Match;
    while ((h2Match = h2Regex.exec(html)) !== null) {
      h2Tags.push(decodeEntities(extractText(h2Match[1])));
    }

    const text = extractText(html);
    const wordCount = countWords(text);
    const hasSchema = htmlLower.includes('schema.org') || htmlLower.includes('"@type"');

    return { url, title, wordCount, h1Tags, h2Tags, hasSchema, html, htmlLower };
  } catch (e) {
    return null;
  }
}

function extractInternalLinks(html, baseHost) {
  const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>/gi;
  const links = new Set();
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    let href = match[1];
    if (!href) continue;
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;

    // manter apenas links internos
    if (href.startsWith('http')) {
      try {
        const u = new URL(href);
        if (u.hostname !== baseHost) continue;
      } catch { continue; }
    }

    // normalizar
    if (href.startsWith('/')) {
      href = `https://${baseHost}${href}`;
    } else if (!href.startsWith('http')) {
      href = `https://${baseHost}/${href}`;
    }

    const lowerHref = href.toLowerCase();
    if (lowerHref.includes('practice') || lowerHref.includes('service') ||
      lowerHref.includes('area') || lowerHref.includes('attorney') ||
      lowerHref.includes('lawyer') || lowerHref.includes('legal')) {
      links.add(href);
    }
  }

  return Array.from(links).slice(0, 5);
}

function estimateGoogleRanking(keyword, pages, rating, reviews) {
  const cleanKw = keyword.toLowerCase().replace(' lawyer', '').replace(' attorney', '').trim();
  let score = 0;

  const inTitle = pages.some(p => (p.title || '').toLowerCase().includes(cleanKw));
  if (inTitle) score += 35;

  const dedicatedPage = pages.find(p => {
    const urlMatch = (p.url || '').toLowerCase().includes(cleanKw);
    const h1Match = (p.h1Tags || []).some(h1 => (h1 || '').toLowerCase().includes(cleanKw));
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
    return { overallScore: 5, keywordScores: [], analysis: null };
  }

  const baseHost = new URL(baseUrl).hostname;

  const internalLinks = extractInternalLinks(homepage.html || '', baseHost);
  const pages = [homepage];

  for (let i = 0; i < Math.min(internalLinks.length, 5); i++) {
    const pageAnalysis = await analyzePage(internalLinks[i]);
    if (pageAnalysis) pages.push(pageAnalysis);
  }

  const totalWords = pages.reduce((sum, p) => sum + (p.wordCount || 0), 0);
  const avgWords = Math.round(totalWords / pages.length);
  const hasSchema = pages.some(p => p.hasSchema);
  const dedicatedPages = pages.filter(p => p.url !== baseUrl && p.wordCount > 400).length;

  const keywordScores = [];

  for (const keyword of keywords) {
    const cleanKw = keyword.toLowerCase().replace(' lawyer', '').replace(' attorney', '').trim();

    const foundInTitle = pages.some(p => (p.title || '').toLowerCase().includes(cleanKw));
    const hasDedicatedPage = pages.some(p => {
      const urlMatch = (p.url || '').toLowerCase().includes(cleanKw);
      const h1Match = (p.h1Tags || []).some(h1 => (h1 || '').toLowerCase().includes(cleanKw));
      return urlMatch && h1Match;
    });

    let totalMentions = 0;
    pages.forEach(p => {
      const pageText = `${p.title} ${(p.h1Tags || []).join(' ')} ${(p.h2Tags || []).join(' ')}`.toLowerCase();
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

// =======================
//  API /api/analyze
// =======================

app.post('/api/analyze', async (req, res) => {
  const startTime = Date.now();

  try {
    const { url, firmName, city, keywords, rating, reviews, mode, competitors, googleTypes } = req.body;

    if (!url || !firmName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const isQuickMode = mode === 'quick';
    console.log(`[START] ${isQuickMode ? 'QUICK' : 'FULL'} analysis for ${firmName}`);

    // ========= QUICK MODE =========
    if (isQuickMode) {
      let normalizedUrl = url.startsWith('http') ? url : `https://${url}`;
      if (normalizedUrl.endsWith('/')) normalizedUrl = normalizedUrl.slice(0, -1);

      let homepageHtml = '';
      let homepageHasSchema = false;
      let htmlLower = '';

      try {
        const page = await analyzePage(normalizedUrl);
        if (page) {
          homepageHtml = page.html || '';
          homepageHasSchema = page.hasSchema || false;
          htmlLower = page.htmlLower || '';
        }
      } catch (e) {
        console.error('[QUICK] Error fetching homepage:', e);
      }

      // Detectar prática usando HTML + Google types
      const detectedPractice = detectPractice(googleTypes || [], htmlLower);
      const suggestedKeywords = homepageHtml
        ? extractKeywordsFromHtml(homepageHtml, detectedPractice)
        : (PRACTICE_KEYWORDS[detectedPractice] || PRACTICE_KEYWORDS['Personal Injury']).slice(0, 10);

      return res.json({
        detectedPractice,
        suggestedKeywords,
        quickAnalysis: true,
        hasSchema: homepageHasSchema,
        processingTime: Math.round((Date.now() - startTime) / 1000)
      });
    }

    // ========= FULL MODE =========
    console.log('[FULL] Analyzing main firm...');
    const firmAnalysis = await analyzeFirm(url, keywords, rating, reviews);

    const insights = [];

    if (firmAnalysis.analysis) {
      const { pagesAnalyzed, avgWords, hasSchema } = firmAnalysis.analysis;

      if (!hasSchema) {
        insights.push(`Missing Schema (LocalBusiness / LegalService) on the ${pagesAnalyzed} pages analyzed.`);
      }

      if (avgWords < 800) {
        insights.push(`Pages have an average of ${avgWords} words. Top competitors in ${city} often have 1,500–2,000+ words on main practice pages.`);
      }

      const keywordsInTitles = firmAnalysis.keywordScores.filter(k => k.foundInTitle).length;
      if (keywordsInTitles < (keywords || []).length / 3) {
        insights.push(`Only ${keywordsInTitles} of ${keywords.length} target keywords appear in page titles.`);
      }
    }

    // Competitors
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
      detectedPractice: null, // prática já está no frontend
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
