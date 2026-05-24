'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';

// Inject DM Sans font
if (typeof document !== 'undefined') {
  if (!document.getElementById('prosper-font')) {
    const link = document.createElement('link');
    link.id = 'prosper-font';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=DM+Mono:wght@400;500&display=swap';
    document.head.appendChild(link);
  }
}

const BASE = 'https://api.tastytrade.com';
const CLIENT_ID = '4d4c851b-bdaf-4ac9-b39b-811e604739f2';
const LS_PROFIT_TARGETS = 'prosper-profit-targets';

async function getAccessToken(): Promise<string> {
  const cached = sessionStorage.getItem('tt_access_token');
  if (cached) return cached;

  const refreshToken = localStorage.getItem('tt_refresh_token');
  const clientSecret = localStorage.getItem('tt_client_secret') ?? '';
  if (!refreshToken || !clientSecret) { window.location.href = '/login'; throw new Error('Not authenticated'); }

  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID, client_secret: clientSecret }),
  });
  if (!res.ok) {
    // Don't clear the refresh token — may be a temporary server error
    sessionStorage.removeItem('tt_access_token');
    localStorage.removeItem('tt_refresh_token');
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  const data = await res.json();
  const token = data.access_token;
  if (!token) { window.location.href = '/login'; throw new Error('No token'); }
  sessionStorage.setItem('tt_access_token', token);
  // Save rotated refresh token if TastyTrade issued a new one
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    localStorage.setItem('tt_refresh_token', data.refresh_token);
  }
  return token;
}

async function ttFetch(path: string, token: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
  });
  if (res.status === 401) {
    sessionStorage.removeItem('tt_access_token');
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  if (!res.ok) { const text = await res.text(); throw new Error(`${path} failed (${res.status}): ${text.slice(0, 100)}`); }
  return res.json();
}

async function ttPost(path: string, token: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { sessionStorage.removeItem('tt_access_token'); window.location.href = '/login'; throw new Error('Session expired'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? data?.['error-message'] ?? `POST ${path} failed (${res.status})`);
  return data;
}

async function ttDelete(path: string, token: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) { const text = await res.text(); throw new Error(`DELETE ${path} failed (${res.status}): ${text.slice(0, 100)}`); }
  return res.status === 204 ? {} : res.json();
}

// ── OCC Symbol Helpers ─────────────────────────────────────────────────────
// TastyTrade order legs require the OCC symbol in space-padded format
function occToOrderSymbol(symbol: string): string {
  // Strip extra whitespace, re-pad to OCC standard: AAAAAAAAYYMMDDCNNNNNNN
  // TastyTrade accepts the symbol as returned by the positions API (already padded)
  return symbol.trim();
}

// ── Order Builders ─────────────────────────────────────────────────────────
// Returns a TastyTrade order body ready to POST to /accounts/{num}/orders

interface OrderLeg { symbol: string; quantity: number; action: 'Buy to Close' | 'Sell to Open' | 'Buy to Open' | 'Sell to Close'; 'instrument-type': 'Equity Option' | 'Index Option'; }
interface OrderBody {
  'order-type': 'Limit' | 'Market';
  'time-in-force': 'GTC' | 'Day';
  price?: string; // debit = positive (we pay), credit = negative (we receive)
  legs: OrderLeg[];
  source?: string;
}

function buildCloseOrder(pos: Position, limitPrice: number, tif: 'GTC' | 'Day' = 'Day'): OrderBody {
  // Closing a spread = Buy to Close all short legs, Sell to Close all long legs
  const instrType = pos.symbol.startsWith('$') || ['SPX','NDX','RUT','VIX'].includes(pos.symbol) ? 'Index Option' : 'Equity Option';
  const legs: OrderLeg[] = pos.legs.map(leg => ({
    symbol: occToOrderSymbol(leg.symbol),
    quantity: leg.quantity,
    action: leg.direction === 'Short' ? 'Buy to Close' : 'Sell to Close',
    'instrument-type': instrType,
  }));
  return {
    'order-type': 'Limit',
    'time-in-force': tif,
    price: limitPrice.toFixed(2), // debit = positive number (cost to close)
    legs,
    source: 'WEB',
  };
}

function buildGtcProfitOrder(pos: Position): OrderBody {
  // Place a GTC limit order to close at 50% of credit received
  const targetClose = parseFloat((pos.creditReceived * pos.profitTarget / 100).toFixed(2));
  return buildCloseOrder(pos, targetClose, 'GTC');
}

// For Roll: close current expiry (Day order) + open new spread (GTC) — submitted sequentially
interface RollOrders { close: OrderBody; open: OrderBody | null }
function buildRollOrders(pos: Position, newExpiry: string, newShortStrike: number, newLongStrike: number, newCredit: number): RollOrders {
  const instrType: 'Equity Option' | 'Index Option' = pos.symbol.startsWith('$') || ['SPX','NDX','RUT','VIX'].includes(pos.symbol) ? 'Index Option' : 'Equity Option';

  // Close current position at market/mid
  const closePrice = pos.currentValue != null ? parseFloat((pos.currentValue / 100).toFixed(2)) : 0;
  const close = buildCloseOrder(pos, closePrice, 'Day');

  // Rebuild OCC symbols for the new legs
  // Format: UNDERLYING + YYMMDD + C/P + 8-digit strike (1/1000)
  const exp = newExpiry.replace(/-/g, '').slice(2); // YYMMDD
  const optType = pos.strategy === 'BCS' ? 'C' : 'P';
  const underlying = pos.symbol.padEnd(6, ' ');
  const fmtStrike = (s: number) => String(Math.round(s * 1000)).padStart(8, '0');
  const shortSym = `${underlying}${exp}${optType}${fmtStrike(newShortStrike)}`;
  const longSym  = `${underlying}${exp}${optType}${fmtStrike(newLongStrike)}`;

  const open: OrderBody = {
    'order-type': 'Limit',
    'time-in-force': 'GTC',
    price: (-Math.abs(newCredit)).toFixed(2), // negative = credit received
    legs: [
      { symbol: shortSym, quantity: pos.legs[0]?.quantity ?? 1, action: 'Sell to Open', 'instrument-type': instrType },
      { symbol: longSym,  quantity: pos.legs[0]?.quantity ?? 1, action: 'Buy to Open',  'instrument-type': instrType },
    ],
    source: 'WEB',
  };

  return { close, open };
}

function parseOptionSymbol(sym: string): { optionType: 'P' | 'C'; strikePrice: number } {
  const match = sym.trim().replace(/\s+/g, '').match(/^([A-Z/]+)(\d{6})([CP])(\d{8})$/);
  if (!match) return { optionType: 'C', strikePrice: 0 };
  const strikePrice = parseInt(match[4], 10) / 1000;
  return { optionType: match[3] as 'P' | 'C', strikePrice };
}

// ── Stop Loss / GTC Order Check ────────────────────────────────────────────
type StopStatus = 'live' | 'loose' | 'none' | 'unknown';

interface GtcOrderLeg {
  symbol: string;
  action: string;
}

interface GtcOrder {
  id: string;
  price: string;
  stopPrice: string | null;
  orderType: string;
  timeInForce: string;
  legs: GtcOrderLeg[];
}

interface StopLossInfo {
  status: StopStatus;
  price: number | null;
}

function normalizeOccSymbol(symbol: string): string {
  return String(symbol ?? '').replace(/\s+/g, '').trim();
}

function normalizeOrderAction(action: string): string {
  return String(action ?? '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isBuyToCloseAction(action: string): boolean {
  const normalized = normalizeOrderAction(action);
  return normalized === 'buy to close' || normalized === 'btc';
}

function isStopOrder(order: GtcOrder): boolean {
  const type = order.orderType.toLowerCase();
  return Boolean(order.stopPrice) || type.includes('stop');
}

function pickOrderField(o: any, keys: string[]): string | null {
  for (const key of keys) {
    const value = o?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value);
  }
  return null;
}

function mapGtcOrder(o: any): GtcOrder {
  return {
    id: String(o?.id ?? ''),
    price: String(o?.price ?? o?.['limit-price'] ?? ''),
    stopPrice: pickOrderField(o, ['stop-trigger', 'stop-price', 'stopPrice', 'stop', 'trigger-price']),
    orderType: String(o?.['order-type'] ?? o?.orderType ?? ''),
    timeInForce: String(o?.['time-in-force'] ?? o?.timeInForce ?? ''),
    legs: (o?.legs ?? []).map((l: any) => ({
      symbol: normalizeOccSymbol(String(l?.symbol ?? '')),
      action: String(l?.action ?? ''),
    })),
  };
}

function collectRawOrders(raw: any): any[] {
  const out: any[] = [];
  const visit = (order: any) => {
    if (!order || typeof order !== 'object') return;
    if (Array.isArray(order.legs) && order.legs.length > 0) out.push(order);
    for (const nested of order.orders ?? []) visit(nested);
  };
  for (const item of raw?.data?.items ?? []) visit(item);
  return out;
}

async function fetchGtcOrders(accountNumber: string, token: string): Promise<GtcOrder[]> {
  try {
    const requests = await Promise.allSettled([
      ttFetch(`/accounts/${accountNumber}/orders?status=Open&per-page=250`, token),
      ttFetch(`/accounts/${accountNumber}/orders/live`, token),
      ttFetch(`/accounts/${accountNumber}/orders?per-page=250`, token),
      ttFetch(`/accounts/${accountNumber}/complex-orders`, token),
    ]);

    const rawOrders = requests.flatMap(result =>
      result.status === 'fulfilled' ? collectRawOrders(result.value) : []
    );

    const seen = new Set<string>();
    return rawOrders
      .map(mapGtcOrder)
      .filter(order => {
        const tif = order.timeInForce.toUpperCase();
        const type = order.orderType.toLowerCase();
        const isGtc = tif === 'GTC';
        const isExitType = type.includes('limit') || type.includes('stop');
        if (!isGtc || !isExitType || order.legs.length === 0) return false;
        const key = `${order.id}|${order.orderType}|${order.price}|${order.stopPrice ?? ''}|${order.legs.map(l => `${l.symbol}:${l.action}`).join(',')}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  } catch {
    return [];
  }
}

function classifyPositionStopLoss(
  position: Pick<Position, 'legs' | 'creditReceived'>,
  gtcOrders: GtcOrder[]
): StopLossInfo {
  const shortLeg = position.legs.find(l => l.direction === 'Short');
  if (!shortLeg?.symbol) return { status: 'unknown', price: null };

  const creditPerContract = shortLeg.quantity > 0
    ? position.creditReceived / (shortLeg.quantity * 100)
    : position.creditReceived / 100;
  const stopThreshold = parseFloat((creditPerContract * 2).toFixed(2));
  const shortSymbol = normalizeOccSymbol(shortLeg.symbol);

  const match = gtcOrders.find(order =>
    isStopOrder(order) &&
    order.legs.some(leg =>
      normalizeOccSymbol(leg.symbol) === shortSymbol && isBuyToCloseAction(leg.action)
    )
  );

  if (!match) return { status: 'none', price: null };

  const orderPrice = parseFloat(match.stopPrice ?? match.price);
  if (isNaN(orderPrice)) return { status: 'unknown', price: null };
  if (orderPrice <= stopThreshold + 0.02) return { status: 'live', price: orderPrice };
  return { status: 'loose', price: orderPrice };
}
async function loadPositions(): Promise<Position[]> {
  const token = await getAccessToken();

  const accountsData = await ttFetch('/customers/me/accounts', token);
  const accounts = accountsData?.data?.items ?? [];
  if (accounts.length === 0) throw new Error('No accounts found');
  const accountNumber = accounts[0]?.account?.['account-number'];
  if (!accountNumber) throw new Error('Could not read account number');

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

  // Keep original symbols with spaces for market data API — TastyTrade requires OCC space-padded format
  const allOptionSymbols = optionPositions.map((p: any) => p.symbol).filter(Boolean);
  // Also keep stripped versions for lookup keys (consistent with position data)
  const allOptionSymbolsStripped = allOptionSymbols.map((s: string) => s.replace(/\s+/g, ''));
  const currentPrices: Record<string, number> = {};
  const thetaMap: Record<string, number> = {};
  const gammaMap: Record<string, number> = {};
  if (allOptionSymbols.length > 0) {
    try {
      for (let i = 0; i < allOptionSymbols.length; i += 50) {
        const chunk = allOptionSymbols.slice(i, i + 50);
        // Send with spaces encoded — TastyTrade market-data requires space-padded OCC symbols
        const qs = chunk.map((s: string) => `equity-option=${encodeURIComponent(s)}`).join('&');
        const priceData = await ttFetch(`/market-data/by-type?${qs}`, token);
        const items = priceData?.data?.items ?? [];
        console.log('MARKET DATA RAW COUNT:', items.length, 'QS:', qs.slice(0, 200));
        if (items.length > 0) console.log('MARKET DATA SAMPLE:', JSON.stringify(items[0], null, 2));
        for (const item of items) {
          const sym = item.symbol?.replace(/\s+/g, '');
          if (!sym) continue;
          const bid = parseFloat(item.bid ?? '0');
          const ask = parseFloat(item.ask ?? '0');
          const mark = parseFloat(item.mark ?? item['mark-price'] ?? '0');
          const mid = (bid + ask) / 2;
          currentPrices[sym] = mid > 0 ? mid : mark > 0 ? mark : 0;
          const theta = parseFloat(item.theta ?? 'NaN');
          const gamma = parseFloat(item.gamma ?? 'NaN');
          if (!isNaN(theta)) thetaMap[sym] = theta;
          if (!isNaN(gamma)) gammaMap[sym] = gamma;
        }
        console.log('currentPrices keys sample:', Object.keys(currentPrices).slice(0, 3));
        console.log('allOptionSymbolsStripped sample:', allOptionSymbolsStripped.slice(0, 3));
      }
    } catch (e) { console.error('Market data fetch error:', e); }
  }

  const ivrMap: Record<string, number | null> = {};
  try {
    const underlyingSymbols: string[] = (optionPositions as any[])
      .map((p: any) => String(p['underlying-symbol']))
      .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
    const qs = underlyingSymbols.join(',');
    const metricsData = await ttFetch(`/market-metrics?symbols=${encodeURIComponent(qs)}`, token);
    for (const item of metricsData?.data?.items ?? []) {
      const raw = item['implied-volatility-index-rank'] ?? item['iv-rank'] ?? null;
      const parsed = raw != null ? parseFloat(String(raw)) : NaN;
      if (!isNaN(parsed)) ivrMap[item['symbol']] = parsed < 1 ? Math.round(parsed * 100) : Math.round(parsed);
    }
  } catch { /* IVR optional */ }

  // Fetch current stock prices for underlying symbols
  const stockPrices: Record<string, number | null> = {};
  try {
    const underlyingSymbols: string[] = (optionPositions as any[])
      .map((p: any) => String(p['underlying-symbol']))
      .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
    const qs = underlyingSymbols.map(s => `equity=${encodeURIComponent(s)}`).join('&');
    const stockData = await ttFetch(`/market-data/by-type?${qs}`, token);
    for (const item of stockData?.data?.items ?? []) {
      const bid = parseFloat(item.bid ?? '0');
      const ask = parseFloat(item.ask ?? '0');
      stockPrices[item.symbol] = (bid + ask) / 2;
    }
  } catch { /* stock prices optional */ }

  const gtcOrders = await fetchGtcOrders(accountNumber, token);
  const gtcSymbols = new Set<string>();
  for (const order of gtcOrders) {
    for (const leg of order.legs) {
      const parsed = parseOptionSymbol(leg.symbol);
      if (parsed.strikePrice > 0) gtcSymbols.add(leg.symbol.split(/\d{6}/)[0].trim());
    }
  }
  try {
    // Fetch all live/working orders — no status filter param
    const [liveData, searchData] = await Promise.allSettled([
      ttFetch(`/accounts/${accountNumber}/orders/live`, token),
      ttFetch(`/accounts/${accountNumber}/orders?per-page=250`, token),
    ]);
  
    const allOrders = [
      ...((liveData.status === 'fulfilled' ? liveData.value?.data?.items : null) ?? []),
      ...((searchData.status === 'fulfilled' ? searchData.value?.data?.items : null) ?? []),
    ];

    // TEMPORARY DEBUG
    console.log('ALL ORDERS RAW:', JSON.stringify(allOrders, null, 2));
  
    for (const order of allOrders) {
      const status = (order['status'] ?? '').toLowerCase();
      const tif = (order['time-in-force'] ?? '');
      // Accept working orders regardless of TIF — bracket orders may show as 'contingent'
      if (['working', 'live', 'contingent', 'received'].includes(status)) {
        for (const leg of order.legs ?? []) {
          const sym = leg['underlying-symbol'] ?? leg.symbol ?? '';
          if (sym) gtcSymbols.add(sym.split(' ')[0].trim());
        }
      }
    }
  } catch { /* GTC optional */ }

  // Also check complex orders — bracket orders on SPX/index options are stored here
  try {
    const complexData = await ttFetch(
      `/accounts/${accountNumber}/complex-orders`, 
      token
    );
    for (const order of complexData?.data?.items ?? []) {
      const status = (order['status'] ?? '').toLowerCase();
      if (['working', 'live', 'contingent', 'received', 'routed'].includes(status)) {
        // Complex orders have nested orders with legs
        for (const nestedOrder of order.orders ?? []) {
          for (const leg of nestedOrder.legs ?? []) {
            const sym = leg['underlying-symbol'] ?? leg.symbol ?? '';
            if (sym) gtcSymbols.add(sym.split(' ')[0].trim());
          }
        }
        // Also check top-level legs if they exist
        for (const leg of order.legs ?? []) {
          const sym = leg['underlying-symbol'] ?? leg.symbol ?? '';
          if (sym) gtcSymbols.add(sym.split(' ')[0].trim());
        }
      }
    }
  } catch { /* complex orders optional */ }

  
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

  let profitTargets: Record<string, number> = {};
  try { profitTargets = JSON.parse(localStorage.getItem(LS_PROFIT_TARGETS) ?? '{}'); } catch {}

  const today = new Date();
  const positions: Position[] = Object.entries(groups).map(([key, legs]) => {
    const [symbol, expDate] = key.split('::');
    const dte = Math.round((new Date(expDate).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    const openedAt = legs[0]?.['created-at']?.slice(0, 10) ?? null;
    const entryDte = openedAt
      ? Math.round((new Date(expDate).getTime() - new Date(openedAt).getTime()) / (1000 * 60 * 60 * 24))
      : dte;
    const putLegs  = legs.filter((l: any) => parseOptionSymbol(l.symbol).optionType === 'P');
    const callLegs = legs.filter((l: any) => parseOptionSymbol(l.symbol).optionType === 'C');
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
      const price = currentPrices[leg.symbol?.replace(/\s+/g, '')];
      if (price == null) { hasCurrentPrices = false; break; }
      currentValue += leg['quantity-direction'] === 'Short' ? price * qty : -(price * qty);
    }
    currentValue = currentValue * 100;

    const pnl = hasCurrentPrices ? Math.abs(creditReceived) - Math.abs(currentValue) : null;
    const pnlPct = creditReceived !== 0 && pnl != null ? (pnl / Math.abs(creditReceived)) * 100 : null;
    const profitTarget = profitTargets[key] ?? 0.5;
    const targetPrice = Math.abs(creditReceived) * profitTarget;
    const hitTarget = hasCurrentPrices && pnl != null && pnl >= Math.abs(creditReceived) * profitTarget;
    const positionLegs: PositionLeg[] = legs.map((l: any) => {
      const parsed = parseOptionSymbol(l.symbol);
      return {
        symbol: l.symbol,
        optionType: parsed.optionType,
        strikePrice: parsed.strikePrice,
        direction: l['quantity-direction'] as 'Short' | 'Long',
        quantity: parseInt(l['quantity'] ?? '1', 10),
        avgOpenPrice: parseFloat(l['average-open-price'] ?? '0'),
        currentPrice: currentPrices[l.symbol?.replace(/\s+/g, '')] ?? null,
      };
    });
    const stopLoss = classifyPositionStopLoss(
      { legs: positionLegs, creditReceived: Math.abs(creditReceived) },
      gtcOrders
    );

    return {
      key, symbol, expDate, dte, strategy,
      legs: positionLegs,
      creditReceived: Math.abs(creditReceived),
      currentValue: hasCurrentPrices ? Math.abs(currentValue) : null,
      pnl, pnlPct, targetPrice, profitTarget, hitTarget,
      plOpen: plBySymbol[symbol] != null ? Math.round(plBySymbol[symbol] * 100) / 100 : null,
      maxRisk: (() => {
        const shorts = legs.filter((l: any) => l['quantity-direction'] === 'Short');
        const longs  = legs.filter((l: any) => l['quantity-direction'] === 'Long');
        if (shorts[0] && longs[0]) {
          const shortStrike = parseOptionSymbol(shorts[0].symbol).strikePrice;
          const longStrike  = parseOptionSymbol(longs[0].symbol).strikePrice;
          const width = Math.abs(shortStrike - longStrike);
          const qty = parseInt(shorts[0]['quantity'] ?? '1', 10);
          return Math.max(0, (width * 100 * qty) - Math.abs(creditReceived));
        }
        return 0;
      })(),
      entryDte,
      needsClose: entryDte > 21 && dte <= 21,
      accountNumber,
      ivr: ivrMap[symbol] ?? null,
      hasGtc: gtcSymbols.has(symbol),
      stopLossStatus: stopLoss.status,
      stopLossPrice: stopLoss.price,
      stockPrice: stockPrices[symbol] ?? null,
      buffer: (() => {
        const stock = stockPrices[symbol];
        if (stock == null) return null;
        const shorts = legs.filter((l: any) => l['quantity-direction'] === 'Short');
        if (shorts.length === 0) return null;
        const shortStrike = parseOptionSymbol(shorts[0].symbol).strikePrice;
        const optType = parseOptionSymbol(shorts[0].symbol).optionType;
        if (optType === 'P') return ((stock - shortStrike) / stock) * 100;
        if (optType === 'C') return ((shortStrike - stock) / stock) * 100;
        return null;
      })(),
      theta: (() => {
        let net = 0; let any = false;
        for (const l of legs) {
          const sym = l.symbol?.replace(/\s+/g, '');
          const val = thetaMap[sym];
          if (val == null) continue;
          const qty = parseInt(l['quantity'] ?? '1', 10);
          // For a short spread, short legs collect theta (positive), long legs pay it (negative)
          net += l['quantity-direction'] === 'Short' ? Math.abs(val) * qty : -Math.abs(val) * qty;
          any = true;
        }
        return any ? parseFloat(net.toFixed(4)) : null;
      })(),
      gamma: (() => {
        let net = 0; let any = false;
        for (const l of legs) {
          const sym = l.symbol?.replace(/\s+/g, '');
          const val = gammaMap[sym];
          if (val == null) continue;
          const qty = parseInt(l['quantity'] ?? '1', 10);
          // Short gamma is expected — negative net gamma for credit spreads
          net += l['quantity-direction'] === 'Short' ? -Math.abs(val) * qty : Math.abs(val) * qty;
          any = true;
        }
        return any ? parseFloat(net.toFixed(4)) : null;
      })(),
    };
  });

  const actionPriority: Record<string, number> = {
    CLOSE_ROLL: 0, CUT_LOSSES: 1, TAKE_PROFIT: 2, MANAGE: 3, WATCH: 4, HOLD: 5,
  };
  positions.sort((a, b) => {
    if (a.needsClose && !b.needsClose) return -1;
    if (!a.needsClose && b.needsClose) return 1;
    const aRec = getRecommendation(a, null).action;
    const bRec = getRecommendation(b, null).action;
    const aPri = actionPriority[aRec] ?? 9;
    const bPri = actionPriority[bRec] ?? 9;
    if (aPri !== bPri) return aPri - bPri;
    return a.dte - b.dte;
  });
  return positions;
}

type Theme = 'dark' | 'medium' | 'light';
const LS_THEME = 'prosper-theme';

const THEMES = {
  dark:   { bg: 'bg-[#0a0a0a]', sidebar: 'bg-[#0f0f0f]', card: 'bg-[#171717]', cardQualified: 'bg-[#1c1c1c]', border: 'border-[#2c2c2c]', borderLight: 'border-[#202020]', header: 'bg-[#0f0f0f]', text: 'text-white', textMuted: 'text-[#e0e0e0]', textFaint: 'text-[#808080]', input: 'bg-[#141414]', inputBorder: 'border-[#353535]', tag: 'bg-[#222222]', label: 'text-[#aaaaaa]' },
  medium: { bg: 'bg-[#141414]', sidebar: 'bg-[#1a1a1a]', card: 'bg-[#202020]', cardQualified: 'bg-[#252525]', border: 'border-[#333333]', borderLight: 'border-[#282828]', header: 'bg-[#1a1a1a]', text: 'text-white', textMuted: 'text-[#d8d8d8]', textFaint: 'text-[#777777]', input: 'bg-[#1e1e1e]', inputBorder: 'border-[#3a3a3a]', tag: 'bg-[#2a2a2a]', label: 'text-[#999999]' },
  light:  { bg: 'bg-[#f5f5f5]', sidebar: 'bg-white', card: 'bg-white', cardQualified: 'bg-white', border: 'border-[#e0e0e0]', borderLight: 'border-[#ebebeb]', header: 'bg-[#111111]', text: 'text-[#111111]', textMuted: 'text-[#1a1a1a]', textFaint: 'text-[#666666]', input: 'bg-white', inputBorder: 'border-[#cccccc]', tag: 'bg-[#f0f0f0]', label: 'text-[#444444]' },
};

interface TrendResult {
  trend: 'uptrend' | 'downtrend' | 'sideways' | 'unknown';
  strategy: 'BPS' | 'BCS' | 'IC' | 'NO_TRADE';
  confidence: number;
  reason: string;
}

type ActionType = 'HOLD' | 'WATCH' | 'MANAGE' | 'TAKE_PROFIT' | 'CUT_LOSSES' | 'CLOSE_ROLL' | 'PLACE_GTC';

interface Recommendation {
  action: ActionType;
  detail: string;
}

async function getTrend(symbol: string): Promise<TrendResult> {
  const res = await fetch(`/api/chart?symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' });
  if (!res.ok) return { trend: 'unknown', strategy: 'NO_TRADE', confidence: 0, reason: 'Chart data unavailable' };
  const data = await res.json();
  const bars: { c: number }[] = data?.bars ?? [];
  const closes = bars.map((b: any) => b.c).filter((c: any): c is number => Number.isFinite(c));
  if (closes.length < 50) return { trend: 'unknown', strategy: 'NO_TRADE', confidence: 0, reason: 'Not enough data' };

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const price = closes[closes.length - 1];
  const ma20 = avg(closes.slice(-20));
  const ma50 = avg(closes.slice(-50));
  const mom20 = (price - closes[closes.length - 21]) / closes[closes.length - 21];
  const low20 = Math.min(...closes.slice(-20));
  const high20 = Math.max(...closes.slice(-20));
  const higherLows = low20 > Math.min(...closes.slice(-40, -20)) * 0.985;
  const lowerHighs = high20 < Math.max(...closes.slice(-40, -20)) * 1.015;

  let score = 0;
  if (price > ma20) score += 2; else score -= 2;
  if (price > ma50) score += 2; else score -= 2;
  if (ma20 > ma50) score += 2; else score -= 2;
  if (mom20 > 0.03) score += 2; else if (mom20 < -0.03) score -= 2;
  if (higherLows) score += 2; else if (lowerHighs) score -= 2;

  const confidence = Math.min(100, Math.abs(score) * 10);
  if (score >= 4) return { trend: 'uptrend', strategy: 'BPS', confidence, reason: `Price above MA20/MA50, positive momentum` };
  if (score <= -4) return { trend: 'downtrend', strategy: 'BCS', confidence, reason: `Price below MA20/MA50, negative momentum` };
  return { trend: 'sideways', strategy: 'IC', confidence, reason: `Mixed signals, range-bound` };
}

function getRecommendation(pos: Position, trend: TrendResult | null): Recommendation {
  const pnlPct = pos.pnl != null && pos.creditReceived !== 0 ? (pos.pnl / pos.creditReceived) * 100 : 0;
  const targetPct = pos.profitTarget * 100;
  const approachingPct = targetPct - 15;
  const trendAgainst = trend && (
    (pos.strategy === 'BPS' && trend.trend === 'downtrend') ||
    (pos.strategy === 'BCS' && trend.trend === 'uptrend')
  );
  const trendAligns = trend && (
    (pos.strategy === 'BPS' && trend.trend === 'uptrend') ||
    (pos.strategy === 'BCS' && trend.trend === 'downtrend') ||
    (pos.strategy === 'IC' && trend.trend === 'sideways')
  );
  if (pos.needsClose && pnlPct >= 0) return { action: 'CLOSE_ROLL', detail: `${pos.dte} DTE — close or roll to next expiry` };
  if (pos.needsClose && pnlPct < 0)  return { action: 'CUT_LOSSES', detail: `${pos.dte} DTE — close to prevent further loss` };
  if (pos.hitTarget)                  return { action: 'TAKE_PROFIT', detail: `${Math.round(targetPct)}% target reached — lock in $${pos.pnl?.toFixed(2)} profit` };
  if (pnlPct < -15 && trendAgainst)  return { action: 'CUT_LOSSES', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% and trend confirms — exit` };
  if (pnlPct < -15)                  return { action: 'MANAGE', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% — trend not confirmed, manage actively` };
  if (pnlPct >= targetPct)           return { action: 'TAKE_PROFIT', detail: `${pnlPct.toFixed(0)}% profit — target reached` };
  if (pnlPct >= approachingPct)      return { action: 'WATCH', detail: `${pnlPct.toFixed(0)}% profit — approaching ${Math.round(targetPct)}% target` };
  if (pnlPct < 0 && trendAgainst)    return { action: 'MANAGE', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% with adverse trend — watch closely` };
  if (pnlPct < 0)                    return { action: 'WATCH', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% — trend still ok, monitor` };
  if (trendAligns)                   return { action: 'HOLD', detail: `Trend confirms ${pos.strategy} — ${pnlPct.toFixed(0)}% profit` };
  return { action: 'HOLD', detail: `${pnlPct.toFixed(0)}% profit — ${pos.dte} DTE remaining` };
}

function getSavedTheme(): Theme {
  try { const t = localStorage.getItem(LS_THEME); return (t === 'dark' || t === 'medium' || t === 'light') ? t : 'dark'; } catch { return 'dark'; }
}

interface PositionLeg {
  symbol: string;
  optionType: 'P' | 'C';
  strikePrice: number;
  direction: 'Short' | 'Long';
  quantity: number;
  avgOpenPrice: number;
  currentPrice: number | null;
}

interface Position {
  key: string;
  symbol: string;
  expDate: string;
  dte: number;
  strategy: string;
  legs: PositionLeg[];
  creditReceived: number;
  currentValue: number | null;
  pnl: number | null;
  pnlPct: number | null;
  plOpen: number | null;
  targetPrice: number;
  profitTarget: number;
  maxRisk: number;
  hitTarget: boolean;
  needsClose: boolean;
  entryDte: number;
  accountNumber: string;
  ivr: number | null;
  hasGtc: boolean;
  stopLossStatus: StopStatus;
  stopLossPrice: number | null;
  stockPrice: number | null;
  buffer: number | null;
  theta: number | null;
  gamma: number | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function stratColor(strategy: string) {
  if (strategy === 'BPS') return 'text-emerald-400 border-emerald-700';
  if (strategy === 'BCS') return 'text-red-400 border-red-700';
  if (strategy === 'IC')  return 'text-blue-400 border-blue-700';
  return 'text-slate-400 border-slate-700';
}

function pnlColor(pnl: number | null) {
  if (pnl == null) return 'text-slate-400';
  return pnl >= 0 ? 'text-emerald-400' : 'text-red-400';
}

function dteColor(dte: number) {
  if (dte <= 7)  return 'text-red-500 font-bold';
  if (dte <= 21) return 'text-yellow-400 font-bold';
  return 'text-slate-400';
}

function ThemeToggle({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const options: { value: Theme; icon: string; label: string }[] = [
    { value: 'light', icon: '☀', label: 'Light' },
    { value: 'medium', icon: '◐', label: 'Dim' },
    { value: 'dark', icon: '☾', label: 'Dark' },
  ];
  return (
    <div className="flex items-center gap-1 bg-black/20 rounded-lg p-1">
      {options.map(o => (
        <button key={o.value} onClick={() => { setTheme(o.value); try { localStorage.setItem(LS_THEME, o.value); } catch {} }}
          title={o.label}
          className={`text-sm px-2 py-1 rounded transition-all ${theme === o.value ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white/80'}`}>
          {o.icon}
        </button>
      ))}
    </div>
  );
}

// ── Position Card ──────────────────────────────────────────────────────────
function PositionCard({ pos, th, selectedAction, onToggleSelect, onProfitTargetChange, onRefresh }: {
  pos: Position;
  th: typeof THEMES[Theme];
  selectedAction: ActionType | null;
  onToggleSelect: (key: string, action: ActionType) => void;
  onProfitTargetChange: (key: string, value: number) => void;
  onRefresh?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [trend, setTrend] = useState<TrendResult | null>(null);
  const [trendLoading, setTrendLoading] = useState(false);
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetInput, setTargetInput] = useState(String(Math.round(pos.profitTarget * 100)));
  const [executeAction, setExecuteAction] = useState<ActionType | null>(null);

  useEffect(() => {
    setTrendLoading(true);
    getTrend(pos.symbol).then(t => { setTrend(t); setTrendLoading(false); }).catch(() => setTrendLoading(false));
  }, [pos.symbol]);

  const rec = getRecommendation(pos, trend);


  const shortPuts  = pos.legs.filter(l => l.optionType === 'P' && l.direction === 'Short');
  const longPuts   = pos.legs.filter(l => l.optionType === 'P' && l.direction === 'Long');
  const shortCalls = pos.legs.filter(l => l.optionType === 'C' && l.direction === 'Short');
  const longCalls  = pos.legs.filter(l => l.optionType === 'C' && l.direction === 'Long');

  const strikesSummary = () => {
    if (pos.strategy === 'BPS' && shortPuts[0] && longPuts[0])
      return `${shortPuts[0].strikePrice}P / ${longPuts[0].strikePrice}P`;
    if (pos.strategy === 'BCS' && shortCalls[0] && longCalls[0])
      return `${shortCalls[0].strikePrice}C / ${longCalls[0].strikePrice}C`;
    if (pos.strategy === 'IC' && shortPuts[0] && longPuts[0] && shortCalls[0] && longCalls[0])
      return `${shortPuts[0].strikePrice}P/${longPuts[0].strikePrice}P · ${shortCalls[0].strikePrice}C/${longCalls[0].strikePrice}C`;
    return pos.legs.map(l => `${l.strikePrice}${l.optionType}`).join(' / ');
  };

  const handleTargetSave = () => {
    const val = Math.min(100, Math.max(10, parseInt(targetInput) || 50)) / 100;
    setEditingTarget(false);
    onProfitTargetChange(pos.key, val);
  };

  const borderClass = selectedAction
    ? 'border-blue-500/60'
    : pos.needsClose
    ? 'border-red-500/60'
    : pos.hitTarget
    ? 'border-emerald-500/60'
    : th.border;

  const effectiveAction = selectedAction ?? rec.action;

  const actionConfig: Record<ActionType, { label: string; btnClass: string; pillClass: string; show: boolean }> = {
    HOLD:        { label: '● Hold',         btnClass: '', pillClass: 'border-blue-700 text-blue-400 bg-blue-500/10',      show: false },
    WATCH:       { label: '⚠ Watch',        btnClass: '', pillClass: 'border-yellow-700 text-yellow-400 bg-yellow-500/10', show: false },
    MANAGE:      { label: '⚡ Manage',       btnClass: 'border-orange-600 text-orange-400 hover:bg-orange-600/10',  pillClass: '', show: true },
    TAKE_PROFIT: { label: '✓ Take Profit',  btnClass: 'border-emerald-600 text-emerald-400 hover:bg-emerald-600/10', pillClass: '', show: true },
    CUT_LOSSES:  { label: '✕ Cut Losses',   btnClass: 'border-red-600 text-red-400 hover:bg-red-600/10',           pillClass: '', show: true },
    CLOSE_ROLL:  { label: '↻ Close / Roll', btnClass: 'border-purple-600 text-purple-400 hover:bg-purple-600/10',  pillClass: '', show: true },
    PLACE_GTC:   { label: '⏱ Place GTC',   btnClass: 'border-blue-600 text-blue-400 hover:bg-blue-600/10',        pillClass: '', show: true },
  };

  const actionDef = actionConfig[effectiveAction];

  const actions: { key: ActionType; label: string; activeColor: string; ringColor: string; labelColor: string }[] = [
    { key: 'HOLD',        label: 'Hold',         activeColor: 'bg-blue-500 border-blue-500',      ringColor: 'ring-blue-500',    labelColor: 'text-blue-400' },
    { key: 'WATCH',       label: 'Watch',        activeColor: 'bg-yellow-500 border-yellow-500',  ringColor: 'ring-yellow-500',  labelColor: 'text-yellow-400' },
    { key: 'MANAGE',      label: 'Manage',       activeColor: 'bg-orange-500 border-orange-500',  ringColor: 'ring-orange-500',  labelColor: 'text-orange-400' },
    { key: 'TAKE_PROFIT', label: 'Take profit',  activeColor: 'bg-emerald-500 border-emerald-500', ringColor: 'ring-emerald-500', labelColor: 'text-emerald-400' },
    { key: 'CUT_LOSSES',  label: 'Cut losses',   activeColor: 'bg-red-500 border-red-500',        ringColor: 'ring-red-500',     labelColor: 'text-red-400' },
    { key: 'CLOSE_ROLL',  label: 'Close / roll', activeColor: 'bg-purple-500 border-purple-500',  ringColor: 'ring-purple-500',  labelColor: 'text-purple-400' },
    { key: 'PLACE_GTC',   label: 'Place GTC',    activeColor: 'bg-blue-500 border-blue-500',      ringColor: 'ring-blue-500',    labelColor: 'text-blue-400' },
  ];

  return (
    <div className={`border ${borderClass} ${th.card} rounded-lg transition-all`}>
      {pos.needsClose && (
        <div className="bg-red-500/10 border-b border-red-500/40 px-4 py-1.5 flex items-center gap-2">
          <span className="text-red-400 text-xs">⚠</span>
          <span className="text-xs text-red-400 font-bold tracking-wider">
            CLOSE NOW — {pos.dte} DTE REMAINING
            <span className="ml-2 font-normal opacity-60">(entered at {pos.entryDte} DTE)</span>
          </span>
        </div>
      )}
      {pos.hitTarget && !pos.needsClose && (
        <div className="bg-emerald-500/10 border-b border-emerald-500/40 px-4 py-1.5 flex items-center gap-2">
          <span className="text-emerald-400 text-xs">✓</span>
          <span className="text-xs text-emerald-400 font-bold tracking-wider">{Math.round(pos.profitTarget * 100)}% PROFIT TARGET HIT — CLOSE FOR PROFIT</span>
        </div>
      )}

      <div className="flex items-stretch">
        {/* Expand toggle */}
        <button
          onClick={() => setExpanded(!expanded)}
          className={`px-3 flex items-center border-r ${th.borderLight} ${th.textFaint} hover:${th.textMuted} transition-colors shrink-0`}>
          <span className="text-[10px]">{expanded ? '▲' : '▼'}</span>
        </button>

        {/* Data columns — scrollable */}
        <div className="overflow-x-auto flex-1">
        <div className="grid px-4 py-3" style={{ gridTemplateColumns: '72px 120px 80px 70px 110px 80px 80px 90px 70px 50px 50px 55px 60px 110px', gap: '0 12px', alignItems: 'center', minWidth: '900px' }}>
          {/* Symbol + strategy */}
          <div>
            <p className={`font-bold ${th.text} text-sm leading-tight`} style={{ fontFamily: "'DM Mono', monospace" }}>{pos.symbol}</p>
            <span className={`text-[10px] px-1.5 py-0.5 border rounded font-bold ${stratColor(pos.strategy)}`}>{pos.strategy}</span>
          </div>

          {/* Expiry / DTE */}
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>Expiry / DTE</p>
            <p className="text-xs leading-tight" style={{ fontFamily: "'DM Mono', monospace" }}>
              <span className={`block ${th.text}`}>{pos.expDate}</span>
              <span className={`block ${dteColor(pos.dte)}`}>({pos.dte}d)</span>
            </p>
          </div>

          {/* Stock price */}
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>Stock</p>
            <p className={`text-xs ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>
              {pos.stockPrice != null ? `$${pos.stockPrice.toFixed(2)}` : '—'}
            </p>
          </div>

          {/* % Buffer */}
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>% Buffer</p>
            <p className={`text-xs font-bold ${
              pos.buffer == null ? th.textFaint :
              pos.buffer < 3 ? 'text-red-400' :
              pos.buffer < 7 ? 'text-yellow-400' :
              'text-emerald-400'
            }`} style={{ fontFamily: "'DM Mono', monospace" }}>
              {pos.buffer != null ? `${pos.buffer.toFixed(1)}%` : '—'}
            </p>
          </div>

          {/* Strikes */}
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>Strikes</p>
            <p className={`text-xs ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{strikesSummary()}</p>
          </div>

          {/* Buyback (was Current) */}
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>Buyback</p>
            <p className={`text-xs ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>
              {pos.currentValue != null ? `$${pos.currentValue.toFixed(2)}` : '—'}
            </p>
          </div>

          {/* Credit */}
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>Credit</p>
            <p className="text-xs font-bold text-emerald-400" style={{ fontFamily: "'DM Mono', monospace" }}>${pos.creditReceived.toFixed(2)}</p>
          </div>

          {/* Profit Target — click to edit */}
          <div onClick={e => e.stopPropagation()}>
            <p className={`text-[9px] ${th.textFaint}`}>{Math.round(pos.profitTarget * 100)}% Target</p>
            {editingTarget ? (
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="10"
                  max="100"
                  value={targetInput}
                  onChange={e => setTargetInput(e.target.value)}
                  onBlur={handleTargetSave}
                  onKeyDown={e => { if (e.key === 'Enter') handleTargetSave(); if (e.key === 'Escape') setEditingTarget(false); }}
                  autoFocus
                  className="text-xs w-12 bg-transparent border-b border-blue-500 outline-none text-blue-400"
                  style={{ fontFamily: "'DM Mono', monospace" }}
                />
                <span className="text-[9px] text-blue-400">%</span>
              </div>
            ) : (
              <p
                className={`text-xs cursor-pointer hover:text-blue-400 transition-colors ${pos.hitTarget ? 'text-emerald-400 font-bold' : th.textFaint}`}
                style={{ fontFamily: "'DM Mono', monospace" }}
                onClick={() => { setTargetInput(String(Math.round(pos.profitTarget * 100))); setEditingTarget(true); }}
                title="Click to edit profit target %"
              >
                ${pos.targetPrice.toFixed(2)}{pos.hitTarget && ' ✓'}
              </p>
            )}
          </div>

          {/* P/L Open */}
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>P/L Open</p>
            <p className={`text-xs font-bold ${pos.plOpen != null ? (pos.plOpen >= 0 ? 'text-emerald-400' : 'text-red-400') : th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>
              {pos.plOpen != null ? `${pos.plOpen >= 0 ? '+' : ''}$${pos.plOpen.toFixed(0)}` : '—'}
            </p>
          </div>

          {/* Theta */}
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>Theta</p>
            <p className={`text-xs font-bold ${pos.theta != null ? (pos.theta >= 0 ? 'text-emerald-400' : 'text-red-400') : th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>
              {pos.theta != null ? (pos.theta >= 0 ? '+' : '') + pos.theta.toFixed(3) : '—'}
            </p>
          </div>

          {/* Gamma */}
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>Gamma</p>
            <p className={`text-xs font-bold ${pos.gamma != null ? (pos.gamma <= 0 ? 'text-emerald-400' : 'text-red-400') : th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>
              {pos.gamma != null ? pos.gamma.toFixed(4) : '—'}
            </p>
          </div>

          {/* IVR */}
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>IVR</p>
            <p className={`text-xs font-bold ${pos.ivr != null ? (pos.ivr >= 30 ? 'text-emerald-400' : 'text-yellow-400') : th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>
              {pos.ivr != null ? `${pos.ivr}` : '—'}
            </p>
          </div>

          {/* GTC */}
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>GTC</p>
            <p className={`text-xs font-bold ${pos.hasGtc ? 'text-emerald-400' : 'text-red-400'}`}>
              {pos.hasGtc ? '✓ Live' : '✕ None'}
            </p>
          </div>

          {/* Stop Loss */}
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>Stop Loss</p>
            {(() => {
              const sl =
                pos.stopLossStatus === 'live'  ? { icon: '✓', label: 'Stop',  cls: 'text-emerald-400' } :
                pos.stopLossStatus === 'loose' ? { icon: '⚠', label: 'Loose', cls: 'text-yellow-400'  } :
                pos.stopLossStatus === 'none'  ? { icon: '✕', label: 'None',  cls: 'text-red-400'     } :
                                                  { icon: '—', label: '?',     cls: th.textFaint      };
              return (
                <p className={`text-xs font-bold ${sl.cls}`}>
                  {sl.icon} {sl.label}
                  {pos.stopLossPrice != null && (
                    <span className={`ml-1 ${th.textFaint} text-[10px]`}>${pos.stopLossPrice.toFixed(2)}</span>
                  )}
                </p>
              );
            })()}
          </div>
        </div>

         </div>{/* end scrollable metrics */}
        {/* Action dropdown + TastyTrade button */}        <div className={`flex items-center gap-2 border-l ${th.border} px-3 shrink-0`} onClick={e => e.stopPropagation()}>
          {trendLoading ? (
            <span className={`text-[10px] ${th.textFaint}`}>analyzing...</span>
          ) : (
            <>
              {/* Dropdown */}
              <div className="flex flex-col gap-0.5">
                <p className={`text-[8px] ${th.textFaint} tracking-wider uppercase`}>Action</p>
                <select
                  value={selectedAction ?? ''}
                  onChange={e => {
                    const val = e.target.value as ActionType;
                    if (val) onToggleSelect(pos.key, val);
                    else onToggleSelect(pos.key, rec.action);
                  }}
                  className={`text-[10px] font-bold border rounded px-2 py-1 cursor-pointer focus:outline-none focus:border-emerald-500 transition-colors ${
                    selectedAction
                      ? actionConfig[selectedAction].pillClass || actionConfig[selectedAction].btnClass
                      : actionConfig[rec.action].pillClass || actionConfig[rec.action].btnClass
                  } bg-transparent`}
                  style={{ minWidth: '140px' }}
                >
                  {/* Suggested option */}
                  {!selectedAction && (
                    <option value="" style={{ background: '#1a1a1a' }}>
                      ✦ {actionConfig[rec.action].label.replace(/^[●⚠⚡✓✕↻]\s*/, '')} — suggested
                    </option>
                  )}
                  {actions.map(a => (
                    <option key={a.key} value={a.key} style={{ background: '#1a1a1a' }}>
                      {actionConfig[a.key].label.replace(/^[●⚠⚡✓✕↻]\s*/, '')}
                      {!selectedAction && rec.action === a.key ? ' (suggested)' : ''}
                    </option>
                  ))}
                  {selectedAction && (
                    <option value="" style={{ background: '#1a1a1a' }}>— Reset to suggested</option>
                  )}
                </select>
              </div>

              {/* Execute button */}
              {(['TAKE_PROFIT', 'CUT_LOSSES', 'CLOSE_ROLL', 'PLACE_GTC'] as ActionType[]).includes(effectiveAction) ? (
                <button
                  onClick={() => setExecuteAction(effectiveAction)}
                  className={`text-[9px] px-2 py-1 border rounded font-bold whitespace-nowrap transition-colors ${
                    effectiveAction === 'TAKE_PROFIT' ? 'border-emerald-600 text-emerald-400 hover:bg-emerald-600/20' :
                    effectiveAction === 'CUT_LOSSES'  ? 'border-red-600 text-red-400 hover:bg-red-600/20' :
                    effectiveAction === 'CLOSE_ROLL'  ? 'border-purple-600 text-purple-400 hover:bg-purple-600/20' :
                    'border-blue-600 text-blue-400 hover:bg-blue-600/20'
                  }`}>
                  Execute ↗
                </button>
              ) : (
                <a
                  href="https://my.tastytrade.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[9px] px-2 py-1 border border-white/20 text-white/50 rounded hover:border-white/40 hover:text-white/80 transition-colors whitespace-nowrap">
                  TT ↗
                </a>
              )}
            </>
          )}
        </div>
      </div>

      {/* Expanded legs */}
      {expanded && (
        <div className={`border-t ${th.border} px-4 py-3`}>
          <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-2`}>Legs</p>
          <div className="space-y-1.5">
            {pos.legs.map((leg, i) => (
              <div key={i} className="flex items-center gap-4 flex-wrap">
                <span className={`text-[10px] w-10 font-bold ${leg.direction === 'Short' ? 'text-red-400' : 'text-emerald-400'}`}>{leg.direction}</span>
                <span className={`text-[10px] ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                  {leg.quantity}x {leg.strikePrice} {leg.optionType === 'P' ? 'Put' : 'Call'}
                </span>
                <span className={`text-[10px] ${th.textFaint}`}>Avg open: <span className={th.text}>${leg.avgOpenPrice.toFixed(2)}</span></span>
                {leg.currentPrice != null && (
                  <span className={`text-[10px] ${th.textFaint}`}>Current: <span className={th.text}>${leg.currentPrice.toFixed(2)}</span></span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Execute modal */}
      {executeAction && (
        <ExecuteModal
          pos={pos}
          action={executeAction}
          onClose={() => setExecuteAction(null)}
          onSuccess={() => { setExecuteAction(null); onRefresh?.(); }}
          th={th}
        />
      )}
    </div>
  );
}

// ── Summary Bar ────────────────────────────────────────────────────────────
function SummaryBar({ positions, th }: { positions: Position[]; th: typeof THEMES[Theme] }) {
  const totalCredit = positions.reduce((sum, p) => sum + p.creditReceived, 0);
  const totalPnl = positions.reduce((sum, p) => sum + (p.pnl ?? p.plOpen ?? 0), 0);
  const capturedPct = totalCredit > 0 ? (totalPnl / totalCredit) * 100 : 0;

  const totalAtRisk = positions.reduce((sum, p) => {
    const shorts = p.legs.filter(l => l.direction === 'Short');
    const longs  = p.legs.filter(l => l.direction === 'Long' && l.optionType === shorts[0]?.optionType);
    if (shorts[0] && longs[0]) {
      const width = Math.abs(shorts[0].strikePrice - longs[0].strikePrice);
      const qty = shorts[0].quantity;
      return sum + Math.max(0, (width * 100 * qty) - p.creditReceived);
    }
    return sum;
  }, 0);

  const totalTheta = positions.reduce((sum, p) => {
  if (p.currentValue != null && p.dte > 0) return sum + (p.currentValue / p.dte);
  if (p.dte > 0) return sum + (p.creditReceived / p.dte);
  return sum;
}, 0);

  return (
    <div className={`grid grid-cols-5 border-b ${th.border}`}>
      <div className={`p-5 border-r ${th.border} flex flex-col items-center text-center`}>
        <p className={`text-[10px] ${th.textFaint} uppercase tracking-widest mb-2`}>Open Positions</p>
        <p className={`text-3xl font-bold ${th.text}`}>{positions.length}</p>
        <p className={`text-[10px] ${th.textFaint} mt-1`}>{positions.length === 1 ? '1 position' : `${positions.length} positions`}</p>
      </div>
      <div className={`p-5 border-r ${th.border} flex flex-col items-center text-center`}>
        <p className={`text-[10px] ${th.textFaint} uppercase tracking-widest mb-2`}>Captured</p>
        <p className={`text-3xl font-bold ${totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
          {(totalPnl >= 0 ? '+' : '') + '$' + Math.abs(totalPnl).toFixed(0)}
        </p>
        <p className={`text-[10px] mt-1`} style={{ fontFamily: "'DM Mono', monospace" }}>
          <span className={`font-bold ${th.textMuted}`}>of ${totalCredit.toFixed(0)} collected</span>
          <span className={`ml-1 ${totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>· {capturedPct.toFixed(0)}%</span>
        </p>
      </div>
      <div className={`p-5 border-r ${th.border} flex flex-col items-center text-center`}>
        <p className={`text-[10px] ${th.textFaint} uppercase tracking-widest mb-2`}>50% Profit Target</p>
        <p className="text-3xl font-bold text-yellow-400" style={{ fontFamily: "'DM Mono', monospace" }}>
          {'$' + Math.round(totalCredit * 0.5)}
        </p>
        <p className={`text-[10px] mt-1`} style={{ fontFamily: "'DM Mono', monospace" }}>
          <span className={th.textFaint}>cycle goal · </span>
          <span className={totalPnl >= totalCredit * 0.5 ? 'text-emerald-400' : th.textFaint}>
            {totalCredit > 0 ? Math.round((totalPnl / (totalCredit * 0.5)) * 100) : 0}% of target captured
          </span>
        </p>
      </div>
      <div className={`p-5 border-r ${th.border} flex flex-col items-center text-center`}>
        <p className={`text-[10px] ${th.textFaint} uppercase tracking-widest mb-2`}>At Risk</p>
        <p className={`text-3xl font-bold ${th.textMuted}`} style={{ fontFamily: "'DM Mono', monospace" }}>
          {'$' + totalAtRisk.toFixed(0)}
        </p>
        <p className={`text-[10px] ${th.textFaint} mt-1`}>max loss if all expire worthless</p>
      </div>
      <div className="p-5 flex flex-col items-center text-center">
        <p className={`text-[10px] ${th.textFaint} uppercase tracking-widest mb-2`}>Est. Theta / Day</p>
        <p className="text-3xl font-bold text-blue-400" style={{ fontFamily: "'DM Mono', monospace" }}>
          {totalTheta > 0 ? '+$' + totalTheta.toFixed(2) : '—'}
        </p>
        <p className={`text-[10px] ${th.textFaint} mt-1`}>est. daily decay across all positions</p>
      </div>
    </div>
  );
}

// ── Execute Modal ─────────────────────────────────────────────────────────
// Replaces the stub CloseModal with real order submission via TastyTrade API.
// Supports: Take Profit (BTC at 50% target), Cut Losses (BTC at mid/market),
//           Close & Roll (BTC now + prompt for new expiry/strikes),
//           Place GTC (set a GTC profit order without closing now).

type ExecStatus = 'preview' | 'submitting' | 'done' | 'error';

interface ExecResult { symbol: string; action: ActionType; orderId?: string; error?: string; }

function ExecuteModal({ pos, action, onClose, onSuccess, th }: {
  pos: Position;
  action: ActionType;
  onClose: () => void;
  onSuccess: () => void;
  th: typeof THEMES[Theme];
}) {
  const [status, setStatus] = useState<ExecStatus>('preview');
  const [results, setResults] = useState<ExecResult[]>([]);
  const [errorMsg, setErrorMsg] = useState('');

  // Roll-specific state
  const [rollExpiry, setRollExpiry] = useState('');
  const [rollShortStrike, setRollShortStrike] = useState('');
  const [rollLongStrike, setRollLongStrike] = useState('');
  const [rollCredit, setRollCredit] = useState('');

  const closePrice = pos.currentValue != null
    ? parseFloat((pos.currentValue / 100).toFixed(2))
    : parseFloat((pos.creditReceived * 0.5 / 100).toFixed(2));

  const targetClose = parseFloat((pos.creditReceived * pos.profitTarget / 100).toFixed(2));

  const orderDescription = () => {
    switch (action) {
      case 'TAKE_PROFIT': return { title: '✓ Take Profit', subtitle: `Buy to Close all legs — limit $${targetClose.toFixed(2)} (${Math.round(pos.profitTarget * 100)}% of credit)`, tif: 'Day', color: 'text-emerald-400', price: targetClose };
      case 'CUT_LOSSES':  return { title: '✕ Cut Losses',  subtitle: `Buy to Close all legs — limit $${closePrice.toFixed(2)} (current mid price)`, tif: 'Day', color: 'text-red-400', price: closePrice };
      case 'CLOSE_ROLL':  return { title: '↻ Close & Roll', subtitle: `Step 1: Buy to Close current spread at mid. Step 2: Sell new spread.`, tif: 'Day', color: 'text-purple-400', price: closePrice };
      case 'PLACE_GTC':   return { title: '⏱ Place GTC Profit Order', subtitle: `Good-Till-Cancelled limit order at $${targetClose.toFixed(2)} — fires automatically when profit target hit`, tif: 'GTC', color: 'text-blue-400', price: targetClose };
      default: return { title: action, subtitle: '', tif: 'Day', color: 'text-white', price: closePrice };
    }
  };

  const desc = orderDescription();

  const submit = async () => {
    setStatus('submitting');
    setErrorMsg('');
    try {
      const token = await getAccessToken();
      const acct = pos.accountNumber;

      if (action === 'TAKE_PROFIT') {
        const body = buildCloseOrder(pos, targetClose, 'Day');
        const res = await ttPost(`/accounts/${acct}/orders`, token, body);
        const orderId = res?.data?.order?.id ?? res?.data?.id;
        setResults([{ symbol: pos.symbol, action, orderId: String(orderId ?? 'submitted') }]);

      } else if (action === 'CUT_LOSSES') {
        const body = buildCloseOrder(pos, closePrice, 'Day');
        const res = await ttPost(`/accounts/${acct}/orders`, token, body);
        const orderId = res?.data?.order?.id ?? res?.data?.id;
        setResults([{ symbol: pos.symbol, action, orderId: String(orderId ?? 'submitted') }]);

      } else if (action === 'PLACE_GTC') {
        const body = buildGtcProfitOrder(pos);
        const res = await ttPost(`/accounts/${acct}/orders`, token, body);
        const orderId = res?.data?.order?.id ?? res?.data?.id;
        setResults([{ symbol: pos.symbol, action, orderId: String(orderId ?? 'submitted') }]);

      } else if (action === 'CLOSE_ROLL') {
        const expiry = rollExpiry.trim();
        const shortS = parseFloat(rollShortStrike);
        const longS  = parseFloat(rollLongStrike);
        const credit = parseFloat(rollCredit);
        if (!expiry || isNaN(shortS) || isNaN(longS) || isNaN(credit)) {
          throw new Error('Fill in all roll fields before submitting.');
        }
        const { close, open } = buildRollOrders(pos, expiry, shortS, longS, credit);
        // Submit close first
        const closeRes = await ttPost(`/accounts/${acct}/orders`, token, close);
        const closeId = closeRes?.data?.order?.id ?? closeRes?.data?.id;
        // Then submit open
        const openRes = await ttPost(`/accounts/${acct}/orders`, token, open!);
        const openId = openRes?.data?.order?.id ?? openRes?.data?.id;
        setResults([
          { symbol: pos.symbol, action: 'CUT_LOSSES',   orderId: `Close #${closeId}` },
          { symbol: pos.symbol, action: 'TAKE_PROFIT', orderId: `Open #${openId}` },
        ]);
      }

      setStatus('done');
    } catch (e: any) {
      setErrorMsg(e.message ?? 'Unknown error');
      setStatus('error');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className={`${th.sidebar} border ${th.border} rounded-2xl w-full max-w-md`} style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>

        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${th.border}`}>
          <div>
            <p className={`text-[10px] tracking-widest font-bold ${desc.color}`}>{desc.title}</p>
            <h2 className={`text-base font-bold ${th.text} mt-0.5`} style={{ fontFamily: "'DM Mono', monospace" }}>
              {pos.symbol} <span className={`text-xs ${stratColor(pos.strategy).split(' ')[0]}`}>{pos.strategy}</span>
            </h2>
            <p className={`text-[10px] ${th.textFaint} mt-0.5`}>{pos.expDate} · {pos.dte} DTE</p>
          </div>
          <button onClick={onClose} className={`text-xl ${th.textFaint} hover:${th.text}`}>✕</button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">

          {status === 'preview' && (
            <>
              {/* Order summary */}
              <div className={`rounded-lg border ${th.border} p-4 space-y-2`}>
                <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest`}>Order Preview</p>
                <p className={`text-xs ${th.textMuted}`}>{desc.subtitle}</p>
                <div className="flex items-center justify-between mt-2">
                  <span className={`text-[10px] ${th.textFaint}`}>Time in force</span>
                  <span className={`text-[10px] font-bold ${th.text}`}>{desc.tif}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className={`text-[10px] ${th.textFaint}`}>Limit price (debit)</span>
                  <span className={`text-[10px] font-bold text-blue-400`} style={{ fontFamily: "'DM Mono', monospace" }}>${desc.price.toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className={`text-[10px] ${th.textFaint}`}>Credit collected</span>
                  <span className={`text-[10px] font-bold text-emerald-400`} style={{ fontFamily: "'DM Mono', monospace" }}>${(pos.creditReceived / 100).toFixed(2)}</span>
                </div>
                {pos.pnl != null && (
                  <div className="flex items-center justify-between">
                    <span className={`text-[10px] ${th.textFaint}`}>Est. P&L at close</span>
                    <span className={`text-[10px] font-bold ${pos.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                      {pos.pnl >= 0 ? '+' : ''}${pos.pnl.toFixed(2)}
                    </span>
                  </div>
                )}
              </div>

              {/* Legs */}
              <div className={`rounded-lg border ${th.border} p-4`}>
                <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-2`}>Legs</p>
                <div className="space-y-1.5">
                  {pos.legs.map((leg, i) => {
                    const closeAction = leg.direction === 'Short' ? 'Buy to Close' : 'Sell to Close';
                    return (
                      <div key={i} className="flex items-center justify-between text-[10px]">
                        <span className={`font-bold ${leg.direction === 'Short' ? 'text-red-400' : 'text-emerald-400'} w-12`}>{leg.direction}</span>
                        <span className={`${th.textFaint} flex-1`} style={{ fontFamily: "'DM Mono', monospace" }}>
                          {leg.quantity}x {leg.strikePrice} {leg.optionType === 'P' ? 'Put' : 'Call'}
                        </span>
                        <span className={`text-blue-400 font-bold`}>{closeAction}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Roll-specific inputs */}
              {action === 'CLOSE_ROLL' && (
                <div className={`rounded-lg border border-purple-700/50 bg-purple-500/5 p-4 space-y-3`}>
                  <p className={`text-[9px] text-purple-400 uppercase tracking-widest`}>New Spread (Roll Target)</p>
                  <p className={`text-[10px] ${th.textFaint}`}>Enter the details for the new spread to open after closing this one.</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <p className={`text-[9px] ${th.textFaint} mb-1`}>New Expiry (YYYY-MM-DD)</p>
                      <input value={rollExpiry} onChange={e => setRollExpiry(e.target.value)} placeholder="2025-08-15"
                        className={`w-full text-xs px-2 py-1.5 rounded border ${th.inputBorder} ${th.input} ${th.text} outline-none focus:border-purple-500`} style={{ fontFamily: "'DM Mono', monospace" }} />
                    </div>
                    <div>
                      <p className={`text-[9px] ${th.textFaint} mb-1`}>Target Credit ($)</p>
                      <input value={rollCredit} onChange={e => setRollCredit(e.target.value)} placeholder="1.50" type="number" step="0.05"
                        className={`w-full text-xs px-2 py-1.5 rounded border ${th.inputBorder} ${th.input} ${th.text} outline-none focus:border-purple-500`} style={{ fontFamily: "'DM Mono', monospace" }} />
                    </div>
                    <div>
                      <p className={`text-[9px] ${th.textFaint} mb-1`}>New Short Strike</p>
                      <input value={rollShortStrike} onChange={e => setRollShortStrike(e.target.value)} placeholder="490" type="number"
                        className={`w-full text-xs px-2 py-1.5 rounded border ${th.inputBorder} ${th.input} ${th.text} outline-none focus:border-purple-500`} style={{ fontFamily: "'DM Mono', monospace" }} />
                    </div>
                    <div>
                      <p className={`text-[9px] ${th.textFaint} mb-1`}>New Long Strike</p>
                      <input value={rollLongStrike} onChange={e => setRollLongStrike(e.target.value)} placeholder="485" type="number"
                        className={`w-full text-xs px-2 py-1.5 rounded border ${th.inputBorder} ${th.input} ${th.text} outline-none focus:border-purple-500`} style={{ fontFamily: "'DM Mono', monospace" }} />
                    </div>
                  </div>
                  <p className={`text-[9px] text-yellow-400`}>⚠ Roll submits two separate orders: close (Day) then open (GTC). Verify fills before leaving.</p>
                </div>
              )}

              <p className={`text-[9px] ${th.textFaint} text-center`}>Orders are submitted directly to TastyTrade. Verify in your Positions tab after submission.</p>
            </>
          )}

          {status === 'submitting' && (
            <div className="py-8 flex flex-col items-center gap-3">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <p className={`text-xs ${th.textFaint} tracking-widest`}>SUBMITTING ORDER...</p>
            </div>
          )}

          {status === 'done' && (
            <div className="py-4 space-y-3">
              <div className="flex flex-col items-center gap-2 py-2">
                <span className="text-2xl">✓</span>
                <p className="text-sm font-bold text-emerald-400 tracking-wider">ORDER SUBMITTED</p>
              </div>
              {results.map((r, i) => (
                <div key={i} className={`flex items-center justify-between p-3 rounded-lg border ${th.border}`}>
                  <span className={`text-xs font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{r.symbol}</span>
                  <span className={`text-[10px] ${th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>Order #{r.orderId}</span>
                </div>
              ))}
              <p className={`text-[10px] ${th.textFaint} text-center`}>Check your TastyTrade Working Orders tab to confirm.</p>
            </div>
          )}

          {status === 'error' && (
            <div className="py-4 space-y-3">
              <div className="flex flex-col items-center gap-2 py-2">
                <span className="text-2xl">✕</span>
                <p className="text-sm font-bold text-red-400 tracking-wider">ORDER FAILED</p>
              </div>
              <div className={`p-3 rounded-lg bg-red-500/10 border border-red-500/40`}>
                <p className="text-xs text-red-300" style={{ fontFamily: "'DM Mono', monospace" }}>{errorMsg}</p>
              </div>
              <p className={`text-[10px] ${th.textFaint} text-center`}>No order was placed. Check credentials and try again, or go to TastyTrade directly.</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`px-5 py-4 border-t ${th.border} flex gap-3`}>
          {status === 'preview' && (
            <>
              <button onClick={submit}
                className={`flex-1 py-3 rounded-xl text-xs font-bold tracking-widest transition-colors ${
                  action === 'TAKE_PROFIT' ? 'bg-emerald-600 hover:bg-emerald-500 text-white' :
                  action === 'CUT_LOSSES'  ? 'bg-red-600 hover:bg-red-500 text-white' :
                  action === 'CLOSE_ROLL'  ? 'bg-purple-600 hover:bg-purple-500 text-white' :
                  action === 'PLACE_GTC'   ? 'bg-blue-600 hover:bg-blue-500 text-white' :
                  'bg-slate-600 hover:bg-slate-500 text-white'
                }`}>
                SUBMIT ORDER
              </button>
              <button onClick={onClose}
                className={`px-4 py-3 border ${th.border} ${th.textFaint} rounded-xl text-xs font-medium transition-colors hover:border-white/30`}>
                Cancel
              </button>
            </>
          )}
          {(status === 'done' || status === 'error') && (
            <>
              <button onClick={() => { onSuccess(); onClose(); }}
                className="flex-1 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold tracking-widest transition-colors">
                DONE — REFRESH POSITIONS
              </button>
              <a href="https://my.tastytrade.com" target="_blank" rel="noopener noreferrer"
                className={`px-4 py-3 border ${th.border} ${th.textFaint} rounded-xl text-xs font-medium hover:border-white/30 transition-colors flex items-center`}>
                TT ↗
              </a>
            </>
          )}
          {status === 'submitting' && (
            <button disabled className="flex-1 py-3 bg-slate-700 text-slate-400 rounded-xl text-xs font-bold tracking-widest">
              SUBMITTING...
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Legacy alias kept so nothing else breaks
function CloseModal({ positions, selected, onClose, th }: { positions: Position[]; selected: Map<string, ActionType>; onClose: () => void; th: typeof THEMES[Theme] }) {
  return null; // replaced by ExecuteModal — kept to avoid import errors
}

// ── Main Page ──────────────────────────────────────────────────────────────
export default function PortfolioPage() {
  const [theme, setTheme] = useState<Theme>(getSavedTheme);
  const th = THEMES[theme];

  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [selected, setSelected] = useState<Map<string, ActionType>>(new Map());

  const toggleSelected = (key: string, action: ActionType) => {
    setSelected(prev => {
      const next = new Map(prev);
      if (next.get(key) === action) next.delete(key);
      else next.set(key, action);
      return next;
    });
  };

  const handleProfitTargetChange = (key: string, value: number) => {
    try {
      const targets = JSON.parse(localStorage.getItem(LS_PROFIT_TARGETS) ?? '{}');
      targets[key] = value;
      localStorage.setItem(LS_PROFIT_TARGETS, JSON.stringify(targets));
    } catch {}
    setPositions(prev => prev.map(p => {
      if (p.key !== key) return p;
      const targetPrice = p.creditReceived * value;
      const hitTarget = p.pnl != null && p.pnl >= p.creditReceived * value;
      return { ...p, profitTarget: value, targetPrice, hitTarget };
    }));
  };

  const fetchPositions = async () => {
    setLoading(true); setError(''); setSelected(new Map());
    try {
      const data = await loadPositions();
      setPositions(data);
      setLastRefresh(new Date());
    } catch (e: any) {
      if (e.message === 'Not authenticated' || e.message === 'Session expired') {
        window.location.href = '/login';
        return;
      }
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchPositions(); }, []);

  const needsClose = positions.filter(p => p.needsClose);
  const hitTarget  = positions.filter(p => p.hitTarget && !p.needsClose);
  const normal     = positions.filter(p => !p.needsClose && !p.hitTarget);

  return (
    <div className={`min-h-screen ${th.bg} transition-colors duration-200`} style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>

      {/* Header */}
      <div className={`${th.header} border-b ${th.border} px-6 py-4 flex items-center justify-between`}>
        <div className="flex items-center gap-6">
          <div>
            <h1 className="text-base font-bold tracking-widest text-white" style={{ fontFamily: "'DM Mono', monospace" }}>OPTIONS HUNTER</h1>
            <p className="text-[10px] text-white/50 mt-0.5 tracking-wider" style={{ fontFamily: "'DM Mono', monospace" }}>PORTFOLIO MANAGEMENT</p>
          </div>
          <nav className="flex items-center gap-1 bg-black/20 rounded-lg p-1">
            <Link href="/" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">HUNTER</Link>
            <span className="text-xs px-3 py-1.5 rounded bg-white/20 text-white tracking-wider">PORTFOLIO</span>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && <span className="text-[10px] text-white/30">Updated {lastRefresh.toLocaleTimeString()}</span>}
          <a href="https://my.tastytrade.com" target="_blank" rel="noopener noreferrer"
            className="text-[10px] px-3 py-1.5 border border-white/20 text-white/60 rounded hover:border-white/40 hover:text-white/80 transition-colors tracking-wider">
            TastyTrade ↗
          </a>
          <button onClick={fetchPositions} disabled={loading}
            className="text-[10px] px-3 py-1.5 border border-white/20 text-white/60 rounded hover:border-white/40 hover:text-white/80 transition-colors tracking-wider disabled:opacity-40">
            {loading ? 'LOADING...' : '↻ REFRESH'}
          </button>
          <button
            onClick={() => { sessionStorage.removeItem('tt_access_token'); window.location.href = '/login'; }}
            className="text-[10px] px-3 py-1.5 border border-white/10 text-white/30 rounded hover:border-white/30 hover:text-white/60 transition-colors tracking-wider">
            SIGN OUT
          </button>
          <ThemeToggle theme={theme} setTheme={setTheme} />
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-6 mt-4 p-4 bg-red-500/10 border border-red-500 rounded-lg text-red-400 text-sm">{error}</div>
      )}

      {/* Loading state */}
      {loading && positions.length === 0 && (
        <div className="flex items-center justify-center h-64">
          <div className={`text-sm ${th.textFaint} tracking-widest`}>FETCHING POSITIONS...</div>
        </div>
      )}

      {/* No positions */}
      {!loading && !error && positions.length === 0 && (
        <div className="flex flex-col items-center justify-center h-64 gap-2">
          <p className={`text-sm ${th.textFaint} tracking-widest`}>NO OPEN POSITIONS FOUND</p>
          <p className={`text-xs ${th.textFaint}`}>Options positions from your TastyTrade account will appear here</p>
        </div>
      )}

      {/* Content */}
      {positions.length > 0 && (
        <>
          <SummaryBar positions={positions} th={th} />

          <div className="overflow-x-auto">
            <div className="p-6 space-y-6" style={{ minWidth: '1200px' }}>  

              {needsClose.length > 0 && (
                <div>
                  <p className="text-[10px] text-red-400 tracking-widest mb-3 font-bold uppercase">⚠ Close Now — Decayed to 21 DTE or Less</p>
                  <div className="space-y-2">{needsClose.map(p => <PositionCard key={p.key} pos={p} th={th} selectedAction={selected.get(p.key) ?? null} onToggleSelect={toggleSelected} onProfitTargetChange={handleProfitTargetChange} onRefresh={fetchPositions} />)}</div>
                </div>
              )}

              {hitTarget.length > 0 && (
                <div>
                  <p className="text-[10px] text-emerald-400 tracking-widest mb-3 font-bold uppercase">✓ Profit Target Hit</p>
                  <div className="space-y-2">{hitTarget.map(p => <PositionCard key={p.key} pos={p} th={th} selectedAction={selected.get(p.key) ?? null} onToggleSelect={toggleSelected} onProfitTargetChange={handleProfitTargetChange} onRefresh={fetchPositions} />)}</div>
                </div>
              )}

              {normal.length > 0 && (
                <div>
                  <p className={`text-[10px] ${th.textFaint} tracking-widest mb-3 font-bold uppercase`}>Active Positions</p>
                  <div className="space-y-2">{normal.map(p => <PositionCard key={p.key} pos={p} th={th} selectedAction={selected.get(p.key) ?? null} onToggleSelect={toggleSelected} onProfitTargetChange={handleProfitTargetChange} onRefresh={fetchPositions} />)}</div>
                </div>
              )}

            </div>
          </div>
        </>
      )}

    </div>
  );
}
