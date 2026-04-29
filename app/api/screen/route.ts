import { NextRequest, NextResponse } from 'next/server';
import { getMarketMetrics, getOptionsChain } from '@/lib/tastytrade';
import { runChecklist, Trend } from '@/lib/screener';

export async function POST(req: NextRequest) {
  console.log("=== SCREEN API CALLED ===", new Date().toISOString());

  try {
    const body = await req.json();
    console.log("Full body received:", JSON.stringify(body, null, 2));

    const { symbols, token, trends } = body;

    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
      console.error("No symbols");
      return NextResponse.json({ error: 'symbols array required' }, { status: 400 });
    }
    if (!token) {
      console.error("No token");
      return NextResponse.json({ error: 'token required' }, { status: 400 });
    }

    console.log(`Scanning ${symbols.length} symbols with real token (length ${token.length})`);

    // Real API calls
    const metrics = await getMarketMetrics(symbols, token);
    console.log(`getMarketMetrics SUCCESS - ${metrics.length} symbols`);

    const metricsMap = Object.fromEntries(metrics.map((m: any) => [m.symbol, m]));

    const results = await Promise.allSettled(
      symbols.map(async (symbol: string) => {
        console.log(`Processing ${symbol}`);
        const symbolMetrics = metricsMap[symbol] || { symbol, ivRank: null, impliedVolatility: null, earningsExpectedDate: null };

        const chainData = await getOptionsChain(symbol, token);
        console.log(`Chain fetched for ${symbol}`);

        const trend: Trend = trends?.[symbol] || null;
        const result = runChecklist(symbol, symbolMetrics, chainData, trend, null);
        console.log(`runChecklist done for ${symbol} | Qualified: ${result.qualified}`);
        return result;
      })
    );

    console.log("=== SCREEN COMPLETE - RETURNING REAL RESULTS ===");
    return NextResponse.json({ results: results.map(r => r.status === 'fulfilled' ? r.value : r.reason) });

  } catch (err: any) {
    console.error("=== CRITICAL ERROR ===", err.message);
    console.error(err.stack);
    return NextResponse.json({ error: err.message || 'Screening failed' }, { status: 500 });
  }
}
