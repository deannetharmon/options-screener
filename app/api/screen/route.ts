import { NextRequest, NextResponse } from 'next/server';
import { getMarketMetrics, getOptionsChain } from '@/lib/tastytrade';
import { runChecklist, Trend } from '@/lib/screener';

export async function POST(req: NextRequest) {
  console.log("=== SCREEN API CALLED ===", new Date().toISOString());

  try {
    const body = await req.json();
    console.log("Body received:", JSON.stringify(body, null, 2));

    const { symbols, token, trends } = body;

    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
      console.error("No symbols");
      return NextResponse.json({ error: 'symbols array required' }, { status: 400 });
    }
    if (!token) {
      console.error("No token");
      return NextResponse.json({ error: 'token required' }, { status: 400 });
    }

    console.log(`Scanning ${symbols.length} symbols with token length ${token.length}`);

    // Try market metrics
    let metrics = [];
    try {
      metrics = await getMarketMetrics(symbols, token);
      console.log(`Market metrics success: ${metrics.length} items`);
    } catch (e: any) {
      console.error("getMarketMetrics FAILED:", e.message);
      return NextResponse.json({ error: `Market metrics failed: ${e.message}` }, { status: 500 });
    }

    const metricsMap = Object.fromEntries(metrics.map((m: any) => [m.symbol, m]));

    const results = await Promise.allSettled(
      symbols.map(async (symbol: string) => {
        console.log(`Starting ${symbol}`);
        try {
          const symbolMetrics = metricsMap[symbol] || { symbol, ivRank: null, impliedVolatility: null, earningsExpectedDate: null };

          const chainData = await getOptionsChain(symbol, token);
          console.log(`Chain fetched for ${symbol}`);

          const trend: Trend = trends?.[symbol] || null;
          const result = runChecklist(symbol, symbolMetrics, chainData, trend, null);
          console.log(`Checklist done for ${symbol} | Qualified: ${result.qualified}`);
          return result;
        } catch (err: any) {
          console.error(`Failed on ${symbol}:`, err.message);
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

    console.log("=== SCREEN FINISHED SUCCESSFULLY ===");
    return NextResponse.json({ results: results.map(r => r.status === 'fulfilled' ? r.value : r.reason) });

  } catch (err: any) {
    console.error("=== CRITICAL TOP-LEVEL ERROR ===", err.message);
    console.error(err.stack);
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 });
  }
}
