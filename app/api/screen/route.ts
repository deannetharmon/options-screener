import { NextRequest, NextResponse } from 'next/server';
import { getMarketMetrics, getOptionsChain } from '@/lib/tastytrade';
import { runChecklist, Trend } from '@/lib/screener';

export async function POST(req: NextRequest) {
  console.log("=== SCREEN API CALLED ===");

  try {
    const body = await req.json();
    const { symbols, token, trends } = body;

    console.log("Received symbols:", symbols);
    console.log("Token length:", token ? token.length : 0);
    console.log("Trends provided:", !!trends);

    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
      console.error("No symbols provided");
      return NextResponse.json({ error: 'symbols array required' }, { status: 400 });
    }
    if (!token) {
      console.error("No token provided");
      return NextResponse.json({ error: 'token required' }, { status: 400 });
    }

    console.log("Fetching market metrics...");
    const metrics = await getMarketMetrics(symbols, token);
    console.log("Market metrics received for", metrics.length, "symbols");

    const metricsMap = Object.fromEntries(metrics.map((m: any) => [m.symbol, m]));

    const results = await Promise.allSettled(
      symbols.map(async (symbol: string) => {
        console.log(`Processing symbol: ${symbol}`);
        try {
          const symbolMetrics = metricsMap[symbol] || { symbol, ivRank: null, impliedVolatility: null, earningsExpectedDate: null };

          console.log(`Fetching chain for ${symbol}...`);
          const chainData = await getOptionsChain(symbol, token);
          console.log(`Chain data received for ${symbol}, expirations:`, chainData.expirations.length);

          const trend: Trend = trends?.[symbol] || null;
          const result = runChecklist(symbol, symbolMetrics, chainData, trend, null);
          console.log(`runChecklist complete for ${symbol} | Qualified: ${result.qualified}`);
          return result;
        } catch (err: any) {
          console.error(`Error processing ${symbol}:`, err.message);
          throw err;
        }
      })
    );

    const screenResults = results.map((r, i) => r.status === 'fulfilled' ? r.value : {
      symbol: symbols[i],
      price: null,
      checks: { ivr: {status:'fail' as const, value:'Error', reason:'Promise failed'}, ...{} as any },
      qualified: false,
      bestCandidate: null,
      failReasons: ['Promise failed'],
      strategy: 'UNKNOWN' as const,
    });

    console.log("=== SCREEN COMPLETE, returning", screenResults.length, "results ===");
    return NextResponse.json({ results: screenResults });

  } catch (err: any) {
    console.error("CRITICAL ERROR in screen route:", err.message);
    console.error(err.stack);
    return NextResponse.json({ error: err.message || 'Screening failed' }, { status: 500 });
  }
}
