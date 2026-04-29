import { NextRequest, NextResponse } from 'next/server';
import { getMarketMetrics, getOptionsChain } from '@/lib/tastytrade';
import { runChecklist, Trend } from '@/lib/screener';

export async function POST(req: NextRequest) {
  try {
    const { symbols, token, trends } = await req.json();

    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
      return NextResponse.json({ error: 'symbols array required' }, { status: 400 });
    }

    // MOCK MODE DETECTION
    const isMock = token === 'mock-token-for-testing';

    let results: any[] = [];

    if (isMock) {
      // Return realistic mock results for testing
      results = symbols.map((symbol: string) => ({
        symbol,
        price: 120 + Math.random() * 100,
        checks: {
          ivr: { status: 'pass' as const, value: '42%', reason: 'Good' },
          ivx: { status: 'pass' as const, value: '38%', reason: 'Good' },
          earnings: { status: 'pass' as const, value: 'Safe', reason: 'No earnings' },
          oi: { status: 'pass' as const, value: '1200/800', reason: 'OK' },
          delta: { status: 'pass' as const, value: '0.18', reason: 'In range' },
          credit: { status: 'pass' as const, value: '$1.45', reason: '38% of width' },
        },
        qualified: true,
        bestCandidate: {
          strategy: Math.random() > 0.5 ? 'BPS' : 'BCS' as const,
          expiration: '2026-05-29',
          dte: 30,
          shortStrike: 115,
          longStrike: 110,
          shortDelta: 0.18,
          shortOI: 1200,
          longOI: 800,
          credit: 1.45,
          spreadWidth: 5,
          creditRatio: 0.29,
          pop: 72,
        },
        failReasons: [],
        strategy: Math.random() > 0.5 ? 'BPS' : 'BCS' as const,
      }));
    } else {
      // Real TastyTrade path
      const metrics = await getMarketMetrics(symbols, token);
      const metricsMap = Object.fromEntries(metrics.map((m: any) => [m.symbol, m]));

      const apiResults = await Promise.allSettled(
        symbols.map(async (symbol: string) => {
          const symbolMetrics = metricsMap[symbol] || { symbol, ivRank: null, impliedVolatility: null, earningsExpectedDate: null };
          const chainData = await getOptionsChain(symbol, token);
          const trend: Trend = trends?.[symbol] || null;
          return runChecklist(symbol, symbolMetrics, chainData, trend, null);
        })
      );

      results = apiResults.map((r, i) => r.status === 'fulfilled' ? r.value : {
        symbol: symbols[i],
        price: null,
        checks: { ivr: {status:'fail' as const, value:'Error', reason:'API'}, ...{} as any },
        qualified: false,
        bestCandidate: null,
        failReasons: ['API error'],
        strategy: 'UNKNOWN' as const,
      });
    }

    return NextResponse.json({ results });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err.message || 'Screening failed' }, { status: 500 });
  }
}
