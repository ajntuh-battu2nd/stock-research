const PROJECT = 'stock-research-9eee9';
const SYMBOLS = (Bun.argv[2] ? [Bun.argv[2].toUpperCase()] : ['NVDA', 'CRWD', 'AAPL', 'TSLA', 'SNOW']);

// Get access token from service account
const sa = await Bun.file('C:/Users/user/stock-research/serviceAccount.json').json();
const now = Math.floor(Date.now() / 1000);
const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
const payload = btoa(JSON.stringify({
  iss: sa.client_email,
  scope: 'https://www.googleapis.com/auth/datastore',
  aud: 'https://oauth2.googleapis.com/token',
  iat: now,
  exp: now + 3600,
}));
const { createSign } = await import('crypto');
const sign = createSign('RSA-SHA256');
sign.update(`${header}.${payload}`);
const sig = sign.sign(sa.private_key, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
const jwt = `${header}.${payload}.${sig}`;

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
});
const { access_token: TOKEN } = await tokenRes.json() as any;

function toFirestore(val: any): any {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') return { doubleValue: val };
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestore) } };
  if (typeof val === 'object') {
    const fields: any = {};
    for (const [k, v] of Object.entries(val)) fields[k] = toFirestore(v);
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

async function fetchFundamentals(symbol: string): Promise<any> {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=defaultKeyStatistics,financialData,summaryDetail,assetProfile`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const json = await res.json() as any;
  const r = json?.quoteSummary?.result?.[0];
  if (!r) return {};
  const ks = r.defaultKeyStatistics || {};
  const fd = r.financialData || {};
  const sd = r.summaryDetail || {};
  const ap = r.assetProfile || {};

  const v = (obj: any, key: string) => obj?.[key]?.raw ?? obj?.[key] ?? null;

  return {
    marketCap: v(sd, 'marketCap'),
    trailingPE: v(sd, 'trailingPE'),
    forwardPE: v(sd, 'forwardPE'),
    priceToBook: v(ks, 'priceToBook'),
    eps: v(ks, 'trailingEps'),
    epsForward: v(ks, 'forwardEps'),
    beta: v(ks, 'beta'),
    dividendYield: v(sd, 'dividendYield'),
    revenue: v(fd, 'totalRevenue'),
    revenueGrowth: v(fd, 'revenueGrowth'),
    grossMargin: v(fd, 'grossMargins'),
    operatingMargin: v(fd, 'operatingMargins'),
    profitMargin: v(fd, 'profitMargins'),
    returnOnEquity: v(fd, 'returnOnEquity'),
    returnOnAssets: v(fd, 'returnOnAssets'),
    debtToEquity: v(fd, 'debtToEquity'),
    freeCashflow: v(fd, 'freeCashflow'),
    currentRatio: v(fd, 'currentRatio'),
    shortRatio: v(ks, 'shortRatio'),
    sector: ap.sector ?? null,
    industry: ap.industry ?? null,
  };
}

async function fetchAnalysis(symbol: string): Promise<any> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const json = await res.json() as any;
  const result = json.chart.result[0];
  const meta = result.meta;
  const closes = result.indicators.quote[0].close as number[];
  const highs = result.indicators.quote[0].high as number[];
  const lows = result.indicators.quote[0].low as number[];
  const volumes = result.indicators.quote[0].volume as number[];

  const valid = closes.map((c, i) => ({ c, h: highs[i], l: lows[i], v: volumes[i] })).filter(x => x.c != null);
  const c = valid.map(x => x.c);
  const v = valid.map(x => x.v);

  function sma(arr: number[], n: number) {
    if (arr.length < n) return null;
    return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
  }

  // RSI 14
  const gains: number[] = [], losses: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  const avgGain = gains.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const avgLoss = losses.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);

  // MACD (12/26/9)
  function ema(arr: number[], n: number): number[] {
    const k = 2 / (n + 1);
    const result: number[] = [arr[0]];
    for (let i = 1; i < arr.length; i++) result.push(arr[i] * k + result[i - 1] * (1 - k));
    return result;
  }
  const ema12 = ema(c, 12); const ema26 = ema(c, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = ema(macdLine, 9);
  const histogram = macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1];

  // Bollinger Bands 20
  const sma20 = sma(c, 20)!;
  const std20 = Math.sqrt(c.slice(-20).reduce((a, b) => a + Math.pow(b - sma20, 2), 0) / 20);

  // Volume
  const avg20vol = v.slice(-20).reduce((a, b) => a + b, 0) / 20;

  // 52W
  const high52 = Math.max(...valid.map(x => x.h).filter(Boolean));
  const low52 = Math.min(...valid.map(x => x.l).filter(Boolean));

  const current = meta.regularMarketPrice ?? c[c.length - 1];
  const prevClose = meta.previousClose ?? c[c.length - 2];
  const change = current - prevClose;

  const signals: string[] = [];
  const s20 = sma(c, 20)!, s50 = sma(c, 50);
  if (current > s20) signals.push('Price above 20-day MA (bullish)');
  else signals.push('Price below 20-day MA (bearish)');
  if (s50 && s20 > s50) signals.push('20 MA above 50 MA (golden cross zone)');
  else if (s50) signals.push('20 MA below 50 MA (death cross zone)');
  if (rsi > 70) signals.push('RSI overbought (>70)');
  else if (rsi < 30) signals.push('RSI oversold (<30)');
  else signals.push(`RSI neutral (${rsi.toFixed(1)})`);
  if (histogram > 0) signals.push('MACD bullish crossover');
  else signals.push('MACD bearish crossover');
  const bb_upper = sma20 + 2 * std20, bb_lower = sma20 - 2 * std20;
  if (current < bb_upper && current > bb_lower) signals.push('Price within Bollinger Bands');
  else if (current >= bb_upper) signals.push('Price above upper Bollinger Band');
  else signals.push('Price below lower Bollinger Band');

  const bullish = signals.filter(s => s.includes('bullish') || s.includes('golden')).length;
  const bearish = signals.filter(s => s.includes('bearish') || s.includes('death') || s.includes('overbought')).length;
  const overall = bullish > bearish ? 'BULLISH' : bearish > bullish ? 'BEARISH' : 'NEUTRAL';

  return {
    symbol,
    generatedAt: new Date().toISOString(),
    price: {
      current, change, changePct: (change / prevClose) * 100,
      open: meta.regularMarketOpen ?? valid[valid.length - 1].c,
      high: meta.regularMarketDayHigh ?? valid[valid.length - 1].h,
      low: meta.regularMarketDayLow ?? valid[valid.length - 1].l,
    },
    movingAverages: { sma20: s20, sma50: s50 ?? null, sma200: sma(c, 200) },
    rsi,
    macd: { macdLine: macdLine[macdLine.length - 1], signal: signalLine[signalLine.length - 1], histogram },
    bollingerBands: { upper: bb_upper, middle: sma20, lower: bb_lower },
    volume: { today: v[v.length - 1], avg20: avg20vol, ratio: v[v.length - 1] / avg20vol },
    yearRange: { high52, low52, pctFromHigh: ((current - high52) / high52) * 100 },
    signals,
    overall,
  };
}



async function pushToFirestore(symbol: string, analysis: any) {
  const body: any = { fields: {} };
  for (const [k, v] of Object.entries(analysis)) body.fields[k] = toFirestore(v);
  const db = '(default)';
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${db}/documents/technicalAnalysis/${symbol}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await res.json() as any;
  if (res.ok) {
    console.log(`✓ ${symbol} written to Firestore (updated: ${result.updateTime})`);
  } else {
    console.error(`✗ ${symbol} error:`, result.error?.message);
  }
}

for (const symbol of SYMBOLS) {
  console.log(`Fetching ${symbol}...`);
  const [analysis, fundamentals] = await Promise.all([fetchAnalysis(symbol), fetchFundamentals(symbol)]);
  await pushToFirestore(symbol, { ...analysis, fundamentals });
}
