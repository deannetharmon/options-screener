import { NextRequest, NextResponse } from 'next/server';
import { getMarketMetrics, getOptionsChain } from '@/lib/tastytrade';
import { runChecklist, Trend } from '@/lib/screener';

export async function POST(req: NextRequest) {
  try {
    const { symbols, token, trends } = await req.json();

    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
      return NextResponse.json({ error: 'symbols array required' }, { status: 400 });
    }
    if (!token) {
      return NextResponse.json({ error: 'token required' }, { status: 400 });
    }

    console.log(`[SCREEN] Starting real scan for: ${symbols.join(', ')}`);

    const metrics = await getMarketMetrics(symbols, token);
    console.log(`[SCREEN] Got metrics for ${metrics.length} symbols`);

    const metricsMap = Object.fromEntries(metrics.map((m: any) => [m.symbol, m]));

    const results = await Promise.allSettled(
      symbols.map(async (symbol: string) => {
        try {
          const symbolMetrics = metricsMap[symbol] || { symbol, ivRank: null, impliedVolatility: null, earningsExpectedDate: null };
          const chainData = await getOptionsChain(symbol, token);
          const trend: Trend = trends?.[symbol] || null;
          return runChecklist(symbol, symbolMetrics, chainData, trend, null);
        } catch (err: any) {
          console.error(`[SCREEN] Error on ${symbol}:`, err.message);
          throw err;
        }
      })
    );

    const screenResults = results.map((r, i) => 
      r.status === 'fulfilled' ? r.value : {
        symbol: symbols[i],
        price: null,
        checks: { ivr: {status:'fail' as const, value:'Error', reason:'Failed'}, ivx:{status:'fail' as const, value:'Error', reason:''}, earnings:{status:'fail' as const, value:'Error', reason:''}, oi:{status:'fail' as const, value:'Error', reason:''}, delta:{status:'fail' as const, value:'Error', reason:''}, credit:{status:'fail' as const, value:'Error', reason:''} },
        qualified: false,
        bestCandidate: null,
        failReasons: ['Failed'],
        strategy: 'UNKNOWN' as const,
      }
    );

    return NextResponse.json({ results: screenResults });
  } catch (err: any) {
    console.error('[SCREEN] Critical error:', err);
    return NextResponse.json({ error: err.message || 'Screening failed' }, { status: 500 });
  }
}
