// Vercel serverless — fetches live Nifty 50 P/E.
// 4-layer fallback: CDN blob → NSE API (cookie) → Yahoo → EPS estimate → hardcode.
// ALWAYS returns a pe value. Edge-cached 3 hours.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

// Nifty 50 trailing EPS base — update quarterly when results season closes.
// Source: NSE India index PE/PB daily release.
// FY26 Q4 (Mar 2026): ~1072. Error margin: ±1.5 pts vs actual NSE P/E.
const TRAILING_EPS = 1072;

// Hard fallback — last manually verified NSE P/E.
// Only used if EPS estimation also fails (e.g. Yahoo Finance down).
// Update this when merging to main if Nifty has moved >8% since last update.
const HARDCODED = { pe: 21.5, source: 'NSE India (cached)', live: false, estimated: true };

function race(p, ms) {
  return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
}

function toPE(v) {
  const n = parseFloat(v);
  return !isNaN(n) && n > 5 && n < 100 ? parseFloat(n.toFixed(2)) : null;
}

// ── 1. niftyindices CDN blob — no auth ──
async function fromBlob() {
  const urls = [
    'https://iislliveblob.niftyindices.com/jsonfiles/LivePEPBData.json',
    'https://www.niftyindices.com/IndexConstituent/Live_Pe_Pb_Data.json',
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { ...BASE_HEADERS, Referer: 'https://www.niftyindices.com/' } });
      if (!r.ok) continue;
      const data = await r.json();
      const row = Array.isArray(data) && data.find(d => typeof d.indexName === 'string' && d.indexName.trim() === 'NIFTY 50');
      const pe = row && toPE(row.pe ?? row.PE ?? row['P/E']);
      if (pe) return { pe, source: 'NSE India', live: true };
    } catch {}
  }
  throw new Error('blob: all urls failed');
}

// ── 2. NSE allIndices API — needs session cookie ──
async function fromNSE() {
  const homeRes = await fetch('https://www.nseindia.com/', {
    headers: {
      ...BASE_HEADERS,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1',
    },
    redirect: 'follow',
  });
  const rawCookies = typeof homeRes.headers.getSetCookie === 'function'
    ? homeRes.headers.getSetCookie()
    : (homeRes.headers.get('set-cookie') || '').split(/,(?=[a-zA-Z_-]+=)/).filter(Boolean);
  const cookieStr = rawCookies.map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
  if (!cookieStr) throw new Error('NSE: no cookie');

  const apiRes = await fetch('https://www.nseindia.com/api/allIndices', {
    headers: {
      ...BASE_HEADERS,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.nseindia.com/',
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: cookieStr,
    },
  });
  if (!apiRes.ok) throw new Error(`NSE: ${apiRes.status}`);
  const data = await apiRes.json();
  const row = Array.isArray(data?.data) && data.data.find(d => d.index === 'NIFTY 50' || d.indexSymbol === 'NIFTY 50');
  const pe = row && toPE(row.pe ?? row.PE);
  if (!pe) throw new Error('NSE: no pe in allIndices');
  return { pe, source: 'NSE India Live', live: true };
}

// ── 3. Yahoo Finance quoteSummary ──
async function fromYahoo() {
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(
        `https://${host}.finance.yahoo.com/v10/finance/quoteSummary/%5ENSEI?modules=summaryDetail`,
        { headers: { ...BASE_HEADERS, Accept: 'application/json' } }
      );
      if (!r.ok) continue;
      const data = await r.json();
      const pe = toPE(data?.quoteSummary?.result?.[0]?.summaryDetail?.trailingPE?.raw);
      if (pe) return { pe, source: 'Yahoo Finance', live: true };
    } catch {}
  }
  throw new Error('Yahoo: no trailingPE for index');
}

// ── 4. EPS estimation — price ÷ trailing EPS ──
async function fromEPS() {
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(
        `https://${host}.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1d`,
        { headers: { ...BASE_HEADERS, Accept: 'application/json' } }
      );
      if (!r.ok) continue;
      const data = await r.json();
      // Try regularMarketPrice first, then last close
      const closes = (data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(Boolean);
      const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice || closes[closes.length - 1];
      if (price && price > 10000) {
        return {
          pe: parseFloat((price / TRAILING_EPS).toFixed(2)),
          source: 'Est. · Nifty price ÷ trailing EPS',
          live: false,
          estimated: true,
        };
      }
    } catch {}
  }
  throw new Error('EPS: price fetch failed');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=10800, stale-while-revalidate=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Layer 1: all live sources in parallel, 3.5s cap each
  try {
    const result = await Promise.any([
      race(fromBlob(), 3500),
      race(fromNSE(),  3500),
      race(fromYahoo(), 3500),
    ]);
    return res.json(result);
  } catch {}

  // Layer 2: EPS estimation (dynamic, tracks price movements)
  try {
    const result = await race(fromEPS(), 4000);
    return res.json(result);
  } catch {}

  // Layer 3: hardcoded recent value — never fails
  return res.json(HARDCODED);
};
