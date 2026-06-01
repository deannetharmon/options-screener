import { NextRequest, NextResponse } from 'next/server';

// Proxy for Yahoo Finance market data — VIX, ES=F, SPX, VIX3M, etc.
// Called client-side as: GET /api/market?symbol=^VIX&range=2d&interval=1d
// Runs server-side so CORS is not an issue.
// Returns raw Yahoo Finance chart JSON so callers can extract whatever fields they need.

export async function GET(req: NextRequest) {
  const symbol   = req.nextUrl.searchParams.get('symbol');
  const range    = req.nextUrl.searchParams.get('range')    ?? '2d';
  const interval = req.nextUrl.searchParams.get('interval') ?? '1d';
  const includePrePost = req.nextUrl.searchParams.get('includePrePost') ?? 'false';

  if (!symbol) {
    return NextResponse.json({ error: 'symbol param required' }, { status: 400 });
  }

  // Whitelist allowed symbols to prevent abuse
  const ALLOWED_PREFIXES = ['^', 'ES', 'NQ', 'SPY', 'QQQ', 'IWM', 'GLD', 'TLT'];
  const symbolUpper = symbol.toUpperCase();
  const isAllowed = ALLOWED_PREFIXES.some(p => symbolUpper.startsWith(p));
  if (!isAllowed) {
    return NextResponse.json({ error: 'Symbol not permitted' }, { status: 403 });
  }

  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set('interval', interval);
  url.searchParams.set('range', range);
  if (includePrePost === 'true') url.searchParams.set('includePrePost', 'true');

  try {
    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; options-screener/1.0)',
        'Accept': 'application/json',
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Yahoo Finance returned ${res.status}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? 'Unknown error' },
      { status: 500 }
    );
  }
}
