/**
 * deep-research.ts
 * Deep fundamental research using SEC EDGAR + Yahoo Finance + Claude AI
 * Usage: bun run deep-research.ts ADSK
 */

const SYMBOL = (Bun.argv[2] || 'ADSK').toUpperCase();
const PROJECT = 'stock-research-9eee9';

// ── Auth: Firestore ────────────────────────────────────────────────────────
const sa = await Bun.file('C:/Users/user/stock-research/serviceAccount.json').json();
const now = Math.floor(Date.now() / 1000);
const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
const payload = btoa(JSON.stringify({
  iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
  aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
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

// ── Auth: Yahoo Finance crumb ──────────────────────────────────────────────
const cookieRes = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': 'Mozilla/5.0' } });
const YF_COOKIE = cookieRes.headers.get('set-cookie') || '';
const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
  headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': YF_COOKIE },
});
const YF_CRUMB = await crumbRes.text();
const YF_HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Cookie': YF_COOKIE };

// ── Auth: Anthropic ────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = (await Bun.file('C:/Users/user/stock-research/.env').text())
  .match(/ANTHROPIC_API_KEY=(.+)/)?.[1]?.trim() ?? '';

const EDGAR_HEADERS = {
  'User-Agent': 'stock-research ajntuh@gmail.com',
  'Accept': 'application/json',
};

// ── Step 1: Find CIK from ticker ───────────────────────────────────────────
console.log(`\n🔍 Looking up ${SYMBOL} on SEC EDGAR...`);
const tickersRes = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: EDGAR_HEADERS });
const tickers = await tickersRes.json() as any;
const entry = Object.values(tickers).find((e: any) => e.ticker === SYMBOL) as any;
if (!entry) throw new Error(`Could not find CIK for ${SYMBOL}`);
const CIK = String(entry.cik_str).padStart(10, '0');
const COMPANY_NAME = entry.title;
console.log(`  Found: ${COMPANY_NAME} (CIK: ${CIK})`);

// ── Step 2: Fetch XBRL company facts (all financial data) ─────────────────
console.log(`📊 Fetching SEC EDGAR XBRL financial data...`);
const factsRes = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${CIK}.json`, { headers: EDGAR_HEADERS });
const facts = await factsRes.json() as any;
const gaap = facts.facts?.['us-gaap'] || facts['us-gaap'] || {};

function extractMetric(key: string, unit = 'USD') {
  const metric = gaap[key];
  if (!metric) return [];
  const units = metric.units[unit] || [];
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  return units
    .filter((d: any) => d.form === '10-Q' || d.form === '10-K')
    .filter((d: any) => new Date(d.end) >= cutoff)
    .filter((d: any) => {
      // For quarterly data, filter to quarterly periods (not annual accumulations in 10-Qs)
      if (d.form === '10-Q') {
        const start = new Date(d.start);
        const end = new Date(d.end);
        const days = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
        return days < 110; // ~3 months
      }
      if (d.form === '10-K') {
        const start = new Date(d.start);
        const end = new Date(d.end);
        const days = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
        return days > 300; // full year
      }
      return true;
    })
    .sort((a: any, b: any) => new Date(a.end).getTime() - new Date(b.end).getTime())
    .map((d: any) => ({ period: d.end, form: d.form, value: d.val }));
}

function extractLatestByPeriod(key: string, unit = 'USD') {
  const metric = gaap[key];
  if (!metric) return [];
  const units = metric.units[unit] || [];
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  // Group by end date, take latest filed
  const byPeriod = new Map<string, any>();
  for (const d of units) {
    if (new Date(d.end) < cutoff) continue;
    const existing = byPeriod.get(d.end);
    if (!existing || new Date(d.filed) > new Date(existing.filed)) {
      byPeriod.set(d.end, d);
    }
  }
  return Array.from(byPeriod.values())
    .sort((a, b) => new Date(a.end).getTime() - new Date(b.end).getTime())
    .map(d => ({ period: d.end, form: d.form, value: d.val }));
}

function fmtM(v: number) { return v != null ? `$${(v / 1e6).toFixed(0)}M` : 'N/A'; }
function fmtPct(a: number, b: number) { return b ? `${(((a - b) / Math.abs(b)) * 100).toFixed(1)}%` : 'N/A'; }

const revenue     = extractMetric('RevenueFromContractWithCustomerExcludingAssessedTax');
const netIncome   = extractMetric('NetIncomeLoss');
const grossProfit = extractMetric('GrossProfit');
const opIncome    = extractMetric('OperatingIncomeLoss');
const rnd         = extractMetric('ResearchAndDevelopmentExpense');
const sga         = extractMetric('SellingGeneralAndAdministrativeExpense');
const opCashFlow  = extractMetric('NetCashProvidedByUsedInOperatingActivities');
const capex       = extractMetric('PaymentsToAcquirePropertyPlantAndEquipment');
const epsDiluted  = extractMetric('EarningsPerShareDiluted', 'USD/shares');
const deferredRev = extractLatestByPeriod('DeferredRevenueCurrent');
const cash        = extractLatestByPeriod('CashAndCashEquivalentsAtCarryingValue');
const totalDebt   = extractLatestByPeriod('LongTermDebt');
const shares      = extractLatestByPeriod('CommonStockSharesOutstanding', 'shares');

console.log(`  Revenue periods: ${revenue.length}, Net Income: ${netIncome.length}`);

// Build quarterly summary table (last 5 quarters for earnings analysis)
const last5Q = revenue.filter(r => r.form === '10-Q').slice(-5);
const last5Annual = revenue.filter(r => r.form === '10-K').slice(-5);

function buildQuarterlyTable() {
  const rows: string[] = [];
  for (const r of last5Q) {
    const ni = netIncome.find(x => x.period === r.period && x.form === r.form);
    const gp = grossProfit.find(x => x.period === r.period && x.form === r.form);
    const op = opIncome.find(x => x.period === r.period && x.form === r.form);
    const eps = epsDiluted.find(x => x.period === r.period && x.form === r.form);
    const dr = deferredRev.find(x => x.period === r.period);
    const grossMargin = gp && r.value ? ((gp.value / r.value) * 100).toFixed(1) : 'N/A';
    const opMargin = op && r.value ? ((op.value / r.value) * 100).toFixed(1) : 'N/A';
    rows.push(`  ${r.period} | Rev: ${fmtM(r.value)} | GM: ${grossMargin}% | OpInc: ${fmtM(op?.value)} | OpMgn: ${opMargin}% | NI: ${fmtM(ni?.value)} | EPS: $${eps?.value?.toFixed(2) || 'N/A'} | DeferredRev: ${fmtM(dr?.value)}`);
  }
  return rows.join('\n');
}

function buildAnnualTable() {
  const rows: string[] = [];
  for (let i = 0; i < last5Annual.length; i++) {
    const r = last5Annual[i];
    const ni = netIncome.find(x => x.period === r.period && x.form === '10-K');
    const gp = grossProfit.find(x => x.period === r.period && x.form === '10-K');
    const op = opIncome.find(x => x.period === r.period && x.form === '10-K');
    const ocf = opCashFlow.find(x => x.period === r.period && x.form === '10-K');
    const cx = capex.find(x => x.period === r.period && x.form === '10-K');
    const fcf = ocf && cx ? ocf.value - cx.value : null;
    const prev = last5Annual[i - 1];
    const yoy = prev ? fmtPct(r.value, prev.value) : 'N/A';
    const grossMargin = gp && r.value ? ((gp.value / r.value) * 100).toFixed(1) : 'N/A';
    const opMargin = op && r.value ? ((op.value / r.value) * 100).toFixed(1) : 'N/A';
    const niMargin = ni && r.value ? ((ni.value / r.value) * 100).toFixed(1) : 'N/A';
    rows.push(`  FY${r.period.slice(0,4)} | Rev: ${fmtM(r.value)} (YoY: ${yoy}) | GM: ${grossMargin}% | OpMgn: ${opMargin}% | NI Mgn: ${niMargin}% | FCF: ${fmtM(fcf)} | NI: ${fmtM(ni?.value)}`);
  }
  return rows.join('\n');
}

// ── Step 3: Fetch filing metadata (10-K and 10-Q list) ───────────────────
console.log(`📁 Fetching SEC filing history...`);
const subsRes = await fetch(`https://data.sec.gov/submissions/CIK${CIK}.json`, { headers: EDGAR_HEADERS });
const subs = await subsRes.json() as any;
const filings = subs.filings?.recent || {};
const forms: string[] = filings.form || [];
const dates: string[] = filings.filingDate || [];
const accessions: string[] = filings.accessionNumber || [];
const descriptions: string[] = filings.primaryDocument || [];

const tenKs: any[] = [], tenQs: any[] = [];
for (let i = 0; i < forms.length; i++) {
  if (forms[i] === '10-K' && tenKs.length < 5) tenKs.push({ date: dates[i], accession: accessions[i], doc: descriptions[i] });
  if (forms[i] === '10-Q' && tenQs.length < 5) tenQs.push({ date: dates[i], accession: accessions[i], doc: descriptions[i] });
}
console.log(`  Found ${tenKs.length} 10-Ks and ${tenQs.length} 10-Qs`);

// ── Step 4: Fetch most recent 10-K MD&A section ───────────────────────────
console.log(`📄 Fetching most recent 10-K filing content...`);
let mdaText = '';
try {
  const acc = tenKs[0]?.accession?.replace(/-/g, '');
  const cikNum = String(entry.cik_str);
  const idxUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/${tenKs[0]?.doc}`;
  const docRes = await fetch(idxUrl, { headers: { 'User-Agent': 'stock-research ajntuh@gmail.com' } });
  const html = await docRes.text();
  // Strip HTML tags and get plain text
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 40000);
  // Try to find MD&A section
  const mdaIdx = text.toLowerCase().indexOf("management's discussion");
  if (mdaIdx > -1) {
    mdaText = text.slice(mdaIdx, mdaIdx + 15000);
    console.log(`  Extracted MD&A: ${mdaText.length} chars`);
  } else {
    mdaText = text.slice(0, 15000);
    console.log(`  Using first 15k chars of 10-K`);
  }
} catch (e) {
  console.log(`  Could not fetch 10-K content: ${e}`);
}

// ── Step 5: Fetch Yahoo Finance earnings history ───────────────────────────
console.log(`📈 Fetching Yahoo Finance earnings history...`);
let earningsHistory: any[] = [];
let analystData: any = {};
try {
  const yfUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${SYMBOL}?modules=earningsHistory,defaultKeyStatistics,financialData,recommendationTrend&crumb=${encodeURIComponent(YF_CRUMB)}`;
  const yfRes = await fetch(yfUrl, { headers: YF_HEADERS });
  const yfJson = await yfRes.json() as any;
  const r = yfJson?.quoteSummary?.result?.[0];
  earningsHistory = (r?.earningsHistory?.history || []).slice(-5);
  analystData = {
    consensus: r?.financialData?.recommendationKey || 'N/A',
    targetMean: r?.financialData?.targetMeanPrice?.raw,
    targetHigh: r?.financialData?.targetHighPrice?.raw,
    targetLow: r?.financialData?.targetLowPrice?.raw,
    numberOfAnalysts: r?.financialData?.numberOfAnalystOpinions?.raw,
    currentPrice: r?.financialData?.currentPrice?.raw,
    revenueGrowth: r?.financialData?.revenueGrowth?.raw,
    grossMargins: r?.financialData?.grossMargins?.raw,
    profitMargins: r?.financialData?.profitMargins?.raw,
  };
  console.log(`  Earnings history: ${earningsHistory.length} quarters`);
} catch (e) {
  console.log(`  Yahoo Finance error: ${e}`);
}

const earningsSummary = earningsHistory.map((q: any) => {
  const surprise = q?.surprisePercent?.raw;
  const beat = surprise == null ? 'N/A' : surprise > 0.05 ? 'Beat' : surprise < -0.05 ? 'Miss' : 'In-Line';
  return `  ${q?.quarter?.fmt || 'N/A'}: Actual $${q?.epsActual?.raw?.toFixed(2) || 'N/A'} vs Est $${q?.epsEstimate?.raw?.toFixed(2) || 'N/A'} → ${beat} (${surprise != null ? (surprise * 100).toFixed(1) + '%' : 'N/A'})`;
}).join('\n');

// ── Step 6: Generate Claude deep research report ───────────────────────────
console.log(`\n🤖 Generating Claude deep research report...`);

const prompt = `You are a senior sell-side equity research analyst at a top-tier investment bank. Conduct a comprehensive deep-dive fundamental research report on ${SYMBOL} (${COMPANY_NAME}).

You have access to 5 years of SEC EDGAR financial data, 10-K annual reports, and earnings history. Produce a thorough, data-driven research report that an institutional investor would find valuable.

═══════════════════════════════════════
SEC EDGAR — ANNUAL FINANCIALS (5 Years)
═══════════════════════════════════════
${buildAnnualTable()}

═══════════════════════════════════════
SEC EDGAR — LAST 5 QUARTERS
═══════════════════════════════════════
${buildQuarterlyTable()}

═══════════════════════════════════════
EARNINGS SURPRISE HISTORY (Last 5Q)
═══════════════════════════════════════
${earningsSummary}

═══════════════════════════════════════
ANALYST CONSENSUS
═══════════════════════════════════════
- Rating: ${analystData.consensus?.toUpperCase() || 'N/A'}
- Analysts: ${analystData.numberOfAnalysts || 'N/A'}
- Price Target: Low $${analystData.targetLow?.toFixed(2) || 'N/A'} | Mean $${analystData.targetMean?.toFixed(2) || 'N/A'} | High $${analystData.targetHigh?.toFixed(2) || 'N/A'}
- Current Price: $${analystData.currentPrice?.toFixed(2) || 'N/A'}
- Upside to Mean Target: ${analystData.targetMean && analystData.currentPrice ? ((analystData.targetMean - analystData.currentPrice) / analystData.currentPrice * 100).toFixed(1) + '%' : 'N/A'}

═══════════════════════════════════════
RECENT 10-K FILING DATES
═══════════════════════════════════════
${tenKs.map(f => `  10-K filed: ${f.date}`).join('\n')}
${tenQs.map(f => `  10-Q filed: ${f.date}`).join('\n')}

═══════════════════════════════════════
10-K MANAGEMENT DISCUSSION EXCERPT
═══════════════════════════════════════
${mdaText.slice(0, 8000)}

═══════════════════════════════════════

Write a comprehensive research report. Return ONLY valid JSON:
{
  "reportTitle": "string — e.g. '${SYMBOL}: Deep Fundamental Research Report'",
  "reportDate": "${new Date().toISOString().split('T')[0]}",
  "executiveSummary": "3-4 sentences: business overview, investment appeal, and overall verdict",
  "recommendation": "BUY or HOLD or SELL",
  "priceTarget": number or null,
  "priceTargetRationale": "1-2 sentences explaining the price target",
  "businessOverview": "2-3 sentences on what the company does, its business model, and competitive moat",
  "revenueAnalysis": {
    "fiveYearTrend": "paragraph analyzing revenue growth over 5 years with specific numbers",
    "recentQuarters": "paragraph analyzing last 5 quarters of revenue performance",
    "growthDrivers": ["driver 1", "driver 2", "driver 3"]
  },
  "profitabilityAnalysis": {
    "marginTrends": "paragraph on gross, operating, and net margin trends over 5 years",
    "freecashflow": "paragraph on FCF generation and trends"
  },
  "earningsAnalysis": {
    "fiveQuarterScorecard": "paragraph analyzing last 5 quarters of EPS beats/misses with context",
    "earningsQuality": "paragraph on earnings quality — recurring revenue, deferred revenue, cash conversion"
  },
  "balanceSheetAnalysis": "paragraph on balance sheet health — cash, debt, liquidity",
  "competitivePosition": "paragraph on competitive moat, market position, and key competitors",
  "keyRisks": ["specific risk 1 with detail", "specific risk 2 with detail", "specific risk 3 with detail", "specific risk 4 with detail"],
  "catalysts": ["catalyst 1 with detail", "catalyst 2 with detail", "catalyst 3 with detail"],
  "valuation": "paragraph on current valuation vs historical and peers, with specific multiples",
  "investmentThesis": "2-3 paragraph comprehensive bull case",
  "bearCase": "1-2 paragraph bear case with specific scenarios",
  "conclusion": "2-3 sentence strong concluding statement with recommendation and conviction level"
}`;

async function callClaude(prompt: string): Promise<any> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300000);
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
          max_tokens: 8192,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      clearTimeout(timeout);
      if (!res.ok) { console.error(`  Claude error: ${res.status} ${await res.text()}`); return null; }
      const json = await res.json() as any;
      const raw = (json.content?.[0]?.text || '').trim();
      try { return JSON.parse(raw); } catch {
        const stripped = raw.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
        try { return JSON.parse(stripped); } catch (e2) {
          console.error(`  Parse failed, attempt ${attempt}: ${(e2 as any).message}`);
          console.error(`  Raw start: ${raw.slice(0, 200)}`);
          console.error(`  Raw end: ${raw.slice(-200)}`);
          if (attempt === 3) return null;
        }
      }
    } catch (e: any) {
      console.log(`  Attempt ${attempt} failed: ${e.message}`);
      if (attempt === 3) return null;
    }
  }
  return null;
}

const report = await callClaude(prompt);
if (!report) { console.error('❌ Failed to generate report'); process.exit(1); }
console.log(`  Recommendation: ${report.recommendation}`);
console.log(`  Price Target: $${report.priceTarget}`);

// ── Step 7: Store in Firestore ─────────────────────────────────────────────
console.log(`\n💾 Storing in Firestore...`);

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

const docData = {
  symbol: SYMBOL,
  companyName: COMPANY_NAME,
  generatedAt: new Date().toISOString(),
  report,
  rawData: {
    annualRevenue: last5Annual.map(r => ({ period: r.period, value: r.value })),
    quarterlyRevenue: last5Q.map(r => ({ period: r.period, value: r.value })),
    earningsHistory: earningsHistory.map((q: any) => ({
      period: q?.quarter?.fmt || '',
      epsActual: q?.epsActual?.raw || null,
      epsEstimate: q?.epsEstimate?.raw || null,
      surprisePct: q?.surprisePercent?.raw ? q.surprisePercent.raw * 100 : null,
    })),
    tenKDates: tenKs.map(f => f.date),
    tenQDates: tenQs.map(f => f.date),
  },
};

const body: any = { fields: {} };
for (const [k, v] of Object.entries(docData)) body.fields[k] = toFirestore(v);

const fsUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/deepResearch/${SYMBOL}`;
const fsRes = await fetch(fsUrl, {
  method: 'PATCH',
  headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const fsResult = await fsRes.json() as any;
if (fsRes.ok) {
  console.log(`✓ Deep research report stored at deepResearch/${SYMBOL}`);
  console.log(`  Updated: ${fsResult.updateTime}`);
} else {
  console.error(`✗ Firestore error:`, fsResult.error?.message);
}

console.log(`\n✅ Deep research complete for ${SYMBOL}`);
console.log(`   Recommendation: ${report.recommendation}`);
console.log(`   Price Target:   $${report.priceTarget}`);
console.log(`   View at:        https://stock-research-9eee9.web.app/research?symbol=${SYMBOL}`);
