import { NextRequest, NextResponse } from 'next/server';
import { getMarketMetrics, getOptionsChain, getQuote } from '@/lib/tastytrade';
import { runChecklist, Strategy } from '@/lib/screener';
import { getValidAccessToken } from '@/lib/tokenStore';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { bps = [], bcs = [], ic = [] } = body as {
      bps: string[];
      bcs: string[];
      ic: string[];
    };

<<<<<<< HEAD
    const allSymbols = Array.from(new Set([...bps, ...bcs, ...ic]));
=======
const allSymbols = Array.from(new Set([...bps, ...bcs, ...ic]));
>>>>>>> 8cb94166b25c713fc7aa9a2b81b29ea85c490227
    if (allSymbols.length === 0) {
      return NextResponse.json({ error: 'No symbols provided' }, { status: 400 });
    }

    const token = await getValidAccessToken();

    const metricsArray = await getMarketMetrics(allSymbols, token);
    const metricsMap = Object.fromEntries(metricsArray.map(m => [m.symbol, m]));

    const results = [];

    const buckets: Array<{ symbols: string[]; strategy: Strategy }> = [
      { symbols: bps, strategy: 'BPS' },
      { symbols: bcs, strategy: 'BCS' },
      { symbols: ic, strategy: 'IC' },
    ];

    for (const { symbols, strategy } of buckets) {
      for (const symbol of symbols) {
        try {
          const metrics = metricsMap[symbol] || {
            symbol,
            ivRank: null,
            impliedVolatility: null,
            earningsExpectedDate: null,
          };

          const [chainData, quote] = await Promise.all([
            getOptionsChain(symbol, token),
            getQuote(symbol, token),
          ]);

          const price = quote.last ?? (quote.bid && quote.ask ? (quote.bid + quote.ask) / 2 : null);
          const result = runChecklist(symbol, strategy, metrics, chainData, price);
          results.push(result);
        } catch (symbolErr: any) {
          results.push({
            symbol,
            strategy,
            price: null,
            ivr: null,
            qualified: false,
            bestCandidate: null,
            failReasons: [`Error: ${symbolErr.message}`],
            checks: {
              ivr: { status: 'fail', value: 'Error', reason: symbolErr.message },
              earnings: { status: 'pending', value: '—', reason: '—' },
              oi: { status: 'pending', value: '—', reason: '—' },
              delta: { status: 'pending', value: '—', reason: '—' },
              credit: { status: 'pending', value: '—', reason: '—' },
              roc: { status: 'pending', value: '—', reason: '—' },
            },
          });
        }
      }
    }

    results.sort((a, b) => {
      if (a.qualified && !b.qualified) return -1;
      if (!a.qualified && b.qualified) return 1;
      return (b.ivr ?? 0) - (a.ivr ?? 0);
    });

    return NextResponse.json({ results });

  } catch (err: any) {
    console.error('Screen API error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
