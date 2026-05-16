// Vercel serverless — fetches live Nifty 50 P/E from NSE India.
// All live sources run in parallel with tight timeouts so the total
// function execution stays well within Vercel's 10s free-tier limit.
// Falls back to price ÷ trailing-EPS estimation if all live sources fail.
// 3-hour edge cache (NSE updates P/E once per trading day after close).

const UA = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'AppleWebKit/537.36 (KHTML, like Gecko)',
  'Chrome/124.0.0.0 Safari/537.36',
].join(' ');

const BROWSER_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
};

function timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)
  );
}

function race(promise, ms) {
  return Promise.race([promise, timeout(ms)]);
}

function validPE(v) {
  const n = parseFloat(v);
  return !isNaN(n) && n > 5 && n < 100 ? parseFloat(n.toFixed(2)) : null;
}

// ── Source 1: NSE niftyindices CDN blob — no auth required ──
async function fromNiftyindicesBlob() {
  const r = await fetch(
    'https://iislliveblob.niftyindices.com/jsonfiles/LivePEPBData.json',
    { headers: { ...BROWSER_HEADERS, Referer: 'https://www.niftyindices.com/' } }
  );
  if (!r.ok) throw new Error(`blob ${r.status}`);
  const data = await r.json();
  const row  = Array.isArray(data) && data.find(d =>
    typeof d.indexName === 'string' && d.indexName.trim() === 'NIFTY 50'
  );
  const pe = row && validPE(row.pe ?? row.PE ?? row['P/E']);
  if (!pe) throw new Error('no valid pe in blob');
  return { pe, source: 'NSE India', live: true };
}

// ── Source 2: NSE allIndices API (requires session cookie) ──
async function fromNSEAllIndices() {
  // Fetch homepage to acquire session cookies
  const home = await fetch('https://www.nseindia.com/', {
    headers: {
      ...BROWSER_HEADERS,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
    },
    redirect: 'follow',
  });

  // getSetCookie() returns an array (Node 18+), avoids comma-in-date parsing bugs
  const rawCookies =
    typeof home.headers.getSetCookie === 'function'
      ? home.headers.getSetCookie()
      : (home.headers.get('set-cookie') || '')
          .split(/,(?=[a-zA-Z_-]+=)/)
          .filter(Boolean);

  const cookieStr = rawCookies.map(c => c.split(';')[0].trim()).join('; ');
  if (!cookieStr) throw new Error('NSE: no session cookie');

  const api = await fetch('https://www.nseindia.com/api/allIndices', {
    headers: {
      ...BROWSER_HEADERS,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.nseindia.com/',
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: cookieStr,
    },
  });
  if (!api.ok) throw new Error(`NSE allIndices ${api.status}`);
  const data = await api.json();
  const row  = Array.isArray(data?.data) &&
    data.data.find(d => d.index === 'NIFTY 50' || d.indexSymbol === 'NIFTY 50');
  const pe = row && validPE(row.pe ?? row.PE);
  if (!pe) throw new Error('NSE: no valid pe in allIndices');
  return { pe, source: 'NSE India Live', live: true };
}

// ── Source 3: Yahoo Finance quoteSummary ──
async function fromYahooSummary() {
  const r = await fetch(
    'https://query1.finance.yahoo.com/v10/finance/quoteSummary/%5ENSEI?modules=summaryDetail',
    { headers: { ...BROWSER_HEADERS, Accept: 'application/json' } }
  );
  if (!r.ok) throw new Error(`yf summary ${r.status}`);
  const data = await r.json();
  const pe = validPE(data?.quoteSummary?.result?.[0]?.summaryDetail?.trailingPE?.raw);
  if (!pe) throw new Error('yf: no trailingPE for index');
  return { pe, source: 'Yahoo Finance', live: true };
}

// ── Fallback: price ÷ trailing EPS estimate ──
// Nifty 50 trailing EPS (12-month) estimated at ~1072 for Q4 FY26 (May 2026).
// Accuracy: ±1.5 pts. Updates needed each quarter if EPS estimate drifts.
async function fromEPSEstimate() {
  // Try query1, then query2
  let price = null;
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(
        `https://${host}.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1d`,
        { headers: BROWSER_HEADERS }
      );
      if (!r.ok) continue;
      const d = await r.json();
      const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (p && p > 10000) { price = p; break; }
    } catch {}
  }
  if (!price) throw new Error('EPS fallback: could not fetch Nifty price');
  const TRAILING_EPS = 1072;
  return {
    pe: parseFloat((price / TRAILING_EPS).toFixed(2)),
    source: 'Est. · price ÷ NSE trailing EPS',
    live: false,
    estimated: true,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // 3-hour edge cache; serve stale for 1 hour while revalidating
  res.setHeader('Cache-Control', 's-maxage=10800, stale-while-revalidate=3600');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // All live sources run in parallel — 3.5 s hard timeout each.
  // Promise.any resolves as soon as ONE succeeds; rejects only if ALL fail.
  // Worst case for live round: ~3.5 s (all timeout together).
  try {
    const result = await Promise.any([
      race(fromNiftyindicesBlob(),  3500),
      race(fromNSEAllIndices(),     3500),
      race(fromYahooSummary(),      3500),
    ]);
    return res.json(result);
  } catch {
    // All live sources failed — use EPS estimation (4.5 s budget, well within limit)
    try {
      const result = await race(fromEPSEstimate(), 4500);
      return res.json(result);
    } catch {
      return res.status(200).json({ pe: null, source: null, live: false });
    }
  }
};
