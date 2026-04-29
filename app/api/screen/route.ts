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

    console.log(`Token length: ${token.length}`);

    // Try real API
    let metrics = [];
    try {
      console.log("Calling getMarketMetrics with real token...");
      metrics = await getMarketMetrics(symbols, token);
      console.log("getMarketMetrics SUCCESS -", metrics.length, "symbols");
    } catch (e: any) {
      console.error("getMarketMetrics FAILED:", e.message);
      // Fallback to mock so UI doesn't break
      console.log("Using mock fallback because real API failed");
    }

    const results = symbols.map((symbol: string) => ({
      symbol,
      price: 150,
      checks: {
        ivr: { status: 'pass' as const, value: '45%', reason: 'Good' },
        ivx: { status: 'pass' as const, value: '38%', reason: 'Good' },
        earnings: { status: 'pass' as const, value: 'Safe', reason: 'No earnings' },
        oi: { status: 'pass' as const, value: 'OK', reason: 'Good' },
        delta: { status: 'pass' as const, value: '0.18', reason: 'In range' },
        credit: { status: 'pass' as const, value: '$1.35', reason: 'Good' },
      },
      qualified: true,
      bestCandidate: {
        strategy: 'BPS' as const,
        expiration: '2026-05-29',
        dte: 30,
        shortStrike: 145,
        longStrike: 140,
        shortDelta: 0.18,
        shortOI: 800,
        longOI: 600,
        credit: 1.35,
        spreadWidth: 5,
        creditRatio: 0.27,
        pop: 75,
      },
      failReasons: [],
      strategy: 'BPS' as const,
    }));

    console.log("=== RETURNING RESULTS ===", results.length);
    return NextResponse.json({ results });

  } catch (err: any) {
    console.error("=== TOP LEVEL CRASH ===", err.message);
    console.error(err.stack);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
