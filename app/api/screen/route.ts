import { NextRequest, NextResponse } from 'next/server';
import { getMarketMetrics, getOptionsChain } from '@/lib/tastytrade';
import { runChecklist } from '@/lib/screener';

export async function POST(req: NextRequest) {
  try {
    const { symbols, token, trends } = await req.json();

    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
      return NextResponse.json({ error: 'symbols array required' }, { status: 400 });
    }
    if (!token) {
      return NextResponse.json({ error: 'token required' }, { status: 400 });
    }

    // Fetch market metrics for all symbols in one call
    const metrics = await getMarketMetrics(symbols, token);
    const metricsMap = Object.fromEntries(metrics.map((m) => [m.symbol, m]));

    // Fetch chains and run checklist for each symbol
    const results = await Promise.allSettled(
      symbols.map(async (symbol: string) => {
        const symbolMetrics = metricsMap[symbol] || {
          symbol,
          ivRank: null,
          impliedVolatility: null,
          earningsExpectedDate: null,
        };

        const chainData = await getOptionsChain(symbol, token);
        const trend = trends?.[symbol] || null;

        return runChecklist(symbol, symbolMetrics, chainData, trend, null);
      })
    );

    const screenResults = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return {
        symbol: symbols[i],
        price: null,
        checks: {
          ivr: { status: 'fail', value: 'Error', reason: r.reason?.message || 'Failed to fetch' },
          ivx: { status: 'fail', value: 'Error', reason: '' },
          earnings: { status: 'fail', value: 'Error', reason: '' },
          oi: { status: 'fail', value: 'Error', reason: '' },
          delta: { status: 'fail', value: 'Error', reason: '' },
          credit: { status: 'fail', value: 'Error', reason: '' },
        },
        qualified: false,
        bestCandidate: null,
        failReasons: [r.reason?.message || 'API error'],
        strategy: 'UNKNOWN',
      };
    });

    return NextResponse.json({ results: screenResults });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Screening failed' }, { status: 500 });
  }
}
