// app/api/positions/route.ts
import { NextResponse } from 'next/server';
import { getSessionToken, ttFetch } from '@/lib/tokenStore';

export async function GET() {
  try {
    const token = await getSessionToken();

    const accountsData = await ttFetch('/customers/me/accounts', token);
    const accounts = accountsData?.data?.items ?? [];
    if (accounts.length === 0) return NextResponse.json({ error: 'No accounts found' }, { status: 404 });

    const accountNumber = accounts[0]?.account?.['account-number'];
    if (!accountNumber) return NextResponse.json({ error: 'Could not read account number' }, { status: 500 });

    const positionsData = await ttFetch(`/accounts/${accountNumber}/positions`, token);
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

    // ── Fetch current option prices ───────────────────────────────────────
    const allOptionSymbols = optionPositions.map((p: any) => p.symbol).filter(Boolean);
    const currentPrices: Record<string, number> = {};
    if (allOptionSymbols.length > 0) {
      try {
        for (let i = 0; i < allOptionSymbols.length; i += 50) {
          const chunk = allOptionSymbols.slice(i, i + 50);
          const qs = chunk.map((s: string) => `equity-option=${encodeURIComponent(s)}`).join('&');
          const priceData = await ttFetch(`/market-data/by-type?${qs}`, token);
          for (const item of priceData?.data?.items ?? []) {
            const bid = parseFloat(item.bid ?? '0');
            const ask = parseFloat(item.ask ?? '0');
            currentPrices[item.symbol] = (bid + ask) / 2;
          }
        }
      } catch { /* prices optional */ }
    }

    // ── Fetch IVR from /market-metrics ────────────────────────────────────
    const ivrMap: Record<string, number | null> = {};
    try {
      const underlyingSymbols: string[] = (optionPositions as any[])
        .map((p: any) => String(p['underlying-symbol']))
        .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
      const qs = underlyingSymbols.map((s) => `symbols[]=${encodeURIComponent(s)}`).join('&');
      const metricsData = await ttFetch(`/market-metrics?${qs}`, token);
      for (const item of metricsData?.data?.items ?? []) {
        const raw = item['implied-volatility-index-rank'] ?? item['iv-rank'] ?? null;
        const parsed = raw != null ? parseFloat(String(raw)) : NaN;
        if (!isNaN(parsed)) {
          ivrMap[item['symbol']] = parsed <= 1 ? Math.round(parsed * 100) : Math.round(parsed);
        }
      }
    } catch { /* IVR optional */ }

    // ── Fetch working (GTC) orders ────────────────────────────────────────
    const gtcSymbols = new Set<string>();
    try {
      const ordersData = await ttFetch(`/accounts/${accountNumber}/orders/live`, token);
      for (const order of ordersData?.data?.items ?? []) {
        if (order.status === 'Live' || order.status === 'Working') {
          for (const leg of order.legs ?? []) {
            const sym = leg['underlying-symbol'] ?? leg.symbol ?? '';
            if (sym) gtcSymbols.add(sym.split(' ')[0].trim());
          }
        }
      }
    } catch { /* GTC check optional */ }

    // ── Fetch P/L Open from positions+marks ──────────────────────────────
    const plBySymbol: Record<string, number> = {};
    try {
      const plData = await ttFetch(`/accounts/${accountNumber}/positions?include-marks=true`, token);
      for (const item of plData?.data?.items ?? []) {
        const sym = item['underlying-symbol'];
        if (!sym) continue;
        const qty = parseFloat(item['quantity'] ?? '1');
        const multiplier = parseFloat(item['multiplier'] ?? '100');
        const avgOpen = parseFloat(item['average-open-price'] ?? '0');
        const mark = parseFloat(item['mark-price'] ?? '0');
        const dir = item['quantity-direction'] === 'Short' ? -1 : 1;
        plBySymbol[sym] = (plBySymbol[sym] ?? 0) + dir * (mark - avgOpen) * qty * multiplier;
      }
    } catch { /* plOpen optional */ }

    // ── Build position objects ────────────────────────────────────────────
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

      const pnl = hasCurrentPrices ? Math.abs(creditReceived) - Math.abs(currentValue) : null;
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
        ivr: ivrMap[symbol] ?? null,
        hasGtc: gtcSymbols.has(symbol),
        plOpen: plBySymbol[symbol] != null ? Math.round(plBySymbol[symbol] * 100) / 100 : null,
      };
    });

    positions.sort((a, b) => {
      if (a.needsClose && !b.needsClose) return -1;
      if (!a.needsClose && b.needsClose) return 1;
      return a.dte - b.dte;
    });

    return NextResponse.json({ positions, accountNumber });
  } catch (e: any) {
    const status = e.message.includes('Not authenticated') ? 401 : 500;
    return NextResponse.json({ error: e.message }, { status });
  }
}
