'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
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
const LS_AUDIT_LOG = 'prosper-audit-log';
const LS_THEME = 'prosper-theme';
const STALE_PRICE_THRESHOLD = 0.15; // 15% move triggers warning
const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MIN = 30;
const MARKET_CLOSE_HOUR = 16;

// ── Types ──────────────────────────────────────────────────────────────────
type Theme = 'dark' | 'medium' | 'light';
type ActionType = 'HOLD' | 'WATCH' | 'MANAGE' | 'TAKE_PROFIT' | 'CUT_LOSSES' | 'CLOSE_ROLL' | 'PLACE_GTC';

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
  // Greeks
  ivr: number | null;
  iv: number | null;          // current implied volatility %
  hv30: number | null;        // 30-day historical volatility %
  beta: number | null;        // beta to SPY
  netDelta: number | null;    // net position delta
  netVega: number | null;     // net position vega
  hasGtc: boolean;
  stopLossStatus: StopStatus;
  stopLossPrice: number | null;
  stockPrice: number | null;
  buffer: number | null;
  theta: number | null;
  gamma: number | null;
  earningsDate: string | null; // next earnings within 60 days
}

interface PositionAnalysis {
  positionKey: string;
  symbol: string;
  loading: boolean;
  error: string | null;
  recommendation: 'HOLD' | 'CLOSE' | 'ROLL' | 'TAKE_PROFIT' | 'CUT_LOSSES' | 'WATCH' | 'MANAGE';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  summary: string;       // 1-2 sentence TL;DR
  reasoning: string;     // full reasoning paragraph
  risks: string[];       // 2-4 bullet risks
  catalysts: string[];   // 1-3 positive factors
  deviatesFromRules: boolean;
  deviationNote: string | null; // when AI recommends outside standard rules, explain why
  generatedAt: string;
}

interface PortfolioAnalysis {
  loading: boolean;
  error: string | null;
  netDelta: number | null;
  dominantRisk: string;
  sectorConcentration: string[];
  thetaYield: string;
  topRisks: string[];
  priorityActions: string[];
  marketContext: string;
  summary: string;
  generatedAt: string;
}

type StopStatus = 'live' | 'loose' | 'none' | 'unknown';

interface GtcOrderLeg { symbol: string; action: string; }
interface GtcOrder {
  id: string; price: string; stopPrice: string | null;
  orderType: string; timeInForce: string; legs: GtcOrderLeg[];
}
interface StopLossInfo { status: StopStatus; price: number | null; }

interface TrendResult {
  trend: 'uptrend' | 'downtrend' | 'sideways' | 'unknown';
  strategy: 'BPS' | 'BCS' | 'IC' | 'NO_TRADE';
  confidence: number;
  reason: string;
}

interface AuditEntry {
  id: string;
  timestamp: string;
  symbol: string;
  strategy: string;
  action: ActionType;
  orderType: string;
  limitPrice: number;
  quantity: number;
  orderId: string;
  status: 'submitted' | 'error';
  error?: string;
  estPnl?: number;
}

interface OrderLeg {
  symbol: string;
  quantity: number;
  action: 'Buy to Close' | 'Sell to Open' | 'Buy to Open' | 'Sell to Close';
  'instrument-type': 'Equity Option' | 'Index Option';
}
interface OrderBody {
  'order-type': 'Limit' | 'Market';
  'time-in-force': 'GTC' | 'Day';
  price?: string;
  legs: OrderLeg[];
  source?: string;
}

interface BatchOrderItem {
  pos: Position;
  action: ActionType;
  orderBody: OrderBody;
  limitPrice: number;
  estPnl: number | null;
  stalePriceWarning: boolean;
  freshPrice: number | null;
  duplicateGtcWarning: boolean;
  // roll-specific
  rollExpiry?: string;
  rollShortStrike?: number;
  rollLongStrike?: number;
  rollCredit?: number;
  openOrderBody?: OrderBody;
}

interface OrderResult {
  symbol: string;
  action: ActionType;
  orderId: string;
  status: 'filled' | 'working' | 'rejected' | 'submitted' | 'error';
  error?: string;
  limitPrice: number;
  estPnl: number | null;
}

interface RollSuggestion {
  expiry: string;
  shortStrike: number;
  longStrike: number;
  credit: number;
  delta: number;
}

// ── Theme ──────────────────────────────────────────────────────────────────
const THEMES: Record<Theme, {
  bg: string; sidebar: string; card: string; border: string; borderLight: string;
  header: string; text: string; textMuted: string; textFaint: string;
  input: string; inputBorder: string; tag: string; label: string;
}> = {
  dark:   { bg: 'bg-[#0a0a0a]', sidebar: 'bg-[#0f0f0f]', card: 'bg-[#171717]', border: 'border-[#2c2c2c]', borderLight: 'border-[#202020]', header: 'bg-[#0f0f0f]', text: 'text-white', textMuted: 'text-[#e0e0e0]', textFaint: 'text-[#808080]', input: 'bg-[#141414]', inputBorder: 'border-[#353535]', tag: 'bg-[#222222]', label: 'text-[#aaaaaa]' },
  medium: { bg: 'bg-[#141414]', sidebar: 'bg-[#1a1a1a]', card: 'bg-[#202020]', border: 'border-[#333333]', borderLight: 'border-[#282828]', header: 'bg-[#1a1a1a]', text: 'text-white', textMuted: 'text-[#d8d8d8]', textFaint: 'text-[#777777]', input: 'bg-[#1e1e1e]', inputBorder: 'border-[#3a3a3a]', tag: 'bg-[#2a2a2a]', label: 'text-[#999999]' },
  light:  { bg: 'bg-[#f5f5f5]', sidebar: 'bg-white', card: 'bg-white', border: 'border-[#e0e0e0]', borderLight: 'border-[#ebebeb]', header: 'bg-[#111111]', text: 'text-[#111111]', textMuted: 'text-[#1a1a1a]', textFaint: 'text-[#666666]', input: 'bg-white', inputBorder: 'border-[#cccccc]', tag: 'bg-[#f0f0f0]', label: 'text-[#444444]' },
};

function getSavedTheme(): Theme {
  try { const t = localStorage.getItem(LS_THEME); return (t === 'dark' || t === 'medium' || t === 'light') ? t : 'dark'; } catch { return 'dark'; }
}

// ── Market Hours ───────────────────────────────────────────────────────────
function isMarketOpen(): boolean {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const etOffset = -5 * 60; // EST (ignores DST — good enough for a guard)
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const etMin = utcMin + etOffset;
  const openMin = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN;
  const closeMin = MARKET_CLOSE_HOUR * 60;
  return etMin >= openMin && etMin < closeMin;
}

function getMarketStatus(): { open: boolean; label: string } {
  const open = isMarketOpen();
  return { open, label: open ? '● Market Open' : '○ Market Closed' };
}

// ── Audit Log ──────────────────────────────────────────────────────────────
function readAuditLog(): AuditEntry[] {
  try { return JSON.parse(localStorage.getItem(LS_AUDIT_LOG) ?? '[]'); } catch { return []; }
}

function writeAuditEntry(entry: AuditEntry) {
  try {
    const log = readAuditLog();
    log.unshift(entry);
    if (log.length > 500) log.length = 500; // cap at 500 entries
    localStorage.setItem(LS_AUDIT_LOG, JSON.stringify(log));
  } catch {}
}

function exportAuditCsv() {
  const log = readAuditLog();
  if (log.length === 0) return;
  const headers = ['Timestamp', 'Symbol', 'Strategy', 'Action', 'Order Type', 'Limit Price', 'Quantity', 'Order ID', 'Status', 'Est P&L', 'Error'];
  const rows = log.map(e => [
    e.timestamp, e.symbol, e.strategy, e.action, e.orderType,
    e.limitPrice.toFixed(2), e.quantity, e.orderId, e.status,
    e.estPnl?.toFixed(2) ?? '', e.error ?? ''
  ]);
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `prosper-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

// ── Auth & API ─────────────────────────────────────────────────────────────
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
    sessionStorage.removeItem('tt_access_token');
    localStorage.removeItem('tt_refresh_token');
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  const data = await res.json();
  const token = data.access_token;
  if (!token) { window.location.href = '/login'; throw new Error('No token'); }
  sessionStorage.setItem('tt_access_token', token);
  if (data.refresh_token && data.refresh_token !== refreshToken) localStorage.setItem('tt_refresh_token', data.refresh_token);
  return token;
}

async function ttFetch(path: string, token: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
  });
  if (res.status === 401) { sessionStorage.removeItem('tt_access_token'); window.location.href = '/login'; throw new Error('Session expired'); }
  if (!res.ok) { const text = await res.text(); throw new Error(`${path} failed (${res.status}): ${text.slice(0, 120)}`); }
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

// ── Fresh Price Fetch ──────────────────────────────────────────────────────
async function fetchFreshPositionPrice(pos: Position, token: string): Promise<number | null> {
  try {
    const symbols = pos.legs.map(l => l.symbol);
    const qs = symbols.map(s => `equity-option=${encodeURIComponent(s)}`).join('&');
    const data = await ttFetch(`/market-data/by-type?${qs}`, token);
    const items: any[] = data?.data?.items ?? [];
    let total = 0;
    for (const leg of pos.legs) {
      const item = items.find((i: any) => i.symbol?.replace(/\s+/g, '') === leg.symbol?.replace(/\s+/g, ''));
      if (!item) return null;
      const bid = parseFloat(item.bid ?? '0');
      const ask = parseFloat(item.ask ?? '0');
      const mid = (bid + ask) / 2;
      total += leg.direction === 'Short' ? mid * leg.quantity : -(mid * leg.quantity);
    }
    return Math.abs(total * 100);
  } catch { return null; }
}

// ── Roll Chain Suggestion ──────────────────────────────────────────────────
async function fetchRollSuggestion(pos: Position, token: string): Promise<RollSuggestion | null> {
  try {
    const optType = pos.strategy === 'BCS' ? 'C' : 'P';
    const targetDelta = pos.strategy === 'BCS' ? 0.25 : -0.25;

    // Get expirations
    const chainData = await ttFetch(`/option-chains/${encodeURIComponent(pos.symbol)}/expirations`, token);
    const expirations: any[] = chainData?.data?.items ?? [];

    // Find next expiry 30-45 DTE
    const today = new Date();
    const target = expirations.find((e: any) => {
      const d = Math.round((new Date(e['expiration-date']).getTime() - today.getTime()) / 86400000);
      return d >= 28 && d <= 50;
    });
    if (!target) return null;

    const expiry = target['expiration-date'];
    const strikeData = await ttFetch(
      `/option-chains/${encodeURIComponent(pos.symbol)}/nested?expiration-date=${expiry}`,
      token
    );

    const strikes: any[] = strikeData?.data?.items?.[0]?.strikes ?? [];
    // Find the strike closest to target delta
    let best: any = null;
    let bestDiff = Infinity;
    for (const s of strikes) {
      const legs = s[optType === 'P' ? 'put' : 'call'];
      if (!legs) continue;
      const delta = parseFloat(legs?.delta ?? '0');
      const diff = Math.abs(delta - targetDelta);
      if (diff < bestDiff) { bestDiff = diff; best = { strike: s['strike-price'], delta, bid: parseFloat(legs?.bid ?? '0'), ask: parseFloat(legs?.ask ?? '0') }; }
    }
    if (!best) return null;

    // Spread width = same as original
    const origShort = pos.legs.find(l => l.direction === 'Short');
    const origLong  = pos.legs.find(l => l.direction === 'Long');
    if (!origShort || !origLong) return null;
    const width = Math.abs(origShort.strikePrice - origLong.strikePrice);

    const shortStrike = best.strike;
    const longStrike = pos.strategy === 'BCS' ? shortStrike + width : shortStrike - width;
    const credit = parseFloat(((best.bid + best.ask) / 2 * 0.7).toFixed(2)); // conservative estimate

    return { expiry, shortStrike, longStrike, credit, delta: best.delta };
  } catch { return null; }
}

// ── OCC Symbol Builder ─────────────────────────────────────────────────────
function buildOccSymbol(underlying: string, expiry: string, optType: 'P' | 'C', strike: number): string {
  const exp = expiry.replace(/-/g, '').slice(2); // YYMMDD
  const under = underlying.padEnd(6, ' ');
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${under}${exp}${optType}${strikeStr}`;
}

function instrType(symbol: string): 'Equity Option' | 'Index Option' {
  return ['SPX', 'NDX', 'RUT', 'VIX'].includes(symbol.toUpperCase().trim()) ? 'Index Option' : 'Equity Option';
}

// ── Order Builders ─────────────────────────────────────────────────────────
function buildCloseOrder(pos: Position, limitPrice: number, tif: 'GTC' | 'Day' = 'Day'): OrderBody {
  const itype = instrType(pos.symbol);
  // If market is closed and tif=Day, auto-upgrade to GTC so it queues for open
  const effectiveTif = (!isMarketOpen() && tif === 'Day') ? 'GTC' : tif;
  return {
    'order-type': 'Limit',
    'time-in-force': effectiveTif,
    price: limitPrice.toFixed(2),
    legs: pos.legs.map(leg => ({
      symbol: leg.symbol.trim(),
      quantity: leg.quantity,
      action: leg.direction === 'Short' ? 'Buy to Close' : 'Sell to Close',
      'instrument-type': itype,
    })),
    source: 'WEB',
  };
}

function buildOpenSpreadOrder(
  underlying: string, expiry: string, optType: 'P' | 'C',
  shortStrike: number, longStrike: number, quantity: number, credit: number
): OrderBody {
  const itype = instrType(underlying);
  const shortSym = buildOccSymbol(underlying, expiry, optType, shortStrike);
  const longSym  = buildOccSymbol(underlying, expiry, optType, longStrike);
  return {
    'order-type': 'Limit',
    'time-in-force': 'GTC',
    price: (-Math.abs(credit)).toFixed(2), // negative = credit
    legs: [
      { symbol: shortSym, quantity, action: 'Sell to Open', 'instrument-type': itype },
      { symbol: longSym,  quantity, action: 'Buy to Open',  'instrument-type': itype },
    ],
    source: 'WEB',
  };
}

// ── Position Loading ───────────────────────────────────────────────────────
function parseOptionSymbol(sym: string): { optionType: 'P' | 'C'; strikePrice: number } {
  const match = sym.trim().replace(/\s+/g, '').match(/^([A-Z/]+)(\d{6})([CP])(\d{8})$/);
  if (!match) return { optionType: 'C', strikePrice: 0 };
  return { optionType: match[3] as 'P' | 'C', strikePrice: parseInt(match[4], 10) / 1000 };
}

function normalizeOccSymbol(symbol: string): string { return String(symbol ?? '').replace(/\s+/g, '').trim(); }
function normalizeOrderAction(action: string): string { return String(action ?? '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase(); }
function isBuyToCloseAction(action: string): boolean { const n = normalizeOrderAction(action); return n === 'buy to close' || n === 'btc'; }
function isStopOrder(order: GtcOrder): boolean { return Boolean(order.stopPrice) || order.orderType.toLowerCase().includes('stop'); }

function pickOrderField(o: any, keys: string[]): string | null {
  for (const key of keys) { const v = o?.[key]; if (v !== undefined && v !== null && String(v).trim() !== '') return String(v); }
  return null;
}

function mapGtcOrder(o: any): GtcOrder {
  return {
    id: String(o?.id ?? ''),
    price: String(o?.price ?? o?.['limit-price'] ?? ''),
    stopPrice: pickOrderField(o, ['stop-trigger', 'stop-price', 'stopPrice', 'stop', 'trigger-price']),
    orderType: String(o?.['order-type'] ?? o?.orderType ?? ''),
    timeInForce: String(o?.['time-in-force'] ?? o?.timeInForce ?? ''),
    legs: (o?.legs ?? []).map((l: any) => ({ symbol: normalizeOccSymbol(String(l?.symbol ?? '')), action: String(l?.action ?? '') })),
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
    const rawOrders = requests.flatMap(r => r.status === 'fulfilled' ? collectRawOrders(r.value) : []);
    const seen = new Set<string>();
    return rawOrders.map(mapGtcOrder).filter(order => {
      const tif = order.timeInForce.toUpperCase();
      const type = order.orderType.toLowerCase();
      if (tif !== 'GTC' || (!type.includes('limit') && !type.includes('stop')) || order.legs.length === 0) return false;
      const key = `${order.id}|${order.orderType}|${order.price}|${order.stopPrice ?? ''}|${order.legs.map(l => `${l.symbol}:${l.action}`).join(',')}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  } catch { return []; }
}

function classifyPositionStopLoss(position: Pick<Position, 'legs' | 'creditReceived'>, gtcOrders: GtcOrder[]): StopLossInfo {
  const shortLeg = position.legs.find(l => l.direction === 'Short');
  if (!shortLeg?.symbol) return { status: 'unknown', price: null };
  const creditPerContract = shortLeg.quantity > 0 ? position.creditReceived / (shortLeg.quantity * 100) : position.creditReceived / 100;
  const stopThreshold = parseFloat((creditPerContract * 2).toFixed(2));
  const shortSymbol = normalizeOccSymbol(shortLeg.symbol);
  const match = gtcOrders.find(order =>
    isStopOrder(order) && order.legs.some(leg => normalizeOccSymbol(leg.symbol) === shortSymbol && isBuyToCloseAction(leg.action))
  );
  if (!match) return { status: 'none', price: null };
  const orderPrice = parseFloat(match.stopPrice ?? match.price);
  if (isNaN(orderPrice)) return { status: 'unknown', price: null };
  return orderPrice <= stopThreshold + 0.02 ? { status: 'live', price: orderPrice } : { status: 'loose', price: orderPrice };
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
    const key = `${pos['underlying-symbol']}::${pos['expires-at']?.slice(0, 10) ?? 'unknown'}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(pos);
  }

  const allOptionSymbols = optionPositions.map((p: any) => p.symbol).filter(Boolean);
  const currentPrices: Record<string, number> = {};
  const thetaMap: Record<string, number> = {};
  const gammaMap: Record<string, number> = {};
  if (allOptionSymbols.length > 0) {
    try {
      for (let i = 0; i < allOptionSymbols.length; i += 50) {
        const chunk = allOptionSymbols.slice(i, i + 50);
        const qs = chunk.map((s: string) => `equity-option=${encodeURIComponent(s)}`).join('&');
        const priceData = await ttFetch(`/market-data/by-type?${qs}`, token);
        for (const item of priceData?.data?.items ?? []) {
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
      }
    } catch {}
  }

  const ivrMap: Record<string, number | null> = {};
  const ivMap:  Record<string, number | null> = {};
  const hv30Map: Record<string, number | null> = {};
  const betaMap: Record<string, number | null> = {};
  const earningsMap: Record<string, string | null> = {};
  try {
    const underlyingSymbols: string[] = (optionPositions as any[]).map((p: any) => String(p['underlying-symbol'])).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
    const metricsData = await ttFetch(`/market-metrics?symbols=${encodeURIComponent(underlyingSymbols.join(','))}`, token);
    for (const item of metricsData?.data?.items ?? []) {
      const sym = item['symbol'];
      // IVR
      const rawIvr = item['implied-volatility-index-rank'] ?? item['iv-rank'] ?? null;
      const parsedIvr = rawIvr != null ? parseFloat(String(rawIvr)) : NaN;
      if (!isNaN(parsedIvr)) ivrMap[sym] = parsedIvr < 1 ? Math.round(parsedIvr * 100) : Math.round(parsedIvr);
      // IV (current implied volatility as %)
      const rawIv = item['implied-volatility'] ?? item['iv'] ?? null;
      const parsedIv = rawIv != null ? parseFloat(String(rawIv)) : NaN;
      if (!isNaN(parsedIv)) ivMap[sym] = parsedIv < 1 ? Math.round(parsedIv * 100) : Math.round(parsedIv);
      // HV30
      const rawHv = item['hv-30'] ?? item['historical-volatility-30'] ?? item['hv30'] ?? null;
      const parsedHv = rawHv != null ? parseFloat(String(rawHv)) : NaN;
      if (!isNaN(parsedHv)) hv30Map[sym] = parsedHv < 1 ? Math.round(parsedHv * 100) : Math.round(parsedHv);
      // Beta
      const rawBeta = item['beta'] ?? item['beta-60-day'] ?? null;
      const parsedBeta = rawBeta != null ? parseFloat(String(rawBeta)) : NaN;
      if (!isNaN(parsedBeta)) betaMap[sym] = parsedBeta;
      // Earnings — next earnings date within 60 days
      const earningsRaw = item['earnings'] ?? item['next-earnings-date'] ?? null;
      if (earningsRaw) {
        const eDate = String(earningsRaw?.['expected-report-date'] ?? earningsRaw ?? '');
        if (eDate && eDate.match(/\d{4}-\d{2}-\d{2}/)) earningsMap[sym] = eDate;
      }
    }
  } catch {}

  const stockPrices: Record<string, number | null> = {};
  try {
    const underlyingSymbols: string[] = (optionPositions as any[]).map((p: any) => String(p['underlying-symbol'])).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
    const qs = underlyingSymbols.map(s => `equity=${encodeURIComponent(s)}`).join('&');
    const stockData = await ttFetch(`/market-data/by-type?${qs}`, token);
    for (const item of stockData?.data?.items ?? []) {
      const bid = parseFloat(item.bid ?? '0'); const ask = parseFloat(item.ask ?? '0');
      stockPrices[item.symbol] = (bid + ask) / 2;
    }
  } catch {}

  const gtcOrders = await fetchGtcOrders(accountNumber, token);
  const gtcSymbols = new Set<string>();
  for (const order of gtcOrders) for (const leg of order.legs) {
    const parsed = parseOptionSymbol(leg.symbol);
    if (parsed.strikePrice > 0) gtcSymbols.add(leg.symbol.split(/\d{6}/)[0].trim());
  }

  try {
    const [liveData, searchData] = await Promise.allSettled([
      ttFetch(`/accounts/${accountNumber}/orders/live`, token),
      ttFetch(`/accounts/${accountNumber}/orders?per-page=250`, token),
    ]);
    const allOrders = [
      ...((liveData.status === 'fulfilled' ? liveData.value?.data?.items : null) ?? []),
      ...((searchData.status === 'fulfilled' ? searchData.value?.data?.items : null) ?? []),
    ];
    for (const order of allOrders) {
      const status = (order['status'] ?? '').toLowerCase();
      if (['working', 'live', 'contingent', 'received'].includes(status)) {
        for (const leg of order.legs ?? []) {
          const sym = leg['underlying-symbol'] ?? leg.symbol ?? '';
          if (sym) gtcSymbols.add(sym.split(' ')[0].trim());
        }
      }
    }
  } catch {}

  try {
    const complexData = await ttFetch(`/accounts/${accountNumber}/complex-orders`, token);
    for (const order of complexData?.data?.items ?? []) {
      const status = (order['status'] ?? '').toLowerCase();
      if (['working', 'live', 'contingent', 'received', 'routed'].includes(status)) {
        for (const nestedOrder of order.orders ?? []) for (const leg of nestedOrder.legs ?? []) {
          const sym = leg['underlying-symbol'] ?? leg.symbol ?? '';
          if (sym) gtcSymbols.add(sym.split(' ')[0].trim());
        }
      }
    }
  } catch {}

  const plBySymbol: Record<string, number> = {};
  try {
    const plData = await ttFetch(`/accounts/${accountNumber}/positions?include-marks=true`, token);
    for (const item of plData?.data?.items ?? []) {
      const sym = item['underlying-symbol']; if (!sym) continue;
      const qty = parseFloat(item['quantity'] ?? '1');
      const multiplier = parseFloat(item['multiplier'] ?? '100');
      const avgOpen = parseFloat(item['average-open-price'] ?? '0');
      const mark = parseFloat(item['mark-price'] ?? '0');
      const dir = item['quantity-direction'] === 'Short' ? -1 : 1;
      plBySymbol[sym] = (plBySymbol[sym] ?? 0) + dir * (mark - avgOpen) * qty * multiplier;
    }
  } catch {}

  let profitTargets: Record<string, number> = {};
  try { profitTargets = JSON.parse(localStorage.getItem(LS_PROFIT_TARGETS) ?? '{}'); } catch {}

  const today = new Date();
  const positions: Position[] = Object.entries(groups).map(([key, legs]) => {
    const [symbol, expDate] = key.split('::');
    const dte = Math.round((new Date(expDate).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    const openedAt = legs[0]?.['created-at']?.slice(0, 10) ?? null;
    const entryDte = openedAt ? Math.round((new Date(expDate).getTime() - new Date(openedAt).getTime()) / (1000 * 60 * 60 * 24)) : dte;
    const putLegs = legs.filter((l: any) => parseOptionSymbol(l.symbol).optionType === 'P');
    const callLegs = legs.filter((l: any) => parseOptionSymbol(l.symbol).optionType === 'C');
    let strategy = 'UNKNOWN';
    if (putLegs.length >= 2 && callLegs.length === 0) strategy = 'BPS';
    else if (callLegs.length >= 2 && putLegs.length === 0) strategy = 'BCS';
    else if (putLegs.length >= 2 && callLegs.length >= 2) strategy = 'IC';
    else if (putLegs.length === 1) strategy = 'PUT';
    else if (callLegs.length === 1) strategy = 'CALL';

    let creditReceived = 0;
    for (const leg of legs) {
      const qty = parseInt(leg['quantity'] ?? '1', 10);
      const avgPrice = parseFloat(leg['average-open-price'] ?? '0');
      creditReceived += leg['quantity-direction'] === 'Short' ? avgPrice * qty : -(avgPrice * qty);
    }
    creditReceived = creditReceived * 100;

    let currentValue = 0; let hasCurrentPrices = true;
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
        symbol: l.symbol, optionType: parsed.optionType, strikePrice: parsed.strikePrice,
        direction: l['quantity-direction'] as 'Short' | 'Long',
        quantity: parseInt(l['quantity'] ?? '1', 10),
        avgOpenPrice: parseFloat(l['average-open-price'] ?? '0'),
        currentPrice: currentPrices[l.symbol?.replace(/\s+/g, '')] ?? null,
      };
    });

    const stopLoss = classifyPositionStopLoss({ legs: positionLegs, creditReceived: Math.abs(creditReceived) }, gtcOrders);

    return {
      key, symbol, expDate, dte, strategy, legs: positionLegs,
      creditReceived: Math.abs(creditReceived),
      currentValue: hasCurrentPrices ? Math.abs(currentValue) : null,
      pnl, pnlPct, targetPrice, profitTarget, hitTarget,
      plOpen: plBySymbol[symbol] != null ? Math.round(plBySymbol[symbol] * 100) / 100 : null,
      maxRisk: (() => {
        const shorts = legs.filter((l: any) => l['quantity-direction'] === 'Short');
        const longs  = legs.filter((l: any) => l['quantity-direction'] === 'Long');
        if (shorts[0] && longs[0]) {
          const w = Math.abs(parseOptionSymbol(shorts[0].symbol).strikePrice - parseOptionSymbol(longs[0].symbol).strikePrice);
          return Math.max(0, (w * 100 * parseInt(shorts[0]['quantity'] ?? '1', 10)) - Math.abs(creditReceived));
        }
        return 0;
      })(),
      entryDte, needsClose: entryDte > 21 && dte <= 21, accountNumber,
      ivr: ivrMap[symbol] ?? null,
      iv: ivMap[symbol] ?? null,
      hv30: hv30Map[symbol] ?? null,
      beta: betaMap[symbol] ?? null,
      earningsDate: earningsMap[symbol] ?? null,
      hasGtc: gtcSymbols.has(symbol),
      stopLossStatus: stopLoss.status, stopLossPrice: stopLoss.price,
      stockPrice: stockPrices[symbol] ?? null,
      buffer: (() => {
        const stock = stockPrices[symbol];
        if (stock == null) return null;
        const shorts = legs.filter((l: any) => l['quantity-direction'] === 'Short');
        if (!shorts[0]) return null;
        const shortStrike = parseOptionSymbol(shorts[0].symbol).strikePrice;
        const optType = parseOptionSymbol(shorts[0].symbol).optionType;
        return optType === 'P' ? ((stock - shortStrike) / stock) * 100 : ((shortStrike - stock) / stock) * 100;
      })(),
      theta: (() => {
        let net = 0; let any = false;
        for (const l of legs) {
          const val = thetaMap[l.symbol?.replace(/\s+/g, '')];
          if (val == null) continue;
          const qty = parseInt(l['quantity'] ?? '1', 10);
          net += l['quantity-direction'] === 'Short' ? Math.abs(val) * qty : -Math.abs(val) * qty;
          any = true;
        }
        return any ? parseFloat(net.toFixed(4)) : null;
      })(),
      gamma: (() => {
        let net = 0; let any = false;
        for (const l of legs) {
          const val = gammaMap[l.symbol?.replace(/\s+/g, '')];
          if (val == null) continue;
          const qty = parseInt(l['quantity'] ?? '1', 10);
          net += l['quantity-direction'] === 'Short' ? -Math.abs(val) * qty : Math.abs(val) * qty;
          any = true;
        }
        return any ? parseFloat(net.toFixed(4)) : null;
      })(),
      netDelta: (() => {
        // deltaMap not yet fetched per-leg — approximate from position Greeks
        // Short spread delta: short leg delta (negative for puts) + long leg delta
        // For now derive from buffer and strategy as a sign-only approximation
        // Will be enriched when per-leg delta is added to market data fetch
        return null;
      })(),
      netVega: (() => { return null; })(),
    };
  });

  const actionPriority: Record<string, number> = { CLOSE_ROLL: 0, CUT_LOSSES: 1, TAKE_PROFIT: 2, MANAGE: 3, WATCH: 4, HOLD: 5 };
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

// ── Recommendation Engine ──────────────────────────────────────────────────
interface Recommendation { action: ActionType; detail: string; }

function getRecommendation(pos: Position, trend: TrendResult | null): Recommendation {
  const pnlPct = pos.pnl != null && pos.creditReceived !== 0 ? (pos.pnl / pos.creditReceived) * 100 : 0;
  const targetPct = pos.profitTarget * 100;
  const trendAgainst = trend && ((pos.strategy === 'BPS' && trend.trend === 'downtrend') || (pos.strategy === 'BCS' && trend.trend === 'uptrend'));
  const trendAligns = trend && ((pos.strategy === 'BPS' && trend.trend === 'uptrend') || (pos.strategy === 'BCS' && trend.trend === 'downtrend') || (pos.strategy === 'IC' && trend.trend === 'sideways'));
  if (pos.needsClose && pnlPct >= 0) return { action: 'CLOSE_ROLL', detail: `${pos.dte} DTE — close or roll to next expiry` };
  if (pos.needsClose && pnlPct < 0)  return { action: 'CUT_LOSSES', detail: `${pos.dte} DTE — close to prevent further loss` };
  if (pos.hitTarget)                  return { action: 'TAKE_PROFIT', detail: `${Math.round(targetPct)}% target — lock in $${pos.pnl?.toFixed(2)}` };
  if (!pos.hasGtc)                    return { action: 'PLACE_GTC', detail: 'No GTC order set — place profit target' };
  if (pnlPct < -15 && trendAgainst)  return { action: 'CUT_LOSSES', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% + trend confirms — exit` };
  if (pnlPct < -15)                  return { action: 'MANAGE', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% — manage actively` };
  if (pnlPct >= targetPct)           return { action: 'TAKE_PROFIT', detail: `${pnlPct.toFixed(0)}% profit` };
  if (pnlPct < 0 && trendAgainst)    return { action: 'MANAGE', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% with adverse trend` };
  if (trendAligns)                   return { action: 'HOLD', detail: `Trend confirms ${pos.strategy} — ${pnlPct.toFixed(0)}% profit` };
  return { action: 'HOLD', detail: `${pnlPct.toFixed(0)}% profit — ${pos.dte} DTE remaining` };
}

// ── AI Analysis ───────────────────────────────────────────────────────────
const TRADING_SYSTEM_PROMPT = `You are a professional options trader and portfolio analyst with deep expertise in selling premium through credit spreads. You advise a trader who follows the Prosper Trading methodology as a foundation — but you treat those rules as informed guidelines, not rigid constraints. You understand when deviation is appropriate.

CORE METHODOLOGY (know it deeply, apply it intelligently):
- Strategies: Bull Put Spread (BPS) for bullish/neutral, Bear Call Spread (BCS) for bearish, Iron Condor (IC) for range-bound
- Entry rules (as guidelines): IVR ≥ 30, DTE 30-45, credit ≥ 1/3 spread width, OI ≥ 500, bid-ask ≤ $0.10
- Target exits: 50% profit (place GTC at entry), hard close at 21 DTE regardless of P&L
- Short strike deltas: BPS -0.20 to -0.30, BCS +0.20 to +0.30, IC ±0.16 to ±0.20
- IC requires sideways price action 2+ weeks, no higher highs/lower lows

WHEN TO DEVIATE FROM RULES (apply professional judgment):
- If IV is very high (IVR > 70) and credit is exceptional, a wider spread or slightly aggressive delta can be justified
- If a position is at 40% profit but 15 DTE with gamma risk rising sharply, closing early beats waiting for 50%
- If trend has reversed hard against a spread, cutting losses at 1.5x credit is better than waiting for 2x
- If IVR just dropped below 30 mid-trade but P&L is positive, holding can still make sense if trend confirms
- If earnings are within the window but the spread is far OTM with minimal risk, evaluate the actual probability rather than auto-skip
- Sometimes doing nothing is the hardest but best trade

ANALYSIS PRINCIPLES:
- Always consider the trend direction vs. the strategy type — a BPS in a downtrend is broken thesis
- Buffer % to short strike is critical — below 3% demands attention regardless of DTE
- High gamma near expiry (DTE < 21) magnifies risk exponentially — treat with respect
- IV vs HV comparison: if IV >> HV (IV premium), edge exists; if IV ≈ HV, edge is thin
- Theta decay accelerates in final 3 weeks — this is your friend if positioned correctly
- Net delta tells you your directional exposure — you're supposed to be mostly neutral

OUTPUT FORMAT (JSON only, no prose outside the JSON):
For position analysis:
{
  "recommendation": "HOLD|CLOSE|ROLL|TAKE_PROFIT|CUT_LOSSES|WATCH|MANAGE",
  "confidence": "HIGH|MEDIUM|LOW",
  "summary": "1-2 sentence TL;DR",
  "reasoning": "2-3 sentence explanation of your reasoning, including what the key factors are",
  "risks": ["risk 1", "risk 2", "risk 3"],
  "catalysts": ["positive factor 1", "positive factor 2"],
  "deviatesFromRules": true|false,
  "deviationNote": "null or explanation of why professional judgment overrides the standard rule"
}

For portfolio analysis:
{
  "netDeltaBias": "BULLISH|BEARISH|NEUTRAL",
  "dominantRisk": "single sentence describing the biggest portfolio-level risk",
  "sectorConcentration": ["sector concern 1", "sector concern 2"],
  "thetaYield": "qualitative assessment of theta capture rate",
  "topRisks": ["risk 1", "risk 2", "risk 3"],
  "priorityActions": ["highest priority action", "second priority", "third priority"],
  "marketContext": "how current market conditions affect this portfolio",
  "summary": "2-3 sentence overall portfolio assessment"
}

Be direct. Be honest. If a position is in trouble, say so. If a rule should be broken, explain why.`;

function buildPositionPrompt(pos: Position, trend: TrendResult | null): string {
  const pnlPct = pos.pnl != null && pos.creditReceived > 0 ? ((pos.pnl / pos.creditReceived) * 100).toFixed(1) : 'unknown';
  const ivEdge = pos.iv != null && pos.hv30 != null ? (pos.iv - pos.hv30) : null;

  return `Analyze this open options position:

POSITION: ${pos.symbol} ${pos.strategy}
Expiry: ${pos.expDate} | DTE: ${pos.dte} | Entry DTE: ${pos.entryDte}
Strikes: ${pos.legs.map(l => `${l.direction} ${l.strikePrice}${l.optionType}`).join(', ')}
Credit received: $${pos.creditReceived.toFixed(2)} | Current buyback: $${pos.currentValue?.toFixed(2) ?? 'unknown'}
P&L: ${pos.pnl != null ? `$${pos.pnl.toFixed(2)} (${pnlPct}% of credit)` : 'unknown'}
Profit target: ${Math.round(pos.profitTarget * 100)}% ($${pos.targetPrice.toFixed(2)})
Max risk: $${pos.maxRisk.toFixed(2)}

MARKET DATA:
Stock price: $${pos.stockPrice?.toFixed(2) ?? 'unknown'}
Buffer to short strike: ${pos.buffer?.toFixed(1) ?? 'unknown'}%
IVR: ${pos.ivr ?? 'unknown'}
Current IV: ${pos.iv ?? 'unknown'}%
HV30: ${pos.hv30 ?? 'unknown'}%
IV edge (IV - HV30): ${ivEdge != null ? `${ivEdge.toFixed(1)}%` : 'unknown'}
Beta: ${pos.beta ?? 'unknown'}

GREEKS (net position):
Theta: ${pos.theta?.toFixed(4) ?? 'unknown'} (daily decay)
Gamma: ${pos.gamma?.toFixed(4) ?? 'unknown'}

OPERATIONAL STATUS:
GTC order: ${pos.hasGtc ? 'Yes — profit target working' : 'No — unprotected'}
Stop loss: ${pos.stopLossStatus} ${pos.stopLossPrice ? `@ $${pos.stopLossPrice}` : ''}
Earnings within expiry: ${pos.earningsDate ? `Yes — ${pos.earningsDate}` : 'No'}

TREND ANALYSIS:
Direction: ${trend?.trend ?? 'unknown'} (confidence: ${trend?.confidence ?? 'unknown'}%)
Suggested strategy: ${trend?.strategy ?? 'unknown'}
Reason: ${trend?.reason ?? 'none'}

Flags: ${[
  pos.needsClose ? '⚠ AT 21 DTE — must close or roll' : '',
  pos.hitTarget ? '✓ Profit target hit' : '',
  !pos.hasGtc ? '⚠ No GTC order' : '',
  pos.buffer != null && pos.buffer < 3 ? `⚠ CRITICAL buffer ${pos.buffer.toFixed(1)}% — near breach` : '',
  pos.buffer != null && pos.buffer < 7 ? `⚠ Tight buffer ${pos.buffer.toFixed(1)}%` : '',
  pos.earningsDate ? `⚠ Earnings ${pos.earningsDate}` : '',
].filter(Boolean).join(', ') || 'None'}

Provide your analysis as JSON only.`;
}

function buildPortfolioPrompt(positions: Position[]): string {
  const lines = positions.map(p => {
    const pnlPct = p.pnl != null && p.creditReceived > 0 ? ((p.pnl / p.creditReceived) * 100).toFixed(0) : '?';
    return `${p.symbol} ${p.strategy}: DTE ${p.dte}, P&L ${pnlPct}%, buffer ${p.buffer?.toFixed(1) ?? '?'}%, IVR ${p.ivr ?? '?'}, ${p.needsClose ? 'NEEDS CLOSE' : p.hitTarget ? 'TARGET HIT' : 'active'}`;
  });

  const totalCredit = positions.reduce((s, p) => s + p.creditReceived, 0);
  const totalPnl = positions.reduce((s, p) => s + (p.pnl ?? 0), 0);
  const totalAtRisk = positions.reduce((s, p) => s + p.maxRisk, 0);
  const totalTheta = positions.reduce((s, p) => s + (p.theta ?? 0), 0);
  const urgentCount = positions.filter(p => p.needsClose || p.hitTarget || (p.buffer != null && p.buffer < 5)).length;

  return `Analyze this options portfolio as a whole:

PORTFOLIO SUMMARY:
${positions.length} open positions | ${urgentCount} requiring immediate attention
Total credit collected: $${totalCredit.toFixed(2)}
Current P&L: $${totalPnl.toFixed(2)} (${totalCredit > 0 ? ((totalPnl / totalCredit) * 100).toFixed(1) : 0}% of credit)
Total at risk: $${totalAtRisk.toFixed(2)}
Net theta/day: $${totalTheta.toFixed(2)}

POSITIONS:
${lines.join('\n')}

STRATEGY MIX:
BPS: ${positions.filter(p => p.strategy === 'BPS').length} | BCS: ${positions.filter(p => p.strategy === 'BCS').length} | IC: ${positions.filter(p => p.strategy === 'IC').length} | Other: ${positions.filter(p => !['BPS','BCS','IC'].includes(p.strategy)).length}

SYMBOLS: ${positions.map(p => p.symbol).filter((v, i, a) => a.indexOf(v) === i).join(', ')}

DTE DISTRIBUTION:
< 21 DTE: ${positions.filter(p => p.dte < 21).length} positions
21-30 DTE: ${positions.filter(p => p.dte >= 21 && p.dte <= 30).length} positions
> 30 DTE: ${positions.filter(p => p.dte > 30).length} positions

Provide portfolio-level analysis as JSON only.`;
}

async function callAI(userMessage: string): Promise<string> {
  // Calls our own Next.js API route which proxies to Anthropic server-side.
  // Direct browser → api.anthropic.com calls are blocked by CORS.
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: TRADING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error ?? `API error: ${res.status}`);
  }
  const data = await res.json();
  const text = data?.content?.find((b: any) => b.type === 'text')?.text ?? '';
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
}

async function analyzePosition(pos: Position, trend: TrendResult | null): Promise<PositionAnalysis> {
  const prompt = buildPositionPrompt(pos, trend);
  const raw = await callAI(prompt);
  const parsed = JSON.parse(raw);
  return {
    positionKey: pos.key,
    symbol: pos.symbol,
    loading: false,
    error: null,
    recommendation: parsed.recommendation,
    confidence: parsed.confidence,
    summary: parsed.summary,
    reasoning: parsed.reasoning,
    risks: parsed.risks ?? [],
    catalysts: parsed.catalysts ?? [],
    deviatesFromRules: parsed.deviatesFromRules ?? false,
    deviationNote: parsed.deviationNote ?? null,
    generatedAt: new Date().toISOString(),
  };
}

async function analyzePortfolio(positions: Position[]): Promise<PortfolioAnalysis> {
  const prompt = buildPortfolioPrompt(positions);
  const raw = await callAI(prompt);
  const parsed = JSON.parse(raw);
  return {
    loading: false,
    error: null,
    netDelta: null,
    dominantRisk: parsed.dominantRisk ?? '',
    sectorConcentration: parsed.sectorConcentration ?? [],
    thetaYield: parsed.thetaYield ?? '',
    topRisks: parsed.topRisks ?? [],
    priorityActions: parsed.priorityActions ?? [],
    marketContext: parsed.marketContext ?? '',
    summary: parsed.summary ?? '',
    generatedAt: new Date().toISOString(),
  };
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
  const ma20 = avg(closes.slice(-20)); const ma50 = avg(closes.slice(-50));
  const mom20 = (price - closes[closes.length - 21]) / closes[closes.length - 21];
  const low20 = Math.min(...closes.slice(-20)); const high20 = Math.max(...closes.slice(-20));
  const higherLows = low20 > Math.min(...closes.slice(-40, -20)) * 0.985;
  const lowerHighs = high20 < Math.max(...closes.slice(-40, -20)) * 1.015;
  let score = 0;
  if (price > ma20) score += 2; else score -= 2;
  if (price > ma50) score += 2; else score -= 2;
  if (ma20 > ma50) score += 2; else score -= 2;
  if (mom20 > 0.03) score += 2; else if (mom20 < -0.03) score -= 2;
  if (higherLows) score += 2; else if (lowerHighs) score -= 2;
  const confidence = Math.min(100, Math.abs(score) * 10);
  if (score >= 4) return { trend: 'uptrend', strategy: 'BPS', confidence, reason: 'Price above MA20/MA50, positive momentum' };
  if (score <= -4) return { trend: 'downtrend', strategy: 'BCS', confidence, reason: 'Price below MA20/MA50, negative momentum' };
  return { trend: 'sideways', strategy: 'IC', confidence, reason: 'Mixed signals, range-bound' };
}

// ── Helpers ────────────────────────────────────────────────────────────────
function stratColor(strategy: string) {
  if (strategy === 'BPS') return 'text-emerald-400 border-emerald-700';
  if (strategy === 'BCS') return 'text-red-400 border-red-700';
  if (strategy === 'IC')  return 'text-blue-400 border-blue-700';
  return 'text-slate-400 border-slate-700';
}
function pnlColor(pnl: number | null) { return pnl == null ? 'text-slate-400' : pnl >= 0 ? 'text-emerald-400' : 'text-red-400'; }
function dteColor(dte: number) { if (dte <= 7) return 'text-red-500 font-bold'; if (dte <= 21) return 'text-yellow-400 font-bold'; return 'text-slate-400'; }

const ACTION_META: Record<ActionType, { label: string; color: string; btnClass: string }> = {
  HOLD:        { label: '● Hold',         color: 'text-slate-400',   btnClass: 'border-slate-600 text-slate-400' },
  WATCH:       { label: '⚠ Watch',        color: 'text-yellow-400',  btnClass: 'border-yellow-700 text-yellow-400' },
  MANAGE:      { label: '⚡ Manage',       color: 'text-orange-400',  btnClass: 'border-orange-600 text-orange-400' },
  TAKE_PROFIT: { label: '✓ Take Profit',  color: 'text-emerald-400', btnClass: 'border-emerald-600 text-emerald-400 hover:bg-emerald-600/20' },
  CUT_LOSSES:  { label: '✕ Cut Losses',   color: 'text-red-400',     btnClass: 'border-red-600 text-red-400 hover:bg-red-600/20' },
  CLOSE_ROLL:  { label: '↻ Close/Roll',   color: 'text-purple-400',  btnClass: 'border-purple-600 text-purple-400 hover:bg-purple-600/20' },
  PLACE_GTC:   { label: '⏱ Place GTC',   color: 'text-blue-400',    btnClass: 'border-blue-600 text-blue-400 hover:bg-blue-600/20' },
};

function ThemeToggle({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  return (
    <div className="flex items-center gap-1 bg-black/20 rounded-lg p-1">
      {(['light', 'medium', 'dark'] as Theme[]).map((v, i) => (
        <button key={v} onClick={() => { setTheme(v); try { localStorage.setItem(LS_THEME, v); } catch {} }}
          className={`text-sm px-2 py-1 rounded transition-all ${theme === v ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white/80'}`}>
          {['☀', '◐', '☾'][i]}
        </button>
      ))}
    </div>
  );
}

// ── Batch Confirmation Modal ───────────────────────────────────────────────
type BatchStatus = 'preview' | 'enriching' | 'ready' | 'submitting' | 'done' | 'error';

function BatchConfirmModal({ items: initialItems, onClose, onSuccess, th }: {
  items: { pos: Position; action: ActionType }[];
  onClose: () => void;
  onSuccess: () => void;
  th: typeof THEMES[Theme];
}) {
  const [status, setStatus] = useState<BatchStatus>('enriching');
  const [batchItems, setBatchItems] = useState<BatchOrderItem[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [orderResults, setOrderResults] = useState<OrderResult[]>([]);
  const [submitProgress, setSubmitProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  // Roll state per position
  const [rollInputs, setRollInputs] = useState<Record<string, { expiry: string; shortStrike: string; longStrike: string; credit: string }>>({});
  const [rollSuggestions, setRollSuggestions] = useState<Record<string, RollSuggestion | null>>({});

  const marketStatus = getMarketStatus();

  // Enrich: re-fetch prices, check staleness, check duplicate GTCs, fetch roll suggestions
  useEffect(() => {
    let cancelled = false;
    async function enrich() {
      setStatus('enriching');
      try {
        const token = await getAccessToken();
        const enriched: BatchOrderItem[] = [];

        for (const { pos, action } of initialItems) {
          const freshPrice = await fetchFreshPositionPrice(pos, token);
          const stalePriceWarning = freshPrice != null && pos.currentValue != null
            ? Math.abs(freshPrice - pos.currentValue) / pos.currentValue > STALE_PRICE_THRESHOLD
            : false;

          const duplicateGtcWarning = pos.hasGtc && (action === 'TAKE_PROFIT' || action === 'CUT_LOSSES' || action === 'CLOSE_ROLL');

          const effectiveValue = freshPrice ?? pos.currentValue;
          const limitPrice = action === 'TAKE_PROFIT' || action === 'PLACE_GTC'
            ? parseFloat(((pos.creditReceived * pos.profitTarget) / 100).toFixed(2))
            : action === 'CUT_LOSSES' || action === 'CLOSE_ROLL'
            ? parseFloat(((effectiveValue ?? pos.creditReceived * 0.5) / 100).toFixed(2))
            : parseFloat(((pos.creditReceived * pos.profitTarget) / 100).toFixed(2));

          const tif = action === 'PLACE_GTC' ? 'GTC' : 'Day';
          const orderBody = buildCloseOrder(pos, limitPrice, tif);
          const estPnl = effectiveValue != null ? pos.creditReceived - effectiveValue : pos.pnl;

          const item: BatchOrderItem = {
            pos, action, orderBody, limitPrice, estPnl,
            stalePriceWarning, freshPrice, duplicateGtcWarning,
          };

          // Roll suggestion
          if (action === 'CLOSE_ROLL') {
            const suggestion = await fetchRollSuggestion(pos, token).catch(() => null);
            if (!cancelled) setRollSuggestions(prev => ({ ...prev, [pos.key]: suggestion }));
            if (suggestion && !rollInputs[pos.key]) {
              setRollInputs(prev => ({
                ...prev,
                [pos.key]: {
                  expiry: suggestion.expiry,
                  shortStrike: String(suggestion.shortStrike),
                  longStrike: String(suggestion.longStrike),
                  credit: String(suggestion.credit),
                },
              }));
            }
          }

          enriched.push(item);
          if (!cancelled) setBatchItems([...enriched]);
        }

        if (!cancelled) setStatus('ready');
      } catch (e: any) {
        if (!cancelled) { setErrorMsg(e.message); setStatus('error'); }
      }
    }
    enrich();
    return () => { cancelled = true; };
  }, []);

  const activeItems = batchItems.filter(i => !excluded.has(i.pos.key));
  const totalDebit = activeItems.reduce((s, i) => s + i.limitPrice, 0);
  const totalEstPnl = activeItems.reduce((s, i) => s + (i.estPnl ?? 0), 0);
  const warningCount = activeItems.filter(i => i.stalePriceWarning || i.duplicateGtcWarning).length;

  const submitAll = async () => {
    setStatus('submitting');
    setSubmitProgress(0);
    const results: OrderResult[] = [];
    try {
      const token = await getAccessToken();
      let completed = 0;
      for (const item of activeItems) {
        try {
          // Submit close order
          const res = await ttPost(`/accounts/${item.pos.accountNumber}/orders`, token, item.orderBody);
          const orderId = String(res?.data?.order?.id ?? res?.data?.id ?? 'submitted');

          // If roll, also submit open order
          if (item.action === 'CLOSE_ROLL') {
            const ri = rollInputs[item.pos.key];
            if (ri?.expiry && ri.shortStrike && ri.longStrike && ri.credit) {
              const optType: 'P' | 'C' = item.pos.strategy === 'BCS' ? 'C' : 'P';
              const openBody = buildOpenSpreadOrder(
                item.pos.symbol, ri.expiry, optType,
                parseFloat(ri.shortStrike), parseFloat(ri.longStrike),
                item.pos.legs[0]?.quantity ?? 1, parseFloat(ri.credit)
              );
              const openRes = await ttPost(`/accounts/${item.pos.accountNumber}/orders`, token, openBody);
              const openId = String(openRes?.data?.order?.id ?? openRes?.data?.id ?? 'submitted');

              // Log open order separately
              writeAuditEntry({
                id: crypto.randomUUID(), timestamp: new Date().toISOString(),
                symbol: item.pos.symbol, strategy: item.pos.strategy, action: 'CLOSE_ROLL',
                orderType: 'Sell to Open (Roll)', limitPrice: parseFloat(ri.credit),
                quantity: item.pos.legs[0]?.quantity ?? 1, orderId: openId, status: 'submitted',
              });

              results.push({ symbol: item.pos.symbol, action: item.action, orderId: `Close #${orderId} · Open #${openId}`, status: 'working', limitPrice: item.limitPrice, estPnl: item.estPnl });
            } else {
              results.push({ symbol: item.pos.symbol, action: item.action, orderId, status: 'working', limitPrice: item.limitPrice, estPnl: item.estPnl });
            }
          } else {
            results.push({ symbol: item.pos.symbol, action: item.action, orderId, status: 'working', limitPrice: item.limitPrice, estPnl: item.estPnl });
          }

          // Audit log
          writeAuditEntry({
            id: crypto.randomUUID(), timestamp: new Date().toISOString(),
            symbol: item.pos.symbol, strategy: item.pos.strategy, action: item.action,
            orderType: item.orderBody['order-type'], limitPrice: item.limitPrice,
            quantity: item.pos.legs[0]?.quantity ?? 1, orderId, status: 'submitted', estPnl: item.estPnl ?? undefined,
          });

        } catch (e: any) {
          results.push({ symbol: item.pos.symbol, action: item.action, orderId: '—', status: 'error', error: e.message, limitPrice: item.limitPrice, estPnl: item.estPnl });
          writeAuditEntry({
            id: crypto.randomUUID(), timestamp: new Date().toISOString(),
            symbol: item.pos.symbol, strategy: item.pos.strategy, action: item.action,
            orderType: item.orderBody['order-type'], limitPrice: item.limitPrice,
            quantity: item.pos.legs[0]?.quantity ?? 1, orderId: '—', status: 'error', error: e.message,
          });
        }
        completed++;
        setSubmitProgress(Math.round((completed / activeItems.length) * 100));
      }
      setOrderResults(results);
      setStatus('done');
    } catch (e: any) {
      setErrorMsg(e.message); setStatus('error');
    }
  };

  const filledCount  = orderResults.filter(r => r.status === 'filled' || r.status === 'working' || r.status === 'submitted').length;
  const rejectedCount = orderResults.filter(r => r.status === 'error' || r.status === 'rejected').length;

  return (
    <div className="fixed inset-0 bg-black/85 flex items-center justify-center z-50 p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div className={`${th.sidebar} border ${th.border} rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col`}>

        {/* Header */}
        <div className={`flex items-center justify-between px-6 py-4 border-b ${th.border} shrink-0`}>
          <div>
            <h2 className={`text-sm font-bold ${th.text} tracking-wider`}>
              {status === 'done' ? 'ORDER RESULTS' : status === 'submitting' ? 'SUBMITTING ORDERS...' : `REVIEW ${activeItems.length} ORDER${activeItems.length !== 1 ? 'S' : ''}`}
            </h2>
            <div className="flex items-center gap-3 mt-1">
              <span className={`text-[10px] font-bold ${marketStatus.open ? 'text-emerald-400' : 'text-yellow-400'}`}>{marketStatus.label}</span>
              {!marketStatus.open && status === 'preview' || status === 'ready' ? (
                <span className="text-[10px] text-yellow-400">Day orders auto-upgraded to GTC</span>
              ) : null}
            </div>
          </div>
          {status !== 'submitting' && <button onClick={onClose} className={`text-xl ${th.textFaint} hover:${th.text}`}>✕</button>}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">

          {/* Enriching spinner */}
          {status === 'enriching' && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <p className={`text-xs ${th.textFaint} tracking-widest`}>FETCHING LIVE PRICES & CHAIN DATA...</p>
              {batchItems.length > 0 && <p className={`text-[10px] ${th.textFaint}`}>{batchItems.length} / {initialItems.length} enriched</p>}
            </div>
          )}

          {/* Submitting progress */}
          {status === 'submitting' && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <div className="w-full max-w-xs">
                <div className={`h-2 rounded-full ${th.border} border overflow-hidden`}>
                  <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${submitProgress}%` }} />
                </div>
              </div>
              <p className={`text-xs ${th.textFaint}`}>{submitProgress}% — {Math.round(activeItems.length * submitProgress / 100)} of {activeItems.length} orders submitted</p>
            </div>
          )}

          {/* Order results */}
          {status === 'done' && (
            <div className="p-6 space-y-4">
              <div className="flex gap-4">
                {filledCount > 0 && <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-emerald-500" /><span className="text-xs text-emerald-400 font-bold">{filledCount} submitted</span></div>}
                {rejectedCount > 0 && <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-red-500" /><span className="text-xs text-red-400 font-bold">{rejectedCount} rejected</span></div>}
              </div>
              <div className="space-y-2">
                {orderResults.map((r, i) => (
                  <div key={i} className={`flex items-center justify-between p-3 rounded-lg border ${r.status === 'error' || r.status === 'rejected' ? 'border-red-500/40 bg-red-500/5' : 'border-emerald-500/20 bg-emerald-500/5'}`}>
                    <div>
                      <span className={`text-xs font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{r.symbol}</span>
                      <span className={`ml-2 text-[10px] ${ACTION_META[r.action].color}`}>{ACTION_META[r.action].label}</span>
                      {r.error && <p className="text-[10px] text-red-400 mt-0.5">{r.error}</p>}
                    </div>
                    <div className="text-right">
                      <p className={`text-[10px] ${th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>{r.orderId}</p>
                      {r.estPnl != null && <p className={`text-[10px] font-bold ${r.estPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{r.estPnl >= 0 ? '+' : ''}${r.estPnl.toFixed(2)}</p>}
                    </div>
                  </div>
                ))}
              </div>
              <p className={`text-[10px] ${th.textFaint} text-center`}>Verify working orders in TastyTrade. Positions will refresh on close.</p>
            </div>
          )}

          {/* Error state */}
          {status === 'error' && (
            <div className="p-6 flex flex-col items-center gap-3">
              <span className="text-2xl">✕</span>
              <p className="text-sm font-bold text-red-400">FAILED</p>
              <div className={`p-3 rounded-lg bg-red-500/10 border border-red-500/40 w-full`}>
                <p className="text-xs text-red-300" style={{ fontFamily: "'DM Mono', monospace" }}>{errorMsg}</p>
              </div>
            </div>
          )}

          {/* Ready state — order table */}
          {(status === 'ready') && (
            <div className="p-4 space-y-3">
              {warningCount > 0 && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                  <span className="text-yellow-400">⚠</span>
                  <p className="text-xs text-yellow-400">{warningCount} position{warningCount !== 1 ? 's have' : ' has'} warnings. Review before submitting.</p>
                </div>
              )}

              <div className="space-y-2">
                {batchItems.map(item => {
                  const isExcluded = excluded.has(item.pos.key);
                  const ri = rollInputs[item.pos.key];
                  const suggestion = rollSuggestions[item.pos.key];
                  return (
                    <div key={item.pos.key} className={`rounded-lg border transition-all ${isExcluded ? 'opacity-40 border-dashed' : item.stalePriceWarning || item.duplicateGtcWarning ? 'border-yellow-500/50' : th.border}`}>
                      {/* Row header */}
                      <div className="flex items-center gap-3 px-4 py-3">
                        <input type="checkbox" checked={!isExcluded}
                          onChange={() => setExcluded(prev => { const n = new Set(prev); isExcluded ? n.delete(item.pos.key) : n.add(item.pos.key); return n; })}
                          className="w-4 h-4 accent-blue-500 cursor-pointer shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`text-sm font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{item.pos.symbol}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 border rounded font-bold ${stratColor(item.pos.strategy)}`}>{item.pos.strategy}</span>
                            <span className={`text-[10px] font-bold ${ACTION_META[item.action].color}`}>{ACTION_META[item.action].label}</span>
                          </div>
                          <div className="flex items-center gap-3 mt-0.5">
                            <span className={`text-[10px] ${th.textFaint}`}>{item.pos.expDate} · {item.pos.dte}d</span>
                            {item.stalePriceWarning && (
                              <span className="text-[10px] text-yellow-400 font-bold">
                                ⚠ Price moved {item.freshPrice != null && item.pos.currentValue != null ? `${Math.abs(((item.freshPrice - item.pos.currentValue) / item.pos.currentValue) * 100).toFixed(0)}%` : ''} since load
                              </span>
                            )}
                            {item.duplicateGtcWarning && (
                              <span className="text-[10px] text-yellow-400 font-bold">⚠ GTC already working</span>
                            )}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-xs font-bold text-blue-400" style={{ fontFamily: "'DM Mono', monospace" }}>
                            Limit ${item.freshPrice != null
                              ? (item.action === 'TAKE_PROFIT' || item.action === 'PLACE_GTC'
                                  ? item.limitPrice
                                  : parseFloat((item.freshPrice / 100).toFixed(2))
                                ).toFixed(2)
                              : item.limitPrice.toFixed(2)}
                          </p>
                          {item.estPnl != null && (
                            <p className={`text-[10px] font-bold ${item.estPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {item.estPnl >= 0 ? '+' : ''}${item.estPnl.toFixed(2)}
                            </p>
                          )}
                          <p className={`text-[10px] ${th.textFaint}`}>{item.orderBody['time-in-force']}</p>
                        </div>
                      </div>

                      {/* Roll inputs */}
                      {item.action === 'CLOSE_ROLL' && !isExcluded && (
                        <div className={`px-4 pb-3 border-t ${th.borderLight}`}>
                          <div className="pt-3">
                            {suggestion && (
                              <div className="flex items-center gap-2 mb-2">
                                <span className="text-[9px] text-blue-400 font-bold uppercase tracking-widest">Suggested roll</span>
                                <span className="text-[10px] text-blue-300" style={{ fontFamily: "'DM Mono', monospace" }}>
                                  {suggestion.expiry} · {suggestion.shortStrike}/{suggestion.longStrike} · δ{suggestion.delta.toFixed(2)} · ${suggestion.credit.toFixed(2)} cr
                                </span>
                                <button onClick={() => setRollInputs(prev => ({
                                  ...prev,
                                  [item.pos.key]: { expiry: suggestion.expiry, shortStrike: String(suggestion.shortStrike), longStrike: String(suggestion.longStrike), credit: String(suggestion.credit) }
                                }))} className="text-[9px] px-2 py-0.5 border border-blue-600 text-blue-400 rounded hover:bg-blue-600/20 transition-colors">
                                  Use this
                                </button>
                              </div>
                            )}
                            <div className="grid grid-cols-4 gap-2">
                              {[
                                { label: 'New Expiry', key: 'expiry', placeholder: '2025-08-15' },
                                { label: 'Short Strike', key: 'shortStrike', placeholder: '490' },
                                { label: 'Long Strike', key: 'longStrike', placeholder: '485' },
                                { label: 'Credit ($)', key: 'credit', placeholder: '1.50' },
                              ].map(f => (
                                <div key={f.key}>
                                  <p className={`text-[9px] ${th.textFaint} mb-1`}>{f.label}</p>
                                  <input
                                    value={ri?.[f.key as keyof typeof ri] ?? ''}
                                    onChange={e => setRollInputs(prev => ({ ...prev, [item.pos.key]: { ...prev[item.pos.key], [f.key]: e.target.value } }))}
                                    placeholder={f.placeholder}
                                    className={`w-full text-[10px] px-2 py-1.5 rounded border ${th.inputBorder} ${th.input} ${th.text} outline-none focus:border-purple-500`}
                                    style={{ fontFamily: "'DM Mono', monospace" }}
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`px-6 py-4 border-t ${th.border} shrink-0`}>
          {status === 'ready' && (
            <div className="space-y-3">
              {/* Totals */}
              <div className={`flex items-center justify-between p-3 rounded-lg ${th.card}`}>
                <div className="flex gap-6">
                  <div>
                    <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest`}>Orders</p>
                    <p className={`text-sm font-bold ${th.text}`}>{activeItems.length}</p>
                  </div>
                  <div>
                    <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest`}>Total Debit</p>
                    <p className="text-sm font-bold text-blue-400" style={{ fontFamily: "'DM Mono', monospace" }}>${totalDebit.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest`}>Est. P&L</p>
                    <p className={`text-sm font-bold ${totalEstPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                      {totalEstPnl >= 0 ? '+' : ''}${totalEstPnl.toFixed(2)}
                    </p>
                  </div>
                </div>
                {excluded.size > 0 && <span className={`text-[10px] ${th.textFaint}`}>{excluded.size} excluded</span>}
              </div>
              <div className="flex gap-3">
                <button onClick={submitAll} disabled={activeItems.length === 0}
                  className="flex-1 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-xl text-xs font-bold tracking-widest transition-colors">
                  SUBMIT {activeItems.length} ORDER{activeItems.length !== 1 ? 'S' : ''}
                </button>
                <button onClick={onClose} className={`px-4 py-3 border ${th.border} ${th.textFaint} rounded-xl text-xs font-medium hover:border-white/30 transition-colors`}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {status === 'done' && (
            <div className="flex gap-3">
              <button onClick={() => { onSuccess(); onClose(); }} className="flex-1 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold tracking-widest transition-colors">
                DONE — REFRESH POSITIONS
              </button>
              <a href="https://my.tastytrade.com" target="_blank" rel="noopener noreferrer"
                className={`px-4 py-3 border ${th.border} ${th.textFaint} rounded-xl text-xs font-medium hover:border-white/30 transition-colors flex items-center`}>
                TT ↗
              </a>
            </div>
          )}
          {status === 'error' && (
            <button onClick={onClose} className={`w-full py-3 border ${th.border} ${th.textFaint} rounded-xl text-xs font-medium hover:border-white/30 transition-colors`}>
              Close
            </button>
          )}
          {(status === 'enriching' || status === 'submitting') && (
            <button disabled className="w-full py-3 bg-slate-700 text-slate-500 rounded-xl text-xs font-bold tracking-widest">
              {status === 'enriching' ? 'FETCHING DATA...' : 'SUBMITTING...'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Audit Log Panel ────────────────────────────────────────────────────────
// ── Audit Log Panel ────────────────────────────────────────────────────────
function AuditLogPanel({ onClose, th }: { onClose: () => void; th: typeof THEMES[Theme] }) {
  const log = readAuditLog();
  return (
    <div className="fixed inset-0 bg-black/85 flex items-center justify-center z-50 p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div className={`${th.sidebar} border ${th.border} rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col`}>
        <div className={`flex items-center justify-between px-6 py-4 border-b ${th.border} shrink-0`}>
          <div>
            <h2 className={`text-sm font-bold ${th.text} tracking-wider`}>AUDIT LOG</h2>
            <p className={`text-[10px] ${th.textFaint}`}>{log.length} entries · last 500 orders</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportAuditCsv} className={`text-[10px] px-3 py-1.5 border ${th.border} ${th.textFaint} rounded hover:border-blue-500 hover:text-blue-400 transition-colors`}>↓ Export CSV</button>
            <button onClick={onClose} className={`text-xl ${th.textFaint} hover:${th.text}`}>✕</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {log.length === 0 ? (
            <div className="flex items-center justify-center h-32">
              <p className={`text-sm ${th.textFaint}`}>No orders logged yet</p>
            </div>
          ) : (
            <div className="space-y-1">
              {log.map(entry => (
                <div key={entry.id} className={`flex items-center gap-3 px-3 py-2 rounded border ${th.borderLight} text-[10px]`}>
                  <span className={`${th.textFaint} shrink-0 w-32`} style={{ fontFamily: "'DM Mono', monospace" }}>{entry.timestamp.slice(0, 16).replace('T', ' ')}</span>
                  <span className={`font-bold ${th.text} w-16 shrink-0`} style={{ fontFamily: "'DM Mono', monospace" }}>{entry.symbol}</span>
                  <span className={`${ACTION_META[entry.action]?.color ?? 'text-slate-400'} w-24 shrink-0`}>{ACTION_META[entry.action]?.label ?? entry.action}</span>
                  <span className={`${th.textFaint} w-20 shrink-0`} style={{ fontFamily: "'DM Mono', monospace" }}>${entry.limitPrice.toFixed(2)}</span>
                  <span className={`${th.textFaint} flex-1 truncate`} style={{ fontFamily: "'DM Mono', monospace" }}>#{entry.orderId}</span>
                  <span className={`shrink-0 font-bold ${entry.status === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>{entry.status}</span>
                  {entry.estPnl != null && <span className={`shrink-0 ${entry.estPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{entry.estPnl >= 0 ? '+' : ''}${entry.estPnl.toFixed(2)}</span>}
                  {entry.error && <span className="text-red-400 truncate max-w-xs" title={entry.error}>{entry.error}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Summary Bar ────────────────────────────────────────────────────────────
function SummaryBar({ positions, th }: { positions: Position[]; th: typeof THEMES[Theme] }) {
  const totalCredit = positions.reduce((s, p) => s + p.creditReceived, 0);
  const totalPnl = positions.reduce((s, p) => s + (p.pnl ?? p.plOpen ?? 0), 0);
  const capturedPct = totalCredit > 0 ? (totalPnl / totalCredit) * 100 : 0;
  const totalAtRisk = positions.reduce((s, p) => {
    const shorts = p.legs.filter(l => l.direction === 'Short');
    const longs  = p.legs.filter(l => l.direction === 'Long' && l.optionType === shorts[0]?.optionType);
    if (shorts[0] && longs[0]) {
      const width = Math.abs(shorts[0].strikePrice - longs[0].strikePrice);
      return s + Math.max(0, (width * 100 * shorts[0].quantity) - p.creditReceived);
    }
    return s;
  }, 0);
  const totalTheta = positions.reduce((s, p) => {
    if (p.currentValue != null && p.dte > 0) return s + p.currentValue / p.dte;
    if (p.dte > 0) return s + p.creditReceived / p.dte;
    return s;
  }, 0);

  return (
    <div className={`grid grid-cols-5 border-b ${th.border}`}>
      {[
        { label: 'Open Positions', value: String(positions.length), sub: `${positions.length} position${positions.length !== 1 ? 's' : ''}`, color: th.text },
        { label: 'Captured', value: `${totalPnl >= 0 ? '+' : ''}$${Math.abs(totalPnl).toFixed(0)}`, sub: `of $${totalCredit.toFixed(0)} · ${capturedPct.toFixed(0)}%`, color: totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400' },
        { label: '50% Target', value: `$${Math.round(totalCredit * 0.5)}`, sub: `${totalCredit > 0 ? Math.round((totalPnl / (totalCredit * 0.5)) * 100) : 0}% of target`, color: 'text-yellow-400' },
        { label: 'At Risk', value: `$${totalAtRisk.toFixed(0)}`, sub: 'max loss if expired', color: th.textMuted },
        { label: 'Est. Theta/Day', value: totalTheta > 0 ? `+$${totalTheta.toFixed(2)}` : '—', sub: 'daily decay', color: 'text-blue-400' },
      ].map((item, i, arr) => (
        <div key={item.label} className={`p-5 ${i < arr.length - 1 ? `border-r ${th.border}` : ''} flex flex-col items-center text-center`}>
          <p className={`text-[10px] ${th.textFaint} uppercase tracking-widest mb-2`}>{item.label}</p>
          <p className={`text-3xl font-bold ${item.color}`} style={{ fontFamily: "'DM Mono', monospace" }}>{item.value}</p>
          <p className={`text-[10px] ${th.textFaint} mt-1`}>{item.sub}</p>
        </div>
      ))}
    </div>
  );
}

// ── Position Card ──────────────────────────────────────────────────────────
// ── Analysis Panel ─────────────────────────────────────────────────────────
const CONFIDENCE_COLOR: Record<string, string> = {
  HIGH: 'text-emerald-400', MEDIUM: 'text-yellow-400', LOW: 'text-orange-400',
};
const REC_COLOR: Record<string, string> = {
  HOLD: 'text-slate-400', WATCH: 'text-yellow-400', MANAGE: 'text-orange-400',
  TAKE_PROFIT: 'text-emerald-400', CUT_LOSSES: 'text-red-400',
  CLOSE: 'text-red-400', ROLL: 'text-purple-400',
};

function AnalysisPanel({ analysis, th }: { analysis: PositionAnalysis; th: typeof THEMES[Theme] }) {
  return (
    <div className={`border-t ${th.border} px-4 py-4 space-y-3`} style={{ background: 'rgba(99,102,241,0.04)' }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-[9px] text-indigo-400 tracking-widest font-bold uppercase">AI Analysis</span>
          <span className={`text-[10px] font-bold ${REC_COLOR[analysis.recommendation] ?? 'text-white'}`}>
            → {analysis.recommendation.replace('_', ' ')}
          </span>
          <span className={`text-[9px] font-bold ${CONFIDENCE_COLOR[analysis.confidence] ?? 'text-slate-400'}`}>
            {analysis.confidence} confidence
          </span>
          {analysis.deviatesFromRules && (
            <span className="text-[9px] px-2 py-0.5 rounded border border-yellow-600/50 text-yellow-400 font-bold">
              ⚡ Outside rules
            </span>
          )}
        </div>
        <span className={`text-[9px] ${th.textFaint}`}>{new Date(analysis.generatedAt).toLocaleTimeString()}</span>
      </div>

      {/* Summary */}
      <p className={`text-xs ${th.textMuted} leading-relaxed`}>{analysis.summary}</p>

      {/* Reasoning */}
      <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>{analysis.reasoning}</p>

      {/* Deviation note */}
      {analysis.deviatesFromRules && analysis.deviationNote && (
        <div className="flex items-start gap-2 p-2 rounded border border-yellow-600/30 bg-yellow-500/5">
          <span className="text-yellow-400 shrink-0 text-[10px] mt-0.5">⚡</span>
          <p className="text-[10px] text-yellow-300 leading-relaxed">{analysis.deviationNote}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {/* Risks */}
        {analysis.risks.length > 0 && (
          <div>
            <p className="text-[9px] text-red-400 uppercase tracking-widest mb-1.5 font-bold">Risks</p>
            <div className="space-y-1">
              {analysis.risks.map((r, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <span className="text-red-400 text-[9px] mt-0.5 shrink-0">▸</span>
                  <p className="text-[10px] text-red-300 leading-snug">{r}</p>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* Catalysts */}
        {analysis.catalysts.length > 0 && (
          <div>
            <p className="text-[9px] text-emerald-400 uppercase tracking-widest mb-1.5 font-bold">In your favor</p>
            <div className="space-y-1">
              {analysis.catalysts.map((c, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <span className="text-emerald-400 text-[9px] mt-0.5 shrink-0">▸</span>
                  <p className="text-[10px] text-emerald-300 leading-snug">{c}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PortfolioAnalysisPanel({ analysis, onClose, th }: {
  analysis: PortfolioAnalysis; onClose: () => void; th: typeof THEMES[Theme];
}) {
  return (
    <div className="fixed inset-0 bg-black/85 flex items-center justify-center z-50 p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div className={`${th.sidebar} border ${th.border} rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col`}>
        <div className={`flex items-center justify-between px-6 py-4 border-b ${th.border} shrink-0`}>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-indigo-400 text-sm">◈</span>
              <h2 className={`text-sm font-bold ${th.text} tracking-wider`}>PORTFOLIO ANALYSIS</h2>
            </div>
            <p className={`text-[10px] ${th.textFaint} mt-0.5`}>Generated {new Date(analysis.generatedAt).toLocaleTimeString()}</p>
          </div>
          <button onClick={onClose} className={`text-xl ${th.textFaint} hover:${th.text}`}>✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Summary */}
          <div className={`p-4 rounded-xl border ${th.border}`} style={{ background: 'rgba(99,102,241,0.05)' }}>
            <p className={`text-xs ${th.textMuted} leading-relaxed`}>{analysis.summary}</p>
          </div>

          {/* Market context */}
          {analysis.marketContext && (
            <div>
              <p className="text-[9px] text-indigo-400 uppercase tracking-widest mb-2 font-bold">Market Context</p>
              <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>{analysis.marketContext}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-5">
            {/* Priority actions */}
            {analysis.priorityActions.length > 0 && (
              <div>
                <p className="text-[9px] text-blue-400 uppercase tracking-widest mb-2 font-bold">Priority Actions</p>
                <div className="space-y-2">
                  {analysis.priorityActions.map((a, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <span className="text-blue-400 text-[10px] font-bold shrink-0 mt-0.5">{i + 1}.</span>
                      <p className={`text-[10px] ${th.textMuted} leading-snug`}>{a}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Top risks */}
            {analysis.topRisks.length > 0 && (
              <div>
                <p className="text-[9px] text-red-400 uppercase tracking-widest mb-2 font-bold">Portfolio Risks</p>
                <div className="space-y-2">
                  {analysis.topRisks.map((r, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <span className="text-red-400 text-[9px] shrink-0 mt-0.5">▸</span>
                      <p className="text-[10px] text-red-300 leading-snug">{r}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Dominant risk */}
          {analysis.dominantRisk && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/20 bg-red-500/5">
              <span className="text-red-400 shrink-0 text-[10px] mt-0.5 font-bold">!</span>
              <div>
                <p className="text-[9px] text-red-400 uppercase tracking-widest mb-1 font-bold">Dominant Risk</p>
                <p className="text-[10px] text-red-300">{analysis.dominantRisk}</p>
              </div>
            </div>
          )}

          {/* Concentration + theta */}
          <div className="grid grid-cols-2 gap-5">
            {analysis.sectorConcentration.length > 0 && (
              <div>
                <p className="text-[9px] text-yellow-400 uppercase tracking-widest mb-2 font-bold">Concentration Risk</p>
                <div className="space-y-1">
                  {analysis.sectorConcentration.map((s, i) => (
                    <p key={i} className="text-[10px] text-yellow-300">▸ {s}</p>
                  ))}
                </div>
              </div>
            )}
            {analysis.thetaYield && (
              <div>
                <p className="text-[9px] text-emerald-400 uppercase tracking-widest mb-2 font-bold">Theta Yield</p>
                <p className={`text-[10px] ${th.textMuted}`}>{analysis.thetaYield}</p>
              </div>
            )}
          </div>
        </div>

        <div className={`px-6 py-4 border-t ${th.border} shrink-0`}>
          <button onClick={onClose} className={`w-full py-3 border ${th.border} ${th.textFaint} rounded-xl text-xs font-medium hover:border-white/30 transition-colors`}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function PositionCard({ pos, th, checked, onToggle, onProfitTargetChange }: {
  pos: Position;
  th: typeof THEMES[Theme];
  checked: boolean;
  onToggle: (key: string) => void;
  onProfitTargetChange: (key: string, value: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [trend, setTrend] = useState<TrendResult | null>(null);
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetInput, setTargetInput] = useState(String(Math.round(pos.profitTarget * 100)));
  const [analysis, setAnalysis] = useState<PositionAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [showAnalysis, setShowAnalysis] = useState(false);

  const handleAnalyze = async () => {
    setShowAnalysis(true);
    if (analysis) return; // already have it
    setAnalysisLoading(true);
    setAnalysisError(null);
    try {
      const result = await analyzePosition(pos, trend);
      setAnalysis(result);
    } catch (e: any) {
      setAnalysisError(e.message ?? 'Analysis failed');
    } finally {
      setAnalysisLoading(false);
    }
  };

  useEffect(() => {
    getTrend(pos.symbol).then(t => setTrend(t)).catch(() => {});
  }, [pos.symbol]);

  const rec = getRecommendation(pos, trend);

  const shortPuts  = pos.legs.filter(l => l.optionType === 'P' && l.direction === 'Short');
  const longPuts   = pos.legs.filter(l => l.optionType === 'P' && l.direction === 'Long');
  const shortCalls = pos.legs.filter(l => l.optionType === 'C' && l.direction === 'Short');
  const longCalls  = pos.legs.filter(l => l.optionType === 'C' && l.direction === 'Long');

  const strikesSummary = () => {
    if (pos.strategy === 'BPS' && shortPuts[0] && longPuts[0]) return `${shortPuts[0].strikePrice}P / ${longPuts[0].strikePrice}P`;
    if (pos.strategy === 'BCS' && shortCalls[0] && longCalls[0]) return `${shortCalls[0].strikePrice}C / ${longCalls[0].strikePrice}C`;
    if (pos.strategy === 'IC') return `${shortPuts[0]?.strikePrice}P/${longPuts[0]?.strikePrice}P · ${shortCalls[0]?.strikePrice}C/${longCalls[0]?.strikePrice}C`;
    return pos.legs.map(l => `${l.strikePrice}${l.optionType}`).join(' / ');
  };

  const handleTargetSave = () => {
    const val = Math.min(100, Math.max(10, parseInt(targetInput) || 50)) / 100;
    setEditingTarget(false);
    onProfitTargetChange(pos.key, val);
  };

  const borderClass = checked
    ? 'border-blue-500/60'
    : pos.needsClose ? 'border-red-500/60'
    : pos.hitTarget ? 'border-emerald-500/60'
    : th.border;

  return (
    <div className={`border ${borderClass} ${th.card} rounded-lg transition-all`}>
      {pos.needsClose && (
        <div className="bg-red-500/10 border-b border-red-500/40 px-4 py-1.5 flex items-center gap-2">
          <span className="text-red-400 text-xs">⚠</span>
          <span className="text-xs text-red-400 font-bold tracking-wider">CLOSE NOW — {pos.dte} DTE</span>
        </div>
      )}
      {pos.hitTarget && !pos.needsClose && (
        <div className="bg-emerald-500/10 border-b border-emerald-500/40 px-4 py-1.5 flex items-center gap-2">
          <span className="text-emerald-400 text-xs">✓</span>
          <span className="text-xs text-emerald-400 font-bold tracking-wider">{Math.round(pos.profitTarget * 100)}% PROFIT TARGET HIT</span>
        </div>
      )}

      <div className="flex items-stretch">
        {/* Checkbox */}
        <div className="flex items-center px-3 border-r border-inherit shrink-0 cursor-pointer" onClick={e => { e.stopPropagation(); onToggle(pos.key); }}>
          <input type="checkbox" checked={checked} onChange={() => onToggle(pos.key)}
            className="w-4 h-4 accent-blue-500 cursor-pointer" onClick={e => e.stopPropagation()} />
        </div>

        {/* Expand toggle */}
        <button onClick={() => setExpanded(!expanded)}
          className={`px-3 flex items-center border-r ${th.borderLight} ${th.textFaint} hover:${th.textMuted} transition-colors shrink-0`}>
          <span className="text-[10px]">{expanded ? '▲' : '▼'}</span>
        </button>

        {/* Data columns */}
        <div className="overflow-x-auto flex-1">
          <div className="grid px-4 py-3" style={{ gridTemplateColumns: '72px 120px 80px 70px 110px 80px 80px 90px 70px 50px 50px 55px 60px 90px 130px', gap: '0 12px', alignItems: 'center', minWidth: '1040px' }}>

            <div>
              <p className={`font-bold ${th.text} text-sm leading-tight`} style={{ fontFamily: "'DM Mono', monospace" }}>{pos.symbol}</p>
              <span className={`text-[10px] px-1.5 py-0.5 border rounded font-bold ${stratColor(pos.strategy)}`}>{pos.strategy}</span>
            </div>

            <div>
              <p className={`text-[9px] ${th.textFaint}`}>Expiry / DTE</p>
              <p className="text-xs leading-tight" style={{ fontFamily: "'DM Mono', monospace" }}>
                <span className={`block ${th.text}`}>{pos.expDate}</span>
                <span className={`block ${dteColor(pos.dte)}`}>({pos.dte}d)</span>
              </p>
            </div>

            <div>
              <p className={`text-[9px] ${th.textFaint}`}>Stock</p>
              <p className={`text-xs ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{pos.stockPrice != null ? `$${pos.stockPrice.toFixed(2)}` : '—'}</p>
            </div>

            <div>
              <p className={`text-[9px] ${th.textFaint}`}>% Buffer</p>
              <p className={`text-xs font-bold ${pos.buffer == null ? th.textFaint : pos.buffer < 3 ? 'text-red-400' : pos.buffer < 7 ? 'text-yellow-400' : 'text-emerald-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                {pos.buffer != null ? `${pos.buffer.toFixed(1)}%` : '—'}
              </p>
            </div>

            <div>
              <p className={`text-[9px] ${th.textFaint}`}>Strikes</p>
              <p className={`text-xs ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{strikesSummary()}</p>
            </div>

            <div>
              <p className={`text-[9px] ${th.textFaint}`}>Buyback</p>
              <p className={`text-xs ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{pos.currentValue != null ? `$${pos.currentValue.toFixed(2)}` : '—'}</p>
            </div>

            <div>
              <p className={`text-[9px] ${th.textFaint}`}>Credit</p>
              <p className="text-xs font-bold text-emerald-400" style={{ fontFamily: "'DM Mono', monospace" }}>${pos.creditReceived.toFixed(2)}</p>
            </div>

            <div onClick={e => e.stopPropagation()}>
              <p className={`text-[9px] ${th.textFaint}`}>{Math.round(pos.profitTarget * 100)}% Target</p>
              {editingTarget ? (
                <div className="flex items-center gap-1">
                  <input type="number" min="10" max="100" value={targetInput}
                    onChange={e => setTargetInput(e.target.value)}
                    onBlur={handleTargetSave}
                    onKeyDown={e => { if (e.key === 'Enter') handleTargetSave(); if (e.key === 'Escape') setEditingTarget(false); }}
                    autoFocus className="text-xs w-12 bg-transparent border-b border-blue-500 outline-none text-blue-400"
                    style={{ fontFamily: "'DM Mono', monospace" }} />
                  <span className="text-[9px] text-blue-400">%</span>
                </div>
              ) : (
                <p className={`text-xs cursor-pointer hover:text-blue-400 transition-colors ${pos.hitTarget ? 'text-emerald-400 font-bold' : th.textFaint}`}
                  style={{ fontFamily: "'DM Mono', monospace" }}
                  onClick={() => { setTargetInput(String(Math.round(pos.profitTarget * 100))); setEditingTarget(true); }}>
                  ${pos.targetPrice.toFixed(2)}{pos.hitTarget && ' ✓'}
                </p>
              )}
            </div>

            <div>
              <p className={`text-[9px] ${th.textFaint}`}>P/L Open</p>
              <p className={`text-xs font-bold ${pos.plOpen != null ? (pos.plOpen >= 0 ? 'text-emerald-400' : 'text-red-400') : th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                {pos.plOpen != null ? `${pos.plOpen >= 0 ? '+' : ''}$${pos.plOpen.toFixed(0)}` : '—'}
              </p>
            </div>

            <div>
              <p className={`text-[9px] ${th.textFaint}`}>Theta</p>
              <p className={`text-xs font-bold ${pos.theta != null ? (pos.theta >= 0 ? 'text-emerald-400' : 'text-red-400') : th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                {pos.theta != null ? (pos.theta >= 0 ? '+' : '') + pos.theta.toFixed(3) : '—'}
              </p>
            </div>

            <div>
              <p className={`text-[9px] ${th.textFaint}`}>Gamma</p>
              <p className={`text-xs font-bold ${pos.gamma != null ? (pos.gamma <= 0 ? 'text-emerald-400' : 'text-red-400') : th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                {pos.gamma != null ? pos.gamma.toFixed(4) : '—'}
              </p>
            </div>

            <div>
              <p className={`text-[9px] ${th.textFaint}`}>IVR</p>
              <p className={`text-xs font-bold ${pos.ivr != null ? (pos.ivr >= 30 ? 'text-emerald-400' : 'text-yellow-400') : th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                {pos.ivr ?? '—'}
              </p>
            </div>

            <div>
              <p className={`text-[9px] ${th.textFaint}`}>GTC</p>
              <p className={`text-xs font-bold ${pos.hasGtc ? 'text-emerald-400' : 'text-red-400'}`}>{pos.hasGtc ? '✓ Live' : '✕ None'}</p>
            </div>

            <div>
              <p className={`text-[9px] ${th.textFaint}`}>Stop Loss</p>
              {(() => {
                const cfg =
                  pos.stopLossStatus === 'live'  ? { icon: '✓', label: 'Stop',  cls: 'text-emerald-400' } :
                  pos.stopLossStatus === 'loose' ? { icon: '⚠', label: 'Loose', cls: 'text-yellow-400'  } :
                  pos.stopLossStatus === 'none'  ? { icon: '✕', label: 'None',  cls: 'text-red-400'     } :
                                                   { icon: '—', label: '?',     cls: th.textFaint        };
                return (
                  <p className={`text-xs font-bold ${cfg.cls}`}>
                    {cfg.icon} {cfg.label}
                    {pos.stopLossPrice != null && (
                      <span className={`ml-1 ${th.textFaint} text-[10px] font-normal`}>${pos.stopLossPrice.toFixed(2)}</span>
                    )}
                  </p>
                );
              })()}
            </div>

            {/* Recommendation */}
            <div>
              <p className={`text-[9px] ${th.textFaint}`}>Suggested</p>
              <span className={`text-[10px] font-bold ${ACTION_META[rec.action].color}`}>{ACTION_META[rec.action].label}</span>
              <p className={`text-[9px] ${th.textFaint} mt-0.5 leading-tight`}>{rec.detail}</p>
              <button
                onClick={e => { e.stopPropagation(); handleAnalyze(); }}
                className={`mt-1.5 text-[9px] px-2 py-0.5 border rounded transition-colors font-bold ${
                  analysis ? 'border-indigo-500 text-indigo-400 hover:bg-indigo-500/10' : 'border-indigo-700 text-indigo-500 hover:border-indigo-500 hover:text-indigo-400'
                }`}>
                {analysisLoading ? '◈ Analyzing...' : analysis ? '◈ AI Analysis ✓' : '◈ Analyze'}
              </button>
            </div>
          </div>
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
                <span className={`text-[10px] ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{leg.quantity}x {leg.strikePrice} {leg.optionType === 'P' ? 'Put' : 'Call'}</span>
                <span className={`text-[10px] ${th.textFaint}`}>Avg open: <span className={th.text}>${leg.avgOpenPrice.toFixed(2)}</span></span>
                {leg.currentPrice != null && <span className={`text-[10px] ${th.textFaint}`}>Current: <span className={th.text}>${leg.currentPrice.toFixed(2)}</span></span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI analysis panel */}
      {showAnalysis && (
        <>
          {analysisLoading && (
            <div className={`border-t ${th.border} px-4 py-4 flex items-center gap-3`} style={{ background: 'rgba(99,102,241,0.04)' }}>
              <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin shrink-0" />
              <p className={`text-xs ${th.textFaint}`}>Analyzing position with AI...</p>
              <button onClick={() => setShowAnalysis(false)} className={`ml-auto text-[10px] ${th.textFaint} hover:${th.text}`}>✕</button>
            </div>
          )}
          {analysisError && (
            <div className={`border-t ${th.border} px-4 py-3 flex items-center gap-2`}>
              <p className="text-[10px] text-red-400">Analysis failed: {analysisError}</p>
              <button onClick={() => { setAnalysisError(null); handleAnalyze(); }} className="text-[10px] text-blue-400 hover:underline">Retry</button>
              <button onClick={() => setShowAnalysis(false)} className={`ml-auto text-[10px] ${th.textFaint}`}>✕</button>
            </div>
          )}
          {analysis && !analysisLoading && (
            <div className="relative">
              <button onClick={() => setShowAnalysis(false)} className={`absolute top-3 right-3 text-[10px] ${th.textFaint} hover:${th.text} z-10`}>✕</button>
              <AnalysisPanel analysis={analysis} th={th} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Position Section with group-action header ──────────────────────────────
function PositionSection({ title, titleColor, positions, th, checked, onToggle, onToggleAll, onProfitTargetChange, groupAction, onGroupAction }: {
  title: string; titleColor: string; positions: Position[];
  th: typeof THEMES[Theme]; checked: Set<string>;
  onToggle: (key: string) => void; onToggleAll: (keys: string[], select: boolean) => void;
  onProfitTargetChange: (key: string, value: number) => void;
  groupAction: ActionType; onGroupAction: (positions: Position[], action: ActionType) => void;
}) {
  const keys = positions.map(p => p.key);
  const allChecked = keys.length > 0 && keys.every(k => checked.has(k));
  const someChecked = keys.some(k => checked.has(k));
  const meta = ACTION_META[groupAction];
  const checkboxRef = (el: HTMLInputElement | null) => { if (el) el.indeterminate = someChecked && !allChecked; };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <input type="checkbox" ref={checkboxRef} checked={allChecked}
            onChange={() => onToggleAll(keys, !allChecked)}
            className="w-4 h-4 accent-blue-500 cursor-pointer" />
          <p className={`text-[10px] ${titleColor} tracking-widest font-bold uppercase`}>{title} — {positions.length}</p>
        </div>
        {groupAction !== 'HOLD' && (
          <button onClick={() => onGroupAction(positions, groupAction)}
            className={`text-[10px] px-3 py-1.5 border rounded font-bold transition-colors ${meta.btnClass}`}>
            {meta.label} All
          </button>
        )}
      </div>
      <div className="space-y-2">
        {positions.map(p => (
          <PositionCard key={p.key} pos={p} th={th} checked={checked.has(p.key)} onToggle={onToggle} onProfitTargetChange={onProfitTargetChange} />
        ))}
      </div>
    </div>
  );
}

// ── Sticky Bulk Action Bar ─────────────────────────────────────────────────
function BulkActionBar({ selectedKeys, positions, onExecute, onClear, th }: {
  selectedKeys: Set<string>; positions: Position[];
  onExecute: (items: { pos: Position; action: ActionType }[]) => void;
  onClear: () => void; th: typeof THEMES[Theme];
}) {
  if (selectedKeys.size === 0) return null;
  const selected = positions.filter(p => selectedKeys.has(p.key));
  const actions: ActionType[] = ['TAKE_PROFIT', 'CUT_LOSSES', 'CLOSE_ROLL', 'PLACE_GTC'];

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div className="mx-auto max-w-7xl px-6 pb-4">
        <div className={`${th.sidebar} border ${th.border} rounded-xl px-5 py-3 flex items-center gap-4 shadow-2xl`}>
          <div className="flex items-center gap-2 shrink-0">
            <span className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-white text-[10px] font-bold">{selectedKeys.size}</span>
            <span className={`text-xs font-bold ${th.text}`}>selected</span>
          </div>
          <div className={`w-px h-6 ${th.border} border-l`} />
          <div className="flex items-center gap-2 flex-1 flex-wrap">
            {actions.map(action => {
              const meta = ACTION_META[action];
              return (
                <button key={action}
                  onClick={() => onExecute(selected.map(pos => ({ pos, action })))}
                  className={`text-[10px] px-3 py-1.5 border rounded font-bold transition-colors ${meta.btnClass}`}>
                  {meta.label}
                </button>
              );
            })}
          </div>
          <button onClick={onClear} className={`text-[10px] ${th.textFaint} hover:${th.text} shrink-0 transition-colors`}>
            ✕ Clear
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────
export default function PortfolioPage() {
  const [theme, setTheme] = useState<Theme>(getSavedTheme);
  const th = THEMES[theme];

  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [batchItems, setBatchItems] = useState<{ pos: Position; action: ActionType }[] | null>(null);
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [portfolioAnalysis, setPortfolioAnalysis] = useState<PortfolioAnalysis | null>(null);
  const [portfolioAnalysisLoading, setPortfolioAnalysisLoading] = useState(false);

  const handleAnalyzePortfolio = async () => {
    if (positions.length === 0) return;
    setPortfolioAnalysisLoading(true);
    try {
      const result = await analyzePortfolio(positions);
      setPortfolioAnalysis(result);
    } catch (e: any) {
      setPortfolioAnalysis({ loading: false, error: e.message, netDelta: null, dominantRisk: '', sectorConcentration: [], thetaYield: '', topRisks: [], priorityActions: [], marketContext: '', summary: '', generatedAt: new Date().toISOString() });
    } finally {
      setPortfolioAnalysisLoading(false);
    }
  };

  const marketStatus = getMarketStatus();

  const fetchPositions = async () => {
    setLoading(true); setError(''); setChecked(new Set());
    try {
      const data = await loadPositions();
      setPositions(data);
      setLastRefresh(new Date());
    } catch (e: any) {
      if (e.message === 'Not authenticated' || e.message === 'Session expired') { window.location.href = '/login'; return; }
      setError(e.message);
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchPositions(); }, []);

  const handleProfitTargetChange = (key: string, value: number) => {
    try {
      const targets = JSON.parse(localStorage.getItem(LS_PROFIT_TARGETS) ?? '{}');
      targets[key] = value; localStorage.setItem(LS_PROFIT_TARGETS, JSON.stringify(targets));
    } catch {}
    setPositions(prev => prev.map(p => {
      if (p.key !== key) return p;
      return { ...p, profitTarget: value, targetPrice: p.creditReceived * value, hitTarget: p.pnl != null && p.pnl >= p.creditReceived * value };
    }));
  };

  const onToggle = (key: string) => setChecked(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const onToggleAll = (keys: string[], select: boolean) => setChecked(prev => { const n = new Set(prev); keys.forEach(k => select ? n.add(k) : n.delete(k)); return n; });
  const onClear = () => setChecked(new Set());

  const openBatch = (items: { pos: Position; action: ActionType }[]) => { if (items.length > 0) setBatchItems(items); };
  const onGroupAction = (pos: Position[], action: ActionType) => openBatch(pos.map(p => ({ pos: p, action })));
  const onBulkExecute = (items: { pos: Position; action: ActionType }[]) => { openBatch(items); onClear(); };

  const needsClose = positions.filter(p => p.needsClose);
  const hitTarget  = positions.filter(p => p.hitTarget && !p.needsClose);
  const noGtc      = positions.filter(p => !p.hasGtc && !p.needsClose && !p.hitTarget);
  const normal     = positions.filter(p => !p.needsClose && !p.hitTarget && p.hasGtc);

  return (
    <div className={`min-h-screen ${th.bg} pb-24 transition-colors duration-200`} style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>

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
          <span className={`text-[10px] font-bold ${marketStatus.open ? 'text-emerald-400' : 'text-yellow-400'}`}>{marketStatus.label}</span>
          {lastRefresh && <span className="text-[10px] text-white/30">Updated {lastRefresh.toLocaleTimeString()}</span>}
          <button onClick={() => setShowAuditLog(true)}
            className="text-[10px] px-3 py-1.5 border border-white/20 text-white/60 rounded hover:border-white/40 hover:text-white/80 transition-colors tracking-wider">
            📋 Audit Log
          </button>
          {positions.length > 0 && (
            <button onClick={handleAnalyzePortfolio} disabled={portfolioAnalysisLoading}
              className="text-[10px] px-3 py-1.5 border border-indigo-700 text-indigo-400 rounded hover:border-indigo-500 hover:text-indigo-300 transition-colors tracking-wider disabled:opacity-50 font-bold">
              {portfolioAnalysisLoading ? '◈ Analyzing...' : '◈ Analyze Portfolio'}
            </button>
          )}
          <a href="https://my.tastytrade.com" target="_blank" rel="noopener noreferrer"
            className="text-[10px] px-3 py-1.5 border border-white/20 text-white/60 rounded hover:border-white/40 hover:text-white/80 transition-colors tracking-wider">
            TastyTrade ↗
          </a>
          <button onClick={fetchPositions} disabled={loading}
            className="text-[10px] px-3 py-1.5 border border-white/20 text-white/60 rounded hover:border-white/40 hover:text-white/80 transition-colors tracking-wider disabled:opacity-40">
            {loading ? 'LOADING...' : '↻ REFRESH'}
          </button>
          <button onClick={() => { sessionStorage.removeItem('tt_access_token'); window.location.href = '/login'; }}
            className="text-[10px] px-3 py-1.5 border border-white/10 text-white/30 rounded hover:border-white/30 hover:text-white/60 transition-colors tracking-wider">
            SIGN OUT
          </button>
          <ThemeToggle theme={theme} setTheme={setTheme} />
        </div>
      </div>

      {error && <div className="mx-6 mt-4 p-4 bg-red-500/10 border border-red-500 rounded-lg text-red-400 text-sm">{error}</div>}

      {loading && positions.length === 0 && (
        <div className="flex items-center justify-center h-64">
          <div className={`text-sm ${th.textFaint} tracking-widest`}>FETCHING POSITIONS...</div>
        </div>
      )}

      {!loading && !error && positions.length === 0 && (
        <div className="flex flex-col items-center justify-center h-64 gap-2">
          <p className={`text-sm ${th.textFaint} tracking-widest`}>NO OPEN POSITIONS FOUND</p>
          <p className={`text-xs ${th.textFaint}`}>Options positions from your TastyTrade account will appear here</p>
        </div>
      )}

      {positions.length > 0 && (
        <>
          <SummaryBar positions={positions} th={th} />
          <div className="overflow-x-auto">
            <div className="p-6 space-y-8" style={{ minWidth: '1200px' }}>

              {needsClose.length > 0 && (
                <PositionSection
                  title="⚠ Close Now — 21 DTE or Less" titleColor="text-red-400"
                  positions={needsClose} th={th} checked={checked}
                  onToggle={onToggle} onToggleAll={onToggleAll}
                  onProfitTargetChange={handleProfitTargetChange}
                  groupAction="CLOSE_ROLL" onGroupAction={onGroupAction}
                />
              )}

              {hitTarget.length > 0 && (
                <PositionSection
                  title="✓ Profit Target Hit" titleColor="text-emerald-400"
                  positions={hitTarget} th={th} checked={checked}
                  onToggle={onToggle} onToggleAll={onToggleAll}
                  onProfitTargetChange={handleProfitTargetChange}
                  groupAction="TAKE_PROFIT" onGroupAction={onGroupAction}
                />
              )}

              {noGtc.length > 0 && (
                <PositionSection
                  title="⏱ Missing GTC Order" titleColor="text-blue-400"
                  positions={noGtc} th={th} checked={checked}
                  onToggle={onToggle} onToggleAll={onToggleAll}
                  onProfitTargetChange={handleProfitTargetChange}
                  groupAction="PLACE_GTC" onGroupAction={onGroupAction}
                />
              )}

              {normal.length > 0 && (
                <PositionSection
                  title="Active Positions" titleColor={th.textFaint}
                  positions={normal} th={th} checked={checked}
                  onToggle={onToggle} onToggleAll={onToggleAll}
                  onProfitTargetChange={handleProfitTargetChange}
                  groupAction="HOLD" onGroupAction={onGroupAction}
                />
              )}
            </div>
          </div>
        </>
      )}

      <BulkActionBar
        selectedKeys={checked} positions={positions}
        onExecute={onBulkExecute} onClear={onClear} th={th}
      />

      {batchItems && (
        <BatchConfirmModal
          items={batchItems}
          onClose={() => setBatchItems(null)}
          onSuccess={fetchPositions}
          th={th}
        />
      )}

      {showAuditLog && <AuditLogPanel onClose={() => setShowAuditLog(false)} th={th} />}

      {portfolioAnalysis && !portfolioAnalysis.error && (
        <PortfolioAnalysisPanel analysis={portfolioAnalysis} onClose={() => setPortfolioAnalysis(null)} th={th} />
      )}
      {portfolioAnalysis?.error && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-red-900/80 border border-red-500 rounded-lg px-4 py-3 text-xs text-red-300 flex items-center gap-3">
          Portfolio analysis failed: {portfolioAnalysis.error}
          <button onClick={() => setPortfolioAnalysis(null)} className="text-red-400 hover:text-red-200">✕</button>
        </div>
      )}
    </div>
  );
}
