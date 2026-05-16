// Vercel serverless function — fetches live Nifty 50 P/E from NSE India.
// Tries 3 sources in parallel; falls back to trailing EPS estimation.
// Cached 3 hours at the edge (NSE updates P/E daily after market close).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

// ── Source 1: NSE niftyindices CDN blob (no auth required) ──
async function fromNiftyindicesBlob() {
  const r = await fetch('https://iislliveblob.niftyindices.com/jsonfiles/LivePEPBData.json', {
    headers: { 'User-Agent': UA, 'Referer': 'https://www.niftyindices.com/' },
  });
  if (!r.ok) throw new Error(`blob ${r.status}`);
  const data = await r.json();
  const row = Array.isArray(data) && data.find(d =>
    typeof d.indexName === 'string' && d.indexName.trim() === 'NIFTY 50'
  );
  const pe = row && parseFloat(row.pe || row.PE || row['P/E'] || 0);
  if (!pe || pe < 5 || pe > 80) throw new Error('invalid pe');
  return { pe: parseFloat(pe.toFixed(2)), source: 'NSE India', live: true };
}

// ── Source 2: NSE India allIndices API (requires session cookie) ──
async function fromNSEDirect() {
  // Step 1: hit the homepage to get a session cookie
  const home = await fetch('https://www.nseindia.com/', {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    redirect: 'follow',
  });
  const rawCookies = home.headers.get('set-cookie') || '';
  const cookie = rawCookies
    .split(/,(?=\s*\w+=)/)
    .map(c => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
  if (!cookie) throw new Error('no cookie');

  // Step 2: call allIndices which includes pe/pb fields
  const api = await fetch('https://www.nseindia.com/api/allIndices', {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json',
      'Referer': 'https://www.nseindia.com/',
      'Cookie': cookie,
    },
  });
  if (!api.ok) throw new Error(`nse api ${api.status}`);
  const data = await api.json();
  const row = Array.isArray(data?.data) &&
    data.data.find(d => d.index === 'NIFTY 50' || d.indexSymbol === 'NIFTY 50');
  const pe = row && parseFloat(row.pe || row.PE || 0);
  if (!pe || pe < 5 || pe > 80) throw new Error('invalid pe');
  return { pe: parseFloat(pe.toFixed(2)), source: 'NSE India Live', live: true };
}

// ── Source 3: Yahoo Finance quoteSummary (may not carry index P/E) ──
async function fromYahoo() {
  const r = await fetch(
    'https://query1.finance.yahoo.com/v10/finance/quoteSummary/%5ENSEI?modules=summaryDetail',
    { headers: { 'User-Agent': UA } }
  );
  if (!r.ok) throw new Error(`yf ${r.status}`);
  const data = await r.json();
  const pe = data?.quoteSummary?.result?.[0]?.summaryDetail?.trailingPE?.raw;
  if (!pe || pe < 5 || pe > 80) throw new Error('no pe in yf');
  return { pe: parseFloat(pe.toFixed(2)), source: 'Yahoo Finance', live: true };
}

// ── Fallback: compute from current Nifty price + trailing EPS estimate ──
// Nifty 50 EPS grows ~13% CAGR. FY24 actuals: ~840. FY26E (May 2026): ~1072.
// Error margin: ±1.5 pts — acceptable for zone classification.
async function fromEPSEstimate() {
  const r = await fetch(
    'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1d',
    { headers: { 'User-Agent': UA } }
  );
  if (!r.ok) throw new Error(`price fetch ${r.status}`);
  const data = await r.json();
  const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (!price || price < 10000) throw new Error('bad price');
  const EPS_FY26 = 1072; // trailing 12-month EPS estimate, May 2026
  const pe = parseFloat((price / EPS_FY26).toFixed(2));
  return { pe, source: 'Estimated · NSE EPS base ±2pt', live: false, estimated: true };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Cache 3 hours at Vercel edge; serve stale up to 1 hour while revalidating
  res.setHeader('Cache-Control', 's-maxage=10800, stale-while-revalidate=3600');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Run all live sources in parallel — take the first that resolves cleanly
  try {
    const result = await Promise.any([
      withTimeout(fromNiftyindicesBlob(), 5000),
      withTimeout(fromNSEDirect(), 8000),
      withTimeout(fromYahoo(), 5000),
    ]);
    return res.json(result);
  } catch {
    // All live sources failed — use EPS estimation
    try {
      const result = await withTimeout(fromEPSEstimate(), 5000);
      return res.json(result);
    } catch {
      return res.json({ pe: null, source: null, live: false });
    }
  }
};
