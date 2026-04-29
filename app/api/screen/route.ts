import { NextRequest, NextResponse } from 'next/server';
import { getMarketMetrics, getOptionsChain } from '@/lib/tastytrade';
import { runChecklist, Trend } from '@/lib/screener';

export async function POST(req: NextRequest) {
  console.log("=== SCREEN API CALLED AT", new Date().toISOString(), "===");

  try {
    const body = await req.json();
    console.log("Request body received:", JSON.stringify(body, null, 2));

    const { symbols, token, trends } = body;

    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
      console.error("ERROR: No symbols");
      return NextResponse.json({ error: 'symbols array required' }, { status: 400 });
    }
    if (!token) {
      console.error("ERROR: No token");
      return NextResponse.json({ error: 'token required' }, { status: 400 });
    }

    console.log(`Starting real scan for symbols: ${symbols.join(', ')}`);
    console.log(`Token length: ${token.length}`);

    // Market Metrics
    console.log("Calling getMarketMetrics...");
    const metrics = await getMarketMetrics(symbols, token);
    console.log(`getMarketMetrics succeeded. Received ${metrics.length} items`);

    const metricsMap = Object.fromEntries(metrics.map((m: any) => [m.symbol, m]));

    // Run checklist for each
    const results = await Promise.allSettled(
      symbols.map(async (symbol: string) => {
        console.log(`--- Processing ${symbol} ---`);
        try {
          const symbolMetrics = metricsMap[symbol] || { symbol, ivRank: null, impliedVolatility: null, earningsExpectedDate: null };

          console.log(`Calling getOptionsChain for ${symbol}...`);
          const chainData = await getOptionsChain(symbol, token);
          console.log(`getOptionsChain succeeded for ${symbol}. Expirations: ${chainData.expirations.length}`);

          const trend: Trend = trends?.[symbol] || null;
          const result = runChecklist(symbol, symbolMetrics, chainData, trend, null);
          console.log(`runChecklist finished for ${symbol}. Qualified: ${result.qualified}`);
          return result;
        } catch (err: any) {
          console.error(`CRITICAL ERROR on ${symbol}:`, err.message);
          return {
            symbol,
            price: null,
            checks: {
              ivr: { status: 'fail' as const, value: 'Error', reason: err.message },
              ivx: { status: 'fail' as const, value: 'Error', reason: '' },
              earnings: { status: 'fail' as const, value: 'Error', reason: '' },
              oi: { status: 'fail' as const, value: 'Error', reason: '' },
              delta: { status: 'fail' as const, value: 'Error', reason: '' },
              credit: { status: 'fail' as const, value: 'Error', reason: '' },
            },
            qualified: false,
            bestCandidate: null,
            failReasons: [err.message],
            strategy: 'UNKNOWN' as const,
          };
        }
      })
    );

    console.log("=== ALL DONE. Returning", results.length, "results ===");
    return NextResponse.json({ results: results.map(r => r.status === 'fulfilled' ? r.value : r.reason) });

  } catch (err: any) {
    console.error("=== TOP LEVEL ERROR IN ROUTE ===", err.message);
    console.error(err.stack);
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 });
  }
}
