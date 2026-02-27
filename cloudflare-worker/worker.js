// Stock Research Worker — Yahoo Finance proxy + Claude narrative
// Secrets required: ANTHROPIC_API_KEY (set via wrangler secret put ANTHROPIC_API_KEY)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

async function getYahooData(symbol, type) {
  const cookieRes = await fetch('https://fc.yahoo.com', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  const cookie = cookieRes.headers.get('set-cookie') || '';
  const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookie },
  });
  const crumb = await crumbRes.text();
  const yfHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Cookie': cookie,
  };
  const crumbParam = `&crumb=${encodeURIComponent(crumb)}`;
  let dataUrl;
  if (type === 'chart') {
    dataUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y${crumbParam}`;
  } else if (type === 'summary') {
    const modules = 'defaultKeyStatistics,financialData,summaryDetail,assetProfile,recommendationTrend,upgradeDowngradeHistory,earningsHistory,calendarEvents,majorHoldersBreakdown';
    dataUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=${modules}${crumbParam}`;
  } else {
    throw new Error('unknown type');
  }
  const dataRes = await fetch(dataUrl, { headers: yfHeaders });
  return dataRes.json();
}

async function generateNarrative(symbol, payload, apiKey) {
  const { technical, fundamentals, analystRatings, earnings, ownership } = payload;
  const ar = analystRatings || {};
  const f  = fundamentals || {};
  const ea = earnings || {};
  const ow = ownership || {};

  const prompt = `You are a senior equity research analyst. Analyze ${symbol} and return a concise JSON narrative. Use the actual numbers provided.

## Market Data
- Price: $${technical?.price?.current?.toFixed(2) ?? 'N/A'} (${technical?.price?.changePct > 0 ? '+' : ''}${technical?.price?.changePct?.toFixed(2) ?? 'N/A'}% today)
- 52W Range: $${technical?.yearRange?.low52?.toFixed(2) ?? 'N/A'} – $${technical?.yearRange?.high52?.toFixed(2) ?? 'N/A'} (${technical?.yearRange?.pctFromHigh?.toFixed(1) ?? 'N/A'}% from high)
- Market Cap: ${f.marketCap ? '$' + (f.marketCap / 1e9).toFixed(1) + 'B' : 'N/A'}
- Sector: ${f.sector || 'N/A'} · ${f.industry || 'N/A'}

## Technical Indicators
- RSI (14): ${technical?.rsi?.toFixed(1) ?? 'N/A'} ${technical?.rsi > 70 ? '(overbought)' : technical?.rsi < 30 ? '(oversold)' : '(neutral)'}
- MACD Histogram: ${technical?.macd?.histogram?.toFixed(4) ?? 'N/A'} ${technical?.macd?.histogram > 0 ? '(bullish)' : '(bearish)'}
- vs SMA20: $${technical?.movingAverages?.sma20?.toFixed(2) ?? 'N/A'} | vs SMA50: $${technical?.movingAverages?.sma50?.toFixed(2) ?? 'N/A'}
- Overall Signal: ${technical?.overall ?? 'N/A'}

## Fundamentals
- Trailing P/E: ${f.trailingPE?.toFixed(1) ?? 'N/A'} | Forward P/E: ${f.forwardPE?.toFixed(1) ?? 'N/A'}
- EPS (TTM): ${f.eps != null ? '$' + f.eps.toFixed(2) : 'N/A'} | EPS Fwd: ${f.epsForward != null ? '$' + f.epsForward.toFixed(2) : 'N/A'}
- Revenue: ${f.revenue ? '$' + (f.revenue / 1e9).toFixed(2) + 'B' : 'N/A'} | Growth: ${f.revenueGrowth != null ? (f.revenueGrowth * 100).toFixed(1) + '%' : 'N/A'}
- Gross Margin: ${f.grossMargin != null ? (f.grossMargin * 100).toFixed(1) + '%' : 'N/A'} | Profit Margin: ${f.profitMargin != null ? (f.profitMargin * 100).toFixed(1) + '%' : 'N/A'}
- ROE: ${f.returnOnEquity != null ? (f.returnOnEquity * 100).toFixed(1) + '%' : 'N/A'} | Debt/Equity: ${f.debtToEquity != null ? Number(f.debtToEquity).toFixed(2) : 'N/A'}
- Free Cash Flow: ${f.freeCashflow ? '$' + (f.freeCashflow / 1e9).toFixed(2) + 'B' : 'N/A'}
- Beta: ${f.beta != null ? Number(f.beta).toFixed(2) : 'N/A'}

## Analyst Sentiment
- Consensus: ${ar.consensus ?? 'N/A'} (${ar.numberOfAnalysts ?? 0} analysts)
- Price Target: Low $${ar.targetLow?.toFixed(2) ?? 'N/A'} | Avg $${ar.targetMean?.toFixed(2) ?? 'N/A'} | High $${ar.targetHigh?.toFixed(2) ?? 'N/A'}
- Upside to Target: ${ar.upsidePct != null ? ar.upsidePct.toFixed(1) + '%' : 'N/A'}
- Strong Buy: ${ar.strongBuy ?? 0} | Buy: ${ar.buy ?? 0} | Hold: ${ar.hold ?? 0} | Sell: ${ar.sell ?? 0}
- Short Float: ${ow.shortFloatPct != null ? (ow.shortFloatPct * 100).toFixed(1) + '%' : 'N/A'}
- Next Earnings: ${ea.nextEarningsDate ?? 'N/A'}
- Recent Quarters: ${(ea.quarters ?? []).map(q => `${q.period} ${q.beat} (${q.surprisePct != null ? (q.surprisePct > 0 ? '+' : '') + q.surprisePct.toFixed(1) + '%' : ''})`).join(', ')}

Return ONLY valid JSON, no markdown:
{
  "executiveSummary": "2-3 sentence overview of current position and outlook",
  "investmentThesis": "Paragraph making the bull case with specific numbers",
  "bearCase": "Paragraph on key risks and why thesis could be wrong",
  "catalysts": ["specific catalyst 1", "specific catalyst 2", "specific catalyst 3"],
  "risks": ["specific risk 1", "specific risk 2", "specific risk 3"],
  "technicalOutlook": "1-2 sentences interpreting the technical setup",
  "fundamentalAssessment": "1-2 sentences on valuation and financial health",
  "recommendation": "BUY or HOLD or SELL",
  "recommendationRationale": "1-2 sentence justification",
  "generatedBy": "claude-sonnet-4-6"
}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err.slice(0, 200)}`);
  }

  const json = await res.json();
  const usage = json.usage || {};
  const raw = (json.content?.[0]?.text || '').trim();
  const claudeUsage = {
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    costUsd: (usage.input_tokens || 0) * 0.000003 + (usage.output_tokens || 0) * 0.000015,
    model: 'claude-sonnet-4-6',
    generatedAt: new Date().toISOString(),
  };

  try {
    return { narrative: JSON.parse(raw), claudeUsage };
  } catch {
    const stripped = raw.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
    return { narrative: JSON.parse(stripped), claudeUsage };
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
    const type = url.searchParams.get('type') || 'chart';

    // ── POST /narrative — generate Claude narrative for live symbol ─────────
    if (request.method === 'POST' && type === 'narrative') {
      try {
        if (!env.ANTHROPIC_API_KEY) {
          return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), { status: 500, headers: CORS });
        }
        const body = await request.json();
        const result = await generateNarrative(symbol || body.symbol, body, env.ANTHROPIC_API_KEY);
        return new Response(JSON.stringify(result), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── GET — Yahoo Finance proxy ──────────────────────────────────────────
    if (!symbol) {
      return new Response(JSON.stringify({ error: 'symbol required' }), { status: 400, headers: CORS });
    }

    try {
      const data = await getYahooData(symbol, type);
      return new Response(JSON.stringify(data), { headers: CORS });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
    }
  },
};
