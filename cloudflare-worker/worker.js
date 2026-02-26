// Yahoo Finance proxy — handles crumb/cookie auth server-side
// Deploy on Cloudflare Workers (free tier)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
    const type = url.searchParams.get('type') || 'chart';

    if (!symbol) {
      return new Response(JSON.stringify({ error: 'symbol required' }), { status: 400, headers: CORS });
    }

    try {
      // 1. Get Yahoo Finance session cookie
      const cookieRes = await fetch('https://fc.yahoo.com', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      const cookie = cookieRes.headers.get('set-cookie') || '';

      // 2. Get crumb
      const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookie },
      });
      const crumb = await crumbRes.text();

      const yfHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookie,
      };
      const crumbParam = `&crumb=${encodeURIComponent(crumb)}`;

      // 3. Fetch requested data
      let dataUrl;
      if (type === 'chart') {
        dataUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y${crumbParam}`;
      } else if (type === 'summary') {
        const modules = 'defaultKeyStatistics,financialData,summaryDetail,assetProfile,recommendationTrend,upgradeDowngradeHistory,earningsHistory,calendarEvents,majorHoldersBreakdown';
        dataUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=${modules}${crumbParam}`;
      } else {
        return new Response(JSON.stringify({ error: 'unknown type' }), { status: 400, headers: CORS });
      }

      const dataRes = await fetch(dataUrl, { headers: yfHeaders });
      const data = await dataRes.json();

      return new Response(JSON.stringify(data), { headers: CORS });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
    }
  },
};
