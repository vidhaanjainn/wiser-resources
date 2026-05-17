// Vercel serverless — fetches Nifty 50 price + 200-DMA + India VIX.
// Server-side: no CORS proxy, direct Yahoo Finance. Always returns a value.
// Edge-cached 15 minutes (NSE updates intraday; 15min is fresh enough).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' };

// Hardcoded fallbacks — update when Nifty moves >8% from these levels.
// Last verified: May 2026, Nifty ~24,500, VIX ~14.2.
const FALLBACK = { niftyPrice: 24500, dma200: 23800, vix: 14.2 };

function race(p, ms) {
  return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
}

async function fetchChart(symbol, range, host) {
  const r = await fetch(
    `https://${host}.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${range}`,
    { headers: HEADERS }
  );
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

async function tryChart(symbol, range) {
  for (const host of ['query1', 'query2']) {
    try { return await race(fetchChart(symbol, range, host), 4000); } catch {}
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const [niftyData, vixData] = await Promise.all([
    tryChart('%5ENSEI', '1y'),
    tryChart('%5EINDIAVIX', '5d'),
  ]);

  let niftyPrice = null, dma200 = null, vix = null;

  if (niftyData) {
    const closes = (niftyData?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(Boolean);
    if (closes.length >= 20) {
      niftyPrice = Math.round(closes[closes.length - 1]);
      const slice = closes.slice(-200);
      dma200 = Math.round(slice.reduce((a, b) => a + b, 0) / slice.length);
    }
  }

  if (vixData) {
    const closes = (vixData?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(Boolean);
    const v = vixData?.chart?.result?.[0]?.meta?.regularMarketPrice || closes[closes.length - 1];
    if (v && v > 0) vix = parseFloat(Number(v).toFixed(1));
  }

  const live = niftyPrice !== null || vix !== null;

  return res.json({
    niftyPrice: niftyPrice ?? FALLBACK.niftyPrice,
    dma200:     dma200     ?? FALLBACK.dma200,
    vix:        vix        ?? FALLBACK.vix,
    live,
    source: live ? 'Yahoo Finance' : 'Cached estimate',
    fetchedAt: new Date().toISOString(),
  });
};
