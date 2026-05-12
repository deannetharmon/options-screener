import { NextRequest, NextResponse } from 'next/server';

const BASE = 'https://api.tastytrade.com';

async function ttFetch(path: string, token: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: token },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function POST(req: NextRequest) {
  try {
    const { accessToken } = await req.json();
    if (!accessToken) return NextResponse.json({ error: 'No access token provided' }, { status: 401 });

    const accountsData = await ttFetch('/customers/me/accounts', accessToken);
    const accounts = accountsData?.data?.items ?? [];
    if (accounts.length === 0) return NextResponse.json({ error: 'No accounts found' }, { status: 404 });

    const accountNumber = accounts[0]?.account?.['account-number'];
    if (!accountNumber) return NextResponse.json({ error: 'Could not read account number' }, { status: 500 });

    const positionsData = await ttFetch(`/accounts/${accountNumber}/positions`, accessToken);
    const rawPositions = positionsData?.data?.items ?? [];

    const optionPositions = rawPositions.filter((p: any) =>
      p['instrument-type'] === 'Equity Option' || p['instrument-type'] === 'Index Option'
    );

    const groups: Record<string, any[]> = {};
    for (const pos of optionPositions) {
      const symbol = pos['underlying-symbol'];
      const expDate = pos['expires-at']?.slice(0, 10) ?? 'unknown';
      const key = `${symbol}::${expDate}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(pos);
    }

    const allOptionSymbols = optionPositions.map((p: any) => p.symbol).filter(Boolean);
    const currentPrices: Record<string, number> = {};
    if (allOptionSymbols.length > 0) {
      try {
        for (let i = 0; i < allOptionSymbols.length; i += 50) {
          const chunk = allOptionSymbols.slice(i, i + 50);
          const qs = chunk.map((s: string) => `equity-option=${encodeURIComponent(s)}`).join('&');
          const priceData = await ttFetch(`/market-data/by-type?${qs}`, accessToken);
          for (const item of priceData?.data?.items ?? []) {
            const bid = parseFloat(item.bid ?? '0');
            const ask = parseFloat(item.ask ?? '0');
            currentPrices[item.symbol] = (bid + ask) / 2;
          }
        }
      } catch { /* prices optional */ }
    }

    const today = new Date();
    const positions = Object.entries(groups).map(([key, legs]) => {
      const [symbol, expDate] = key.split('::');
      const dte = Math.round((new Date(expDate).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

      const putLegs  = legs.filter((l: any) => l['option-type'] === 'P');
      const callLegs = legs.filter((l: any) => l['option-type'] === 'C');
      let strategy = 'UNKNOWN';
      if      (putLegs.length >= 2 && callLegs.length === 0) strategy = 'BPS';
      else if (callLegs.length >= 2 && putLegs.length === 0) strategy = 'BCS';
      else if (putLegs.length >= 2 && callLegs.length >= 2)  strategy = 'IC';
      else if (putLegs.length === 1 && callLegs.length === 0) strategy = 'PUT';
      else if (callLegs.length === 1 && putLegs.length === 0) strategy = 'CALL';

      let creditReceived = 0;
      for (const leg of legs) {
        const qty = parseInt(leg['quantity'] ?? '1', 10);
        const avgPrice = parseFloat(leg['average-open-price'] ?? '0');
        creditReceived += leg['quantity-direction'] === 'Short' ? avgPrice * qty : -(avgPrice * qty);
      }
      creditReceived = creditReceived * 100;

      let currentValue = 0;
      let hasCurrentPrices = true;
      for (const leg of legs) {
        const qty = parseInt(leg['quantity'] ?? '1', 10);
        const price = currentPrices[leg.symbol];
        if (price == null) { hasCurrentPrices = false; break; }
        currentValue += leg['quantity-direction'] === 'Short' ? price * qty : -(price * qty);
      }
      currentValue = currentValue * 100;

      const pnl = hasCurrentPrices ? creditReceived + currentValue : null;
      const pnlPct = creditReceived !== 0 && pnl != null ? (pnl / Math.abs(creditReceived)) * 100 : null;
      const targetPrice = Math.abs(creditReceived) * 0.5;
      const hitTarget = hasCurrentPrices && pnl != null && pnl >= Math.abs(creditReceived) * 0.5;

      return {
        key, symbol, expDate, dte, strategy,
        legs: legs.map((l: any) => ({
          symbol: l.symbol,
          optionType: l['option-type'],
          strikePrice: parseFloat(l['strike-price'] ?? '0'),
          direction: l['quantity-direction'],
          quantity: parseInt(l['quantity'] ?? '1', 10),
          avgOpenPrice: parseFloat(l['average-open-price'] ?? '0'),
          currentPrice: currentPrices[l.symbol] ?? null,
        })),
        creditReceived: Math.abs(creditReceived),
        currentValue: hasCurrentPrices ? Math.abs(currentValue) : null,
        pnl, pnlPct, targetPrice, hitTarget,
        needsClose: dte <= 21,
        accountNumber,
      };
    });

    positions.sort((a, b) => {
      if (a.needsClose && !b.needsClose) return -1;
      if (!a.needsClose && b.needsClose) return 1;
      return a.dte - b.dte;
    });

    return NextResponse.json({ positions, accountNumber });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
