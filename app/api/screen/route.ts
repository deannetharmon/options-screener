import { NextRequest, NextResponse } from 'next/server';
import { getMarketMetrics, getOptionsChain } from '@/lib/tastytrade';
import { runChecklist, Trend } from '@/lib/screener';

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  console.log("=== SCREEN REQUEST STARTED ===");

  try {
    const body = await req.json();
    const { symbols, token, trends } = body;

    console.log(`Symbols: ${symbols}`);
    console.log(`Token length: ${token?.length || 0}`);

    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
      return NextResponse.json({ error: 'symbols array required' }, { status: 400 });
    }
    if (!token) {
      return NextResponse.json({ error: 'token required' }, { status: 400 });
    }

    // Try to fetch market metrics
    let metrics = [];
    try {
      console.log("Fetching market metrics...");
      metrics = await getMarketMetrics(symbols, token);
      console.log(`Received metrics for ${metrics.length} symbols`);
    } catch (e: any) {
      console.error("Market metrics failed:", e.message);
      return NextResponse.json({ error: `Market metrics failed: ${e.message}` }, { status: 500 });
    }

    const metricsMap = Object.fromEntries(metrics.map((m: any) => [m.symbol, m]));

    const results = await Promise.allSettled(
      symbols.map(async (symbol: string) => {
        try {
          console.log(`Processing ${symbol}...`);
          const symbolMetrics = metricsMap[symbol] || { symbol, ivRank: null, impliedVolatility: null, earningsExpectedDate: null };

          const chainData = await getOptionsChain(symbol, token);
          console.log(`Chain data received for ${symbol}`);

          const trend: Trend = trends?.[symbol] || null;
          const result = runChecklist(symbol, symbolMetrics, chainData, trend, null);
          console.log(`Checklist complete for ${symbol}: qualified=${result.qualified}`);
          return result;
        } catch (err: any) {
          console.error(`Error on ${symbol}:`, err.message);
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

    const screenResults = results.map((r, i) => r.status === 'fulfilled' ? r.value : { symbol: symbols[i], ...{} as any });

    console.log(`=== SCREEN COMPLETE in ${Date.now() - startTime}ms ===`);
    return NextResponse.json({ results: screenResults });

  } catch (err: any) {
    console.error("CRITICAL SCREEN ERROR:", err);
    return NextResponse.json({ 
      error: err.message || 'Unknown error',
      stack: err.stack 
    }, { status: 500 });
  }
}
