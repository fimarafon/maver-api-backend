// competitor-scoring.js
// Baseado na lógica do Gemini AI Studio

/**
 * Converte string para hash numérico (determinístico)
 */
function stringToHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

/**
 * Gera número pseudo-aleatório baseado em seed
 * IMPORTANTE: Mesmo seed = sempre mesmo número
 */
function getPseudoRandom(seed, min, max) {
  const x = Math.sin(seed++) * 10000;
  return Math.floor((x - Math.floor(x)) * (max - min + 1)) + min;
}

/**
 * Calcula score de competitor
 * USA APENAS O NOME (hash) para gerar score consistente
 */
function calculateCompetitorScore(competitor, index, baseSeed) {
  // Gera seed baseado no nome do competitor + index
  const seed = stringToHash(competitor.name) + index + baseSeed;
  
  // Competitors SEMPRE têm scores altos (75-96)
  return getPseudoRandom(seed, 75, 96);
}

/**
 * Calcula score do cliente
 * USA APENAS O NOME (hash) para gerar score consistente
 */
function calculateClientScore(firmName) {
  const seed = stringToHash(firmName);
  
  // Cliente SEMPRE tem score baixo (14-29)
  return getPseudoRandom(seed, 14, 29);
}

/**
 * Processa competitors do Google Places
 */
function processRealCompetitors(googlePlacesCompetitors, firmName) {
  if (!googlePlacesCompetitors || googlePlacesCompetitors.length === 0) {
    return [];
  }
  
  // Remove o próprio firm da lista
  const filtered = googlePlacesCompetitors.filter(comp => 
    !comp.name.toLowerCase().includes(firmName.toLowerCase())
  );
  
  // Gera seed base a partir do nome da firma
  const baseSeed = stringToHash(firmName);
  
  // Calcula scores para cada competitor
  const competitorsWithScores = filtered.slice(0, 8).map((comp, index) => ({
    name: comp.name,
    score: calculateCompetitorScore(comp, index, baseSeed)
  }));
  
  // Ordena por score (maior para menor)
  competitorsWithScores.sort((a, b) => b.score - a.score);
  
  return competitorsWithScores;
}

/**
 * Ajusta score do cliente para GARANTIR que está abaixo de todos
 */
function adjustClientScore(calculatedScore, competitors) {
  if (!competitors || competitors.length === 0) {
    return calculatedScore;
  }
  
  // Pega o MENOR score dos competitors
  const lowestCompetitorScore = Math.min(...competitors.map(c => c.score));
  
  // Se o score calculado já está abaixo, mantém
  if (calculatedScore < lowestCompetitorScore) {
    return calculatedScore;
  }
  
  // Se não, força para ficar abaixo (com margem de 2-5 pontos)
  const adjustment = Math.floor(Math.random() * 4 + 2); // 2-5 pontos
  return Math.max(lowestCompetitorScore - adjustment, 5); // Nunca menos que 5
}

/**
 * Calcula scores por plataforma (baseado no overall)
 */
function calculatePlatformScores(overallScore, firmName) {
  const seed = stringToHash(firmName);
  
  return {
    chatgptScore: getPseudoRandom(seed + 5, Math.max(5, overallScore - 10), Math.min(35, overallScore + 5)),
    perplexityScore: 0, // Sempre 0 como no Gemini
    geminiScore: getPseudoRandom(seed + 9, Math.max(0, overallScore - 15), Math.min(25, overallScore))
  };
}

module.exports = {
  stringToHash,
  getPseudoRandom,
  calculateClientScore,
  processRealCompetitors,
  adjustClientScore,
  calculatePlatformScores
};
