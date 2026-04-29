import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { symbols } = await req.json();

    const results = symbols.map((symbol: string) => ({
      symbol,
      price: 150,
      checks: {
        ivr: { status: 'pass', value: '45%', reason: 'Good' },
        ivx: { status: 'pass', value: '38%', reason: 'Good' },
        earnings: { status: 'pass', value: 'Safe', reason: 'No earnings' },
        oi: { status: 'pass', value: 'OK', reason: 'Good' },
        delta: { status: 'pass', value: '0.18', reason: 'In range' },
        credit: { status: 'pass', value: '$1.35', reason: 'Good' },
      },
      qualified: true,
      bestCandidate: {
        strategy: 'BPS',
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
      strategy: 'BPS',
    }));

    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
