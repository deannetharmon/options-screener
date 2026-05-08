import { NextRequest, NextResponse } from 'next/server';

// Proxy for Yahoo Finance daily OHLCV data.
// Called client-side as: GET /api/chart?symbol=AAPL
// Runs server-side so CORS is not an issue.
// No API key required — Yahoo Finance is free and public.

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get('symbol');
  if (!symbol) {
    return NextResponse.json({ error: 'symbol param required' }, { status: 400 });
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=6mo`;

  try {
    const res = await fetch(url, {
      headers: {
        // Yahoo requires a browser-like User-Agent or it returns 401/429
        'User-Agent': 'Mozilla/5.0 (compatible; options-screener/1.0)',
        'Accept': 'application/json',
      },
      // Next.js: don't cache — always fetch fresh market data
      cache: 'no-store',
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Yahoo Finance returned ${res.status}` },
        { status: res.status }
      );
    }

    const data = await res.json();

    // Parse Yahoo's response into flat OHLCV arrays matching our bar format
    const result = data?.chart?.result?.[0];
    if (!result) {
      return NextResponse.json({ error: 'No data returned' }, { status: 404 });
    }

    const timestamps: number[]    = result.timestamp ?? [];
    const quote                   = result.indicators?.quote?.[0] ?? {};
    const opens:  (number|null)[] = quote.open   ?? [];
    const highs:  (number|null)[] = quote.high   ?? [];
    const lows:   (number|null)[] = quote.low    ?? [];
    const closes: (number|null)[] = quote.close  ?? [];

    // Filter out any bars where any OHLC value is null (Yahoo sometimes returns nulls
    // for weekends/holidays that slipped through)
    const bars: { t: number; o: number; h: number; l: number; c: number }[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = opens[i], h = highs[i], l = lows[i], c = closes[i];
      if (o != null && h != null && l != null && c != null) {
        bars.push({ t: timestamps[i], o, h, l, c });
      }
    }

    return NextResponse.json({ bars });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? 'Unknown error fetching chart data' },
      { status: 500 }
    );
  }
}
