const PROJECT = 'stock-research-9eee9';
const SYMBOLS = (Bun.argv[2] ? [Bun.argv[2].toUpperCase()] : ['NVDA', 'CRWD', 'AAPL', 'TSLA', 'SNOW', 'NTAP', 'DELL']);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || (await Bun.file('C:/Users/user/stock-research/.env').text().then(t => t.match(/ANTHROPIC_API_KEY=(.+)/)?.[1]?.trim() ?? ''));

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

// Yahoo Finance crumb auth
const cookieRes = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': 'Mozilla/5.0' } });
const YF_COOKIE = cookieRes.headers.get('set-cookie') || '';
const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
  headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': YF_COOKIE },
});
const YF_CRUMB = await crumbRes.text();
const YF_HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Cookie': YF_COOKIE };
console.log('Yahoo crumb:', YF_CRUMB);

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

async function fetchDeepResearch(symbol: string): Promise<any> {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=recommendationTrend,upgradeDowngradeHistory,earningsHistory,calendarEvents,majorHoldersBreakdown,defaultKeyStatistics,financialData&crumb=${encodeURIComponent(YF_CRUMB)}`;
  const res = await fetch(url, { headers: YF_HEADERS });
  const json = await res.json() as any;
  const r = json?.quoteSummary?.result?.[0];
  if (!r) return {};

  const rt  = r.recommendationTrend || {};
  const udh = r.upgradeDowngradeHistory || {};
  const eh  = r.earningsHistory || {};
  const ce  = r.calendarEvents || {};
  const mhb = r.majorHoldersBreakdown || {};
  const fd  = r.financialData || {};
  const ks  = r.defaultKeyStatistics || {};
  const v = (obj: any, key: string) => obj?.[key]?.raw ?? obj?.[key] ?? null;

  const mean = v(fd, 'recommendationMean');
  const consensus = mean == null ? 'N/A'
    : mean <= 1.5 ? 'Strong Buy'
    : mean <= 2.5 ? 'Buy'
    : mean <= 3.5 ? 'Hold'
    : mean <= 4.5 ? 'Sell'
    : 'Strong Sell';

  const trend = rt.trend?.[0] || {};
  const actionLabels: Record<string, string> = {
    up: 'Upgraded', down: 'Downgraded', init: 'Initiated', main: 'Maintained', reit: 'Reiterated',
  };
  const upgrades = (udh.history || []).slice(0, 5).map((item: any) => ({
    firm:      item.firm ?? '',
    action:    actionLabels[item.action] ?? item.action ?? '',
    fromGrade: item.fromGrade ?? '',
    toGrade:   item.toGrade ?? '',
    date:      item.epochGradeDate ? new Date(item.epochGradeDate * 1000).toISOString().split('T')[0] : '',
  }));

  const quarters = (eh.history || []).slice(-4).map((q: any) => {
    const surprise = q?.surprisePercent?.raw ?? null;
    const beat = surprise == null ? 'N/A'
      : surprise > 0.05  ? 'Beat'
      : surprise < -0.05 ? 'Miss'
      : 'In-Line';
    return {
      period:      q?.quarter?.fmt ?? '',
      epsActual:   q?.epsActual?.raw ?? null,
      epsEstimate: q?.epsEstimate?.raw ?? null,
      surprisePct: surprise != null ? surprise * 100 : null,
      beat,
    };
  });

  const earningsDates = ce.earnings?.earningsDate || [];
  const nextEarningsDate = earningsDates[0]?.raw
    ? new Date(earningsDates[0].raw * 1000).toISOString().split('T')[0]
    : null;

  const currentPrice = v(fd, 'currentPrice');
  const targetMean   = v(fd, 'targetMeanPrice');
  const shortFloat   = v(ks, 'shortPercentOfFloat');

  const meanScore  = mean != null ? Math.max(0, Math.min(40, ((5 - mean) / 4) * 40)) : 20;
  const shortScore = shortFloat != null ? Math.max(0, Math.min(30, (1 - shortFloat / 0.20) * 30)) : 15;
  const beats      = quarters.filter((q: any) => q.beat === 'Beat').length;
  const counted    = quarters.filter((q: any) => q.beat !== 'N/A').length;
  const beatScore  = counted > 0 ? (beats / counted) * 30 : 15;
  const sentimentScore = Math.round(Math.max(0, Math.min(100, meanScore + shortScore + beatScore)));
  const sentimentLabel = sentimentScore >= 75 ? 'Very Bullish'
    : sentimentScore >= 55 ? 'Bullish'
    : sentimentScore >= 40 ? 'Neutral'
    : sentimentScore >= 20 ? 'Bearish'
    : 'Very Bearish';

  return {
    analystRatings: {
      consensus,
      recommendationMean: mean,
      numberOfAnalysts:   v(fd, 'numberOfAnalystOpinions'),
      targetHigh:         v(fd, 'targetHighPrice'),
      targetLow:          v(fd, 'targetLowPrice'),
      targetMean,
      upsidePct: (currentPrice && targetMean) ? ((targetMean - currentPrice) / currentPrice) * 100 : null,
      strongBuy:   v(trend, 'strongBuy'),
      buy:         v(trend, 'buy'),
      hold:        v(trend, 'hold'),
      sell:        v(trend, 'sell'),
      strongSell:  v(trend, 'strongSell'),
    },
    upgrades,
    earnings: { nextEarningsDate, quarters },
    ownership: {
      institutionalPct: v(mhb, 'institutionsPercentHeld'),
      insiderPct:       v(mhb, 'insidersPercentHeld'),
      shortFloatPct:    shortFloat,
      shortRatio:       v(ks, 'shortRatio'),
    },
    sentimentScore,
    sentimentLabel,
  };
}

async function fetchFundamentals(symbol: string): Promise<any> {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=defaultKeyStatistics,financialData,summaryDetail,assetProfile&crumb=${encodeURIComponent(YF_CRUMB)}`;
  const res = await fetch(url, { headers: YF_HEADERS });
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
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y&crumb=${encodeURIComponent(YF_CRUMB)}`;
  const res = await fetch(url, { headers: YF_HEADERS });
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

async function generateNarrative(symbol: string, analysis: any, fundamentals: any, deepResearch: any): Promise<any> {
  const ar = deepResearch?.analystRatings || {};
  const ow = deepResearch?.ownership || {};
  const ea = deepResearch?.earnings || {};
  const f  = fundamentals || {};

  const prompt = `You are a senior equity research analyst. Analyze ${symbol} based on the data below and return a JSON object with your narrative assessment. Be concise, specific, and professional. Use actual numbers from the data.

## Market Data
- Price: $${analysis.price.current.toFixed(2)} (${analysis.price.changePct > 0 ? '+' : ''}${analysis.price.changePct.toFixed(2)}% today)
- 52W Range: $${analysis.yearRange.low52.toFixed(2)} – $${analysis.yearRange.high52.toFixed(2)} (${analysis.yearRange.pctFromHigh.toFixed(1)}% from high)
- Market Cap: ${f.marketCap ? '$' + (f.marketCap / 1e9).toFixed(1) + 'B' : 'N/A'}
- Sector: ${f.sector || 'N/A'} | ${f.industry || ''}

## Technical Indicators
- RSI (14): ${analysis.rsi.toFixed(1)} ${analysis.rsi > 70 ? '(overbought)' : analysis.rsi < 30 ? '(oversold)' : '(neutral)'}
- MACD Histogram: ${analysis.macd.histogram.toFixed(4)} ${analysis.macd.histogram > 0 ? '(bullish)' : '(bearish)'}
- Price vs SMA20: $${analysis.price.current.toFixed(2)} vs $${analysis.movingAverages.sma20?.toFixed(2)}
- Price vs SMA50: $${analysis.price.current.toFixed(2)} vs $${analysis.movingAverages.sma50?.toFixed(2) || 'N/A'}
- Bollinger Bands: Upper $${analysis.bollingerBands.upper.toFixed(2)}, Lower $${analysis.bollingerBands.lower.toFixed(2)}
- Volume Ratio: ${analysis.volume.ratio.toFixed(2)}x avg
- Overall Signal: ${analysis.overall}

## Fundamentals
- Trailing P/E: ${f.trailingPE?.toFixed(1) || 'N/A'} | Forward P/E: ${f.forwardPE?.toFixed(1) || 'N/A'}
- EPS (TTM): ${f.eps != null ? '$' + f.eps.toFixed(2) : 'N/A'} | EPS Forward: ${f.epsForward != null ? '$' + f.epsForward.toFixed(2) : 'N/A'}
- Revenue (TTM): ${f.revenue ? '$' + (f.revenue / 1e9).toFixed(2) + 'B' : 'N/A'} | Growth: ${f.revenueGrowth != null ? (f.revenueGrowth * 100).toFixed(1) + '%' : 'N/A'}
- Gross Margin: ${f.grossMargin != null ? (f.grossMargin * 100).toFixed(1) + '%' : 'N/A'} | Profit Margin: ${f.profitMargin != null ? (f.profitMargin * 100).toFixed(1) + '%' : 'N/A'}
- ROE: ${f.returnOnEquity != null ? (f.returnOnEquity * 100).toFixed(1) + '%' : 'N/A'} | Debt/Equity: ${f.debtToEquity != null ? Number(f.debtToEquity).toFixed(2) : 'N/A'}
- Free Cash Flow: ${f.freeCashflow ? '$' + (f.freeCashflow / 1e9).toFixed(2) + 'B' : 'N/A'}
- Beta: ${f.beta?.toFixed(2) || 'N/A'}

## Analyst Sentiment
- Consensus: ${ar.consensus || 'N/A'} (${ar.numberOfAnalysts || 0} analysts)
- Price Target: Low $${ar.targetLow?.toFixed(2) || 'N/A'} | Avg $${ar.targetMean?.toFixed(2) || 'N/A'} | High $${ar.targetHigh?.toFixed(2) || 'N/A'}
- Upside to Target: ${ar.upsidePct != null ? ar.upsidePct.toFixed(1) + '%' : 'N/A'}
- Strong Buy: ${ar.strongBuy || 0} | Buy: ${ar.buy || 0} | Hold: ${ar.hold || 0} | Sell: ${ar.sell || 0}
- Institutional Ownership: ${ow.institutionalPct != null ? (ow.institutionalPct * 100).toFixed(1) + '%' : 'N/A'}
- Short Float: ${ow.shortFloatPct != null ? (ow.shortFloatPct * 100).toFixed(1) + '%' : 'N/A'}
- Next Earnings: ${ea.nextEarningsDate || 'N/A'}
- Recent Quarters: ${(ea.quarters || []).map((q: any) => `${q.period} ${q.beat} (${q.surprisePct != null ? (q.surprisePct > 0 ? '+' : '') + q.surprisePct.toFixed(1) + '%' : ''})`).join(', ')}

Return ONLY valid JSON, no markdown, no explanation:
{
  "executiveSummary": "2-3 sentence overview of the stock's current position and outlook",
  "investmentThesis": "Paragraph making the bull case — why someone would buy this stock",
  "bearCase": "Paragraph on the key risks and why the thesis could be wrong",
  "catalysts": ["specific catalyst 1", "specific catalyst 2", "specific catalyst 3"],
  "risks": ["specific risk 1", "specific risk 2", "specific risk 3"],
  "technicalOutlook": "1-2 sentences interpreting the technical setup",
  "fundamentalAssessment": "1-2 sentences on valuation and financial health",
  "recommendation": "BUY or HOLD or SELL",
  "recommendationRationale": "1-2 sentence justification for the recommendation",
  "generatedBy": "claude-sonnet-4-6"
}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      clearTimeout(timeout);

      if (!res.ok) { console.error(`  Claude API error: ${res.status}`); return null; }

      const json = await res.json() as any;
      const raw = (json.content?.[0]?.text || '').trim();
      try { return JSON.parse(raw); } catch {
        const stripped = raw.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
        try { return JSON.parse(stripped); } catch(e) {
          console.error(`  Failed to parse Claude response:`, stripped.slice(0, 200));
          return null;
        }
      }
    } catch (e: any) {
      if (attempt < 3) { console.log(`  Attempt ${attempt} failed, retrying...`); }
      else { console.error(`  Claude narrative failed after 3 attempts`); return null; }
    }
  }
  return null;
}

for (const symbol of SYMBOLS) {
  console.log(`Fetching ${symbol}...`);
  const [analysis, fundamentals, deepResearch] = await Promise.all([fetchAnalysis(symbol), fetchFundamentals(symbol), fetchDeepResearch(symbol)]);
  console.log(`  Generating Claude narrative...`);
  const narrative = await generateNarrative(symbol, analysis, fundamentals, deepResearch);
  if (narrative) console.log(`  Claude recommendation: ${narrative.recommendation}`);
  await pushToFirestore(symbol, { ...analysis, fundamentals, deepResearch, narrative });
}
