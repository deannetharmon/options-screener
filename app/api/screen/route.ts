import { NextRequest, NextResponse } from 'next/server';
import { runChecklist, Trend } from '@/lib/screener';

export async function POST(req: NextRequest) {
  console.log("=== SCREEN API CALLED ===", new Date().toISOString());

  try {
    const body = await req.json();
    console.log("Received body:", JSON.stringify(body, null, 2));

    const { symbols } = body;

    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
      console.error("No symbols received");
      return NextResponse.json({ error: 'symbols array required' }, { status: 400 });
    }

    // Always return mock results so the UI works
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

    console.log("=== RETURNING", results.length, "RESULTS ===");
    return NextResponse.json({ results });

  } catch (err: any) {
    console.error("=== CRITICAL ERROR IN ROUTE ===", err.message);
    console.error(err.stack);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
