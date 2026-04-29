// app/api/screen/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getMarketMetrics, getOptionsChain } from '@/lib/tastytrade';
import { runChecklist } from '@/lib/screener';

export async function POST(req: NextRequest) {
  try {
    const { symbols, token, trends } = await req.json();
    // ... (rest of your existing code)

    const results = await Promise.allSettled(
      symbols.map(async (symbol: string) => {
        const symbolMetrics = ...; // your existing
        const chainData = await getOptionsChain(symbol, token);
        const trend = trends?.[symbol] || null; // Semi mode
        return runChecklist(symbol, symbolMetrics, chainData, trend, null);
      })
    );

    // ... return results
  } catch (err) { ... }
}
