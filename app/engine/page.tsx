// app/engine/page.tsx

'use client';
import { THEMES, ACCENTS, Theme, Accent, LS_THEME, LS_ACCENT, getSavedTheme, getSavedAccent, applyAccent, injectAccentStyle } from '@/lib/theme';
import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';

// ── Font injection ─────────────────────────────────────────────────────────
if (typeof document !== 'undefined') {
  if (!document.getElementById('hunter-font')) {
    const link = document.createElement('link');
    link.id = 'hunter-font';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=DM+Mono:wght@400;500&display=swap';
    document.head.appendChild(link);
  }
}

// ── Constants ──────────────────────────────────────────────────────────────
const BASE = 'https://api.tastytrade.com';
const CLIENT_ID = '4d4c851b-bdaf-4ac9-b39b-811e604739f2';
const LS_ACCESS_TOKEN = 'tt_access_token_cache';
const LS_ACCESS_TOKEN_EXPIRY = 'tt_access_token_expiry';
const LS_ENGINE_ALLOC = 'hunter-engine-allocation';
const LS_ENGINE_WATCHLIST = 'hunter-engine-watchlist';
const LS_ENGINE_SUBTAB = 'hunter-engine-subtab';

const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA']; // Mag 7 default — add AMD, MU via settings

// ── Shared ETF rules (same keys as Hunter — tune once, applies everywhere) ──
const LS_RULES_ETF = 'hunter-rules-etf';
interface EtfRules { CREDIT_RATIO_MIN: number; POP_MIN: number; SPREAD_DELTA_MIN: number; SPREAD_DELTA_MAX: number; ROC_MIN_SPREAD: number; }
const DEFAULT_ETF_RULES: EtfRules = { CREDIT_RATIO_MIN: 0.20, POP_MIN: 65, SPREAD_DELTA_MIN: 0.15, SPREAD_DELTA_MAX: 0.35, ROC_MIN_SPREAD: 15 };
function getSavedEtfRules(): EtfRules {
  try {
    const saved = typeof window !== 'undefined' ? localStorage.getItem(LS_RULES_ETF) : null;
    return saved ? { ...DEFAULT_ETF_RULES, ...JSON.parse(saved) } : { ...DEFAULT_ETF_RULES };
  } catch { return { ...DEFAULT_ETF_RULES }; }
}

const DEFAULT_ALLOC = { reserve: 5, wheel: 51, spx: 30, hunter: 7, longBook: 7 };

type SubTab = 'actions' | 'dashboard' | 'timeline' | 'advisor';
type ActionPriority = 'urgent' | 'review' | 'entry' | 'hold';
type EngineStatus = 'idle' | 'loading' | 'ready' | 'error';

interface Allocation { reserve: number; wheel: number; spx: number; hunter: number; longBook: number; }

interface CapitalSummary {
  obp: number;        // derivative buying power (includes margin)
  obpCash: number;    // cash available without margin
  netLiq: number;
  reserveTarget: number;
  wheelTarget: number;
  spxTarget: number;
  wheelDeployed: number;
  spxDeployed: number;
  hunterDeployed: number;  // capital in non-SPX/SPY portfolio spreads (QQQ, NVDA, etc.)
  wheelAvailable: number;
  spxAvailable: number;
  deploymentPct: number;
}

interface SpxPosition {
  symbol: string;
  shortStrike: number;
  longStrike: number;
  expiration: string;
  dte: number;
  pop: number;
  credit: number;
  creditReceived: number;
  pnl: number | null;
  pnlPct: number | null;
  status: 'hold' | 'watch' | 'close' | 'manage';
  contracts: number;
  capitalAtRisk: number;
}

interface WheelPosition {
  symbol: string;
  phase: 'cash-secured-put' | 'assigned' | 'covered-call' | 'idle';
  strike?: number;
  expiration?: string;
  dte?: number;
  pop?: number;
  credit?: number;
  pnl?: number | null;
  pnlPct?: number | null;
  sharesHeld?: number;
  costBasis?: number;
  currentPrice?: number;
  ivr?: number | null;
  status: 'hold' | 'watch' | 'entry' | 'manage' | 'idle';
  capitalRequired?: number;
}

interface ActionItem {
  id: string;
  priority: ActionPriority;
  category: 'spx' | 'wheel';
  symbol: string;
  title: string;
  detail: string;
  action: string;
  urgency?: string;
}

interface SpySuggestion {
  shortStrike: number;
  longStrike: number;
  expiration: string;
  dte: number;
  pop: number;
  credit: number;
  creditRatio: number;
  roc: number;
  contracts: number;
  spreadWidth: number;
  capitalRequired: number;
  strategy: 'BPS' | 'BCS';
  rationale: string;
  shortOccSymbol: string;
  longOccSymbol: string;
}

interface EngineData {
  capital: CapitalSummary;
  spxPositions: SpxPosition[];
  spyPositions: SpxPosition[]; // SPY spreads — same shape as SPX
  wheelPositions: WheelPosition[];
  actions: ActionItem[];
  spxSuggestedEntry: SpxSuggestion | null;
  spySuggestedEntry: SpySuggestion | null;
  wheelSuggestions: WheelSuggestion[];
  lastUpdated: Date;
}

interface SpxSuggestion {
  shortStrike: number;
  longStrike: number;
  expiration: string;
  dte: number;
  pop: number;
  credit: number;
  creditRatio: number;
  roc: number;
  contracts: number;
  capitalRequired: number;
  rationale: string;
  shortOccSymbol: string;
  longOccSymbol: string;
  strategy: 'BPS' | 'BCS';
}

interface WheelSuggestion {
  symbol: string;
  action: 'sell-put' | 'sell-call' | 'wait';
  strike?: number;
  expiration?: string;
  dte?: number;
  pop?: number;
  credit?: number;
  delta?: number;
  capitalRequired?: number;
  rationale: string;
}

// ── Auth helpers ───────────────────────────────────────────────────────────
async function getAccessToken(): Promise<string> {
  const sessionCached = sessionStorage.getItem('tt_access_token');
  if (sessionCached) return sessionCached;
  try {
    const lsCached = localStorage.getItem(LS_ACCESS_TOKEN);
    const expiry = localStorage.getItem(LS_ACCESS_TOKEN_EXPIRY);
    if (lsCached && expiry && Date.now() < parseInt(expiry)) {
      sessionStorage.setItem('tt_access_token', lsCached);
      return lsCached;
    }
  } catch {}
  const refreshToken = localStorage.getItem('tt_refresh_token');
  const clientSecret = localStorage.getItem('tt_client_secret') ?? '';
  if (!refreshToken || !clientSecret) { window.location.href = '/login'; throw new Error('Not authenticated'); }
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID, client_secret: clientSecret }),
  });
  if (!res.ok) { window.location.href = '/login'; throw new Error('Session expired'); }
  const data = await res.json();
  const token = data.access_token;
  if (!token) { window.location.href = '/login'; throw new Error('No token'); }
  sessionStorage.setItem('tt_access_token', token);
  try {
    localStorage.setItem(LS_ACCESS_TOKEN, token);
    localStorage.setItem(LS_ACCESS_TOKEN_EXPIRY, String(Date.now() + 23 * 60 * 60 * 1000));
  } catch {}
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    localStorage.setItem('tt_refresh_token', data.refresh_token);
  }
  return token;
}

async function ttFetch(path: string, token: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    sessionStorage.removeItem('tt_access_token');
    try { localStorage.removeItem(LS_ACCESS_TOKEN); localStorage.removeItem(LS_ACCESS_TOKEN_EXPIRY); } catch {}
    const freshToken = await getAccessToken();
    const retry = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${freshToken}` } });
    if (!retry.ok) throw new Error(`${path} failed (${retry.status})`);
    return retry.json();
  }
  if (!res.ok) throw new Error(`${path} failed (${res.status})`);
  return res.json();
}

function daysUntil(dateStr: string): number {
  const target = new Date(dateStr);
  const now = new Date();
  return Math.round((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

// ── Engine data loader ─────────────────────────────────────────────────────
async function loadEngineData(watchlist: string[], alloc: Allocation, esFuturesSignal: EsFutures | null = null, trendContext: TrendContext | null = null): Promise<EngineData> {
  const token = await getAccessToken();

  // ── Account + OBP ──────────────────────────────────────────────────────
  const accountsData = await ttFetch('/customers/me/accounts', token);
  const account = accountsData?.data?.items?.find((a: any) => a.account['account-number'] === '5WI51392')
    ?? accountsData?.data?.items?.[0];
  const accountNumber = account?.account?.['account-number'];
  if (!accountNumber) throw new Error('No account found');

  const balanceData = await ttFetch(`/accounts/${accountNumber}/balances`, token);
  const balData = balanceData?.data ?? {};

  const netLiq = parseFloat(
    balData['net-liquidating-value']
    ?? balData['net-liq']
    ?? balData['net-liquidation-value']
    ?? '0'
  );

  const obp = parseFloat(
    balData['derivative-buying-power']
    ?? balData['option-buying-power']
    ?? '0'
  );
  const obpCash = parseFloat(
    balData['cash-available-to-withdraw']
    ?? balData['cash-balance']
    ?? balData['equity-buying-power']
    ?? String(obp)
  );

  const capital: CapitalSummary = {
    obp,
    obpCash,
    netLiq,
    reserveTarget: netLiq * (alloc.reserve / 100),
    wheelTarget: netLiq * (alloc.wheel / 100),
    spxTarget: netLiq * (alloc.spx / 100),
    wheelDeployed: 0, spxDeployed: 0, hunterDeployed: 0,
    wheelAvailable: 0, spxAvailable: 0,
    deploymentPct: 0,
  };

  // ── Current positions ──────────────────────────────────────────────────
  const posData = await ttFetch(`/accounts/${accountNumber}/positions?include-marks=true`, token);
  const rawPositions: any[] = posData?.data?.items ?? [];

  // Group legs by underlying + expiry
  const groups: Record<string, any[]> = {};
  for (const leg of rawPositions.filter((p: any) => p['instrument-type']?.includes('Option'))) {
    const sym = leg['underlying-symbol'];
    const exp = (leg['expires-at'] ?? '').slice(0, 10);
    const key = `${sym}::${exp}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(leg);
  }

  // ── Unified capital classification ─────────────────────────────────────
  // ALL spreads (2-leg defined risk) → spread bucket regardless of symbol
  // ALL CSPs/CCs (single short option) → wheel bucket regardless of symbol

  // Helper: parse expiry date from TastyTrade option symbol
  // Format: UNDERLYING YYMMDD C/P STRIKE — e.g. AAPL  260626C00300000
  // expires-at may differ between legs; use option symbol date as canonical key
  function parseExpFromSymbol(sym: string): string {
    const m = sym?.match(/(\d{6})[CP]/);
    if (!m) return '';
    const raw = m[1]; // YYMMDD
    return `20${raw.slice(0,2)}-${raw.slice(2,4)}-${raw.slice(4,6)}`;
  }

  // Re-group using canonical expiry from option symbol (more reliable than expires-at)
  const canonicalGroups: Record<string, any[]> = {};
  for (const leg of rawPositions.filter((p: any) => p['instrument-type']?.includes('Option'))) {
    const sym = leg['underlying-symbol'];
    const expDate = parseExpFromSymbol(leg.symbol ?? '') || (leg['expires-at'] ?? '').slice(0, 10);
    const key = `${sym}::${expDate}`;
    if (!canonicalGroups[key]) canonicalGroups[key] = [];
    canonicalGroups[key].push(leg);
  }

  const spxPositions: SpxPosition[] = [];
  const spyPositions: SpxPosition[] = [];
  let spxDeployed = 0;
  for (const [key, legs] of Object.entries(canonicalGroups)) {
    const [symbol, expDate] = key.split('::');

    // Income Engine only tracks SPX/SPXW (anchor) and SPY (fills)
    // Hunter-sourced spreads on other symbols are visible in Portfolio, not here
    if (symbol !== 'SPX' && symbol !== 'SPXW' && symbol !== 'SPY') continue;

    const shortLegs = legs.filter(l => l['quantity-direction'] === 'Short');
    const longLegs = legs.filter(l => l['quantity-direction'] === 'Long');

    if (shortLegs.length > 0 && longLegs.length > 0) {
      const shortLeg = shortLegs[0];
      const longLeg = longLegs[0];
      const shortStrike = parseFloat(shortLeg.symbol?.match(/(\d{8})$/)?.[1] ?? '0') / 1000;
      const longStrike = parseFloat(longLeg.symbol?.match(/(\d{8})$/)?.[1] ?? '0') / 1000;
      const qty = Math.abs(parseInt(shortLeg['quantity'] ?? '1', 10));
      const multiplier = parseFloat(shortLeg['multiplier'] ?? '100');
      const avgShort = parseFloat(shortLeg['average-open-price'] ?? '0');
      const avgLong = parseFloat(longLeg['average-open-price'] ?? '0');
      const creditReceived = (avgShort - avgLong) * qty * multiplier;
      const shortMark = parseFloat(shortLeg['mark-price'] ?? shortLeg['close-price'] ?? '0');
      const longMark = parseFloat(longLeg['mark-price'] ?? longLeg['close-price'] ?? '0');
      const currentCost = (shortMark - longMark) * qty * multiplier;
      const pnl = creditReceived - currentCost;
      const dte = daysUntil(expDate);
      const pnlPct = creditReceived !== 0 ? (pnl / creditReceived) * 100 : null;
      const spreadWidth = Math.abs(shortStrike - longStrike);
      // Capital at risk = spread width × multiplier × qty (max loss on a defined-risk spread)
      const capitalAtRisk = spreadWidth * multiplier * qty;
      spxDeployed += capitalAtRisk;

      let status: SpxPosition['status'] = 'hold';
      if (pnlPct !== null && pnlPct >= 50) status = 'close';
      else if (dte <= 21) status = 'watch';
      else if (pnlPct !== null && pnlPct < -100) status = 'manage';

      const pop = Math.max(55, Math.min(90, 70 + (pnlPct ?? 0) * 0.1));
      const posEntry: SpxPosition = { symbol, shortStrike, longStrike, expiration: expDate, dte, pop, credit: currentCost / (qty * multiplier), creditReceived, pnl, pnlPct, status, contracts: qty, capitalAtRisk };

      if (symbol === 'SPY') spyPositions.push(posEntry);
      else spxPositions.push(posEntry);
    }
  }
  capital.spxDeployed = spxDeployed;
  capital.spxAvailable = Math.max(0, capital.spxTarget - spxDeployed);

  // Parse wheel positions
  const wheelPositions: WheelPosition[] = [];
  let wheelDeployed = 0;
  const currentPricesMap: Record<string, number> = {};
  const ivrMap: Record<string, number | null> = {};

  try {
    const equityQs = watchlist.map(s => `equity=${encodeURIComponent(s)}`).join('&');
    const priceData = await ttFetch(`/market-data/by-type?${equityQs}`, token);
    for (const item of priceData?.data?.items ?? []) {
      const sym = item.symbol?.trim();
      const last = parseFloat(item.last ?? '0');
      const bid = parseFloat(item.bid ?? '0');
      const ask = parseFloat(item.ask ?? '0');
      currentPricesMap[sym] = last > 0 ? last : (bid + ask) / 2;
      const ivrRaw = item['implied-volatility-index-rank'];
      ivrMap[sym] = ivrRaw != null ? (parseFloat(ivrRaw) > 1 ? Math.round(parseFloat(ivrRaw)) : Math.round(parseFloat(ivrRaw) * 100)) : null;
    }
  } catch {}

  // Find which watchlist stocks have active option positions
  const activeWheelSymbols = new Set<string>();
  for (const sym of watchlist) {
    for (const [key, legs] of Object.entries(canonicalGroups)) {
      if (key.startsWith(`${sym}::`) || legs.some(l => l['underlying-symbol'] === sym)) {
        const [, expDate] = key.split('::');
        // Don't mark as active yet — wait until we confirm it's a CSP/CC, not a spread
        const shortLeg = legs.find(l => l['quantity-direction'] === 'Short');
        const longLeg = legs.find(l => l['quantity-direction'] === 'Long');
        const putLeg = legs.find(l => l.symbol?.includes('P'));
        const callLeg = legs.find(l => l.symbol?.includes('C'));
        const dte = daysUntil(expDate);
        const qty = parseInt(shortLeg?.['quantity'] ?? longLeg?.['quantity'] ?? '1', 10);
        const currentPrice = currentPricesMap[sym] ?? null;

        const putLegs = legs.filter(l => l.symbol?.match(/P\d{8}$/) || l.symbol?.includes('P0'));
        const callLegs = legs.filter(l => l.symbol?.match(/C\d{8}$/) || l.symbol?.includes('C0'));
        const shortPuts = putLegs.filter(l => l['quantity-direction'] === 'Short');
        const longPuts = putLegs.filter(l => l['quantity-direction'] === 'Long');
        const shortCalls = callLegs.filter(l => l['quantity-direction'] === 'Short');
        const longCalls = callLegs.filter(l => l['quantity-direction'] === 'Long');
        const isSpread = (shortPuts.length > 0 && longPuts.length > 0) || (shortCalls.length > 0 && longCalls.length > 0);
        const isCsp = shortPuts.length > 0 && longPuts.length === 0 && callLegs.length === 0;
        const isCoveredCall = shortCalls.length > 0 && longCalls.length === 0 && putLegs.length === 0;

        if (isSpread) {
          wheelPositions.push({ symbol: sym, phase: 'idle', currentPrice: currentPricesMap[sym] ?? undefined, status: 'idle', capitalRequired: 0, ivr: ivrMap[sym] ?? null });
        } else if (isCsp && shortPuts[0]) {
          // True cash-secured put — single short put, no long leg
          const putSymbol = shortPuts[0].symbol;
          const strike = parseFloat(putSymbol?.match(/(\d{8})$/)?.[1] ?? '0') / 1000;
          const avgOpen = parseFloat(shortPuts[0]['average-open-price'] ?? '0');
          const markPrice = parseFloat(shortPuts[0]['mark-price'] ?? shortPuts[0]['close-price'] ?? '0');
          const creditRec = avgOpen * qty * 100;
          const pnl = (avgOpen - markPrice) * qty * 100;
          const pnlPct = creditRec > 0 ? (pnl / creditRec) * 100 : null;
          const capitalRequired = strike * qty * 100; // full cash-secured requirement
          wheelDeployed += capitalRequired;
          let status: WheelPosition['status'] = 'hold';
          if (pnlPct !== null && pnlPct >= 50) status = 'entry';
          else if (dte <= 14) status = 'watch';
          activeWheelSymbols.add(sym);
          wheelPositions.push({ symbol: sym, phase: 'cash-secured-put', strike, expiration: expDate, dte, pop: Math.max(60, 80 - Math.abs(pnlPct ?? 0) * 0.2), credit: markPrice, pnl, pnlPct, status, capitalRequired, currentPrice: currentPricesMap[sym] ?? undefined, ivr: ivrMap[sym] ?? null });
        } else if (isCoveredCall && shortCalls[0]) {
          // Covered call leg (shares should be in stock positions)
          const callSymbol = shortCalls[0].symbol;
          const strike = parseFloat(callSymbol?.match(/(\d{8})$/)?.[1] ?? '0') / 1000;
          const avgOpen = parseFloat(shortCalls[0]['average-open-price'] ?? '0');
          const markPrice = parseFloat(shortCalls[0]['mark-price'] ?? shortCalls[0]['close-price'] ?? '0');
          const pnl = (avgOpen - markPrice) * qty * 100;
          const pnlPct = avgOpen > 0 ? (pnl / (avgOpen * qty * 100)) * 100 : null;
          activeWheelSymbols.add(sym);
          wheelPositions.push({ symbol: sym, phase: 'covered-call', strike, expiration: expDate, dte, pnl, pnlPct, status: 'hold', capitalRequired: 0, currentPrice: currentPricesMap[sym] ?? undefined, ivr: ivrMap[sym] ?? null });
        }
      }
    }
    if (!activeWheelSymbols.has(sym)) {
      // Check if shares are held (stock position)
      const stockLeg = rawPositions.find((p: any) => p['underlying-symbol'] === sym && p['instrument-type'] === 'Equity');
      if (stockLeg) {
        const shares = parseInt(stockLeg['quantity'] ?? '0', 10);
        const costBasis = parseFloat(stockLeg['average-open-price'] ?? '0');
        const currentPrice = currentPricesMap[sym] ?? costBasis;
        wheelDeployed += (currentPricesMap[sym] ?? costBasis) * shares;
        wheelPositions.push({ symbol: sym, phase: 'assigned', sharesHeld: shares, costBasis, currentPrice, status: 'entry', capitalRequired: costBasis * shares, ivr: ivrMap[sym] ?? null });
      } else {
        const currentPrice = currentPricesMap[sym];
        wheelPositions.push({ symbol: sym, phase: 'idle', currentPrice: currentPrice ?? undefined, status: 'idle', capitalRequired: 0, ivr: ivrMap[sym] ?? null });
      }
    }
  }
  capital.wheelDeployed = wheelDeployed;
  capital.wheelAvailable = Math.max(0, capital.wheelTarget - wheelDeployed);

  // ── Hunter spreads (non-SPX/SPY, non-wheel) ───────────────────────────
  // These are spreads placed via the Hunter screener on individual stocks/ETFs.
  // They consume OBP but aren't tracked by either engine bucket.
  // Capital at risk = spread width × 100 × contracts (no margin assumption).
  let hunterDeployed = 0;
  const wheelSymbolSet = new Set(watchlist.map(s => s.toUpperCase()));
  for (const [key, legs] of Object.entries(canonicalGroups)) {
    const [symbol] = key.split('::');
    // Skip SPX/SPXW/SPY (already in spxDeployed) and wheel stocks (in wheelDeployed)
    if (['SPX', 'SPXW', 'SPY'].includes(symbol)) continue;
    if (wheelSymbolSet.has(symbol.toUpperCase())) continue;
    // Must be a defined-risk spread: exactly one short + one long option leg
    const shortLegs = legs.filter(l => l['quantity-direction'] === 'Short');
    const longLegs  = legs.filter(l => l['quantity-direction'] === 'Long');
    if (shortLegs.length !== 1 || longLegs.length !== 1) continue;
    const shortStrike = parseFloat(shortLegs[0].symbol?.match(/(\d{8})$/)?.[1] ?? '0') / 1000;
    const longStrike  = parseFloat(longLegs[0].symbol?.match(/(\d{8})$/)?.[1] ?? '0') / 1000;
    const qty = Math.abs(parseInt(shortLegs[0]['quantity'] ?? '1', 10));
    const spreadWidth = Math.abs(shortStrike - longStrike);
    if (spreadWidth > 0) hunterDeployed += spreadWidth * 100 * qty;
  }
  capital.hunterDeployed = Math.round(hunterDeployed);

  capital.deploymentPct = netLiq > 0 ? Math.round(((wheelDeployed + spxDeployed) / (capital.wheelTarget + capital.spxTarget)) * 100) : 0;

  // Deduplicate wheelPositions by symbol — keep the most meaningful phase.
  // Two accounts scanning the same watchlist symbol can create duplicate entries.
  // Priority: cash-secured-put > covered-call > assigned > idle
  const phasePriority = (phase: string) =>
    phase === 'cash-secured-put' ? 4 : phase === 'covered-call' ? 3 : phase === 'assigned' ? 2 : 1;
  const dedupedWheelPositions: WheelPosition[] = [];
  const seenWheelSymbols = new Map<string, number>(); // symbol → index in dedupedWheelPositions
  for (const pos of wheelPositions) {
    const existing = seenWheelSymbols.get(pos.symbol);
    if (existing === undefined) {
      seenWheelSymbols.set(pos.symbol, dedupedWheelPositions.length);
      dedupedWheelPositions.push(pos);
    } else {
      // Replace if this entry has a higher-priority phase
      if (phasePriority(pos.phase) > phasePriority(dedupedWheelPositions[existing].phase)) {
        dedupedWheelPositions[existing] = pos;
      }
    }
  }
  const finalWheelPositions = dedupedWheelPositions;

  // ── SPX chain scan for suggestion ─────────────────────────────────────
  let spxSuggestedEntry: SpxSuggestion | null = null;
  if (capital.spxAvailable >= 2500) {
    try {
      // Read user's saved ETF rules (shared with Hunter — tune once, applies here too)
      const etfRules = getSavedEtfRules();
      const SPREAD_WIDTH = 25; // 25-wide SPX spreads — liquid, manageable, standard
      const MAX_LOSS_PER_CONTRACT = SPREAD_WIDTH * 100; // $2,500

      const nested = await ttFetch('/option-chains/SPX/nested', token);
      const expirations = nested?.data?.items?.[0]?.expirations ?? [];
      // Friday expirations only — most liquid, best fills, matches what you already trade
      // Use UTC date parsing to avoid timezone offset shifting the day
      const isFriday = (dateStr: string) => {
        const parts = dateStr.split('-');
        return new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]))).getUTCDay() === 5;
      };
      const validExps = expirations
        .map((e: any) => ({ date: e['expiration-date'], dte: daysUntil(e['expiration-date']), strikes: e.strikes }))
        .filter((e: any) => e.dte >= 28 && e.dte <= 48 && isFriday(e.date))
        .sort((a: any, b: any) => Math.abs(a.dte - 38) - Math.abs(b.dte - 38));

      // Strategy: BPS when bullish or neutral, BCS when bearish
      // IC conditions (neutral) → still use BPS — simpler, more liquid, puts have better credit
      const esBias = esFuturesSignal?.bias ?? 'bullish';
      const strategy: 'BPS' | 'BCS' = esBias === 'bearish' ? 'BCS' : 'BPS';
      const deltaMin = etfRules.SPREAD_DELTA_MIN;
      const deltaMax = etfRules.SPREAD_DELTA_MAX;

      for (const exp of validExps.slice(0, 5)) {
        // Skip expiries in the same calendar week (Mon-Sun) as any existing position
        // Same-week expiries share gamma risk, macro events, and Friday risk
        const getWeekStart = (dateStr: string) => {
          const parts = dateStr.split('-');
          const d = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
          const day = d.getUTCDay(); // 0=Sun
          const diff = day === 0 ? -6 : 1 - day; // Monday of that week
          d.setUTCDate(d.getUTCDate() + diff);
          return d.toISOString().slice(0, 10);
        };
        const expWeek = getWeekStart(exp.date);
        const conflictsWithExisting = [...spxPositions, ...spyPositions].some(p =>
          getWeekStart(p.expiration) === expWeek
        );
        if (conflictsWithExisting) {
          console.log(`[SPX screener] Skipping ${exp.date} — same calendar week as existing position`);
          continue;
        }
        const allSymbols: string[] = [];
        for (const s of exp.strikes ?? []) {
          if (strategy === 'BCS' && s.call) allSymbols.push(s.call);
          else if (s.put) allSymbols.push(s.put);
        }
        if (allSymbols.length === 0) continue;
        for (let i = 0; i < allSymbols.length; i += 100) {
          const chunk = allSymbols.slice(i, i + 100);
          const qs = chunk.map((s: string) => `equity-option=${encodeURIComponent(s)}`).join('&');
          try {
            const greeksData = await ttFetch(`/market-data/by-type?${qs}`, token);
            for (const item of greeksData?.data?.items ?? []) {
              const delta = item.delta != null ? Math.abs(parseFloat(item.delta)) : null;
              if (!delta || delta < deltaMin || delta > deltaMax) continue;

              const shortMatch = item.symbol?.match(/(\d{8})$/);
              if (!shortMatch) continue;
              const shortStrike = parseInt(shortMatch[1], 10) / 1000;
              const longStrike = strategy === 'BCS' ? shortStrike + SPREAD_WIDTH : shortStrike - SPREAD_WIDTH;

              // ES=F strike anchor — advisory warning only, not a hard gate
              // (overnight H/L from 2-day fetch can be imprecise outside market hours)
              const esAnchorNote = (() => {
                if (!esFuturesSignal) return '';
                const buffer = 0.005;
                if (strategy === 'BPS' && shortStrike > esFuturesSignal.overnightLow * (1 - buffer))
                  return ` ⚠ Near overnight low ${esFuturesSignal.overnightLow.toFixed(0)}`;
                if (strategy === 'BCS' && shortStrike < esFuturesSignal.overnightHigh * (1 + buffer))
                  return ` ⚠ Near overnight high ${esFuturesSignal.overnightHigh.toFixed(0)}`;
                return '';
              })();

              const shortMid = (parseFloat(item.bid ?? '0') + parseFloat(item.ask ?? '0')) / 2;
              if (shortMid <= 0) continue;

              // Build exact long leg OCC symbol
              const longStrikeDigits = Math.round(longStrike * 1000).toString().padStart(8, '0');
              const longOccSymbol: string = (item.symbol ?? '').replace(/(\d{8})$/, longStrikeDigits);
              const shortOccSymbol: string = item.symbol ?? '';

              // Find long leg in current batch — fetch explicitly if missing
              let longItem = greeksData?.data?.items?.find((gi: any) => gi.symbol === longOccSymbol);
              if (!longItem && longOccSymbol) {
                try {
                  const longData = await ttFetch(`/market-data/by-type?equity-option=${encodeURIComponent(longOccSymbol)}`, token);
                  longItem = longData?.data?.items?.[0];
                } catch {}
              }
              const longMid = longItem
                ? (parseFloat(longItem.bid ?? '0') + parseFloat(longItem.ask ?? '0')) / 2
                : null;

              if (longMid == null) { console.log(`[SPX screener] ${shortStrike}/${longStrike} — long leg not found (${longOccSymbol})`); continue; }
              const credit = Math.max(0, shortMid - longMid);
              if (credit <= 0) { console.log(`[SPX screener] ${shortStrike}/${longStrike} — zero credit (short ${shortMid} long ${longMid})`); continue; }

              const SPX_CREDIT_RATIO_MIN = 0.15; // SPX index spreads — lower threshold than ETF/stock rule
              const creditRatio = credit / SPREAD_WIDTH;
              if (creditRatio < SPX_CREDIT_RATIO_MIN) { console.log(`[SPX screener] ${shortStrike}/${longStrike} — credit ratio ${(creditRatio*100).toFixed(1)}% < min ${(SPX_CREDIT_RATIO_MIN*100).toFixed(0)}%`); continue; }
              const maxLoss = SPREAD_WIDTH - credit;
              const roc = maxLoss > 0 ? (credit / maxLoss) * 100 : 0;
              if (roc < etfRules.ROC_MIN_SPREAD) { console.log(`[SPX screener] ${shortStrike}/${longStrike} — ROC ${roc.toFixed(1)}% < min ${etfRules.ROC_MIN_SPREAD}%`); continue; }
              const pop = (1 - delta) * 100;
              if (pop < 68) { console.log(`[SPX screener] ${shortStrike}/${longStrike} — POP ${pop.toFixed(0)}% < min 68%`); continue; }

              console.log(`[SPX screener] ✓ ${shortStrike}/${longStrike} — POP ${pop.toFixed(0)}% credit $${credit.toFixed(2)} ratio ${(creditRatio*100).toFixed(0)}%${esAnchorNote}`);

              const maxContracts = Math.floor(capital.spxAvailable / MAX_LOSS_PER_CONTRACT);
              const contracts = Math.max(1, Math.min(maxContracts, 3));
              const biasNote = esFuturesSignal
                ? `ES=F ${esFuturesSignal.overnightChangePct >= 0 ? '+' : ''}${esFuturesSignal.overnightChangePct.toFixed(2)}% overnight → ${strategy} bias. `
                : '';
              const primeNote = trendContext?.primeSetup
                ? `★ PRIME SETUP — reversal from ${trendContext.consecutiveDays}d downtrend. VIX elevated. `
                : trendContext?.recoverySetup
                ? `↑ Recovery setup — reversal confirmed. `
                : '';
              const anchorNote = trendContext?.reversalAnchorPrice
                ? ` Reversal anchor: ${trendContext.reversalAnchorPrice.toFixed(0)}.`
                : '';

              spxSuggestedEntry = {
                shortStrike, longStrike, expiration: exp.date, dte: exp.dte,
                pop, credit, creditRatio, roc,
                contracts, capitalRequired: MAX_LOSS_PER_CONTRACT * contracts,
                shortOccSymbol, longOccSymbol, strategy,
                rationale: `${primeNote}${biasNote}${exp.dte}d DTE · ${pop.toFixed(0)}% POP · ${(creditRatio * 100).toFixed(0)}% credit ratio · 25-wide · 1256 tax treatment.${anchorNote}`
              };
              break;
            }
            if (spxSuggestedEntry) break;
          } catch {}
        }
        if (spxSuggestedEntry) break;
      }
    } catch {}
  }

  // ── SPY chain scan — fills remaining spread bucket capital ─────────────
  let spySuggestedEntry: SpySuggestion | null = null;
  // SPY available = spread target minus ALL deployed spread capital (SPX + SPY positions)
  const spyCapitalAvailable = Math.max(0, capital.spxTarget - spxDeployed);
  const SPY_WIDTH = 3; // 3-wide default — liquid, granular
  const SPY_MAX_LOSS = SPY_WIDTH * 100; // $300 per contract
  if (spyCapitalAvailable >= SPY_MAX_LOSS * 2) { // need at least 2 contracts worth
    try {
      const etfRules = getSavedEtfRules();
      const nested = await ttFetch('/option-chains/SPY/nested', token);
      const expirations = nested?.data?.items?.[0]?.expirations ?? [];
      const validExps = expirations
        .map((e: any) => ({ date: e['expiration-date'], dte: daysUntil(e['expiration-date']), strikes: e.strikes }))
        .filter((e: any) => e.dte >= 28 && e.dte <= 48)
        .sort((a: any, b: any) => Math.abs(a.dte - 38) - Math.abs(b.dte - 38));

      const esBias = esFuturesSignal?.bias ?? 'bullish';
      const strategy: 'BPS' | 'BCS' = esBias === 'bearish' ? 'BCS' : 'BPS';

      for (const exp of validExps.slice(0, 5)) {
        const getWeekStartSpy = (dateStr: string) => {
          const parts = dateStr.split('-');
          const d = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
          const day = d.getUTCDay();
          const diff = day === 0 ? -6 : 1 - day;
          d.setUTCDate(d.getUTCDate() + diff);
          return d.toISOString().slice(0, 10);
        };
        const expWeekSpy = getWeekStartSpy(exp.date);
        const conflictsSpy = [...spxPositions, ...spyPositions].some(p =>
          getWeekStartSpy(p.expiration) === expWeekSpy
        );
        if (conflictsSpy) {
          console.log(`[SPY screener] Skipping ${exp.date} — same calendar week as existing position`);
          continue;
        }
        const allSymbols: string[] = [];
        for (const s of exp.strikes ?? []) {
          if (strategy === 'BCS' && s.call) allSymbols.push(s.call);
          else if (s.put) allSymbols.push(s.put);
        }
        if (allSymbols.length === 0) continue;
        for (let i = 0; i < allSymbols.length; i += 100) {
          const chunk = allSymbols.slice(i, i + 100);
          const qs = chunk.map((s: string) => `equity-option=${encodeURIComponent(s)}`).join('&');
          try {
            const greeksData = await ttFetch(`/market-data/by-type?${qs}`, token);
            for (const item of greeksData?.data?.items ?? []) {
              const delta = item.delta != null ? Math.abs(parseFloat(item.delta)) : null;
              if (!delta || delta < etfRules.SPREAD_DELTA_MIN || delta > etfRules.SPREAD_DELTA_MAX) continue;

              const shortMatch = item.symbol?.match(/(\d{8})$/);
              if (!shortMatch) continue;
              const shortStrike = parseInt(shortMatch[1], 10) / 1000;
              const longStrike = strategy === 'BCS' ? shortStrike + SPY_WIDTH : shortStrike - SPY_WIDTH;

              // ES=F strike anchor (scaled to SPY price — SPY ≈ SPX ÷ 10)
              // Advisory only — logs a warning but does NOT filter strikes (same as SPX behavior).
              // Hard-gating here produced strikes far below current price when overnight range
              // was used as a floor, causing badly OTM suggestions with stale-looking credits.
              const spyEsAnchorNote = (() => {
                if (!esFuturesSignal) return '';
                const buffer = 0.005;
                const spyOvernight = { low: esFuturesSignal.overnightLow / 10, high: esFuturesSignal.overnightHigh / 10 };
                if (strategy === 'BPS' && shortStrike > spyOvernight.low * (1 - buffer))
                  return ` ⚠ Near SPY overnight low ${spyOvernight.low.toFixed(1)}`;
                if (strategy === 'BCS' && shortStrike < spyOvernight.high * (1 + buffer))
                  return ` ⚠ Near SPY overnight high ${spyOvernight.high.toFixed(1)}`;
                return '';
              })();

              const shortMid = (parseFloat(item.bid ?? '0') + parseFloat(item.ask ?? '0')) / 2;
              if (shortMid <= 0) continue;

              // OI filter — short leg must have meaningful liquidity
              const shortOI = parseInt(item['open-interest'] ?? item['oi'] ?? '0', 10);
              if (shortOI < 100) continue;

              // Build exact long leg OCC symbol
              const longStrikeDigitsSpy = Math.round(longStrike * 1000).toString().padStart(8, '0');
              const longOccSymbolSpy: string = (item.symbol ?? '').replace(/(\d{8})$/, longStrikeDigitsSpy);
              const shortOccSymbolSpy: string = item.symbol ?? '';

              // Find long leg in current batch — fetch explicitly if missing
              let longItemSpy = greeksData?.data?.items?.find((gi: any) => gi.symbol === longOccSymbolSpy);
              if (!longItemSpy && longOccSymbolSpy) {
                try {
                  const longDataSpy = await ttFetch(`/market-data/by-type?equity-option=${encodeURIComponent(longOccSymbolSpy)}`, token);
                  longItemSpy = longDataSpy?.data?.items?.[0];
                } catch {}
              }
              const longMidSpy = longItemSpy
                ? (parseFloat(longItemSpy.bid ?? '0') + parseFloat(longItemSpy.ask ?? '0')) / 2
                : null;

              if (longMidSpy == null) continue;
              const credit = Math.max(0, shortMid - longMidSpy);
              if (credit <= 0) continue;

              const creditRatio = credit / SPY_WIDTH;
              if (creditRatio < etfRules.CREDIT_RATIO_MIN) continue;
              const maxLoss = SPY_WIDTH - credit;
              const roc = maxLoss > 0 ? (credit / maxLoss) * 100 : 0;
              if (roc < etfRules.ROC_MIN_SPREAD) continue;
              const pop = (1 - delta) * 100;
              if (pop < Math.max(etfRules.POP_MIN, 68)) continue;

              const maxContracts = Math.floor(spyCapitalAvailable / SPY_MAX_LOSS);
              const contracts = Math.max(2, Math.min(maxContracts, 10));
              const biasNote = esFuturesSignal
                ? `ES=F ${esFuturesSignal.overnightChangePct >= 0 ? '+' : ''}${esFuturesSignal.overnightChangePct.toFixed(2)}% → ${strategy}. `
                : '';
              const taxNote = 'Short-term tax treatment.';

              console.log(`[SPY screener] ✓ ${shortStrike}/${longStrike} — POP ${pop.toFixed(0)}% credit $${credit.toFixed(2)} ratio ${(creditRatio*100).toFixed(0)}%${spyEsAnchorNote}`);
              spySuggestedEntry = {
                shortStrike, longStrike, expiration: exp.date, dte: exp.dte,
                pop, credit, creditRatio, roc, contracts,
                spreadWidth: SPY_WIDTH,
                capitalRequired: SPY_MAX_LOSS * contracts,
                strategy,
                shortOccSymbol: shortOccSymbolSpy,
                longOccSymbol: longOccSymbolSpy,
                rationale: `${biasNote}${exp.dte}d DTE · ${pop.toFixed(0)}% POP · ${(creditRatio * 100).toFixed(0)}% credit ratio · ${SPY_WIDTH}-wide · ${contracts} contracts · ${taxNote}${spyEsAnchorNote}`
              };
              break;
            }
            if (spySuggestedEntry) break;
          } catch {}
        }
        if (spySuggestedEntry) break;
      }
    } catch {}
  }

  const IVR_MIN_FOR_NEW_PUT = 30;

  const wheelSuggestions: WheelSuggestion[] = [];
  console.log('[WheelSuggestions] Available capital:', capital.wheelAvailable, 'Positions to scan:', finalWheelPositions.filter(p => p.phase === 'idle' || p.phase === 'assigned').length);
  for (const pos of finalWheelPositions.filter(p => p.phase === 'idle' || p.phase === 'assigned')) {
    console.log(`[WheelSuggestions] ${pos.symbol} phase=${pos.phase} price=${pos.currentPrice} ivr=${pos.ivr} capitalAvail=${capital.wheelAvailable}`);
    if (pos.phase === 'idle' && capital.wheelAvailable > 0) {
      const price = pos.currentPrice ?? 0;
      if (!price) {
        console.log(`[WheelSuggestions] ${pos.symbol} skipped — no price`);
        continue;
      }
      const ivr = pos.ivr;
      const ivrStr = ivr != null ? `IVR ${ivr}` : 'IVR unavailable';
      if (ivr != null && ivr < IVR_MIN_FOR_NEW_PUT) {
        wheelSuggestions.push({
          symbol: pos.symbol,
          action: 'wait',
          rationale: `${pos.symbol} idle · ${ivrStr} — below ${IVR_MIN_FOR_NEW_PUT} threshold · wait for elevated IV before writing put`
        });
        continue;
      }
      const strike = Math.floor(price * 0.95 / 5) * 5;
      const capitalReq = strike * 100;
      if (capitalReq > capital.wheelAvailable) {
        console.log(`[WheelSuggestions] ${pos.symbol} skipped — capitalReq ${capitalReq} > available ${capital.wheelAvailable}`);
        continue;
      }
      wheelSuggestions.push({
        symbol: pos.symbol,
        action: 'sell-put',
        strike,
        dte: 35,
        pop: 75,
        delta: 0.25,
        capitalRequired: capitalReq,
        rationale: `${pos.symbol} idle · ${ivrStr} · Sell ${strike}P ~35 DTE at Δ0.25 · Capital: $${capitalReq.toLocaleString()}`
      });
    } else if (pos.phase === 'assigned' && pos.sharesHeld && pos.costBasis && pos.currentPrice) {
      const ivr = pos.ivr;
      const ivrStr = ivr != null ? `IVR ${ivr}` : 'IVR unavailable';
      const callStrike = Math.ceil(pos.costBasis * 1.03 / 5) * 5;
      wheelSuggestions.push({
        symbol: pos.symbol,
        action: 'sell-call',
        strike: callStrike,
        dte: 28,
        pop: 75,
        delta: 0.25,
        rationale: `Assigned ${pos.sharesHeld} shares @ $${pos.costBasis.toFixed(2)} · ${ivrStr} · Sell ${callStrike}C ~28 DTE at Δ0.25, 3% above cost basis`
      });
    }
  }

  // ── Build action items ─────────────────────────────────────────────────
  const actions: ActionItem[] = [];

  // SPX actions
  for (const pos of spxPositions) {
    if (pos.status === 'close') {
      actions.push({ id: `spx-close-${pos.expiration}`, priority: 'entry', category: 'spx', symbol: 'SPX', title: `Close SPX ${pos.shortStrike}/${pos.longStrike}P`, detail: `${pos.dte}d · up ${pos.pnlPct?.toFixed(0)}% · hit 50% target`, action: 'Buy to close', urgency: 'Take profit' });
    } else if (pos.status === 'watch') {
      actions.push({ id: `spx-watch-${pos.expiration}`, priority: 'review', category: 'spx', symbol: 'SPX', title: `Manage SPX ${pos.shortStrike}/${pos.longStrike}P`, detail: `${pos.dte}d · approaching 21 DTE · close or roll`, action: 'Close at 21 DTE regardless', urgency: 'Time-based rule' });
    } else if (pos.status === 'manage') {
      actions.push({ id: `spx-manage-${pos.expiration}`, priority: 'urgent', category: 'spx', symbol: 'SPX', title: `Roll SPX ${pos.shortStrike}/${pos.longStrike}P`, detail: `Loss ${pos.pnlPct?.toFixed(0)}% · roll down 10pt, out 2 weeks`, action: 'Roll down and out', urgency: 'Exceeds 2× credit' });
    }
  }

  // New SPX entry
  if (spxSuggestedEntry) {
    // Find existing position expiry for context note
    const existingExpiries = [...spxPositions, ...spyPositions].map(p => p.expiration);
    const expiryNote = existingExpiries.length > 0 ? ` · ${spxSuggestedEntry.expiration} (different week from ${existingExpiries[0]})` : '';
    // Determine if SPX is recommended over SPY
    const spxWins = !spySuggestedEntry || capital.spxAvailable < (spxSuggestedEntry.capitalRequired + (spySuggestedEntry?.capitalRequired ?? 0));
    const recBadge = spySuggestedEntry && spxWins ? ' · ◈ Recommended over SPY' : '';
    actions.push({
      id: 'spx-new-entry', priority: 'entry', category: 'spx', symbol: 'SPX',
      title: `New ${spxSuggestedEntry.rationale.startsWith('★') ? '★ ' : ''}BPS ${spxSuggestedEntry.shortStrike}/${spxSuggestedEntry.longStrike}P`,
      detail: `${spxSuggestedEntry.dte}d · ${spxSuggestedEntry.pop.toFixed(0)}% POP · $${spxSuggestedEntry.credit.toFixed(2)} cr · ${spxSuggestedEntry.contracts} contract${spxSuggestedEntry.contracts > 1 ? 's' : ''} · 25-wide · 1256${expiryNote}${recBadge}`,
      action: 'Enter SPX anchor position',
      urgency: spxWins && spySuggestedEntry ? 'Recommended over SPY' : 'Fill SPX spread allocation'
    });
  }
  if (spySuggestedEntry) {
    const existingExpiries = [...spxPositions, ...spyPositions].map(p => p.expiration);
    const expiryNote = existingExpiries.length > 0 ? ` · ${spySuggestedEntry.expiration} (different week from ${existingExpiries[0]})` : '';
    const spxWins = spxSuggestedEntry && capital.spxAvailable < (spxSuggestedEntry.capitalRequired + spySuggestedEntry.capitalRequired);
    actions.push({
      id: 'spy-new-entry', priority: 'entry', category: 'spx', symbol: 'SPY',
      title: `New ${spySuggestedEntry.strategy} ${spySuggestedEntry.shortStrike}/${spySuggestedEntry.longStrike}${spySuggestedEntry.strategy === 'BCS' ? 'C' : 'P'}`,
      detail: `${spySuggestedEntry.dte}d · ${spySuggestedEntry.pop.toFixed(0)}% POP · $${spySuggestedEntry.credit.toFixed(2)} cr · ${spySuggestedEntry.contracts} contracts · ${spySuggestedEntry.spreadWidth}-wide · ST tax${expiryNote}${spxWins ? ' · See SPX for better trade' : ''}`,
      action: 'Enter SPY fill position',
      urgency: spxWins ? 'Secondary — SPX preferred' : 'Deploy remaining spread capital'
    });
  }

  // Wheel actions
  for (const pos of wheelPositions) {
    if (pos.phase === 'cash-secured-put' && pos.status === 'entry' && pos.pnlPct && pos.pnlPct >= 50) {
      actions.push({ id: `wheel-close-${pos.symbol}`, priority: 'entry', category: 'wheel', symbol: pos.symbol, title: `Close ${pos.symbol} ${pos.strike}P`, detail: `${pos.dte}d · up ${pos.pnlPct.toFixed(0)}% · hit profit target`, action: 'Buy to close, re-enter', urgency: 'Profit target hit' });
    } else if (pos.phase === 'assigned') {
      actions.push({ id: `wheel-cc-${pos.symbol}`, priority: 'entry', category: 'wheel', symbol: pos.symbol, title: `Sell covered call ${pos.symbol}`, detail: `Assigned ${pos.sharesHeld} shares · sell CC 3% above cost basis`, action: 'Sell covered call', urgency: 'Shares idle' });
    } else if (pos.phase === 'cash-secured-put' && pos.status === 'watch') {
      actions.push({ id: `wheel-watch-${pos.symbol}`, priority: 'review', category: 'wheel', symbol: pos.symbol, title: `Review ${pos.symbol} ${pos.strike}P`, detail: `${pos.dte}d DTE · monitor for close or roll`, action: 'Review position', urgency: 'Approaching expiry' });
    }
  }

  // Wheel new entries
  for (const sug of wheelSuggestions.slice(0, 5)) {
    if (sug.action === 'sell-put') {
      actions.push({ id: `wheel-new-${sug.symbol}`, priority: 'entry', category: 'wheel', symbol: sug.symbol, title: `Sell ${sug.symbol} ${sug.strike}P`, detail: sug.rationale, action: 'Sell cash-secured put', urgency: 'Idle capital' });
    } else if (sug.action === 'sell-call') {
      actions.push({ id: `wheel-cc-sug-${sug.symbol}`, priority: 'entry', category: 'wheel', symbol: sug.symbol, title: `Sell ${sug.symbol} ${sug.strike}C`, detail: sug.rationale, action: 'Sell covered call', urgency: 'Shares held' });
    } else if (sug.action === 'wait') {
      actions.push({ id: `wheel-wait-${sug.symbol}`, priority: 'hold', category: 'wheel', symbol: sug.symbol, title: `${sug.symbol} — Wait for IV`, detail: sug.rationale, action: 'Monitor IVR', urgency: 'IVR below threshold' });
    }
  }

  // Sort: urgent → review → entry → hold
  const priorityOrder: Record<ActionPriority, number> = { urgent: 0, review: 1, entry: 2, hold: 3 };
  actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return { capital, spxPositions, spyPositions, wheelPositions: finalWheelPositions, actions, spxSuggestedEntry, spySuggestedEntry, wheelSuggestions, lastUpdated: new Date() };
}

// ── AI analysis ────────────────────────────────────────────────────────────
async function getEngineAIAnalysis(data: EngineData, watchlist: string[]): Promise<string> {
  const prompt = `You are an options trading portfolio manager analyzing a premium-selling account.

Capital: $${data.capital.netLiq.toLocaleString()} Net Liq · $${data.capital.obp.toLocaleString()} Option BP
SPX allocation: $${data.capital.spxTarget.toLocaleString()} target, $${data.capital.spxDeployed.toLocaleString()} deployed (${Math.round(data.capital.spxDeployed / data.capital.spxTarget * 100)}%)
Wheel allocation: $${data.capital.wheelTarget.toLocaleString()} target, $${data.capital.wheelDeployed.toLocaleString()} deployed (${Math.round(data.capital.wheelDeployed / data.capital.wheelTarget * 100)}%)

SPX positions (${data.spxPositions.length}):
${data.spxPositions.map(p => `- ${p.shortStrike}/${p.longStrike}P exp ${p.expiration} (${p.dte}d) · P&L ${p.pnlPct?.toFixed(0) ?? '?'}% · ${p.status}`).join('\n')}

Wheel positions:
${data.wheelPositions.filter(p => p.phase !== 'idle').map(p => `- ${p.symbol}: ${p.phase} ${p.strike ? p.strike + 'P' : ''} ${p.sharesHeld ? p.sharesHeld + ' shares' : ''}`).join('\n')}

Watchlist (idle): ${watchlist.join(', ')}

Give a 3-4 sentence portfolio assessment covering:
1. Overall deployment health — are we under/over-deployed?
2. SPX engine status — is the revolving engine running efficiently?
3. Top 1-2 priority actions and why
4. Any market conditions that should change the strategy today

Be specific, direct, no disclaimers.`;

  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 400,
      system: 'You are a concise options portfolio manager. Be direct, specific, no hedging.',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error('AI analysis failed');
  const d = await res.json();
  return d?.content?.find((b: any) => b.type === 'text')?.text ?? '';
}


// ── Market Conditions ─────────────────────────────────────────────────────
// 2026 FOMC meeting dates (announcement days)
const FOMC_DATES_2026 = [
  '2026-01-29','2026-03-19','2026-05-07','2026-06-18',
  '2026-07-30','2026-09-17','2026-11-05','2026-12-17',
];

interface ConditionFlag {
  label: string;
  value: string;
  status: 'good' | 'warn' | 'bad';
  detail: string;
}

interface EsFutures {
  price: number;
  overnightChangePct: number;
  overnightHigh: number;
  overnightLow: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  biasLabel: string;
  strikeAnchorNote: string;
  settling: boolean;
}

interface TrendContext {
  sma10: number;
  currentVsSma: 'above' | 'below' | 'just_crossed_above' | 'just_crossed_below';
  consecutiveDays: number; // days above or below SMA before today
  primeSetup: boolean;     // reversal + VIX >= 20
  recoverySetup: boolean;  // reversal but VIX < 20
  reversalAnchorPrice: number | null; // low of reversal candle — BPS strike anchor
  trendLabel: string;      // e.g. "In downtrend 8 days" / "Reversal day 1" / "Uptrend 12 days"
}

interface MarketConditions {
  score: number;
  signal: 'PRIME SETUP' | 'TRADE TODAY' | 'MANAGE ONLY' | 'CAUTION' | 'WAIT TODAY';
  signalDetail: string;
  flags: {
    dayOfWeek: ConditionFlag;
    timeOfDay: ConditionFlag;
    esFutures: ConditionFlag;
    vix: ConditionFlag;
    termStructure: ConditionFlag;
    spxMove: ConditionFlag;
    fomc: ConditionFlag;
    expirationWeek: ConditionFlag;
    earnings: ConditionFlag;
  };
  esFutures: EsFutures | null;
  trendContext: TrendContext | null;
  fiftyPctPositions: string[];
}

async function loadMarketConditions(watchlist: string[], engineData: EngineData | null): Promise<MarketConditions> {
  const now = new Date();
  // Dynamic ET offset — handles EST (-5) and EDT (-4) automatically
  const etParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now);
  const etHour = parseInt(etParts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const etMinutes = parseInt(etParts.find(p => p.type === 'minute')?.value ?? '0', 10);
  const etTimeDecimal = etHour + etMinutes / 60;
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon ... 5=Fri
  const todayStr = now.toISOString().slice(0, 10);

  let score = 100;
  const flags: MarketConditions['flags'] = {} as any;

  // ── Day of week ────────────────────────────────────────────────────────
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const dayName = dayNames[dayOfWeek];
  if (dayOfWeek === 1) {
    score -= 15;
    flags.dayOfWeek = { label: 'Day of week', value: dayName, status: 'warn', detail: 'Monday gap risk — weekend news can gap fills' };
  } else if (dayOfWeek === 5) {
    score -= 12;
    flags.dayOfWeek = { label: 'Day of week', value: dayName, status: 'warn', detail: 'Friday theta distortion — avoid new entries near close' };
  } else if (dayOfWeek === 0 || dayOfWeek === 6) {
    score -= 100;
    flags.dayOfWeek = { label: 'Day of week', value: dayName, status: 'bad', detail: 'Market closed' };
  } else {
    flags.dayOfWeek = { label: 'Day of week', value: dayName, status: 'good', detail: 'Optimal trading day' };
  }

  // ── Time of day ────────────────────────────────────────────────────────
  const etTimeStr = `${String(etHour).padStart(2,'0')}:${String(etMinutes).padStart(2,'0')} ET`;
  if (etTimeDecimal < 9.5 || etTimeDecimal > 16.0) {
    score -= 100;
    flags.timeOfDay = { label: 'Market time', value: etTimeStr, status: 'bad', detail: 'Market closed' };
  } else if (etTimeDecimal < 10.0) {
    score -= 18;
    flags.timeOfDay = { label: 'Market time', value: etTimeStr, status: 'warn', detail: 'Opening 30 min — wide bid-ask, erratic pricing' };
  } else if (etTimeDecimal > 15.5) {
    score -= 15;
    flags.timeOfDay = { label: 'Market time', value: etTimeStr, status: 'warn', detail: 'Closing 30 min — liquidity thin, avoid new fills' };
  } else {
    flags.timeOfDay = { label: 'Market time', value: etTimeStr, status: 'good', detail: 'Clean trading window (10am–3:30pm ET)' };
  }

  // ── VIX + term structure ───────────────────────────────────────────────
  let vixValue = 18;
  let vix3mValue = 20;
  let spxChange = 0;
  let esFutures: EsFutures | null = null;
  let trendContext: TrendContext | null = null;

  try {
    const [vixRes, vix3mRes, spxRes, esRes, esTrendRes] = await Promise.allSettled([
      fetch('/api/market?symbol=%5EVIX&range=2d&interval=1d',                     { cache: 'no-store' }),
      fetch('/api/market?symbol=%5EVIX3M&range=2d&interval=1d',                   { cache: 'no-store' }),
      fetch('/api/market?symbol=%5EGSPC&range=2d&interval=1d',                    { cache: 'no-store' }),
      fetch('/api/market?symbol=ES%3DF&range=2d&interval=1d&includePrePost=true', { cache: 'no-store' }),
      fetch('/api/market?symbol=ES%3DF&range=1mo&interval=1d',                    { cache: 'no-store' }),
    ]);
    if (vixRes.status === 'fulfilled' && vixRes.value.ok) {
      const d = await vixRes.value.json();
      const meta = d?.chart?.result?.[0]?.meta;
      vixValue = meta?.regularMarketPrice ?? meta?.previousClose ?? 18;
    }
    if (vix3mRes.status === 'fulfilled' && vix3mRes.value.ok) {
      const d = await vix3mRes.value.json();
      const meta = d?.chart?.result?.[0]?.meta;
      vix3mValue = meta?.regularMarketPrice ?? meta?.previousClose ?? 20;
    }
    if (spxRes.status === 'fulfilled' && spxRes.value.ok) {
      const d = await spxRes.value.json();
      const meta = d?.chart?.result?.[0]?.meta;
      const prev = meta?.chartPreviousClose ?? meta?.previousClose ?? 0;
      const curr = meta?.regularMarketPrice ?? prev;
      spxChange = prev > 0 ? ((curr - prev) / prev) * 100 : 0;
    }
    if (esRes.status === 'fulfilled' && esRes.value.ok) {
      const d = await esRes.value.json();
      const result = d?.chart?.result?.[0];
      const meta = result?.meta;
      const quotes = result?.indicators?.quote?.[0];
      const timestamps = result?.timestamp ?? [];
      // Current price
      const esPrice = meta?.regularMarketPrice ?? meta?.previousClose ?? 0;
      const esPrevClose = meta?.chartPreviousClose ?? meta?.previousClose ?? esPrice;
      // Overnight high/low: look at last session's candle data
      const highs: number[] = quotes?.high ?? [];
      const lows: number[] = quotes?.low ?? [];
      const overnightHigh = highs.length > 0 ? Math.max(...highs.filter(h => h > 0)) : esPrice * 1.005;
      const overnightLow = lows.length > 0 ? Math.min(...lows.filter(l => l > 0)) : esPrice * 0.995;
      const overnightChangePct = esPrevClose > 0 ? ((esPrice - esPrevClose) / esPrevClose) * 100 : 0;
      // Direction bias
      let bias: EsFutures['bias'] = 'neutral';
      let biasLabel = 'BPS'; // neutral → default to BPS (engine uses BPS not IC in neutral)
      if (overnightChangePct > 0.5) { bias = 'bullish'; biasLabel = 'BPS'; }
      else if (overnightChangePct < -0.5) { bias = 'bearish'; biasLabel = 'BCS'; }
      // Strike anchor note
      const bufferPct = 0.5;
      const strikeAnchorNote = bias === 'bullish'
        ? `Overnight low ~${overnightLow.toFixed(0)} — short put strike should clear this by ${bufferPct}% (≥${(overnightLow * (1 - bufferPct / 100)).toFixed(0)})`
        : bias === 'bearish'
        ? `Overnight high ~${overnightHigh.toFixed(0)} — short call strike should clear this by ${bufferPct}% (≤${(overnightHigh * (1 + bufferPct / 100)).toFixed(0)})`
        : `ES=F flat — BPS conditions · puts below ${overnightLow.toFixed(0)} for best buffer`;
      // Settling: market just opened and ES still moving > 0.3% intraday
      const etPartsNow = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric', minute: 'numeric', hour12: false,
      }).formatToParts(new Date());
      const etHourNow = parseInt(etPartsNow.find(p => p.type === 'hour')?.value ?? '0', 10);
      const etMinNow = parseInt(etPartsNow.find(p => p.type === 'minute')?.value ?? '0', 10);
      const etDecNow = etHourNow + etMinNow / 60;
      const settling = etDecNow >= 9.5 && etDecNow < 9.75 && Math.abs(overnightChangePct) > 0.3;

      esFutures = { price: esPrice, overnightChangePct, overnightHigh, overnightLow, bias, biasLabel, strikeAnchorNote, settling };
    }

    // ── ES=F 30-day trend analysis — PRIME SETUP detection ────────────────
    if (esTrendRes.status === 'fulfilled' && esTrendRes.value.ok) {
      const td = await esTrendRes.value.json();
      const closes: number[] = td?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
      const lows: number[] = td?.chart?.result?.[0]?.indicators?.quote?.[0]?.low ?? [];
      const validCloses = closes.filter(c => c != null && c > 0);

      if (validCloses.length >= 11) {
        // Calculate 10-day SMA using the 10 closes ending at yesterday (index -2 to -11)
        const yesterday = validCloses[validCloses.length - 2] ?? validCloses[validCloses.length - 1];
        const today = validCloses[validCloses.length - 1];
        const sma10Closes = validCloses.slice(-11, -1); // last 10 closes before today
        const sma10 = sma10Closes.reduce((a, b) => a + b, 0) / sma10Closes.length;

        const todayAbove = today > sma10;
        const yesterdayAbove = yesterday > sma10;

        // Detect cross
        let currentVsSma: TrendContext['currentVsSma'];
        if (!yesterdayAbove && todayAbove) currentVsSma = 'just_crossed_above';
        else if (yesterdayAbove && !todayAbove) currentVsSma = 'just_crossed_below';
        else if (todayAbove) currentVsSma = 'above';
        else currentVsSma = 'below';

        // Count consecutive days in current state (walking back from yesterday)
        let consecutiveDays = 0;
        const compareAbove = currentVsSma === 'just_crossed_above' ? false : todayAbove; // count days in prior state for reversals
        for (let i = validCloses.length - 2; i >= 0 && validCloses.length - 11 <= i; i--) {
          const c = validCloses[i];
          const smaSlice = validCloses.slice(Math.max(0, i - 10), i);
          if (smaSlice.length < 5) break;
          const sma = smaSlice.reduce((a, b) => a + b, 0) / smaSlice.length;
          const wasAbove = c > sma;
          if (wasAbove !== compareAbove) break;
          consecutiveDays++;
        }

        // Reversal conditions
        const isReversal = currentVsSma === 'just_crossed_above' && consecutiveDays >= 5;
        const reversalAnchorPrice = isReversal
          ? Math.min(...lows.filter(l => l != null && l > 0).slice(-3)) // low of recent 3 candles
          : null;

        const primeSetup = isReversal && vixValue >= 20;
        const recoverySetup = isReversal && vixValue < 20;

        const trendLabel = currentVsSma === 'just_crossed_above'
          ? `Reversal — crossed above SMA10 after ${consecutiveDays}d downtrend`
          : currentVsSma === 'just_crossed_below'
          ? `Breakdown — crossed below SMA10 after ${consecutiveDays}d uptrend`
          : currentVsSma === 'above'
          ? `Uptrend — above SMA10 for ${consecutiveDays}d`
          : `Downtrend — below SMA10 for ${consecutiveDays}d`;

        trendContext = { sma10, currentVsSma, consecutiveDays, primeSetup, recoverySetup, reversalAnchorPrice, trendLabel };
      }
    }
  } catch {}
  if (esFutures) {
    const chg = esFutures.overnightChangePct;
    const chgStr = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% overnight · ${esFutures.biasLabel} bias`;
    if (esFutures.settling) {
      score -= 15;
      flags.esFutures = { label: 'ES=F Futures', value: chgStr, status: 'warn', detail: `Open settling — ES still moving aggressively. Wait until 9:45am ET before entering. ${esFutures.strikeAnchorNote}` };
    } else if (Math.abs(chg) > 2.0) {
      score -= 20;
      flags.esFutures = { label: 'ES=F Futures', value: chgStr, status: 'bad', detail: `Large overnight move >2% — elevated gap risk. ${esFutures.strikeAnchorNote}` };
    } else if (Math.abs(chg) > 0.5) {
      flags.esFutures = { label: 'ES=F Futures', value: chgStr, status: 'good', detail: `Directional bias clear — ${esFutures.biasLabel} favored. ${esFutures.strikeAnchorNote}` };
    } else {
      flags.esFutures = { label: 'ES=F Futures', value: chgStr, status: 'good', detail: `ES flat — IC conditions. ${esFutures.strikeAnchorNote}` };
    }
  } else {
    flags.esFutures = { label: 'ES=F Futures', value: 'Unavailable', status: 'warn', detail: 'Could not fetch ES=F data — use SPX day move as proxy' };
  }

  // VIX scoring
  const vixStr = vixValue.toFixed(1);
  if (vixValue > 35) {
    score -= 30;
    flags.vix = { label: 'VIX', value: vixStr, status: 'bad', detail: 'Extreme fear — wide spreads, avoid new entries' };
  } else if (vixValue > 28) {
    score -= 18;
    flags.vix = { label: 'VIX', value: vixStr, status: 'warn', detail: 'Elevated fear — fills will be wide, size down' };
  } else if (vixValue < 13) {
    score -= 15;
    flags.vix = { label: 'VIX', value: vixStr, status: 'warn', detail: 'Crushed IV — premium too thin to sell efficiently' };
  } else if (vixValue < 16) {
    score -= 8;
    flags.vix = { label: 'VIX', value: vixStr, status: 'warn', detail: 'Low IV — thin premium, prefer managing existing positions' };
  } else {
    flags.vix = { label: 'VIX', value: vixStr, status: 'good', detail: `Normal range (${vixStr}) — good premium environment` };
  }

  // Term structure
  const inverted = vixValue > vix3mValue;
  if (inverted) {
    score -= 20;
    flags.termStructure = { label: 'VIX term structure', value: `Inverted (${vixValue.toFixed(1)} > ${vix3mValue.toFixed(1)})`, status: 'bad', detail: 'Backwardation — market in panic, IV may spike further' };
  } else {
    const spread = (vix3mValue - vixValue).toFixed(1);
    flags.termStructure = { label: 'VIX term structure', value: `Normal (+${spread} spread)`, status: 'good', detail: `Contango — VIX3M ${vix3mValue.toFixed(1)} > VIX ${vixValue.toFixed(1)}, favorable for selling premium` };
  }

  // SPX move
  const spxStr = `${spxChange >= 0 ? '+' : ''}${spxChange.toFixed(2)}%`;
  if (spxChange < -2.0) {
    score -= 25;
    flags.spxMove = { label: 'SPX today', value: spxStr, status: 'bad', detail: 'Sharp drop >2% — avoid BPS entries, selling into falling market' };
  } else if (spxChange < -1.0) {
    score -= 12;
    flags.spxMove = { label: 'SPX today', value: spxStr, status: 'warn', detail: 'Moderate drop — if bullish thesis intact, wait for stabilization' };
  } else if (spxChange > 2.0) {
    score -= 5;
    flags.spxMove = { label: 'SPX today', value: spxStr, status: 'good', detail: 'Strong up day — BPS entries favorable, strikes have more buffer' };
  } else {
    flags.spxMove = { label: 'SPX today', value: spxStr, status: 'good', detail: 'Stable — normal conditions for new entries' };
  }

  // ── FOMC ──────────────────────────────────────────────────────────────
  const isFomcDay = FOMC_DATES_2026.includes(todayStr);
  const nextFomc = FOMC_DATES_2026.find(d => d >= todayStr);
  const daysToFomc = nextFomc ? Math.round((new Date(Date.UTC(...nextFomc.split('-').map(Number) as [number,number,number])).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : 999;
  const fomcThisWeek = daysToFomc <= 3 && daysToFomc >= 0;
  if (isFomcDay) {
    score -= 25;
    flags.fomc = { label: 'FOMC', value: 'Today · 2:00 PM ET', status: 'bad', detail: 'FOMC announcement day — IV spikes before, collapses after. No new positions.' };
  } else if (fomcThisWeek) {
    score -= 12;
    flags.fomc = { label: 'FOMC', value: `In ${daysToFomc}d (${nextFomc})`, status: 'warn', detail: 'FOMC this week — defer new entries until after announcement' };
  } else {
    flags.fomc = { label: 'FOMC', value: nextFomc ? `Next: ${nextFomc}` : 'None scheduled', status: 'good', detail: 'No FOMC risk this week' };
  }

  // ── Expiration week ────────────────────────────────────────────────────
  // Monthly expiration = 3rd Friday of month
  const month = now.getMonth(), year = now.getFullYear();
  const firstDay = new Date(year, month, 1).getDay();
  const thirdFriday = new Date(year, month, 1 + ((5 - firstDay + 7) % 7) + 14);
  const daysToExp = Math.round((thirdFriday.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const expWeek = daysToExp >= 0 && daysToExp <= 5;
  const expDay = daysToExp === 0;
  if (expDay) {
    score -= 20;
    flags.expirationWeek = { label: 'Expiration', value: 'Today (monthly)', status: 'bad', detail: 'Monthly expiration day — extreme gamma, avoid all new positions' };
  } else if (expWeek) {
    score -= 10;
    flags.expirationWeek = { label: 'Expiration', value: `Monthly exp in ${daysToExp}d`, status: 'warn', detail: 'Expiration week — gamma elevated, prefer closing over opening' };
  } else {
    flags.expirationWeek = { label: 'Expiration', value: `Next monthly: ${daysToExp}d`, status: 'good', detail: 'Not expiration week — normal conditions' };
  }

  // ── Earnings from engine data ──────────────────────────────────────────
  const earningsPositions = engineData?.actions.filter(a => a.detail.toLowerCase().includes('earnings')) ?? [];
  if (earningsPositions.length > 0) {
    score -= 10;
    flags.earnings = { label: 'Watchlist earnings', value: `${earningsPositions.map(a => a.symbol).join(', ')} at risk`, status: 'warn', detail: 'Earnings within 7d on active positions — do not add to those names' };
  } else {
    flags.earnings = { label: 'Watchlist earnings', value: 'None within 7d', status: 'good', detail: 'No near-term earnings risk on watchlist' };
  }

  // ── 50% profit positions ───────────────────────────────────────────────
  const fiftyPct = engineData?.actions.filter(a => a.priority === 'entry' && a.detail.includes('50%')).map(a => a.symbol) ?? [];
  if (fiftyPct.length > 0 && score >= 55) {
    score = Math.min(score, 72); // cap at MANAGE ONLY if there are positions to close
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // PRIME SETUP boost — reversal from sustained downtrend with elevated IV
  if (trendContext?.primeSetup) score = Math.min(100, score + 15);

  let signal: MarketConditions['signal'];
  let signalDetail: string;

  if (trendContext?.primeSetup && score >= 70) {
    signal = 'PRIME SETUP';
    signalDetail = `${trendContext.trendLabel} · VIX ${vixValue.toFixed(1)} still elevated · maximum BPS entry conditions`;
  } else if (score >= 75) {
    signal = 'TRADE TODAY';
    const biasNote = esFutures ? ` · ${esFutures.biasLabel} bias from ES=F` : '';
    const recoveryNote = trendContext?.recoverySetup ? ' · Recovery setup — good BPS conditions' : '';
    signalDetail = `All systems green · optimal window for new entries${biasNote}${recoveryNote}`;
  } else if (score >= 55) {
    signal = 'MANAGE ONLY';
    if (fiftyPct.length > 0) signalDetail = `Close ${fiftyPct.join(', ')} profit targets first · defer new entries`;
    else if (vixValue < 16) signalDetail = 'Low IV environment · close winners, wait for better premium';
    else signalDetail = 'Conditions acceptable · manage existing positions, cautious on new entries';
  } else if (score >= 35) {
    signal = 'CAUTION';
    signalDetail = `${Object.values(flags).filter(f => f.status !== 'good').length} flags active · manage urgent positions only`;
  } else {
    signal = 'WAIT TODAY';
    signalDetail = 'High-risk environment · no new positions, only stop-loss closes if needed';
  }

  return { score, signal, signalDetail, flags, esFutures, trendContext, fiftyPctPositions: fiftyPct };
}

// ── UI Components ──────────────────────────────────────────────────────────
function CapitalBar({ label, deployed, target, color }: { label: string; deployed: number; target: number; color: string }) {
  const pct = target > 0 ? Math.min(100, (deployed / target) * 100) : 0;
  const isOver = deployed > target;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-slate-400">{label}</span>
        <span className={isOver ? 'text-red-400' : 'text-slate-300'}>${deployed.toLocaleString()} / ${target.toLocaleString()}</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-700/60 overflow-hidden">
        <div className={`h-full rounded-full transition-all ${isOver ? 'bg-red-500' : color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between text-[9px] text-slate-500">
        <span>{pct.toFixed(0)}% deployed</span>
        <span className={isOver ? 'text-red-400' : 'text-emerald-400/70'}>{isOver ? `+$${(deployed - target).toLocaleString()} over` : `$${(target - deployed).toLocaleString()} available`}</span>
      </div>
    </div>
  );
}

function ActionCard({ item, th }: { item: ActionItem; th: typeof THEMES[Theme] }) {
  const colors = {
    urgent: { border: 'border-l-red-500',    badge: 'bg-red-500/15 text-red-400 border-red-600',     action: 'text-red-400' },
    review: { border: 'border-l-amber-500',  badge: 'bg-amber-500/15 text-amber-400 border-amber-600', action: 'text-amber-400' },
    entry:  { border: 'border-l-emerald-500', badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-600', action: 'text-emerald-400' },
    hold:   { border: 'border-l-slate-600',  badge: 'bg-slate-700 text-slate-400 border-slate-600',   action: 'text-slate-400' },
  };
  const c = colors[item.priority];
  const priorityIcon = { urgent: '⚡', review: '⚠', entry: '✦', hold: '·' }[item.priority];
  const isSuggested = item.priority === 'entry' && (item.symbol === 'SPX' || item.symbol === 'SPY');
  return (
    <div className={`border-l-4 ${c.border} ${th.card} border ${th.border} rounded-r-lg px-3 py-2.5`}>
      <div className="flex items-center gap-3">
        {/* Symbol badge */}
        <span className={`text-[8px] px-1.5 py-0.5 border rounded font-bold shrink-0 ${item.category === 'spx' ? 'border-violet-700 text-violet-400 bg-violet-500/10' : 'border-blue-700 text-blue-400 bg-blue-500/10'}`}>
          {item.symbol}
        </span>
        {isSuggested && (
          <span className="text-[8px] px-1.5 py-0.5 border border-emerald-700 text-emerald-400 bg-emerald-500/10 rounded font-bold shrink-0">SUGGESTED</span>
        )}
        {/* Action — main text */}
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-bold ${th.text} truncate`}>{item.title}</p>
          <p className={`text-[10px] ${th.textFaint} truncate`}>{item.detail}</p>
        </div>
        {/* Priority indicator */}
        <span className={`text-[9px] font-bold shrink-0 ${c.action}`}>{priorityIcon} {item.priority}</span>
      </div>
      {isSuggested && (
        <p className={`text-[9px] ${th.textFaint} mt-1 ml-1 italic`}>Not yet placed — review details, then use the Enter button in Suggested New Positions</p>
      )}
    </div>
  );
}

// ── Reusable chart button — sparkline popup + TradingView link ─────────────
function ChartButton({ symbol, th }: { symbol: string; th: typeof THEMES[Theme] }) {
  const [showChart, setShowChart] = useState(false);
  const [popupPos, setPopupPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [sparkData, setSparkData] = useState(null as number[] | null);
  const [sparkLoading, setSparkLoading] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={e => {
          e.stopPropagation();
          if (!showChart) {
            if (buttonRef.current) {
              const r = buttonRef.current.getBoundingClientRect();
              setPopupPos({ top: r.bottom + window.scrollY + 4, left: r.left + window.scrollX });
            }
            setShowChart(true);
            if (!sparkData) {
              setSparkLoading(true);
              fetch(`/api/chart?symbol=${encodeURIComponent(symbol)}`)
                .then(r => r.json())
                .then(d => {
                  const closes = (d?.bars ?? []).map((b: any) => b?.c).filter((v: any) => v != null).slice(-90);
                  setSparkData(closes);
                })
                .catch(() => setSparkData([]))
                .finally(() => setSparkLoading(false));
            }
          } else { setShowChart(false); }
        }}
        ref={buttonRef}
        className={`inline-flex items-center gap-0.5 text-[9px] transition-colors ${showChart ? 'text-blue-400' : 'text-slate-500 hover:text-blue-400'}`}
        title="Quick chart"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
        <span className="tracking-wide">chart</span>
      </button>

      {showChart && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setShowChart(false)} />
          <div
            className={`fixed z-[9999] ${th.sidebar} border ${th.border} rounded-xl shadow-2xl p-3`}
            style={{ width: '280px', top: popupPos?.top ?? 0, left: popupPos?.left ?? 0 }}
            onClick={e => e.stopPropagation()}
          >
          <div className="flex items-center justify-between mb-2">
            <span className={`text-[10px] font-bold ${th.textFaint} tracking-widest`}>{symbol}</span>
            <button onClick={() => setShowChart(false)} className="text-slate-500 hover:text-white transition-colors text-sm leading-none">✕</button>
          </div>
            {sparkLoading && (
              <div className="flex items-center justify-center h-16">
                <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            {!sparkLoading && sparkData && sparkData.length > 1 && (() => {
              const min = Math.min(...sparkData);
              const max = Math.max(...sparkData);
              const range = max - min || 1;
              const w = 256, h = 56;
              const pts = sparkData.map((v, i) => {
                const x = (i / (sparkData.length - 1)) * w;
                const y = h - ((v - min) / range) * h;
                return `${x.toFixed(1)},${y.toFixed(1)}`;
              }).join(' ');
              const isUp = sparkData[sparkData.length - 1] >= sparkData[0];
              const color = isUp ? '#10b981' : '#ef4444';
              const lastPrice = sparkData[sparkData.length - 1];
              const changePct = ((lastPrice - sparkData[0]) / sparkData[0] * 100).toFixed(1);
              return (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className={`text-[10px] font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{symbol}</span>
                    <span className="text-[10px] font-bold" style={{ color }}>
                      ${lastPrice.toFixed(2)} <span className="text-[9px]">{isUp ? '+' : ''}{changePct}% 30d</span>
                    </span>
                  </div>
                  <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: '56px' }}>
                    <defs>
                      <linearGradient id={`grad-engine-${symbol}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity="0.3" />
                        <stop offset="100%" stopColor={color} stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
                    <polygon points={`0,${h} ${pts} ${w},${h}`} fill={`url(#grad-engine-${symbol})`} />
                  </svg>
                </div>
              );
            })()}
            {!sparkLoading && sparkData && sparkData.length === 0 && (
              <p className={`text-[9px] ${th.textFaint} text-center py-3`}>Chart data unavailable</p>
            )}
          <a
            href={`https://www.tradingview.com/chart/?symbol=${symbol}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="flex items-center justify-center gap-2 w-full py-2 rounded-lg text-[10px] text-blue-400 font-bold tracking-wider transition-colors border border-blue-500/30 hover:border-blue-500/60 hover:bg-blue-500/10"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            Open in TradingView
          </a>
        </div>
        </>
      )}
    </div>
  );
}

function SpxPositionRow({ pos, th }: { pos: SpxPosition; th: typeof THEMES[Theme] }) {
  const statusColors = { hold: 'text-emerald-400', watch: 'text-amber-400', close: 'text-blue-400', manage: 'text-red-400' };
  const statusBg = { hold: 'bg-emerald-500/10 border-emerald-700', watch: 'bg-amber-500/10 border-amber-700', close: 'bg-blue-500/10 border-blue-700', manage: 'bg-red-500/10 border-red-700' };
  return (
    <div className={`border-b ${th.border} last:border-b-0`}>
      <div className={`flex items-center gap-3 px-4 py-2.5`}>
        <div className="w-32 shrink-0">
          <p className={`text-xs font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{pos.symbol} {pos.shortStrike}/{pos.longStrike}P</p>
          <p className={`text-[9px] ${th.textFaint}`}>{pos.expiration} · {pos.dte}d</p>
        </div>
        <div className="w-16 shrink-0 text-center">
          <p className={`text-xs font-bold ${pos.pop >= 70 ? 'text-emerald-400' : pos.pop >= 60 ? 'text-amber-400' : 'text-red-400'}`}>{pos.pop.toFixed(0)}%</p>
          <p className={`text-[9px] ${th.textFaint}`}>POP</p>
        </div>
        <div className="w-20 shrink-0 text-center">
          <p className={`text-xs font-bold ${pos.pnl != null && pos.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {pos.pnlPct != null ? `${pos.pnlPct >= 0 ? '+' : ''}${pos.pnlPct.toFixed(0)}%` : '—'}
          </p>
          <p className={`text-[9px] ${th.textFaint}`}>{pos.pnl != null ? `${pos.pnl >= 0 ? '+' : ''}$${pos.pnl.toFixed(0)}` : '—'}</p>
        </div>
        <div className="w-20 shrink-0 text-center">
          <p className={`text-[9px] ${th.textFaint}`}>${pos.capitalAtRisk.toLocaleString()}</p>
          <p className={`text-[9px] ${th.textFaint}`}>at risk</p>
        </div>
        <div className="w-16 shrink-0 text-center">
          <p className={`text-[9px] ${pos.contracts > 1 ? 'text-amber-400 font-bold' : th.textFaint}`}>{pos.contracts}×</p>
        </div>
        <div className="flex-1 flex justify-end">
          <span className={`text-[9px] px-2 py-0.5 border rounded font-bold ${statusColors[pos.status]} ${statusBg[pos.status]}`}>{pos.status.toUpperCase()}</span>
        </div>
      </div>
      {pos.contracts > 1 && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-amber-500/8 border-t border-amber-600/20">
          <span className="text-amber-400 text-[9px]">⚠</span>
          <p className="text-[9px] text-amber-400/80">Existing position — {pos.contracts}× contracts on {pos.expiration} expiry concentrates risk. New suggestions will target a different expiry week.</p>
        </div>
      )}
    </div>
  );
}

function WheelPositionRow({ pos, th }: { pos: WheelPosition; th: typeof THEMES[Theme] }) {
  const phaseColors = {
    'cash-secured-put': 'text-blue-400 border-blue-700 bg-blue-500/10',
    'assigned': 'text-amber-400 border-amber-700 bg-amber-500/10',
    'covered-call': 'text-emerald-400 border-emerald-700 bg-emerald-500/10',
    'idle': 'text-slate-400 border-slate-700 bg-slate-700/20',
  };
  const phaseLabel = { 'cash-secured-put': 'CSP', 'assigned': 'ASSIGNED', 'covered-call': 'CC', 'idle': 'IDLE' };
  const ivrColor = pos.ivr == null ? th.textFaint
    : pos.ivr >= 50 ? 'text-emerald-400'
    : pos.ivr >= 30 ? 'text-amber-400'
    : 'text-red-400';
  const ivrLabel = pos.ivr != null ? `IVR ${pos.ivr}` : 'IVR —';
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 border-b ${th.border} last:border-b-0`}>
      <div className="w-16 shrink-0">
        <p className={`text-xs font-bold ${th.text}`}>{pos.symbol}</p>
        {pos.currentPrice && <p className={`text-[9px] ${th.textFaint}`}>${pos.currentPrice.toFixed(2)}</p>}
        <ChartButton symbol={pos.symbol} th={th} />
      </div>
      <span className={`text-[8px] px-1.5 py-0.5 border rounded font-bold shrink-0 ${phaseColors[pos.phase]}`}>{phaseLabel[pos.phase]}</span>
      <span className={`text-[8px] font-bold shrink-0 ${ivrColor}`}>{ivrLabel}</span>
      <div className="flex-1 min-w-0">
        {pos.phase === 'cash-secured-put' && pos.strike && (
          <p className={`text-[10px] ${th.textMuted}`}>{pos.strike}P · {pos.expiration} ({pos.dte}d) · {pos.pop?.toFixed(0)}% POP</p>
        )}
        {pos.phase === 'assigned' && pos.sharesHeld && (
          <p className={`text-[10px] ${th.textMuted}`}>{pos.sharesHeld} shares · cost ${pos.costBasis?.toFixed(2)} · current ${pos.currentPrice?.toFixed(2)}</p>
        )}
        {pos.phase === 'covered-call' && pos.strike && (
          <p className={`text-[10px] ${th.textMuted}`}>{pos.strike}C · {pos.expiration} ({pos.dte}d)</p>
        )}
        {pos.phase === 'idle' && (
          <p className={`text-[10px] ${pos.ivr != null && pos.ivr < 30 ? 'text-red-400/70' : th.textFaint} italic`}>
            {pos.ivr != null && pos.ivr < 30
              ? `IVR too low (${pos.ivr}) — wait for ≥30 before writing put`
              : 'No active position — eligible for new CSP'}
          </p>
        )}
      </div>
      {pos.pnlPct != null && (
        <div className="text-right shrink-0">
          <p className={`text-xs font-bold ${pos.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{pos.pnlPct >= 0 ? '+' : ''}{pos.pnlPct.toFixed(0)}%</p>
          <p className={`text-[9px] ${th.textFaint}`}>{pos.pnl != null ? `${pos.pnl >= 0 ? '+' : ''}$${pos.pnl.toFixed(0)}` : ''}</p>
        </div>
      )}
    </div>
  );
}

// ── Timeline helpers ───────────────────────────────────────────────────────
function TimelineBar({ startDte, endDte, totalDays, color, label, status }: { startDte: number; endDte: number; totalDays: number; color: string; label: string; status: string }) {
  const left = Math.max(0, ((totalDays - endDte) / totalDays) * 100);
  const width = Math.max(2, ((endDte - startDte) / totalDays) * 100);
  return (
    <div className="relative h-5" style={{ marginBottom: '3px' }}>
      <div className={`absolute h-full rounded flex items-center px-1.5 text-[9px] font-medium overflow-hidden ${color}`}
           style={{ left: `${left}%`, width: `${width}%`, minWidth: '30px' }}>
        <span className="truncate">{label}</span>
      </div>
    </div>
  );
}


// ── Engine Order Modal ─────────────────────────────────────────────────────
interface EngineOrderEntry {
  mode?: 'spread' | 'wheel';
  symbol: string;
  shortOccSymbol?: string;
  longOccSymbol?: string;
  credit: number;
  contracts: number;
  strategy: 'BPS' | 'BCS' | 'CSP' | 'CC';
  dte: number;
  shortStrike: number;
  longStrike?: number;
  spreadWidth: number;
  expiration?: string;
  optionType?: 'P' | 'C';
  action?: 'sell-put' | 'sell-call';
  capitalRequired?: number;
}

function EngineOrderModal({ entry, th, onClose }: { entry: EngineOrderEntry; th: typeof THEMES[Theme]; onClose: () => void }) {
  const [phase, setPhase] = useState<'confirm' | 'placing' | 'done' | 'error'>('confirm');
  const [contracts, setContracts] = useState(entry.contracts);
  const [entryLimit, setEntryLimit] = useState(parseFloat(entry.credit.toFixed(2)));
  const [gtcPct, setGtcPct] = useState(50);
  const [error, setError] = useState('');
  const [orderId, setOrderId] = useState('');

  const isWheelEntry = entry.mode === 'wheel' || entry.strategy === 'CSP' || entry.strategy === 'CC';
  const [resolvedOcc, setResolvedOcc] = useState(entry.shortOccSymbol ?? '');
  const [resolvedLongOcc, setResolvedLongOcc] = useState(entry.longOccSymbol ?? '');
  const [resolvedExpiration, setResolvedExpiration] = useState(entry.expiration ?? '');
  const [resolvedBidAsk, setResolvedBidAsk] = useState<{ bid: number; ask: number; mid: number; delta: number | null; oi: number | null } | null>(null);
  const [resolvingOption, setResolvingOption] = useState(false);
  const [liveRefreshNote, setLiveRefreshNote] = useState<string>('');

  const gtcBuyback = parseFloat((entryLimit * (1 - gtcPct / 100)).toFixed(2));
  const totalCredit = entryLimit * contracts * 100;
  const maxLoss = isWheelEntry
    ? entry.strategy === 'CSP'
      ? Math.max(0, (entry.shortStrike * 100 * contracts) - totalCredit)
      : 0
    : Math.max(0, (entry.spreadWidth - entryLimit) * contracts * 100);
  const hasOcc = isWheelEntry ? Boolean(resolvedOcc) : Boolean(resolvedOcc && resolvedLongOcc);
  const engineInstrumentType = (symbol: string): 'Equity Option' | 'Index Option' => {
    const normalized = String(symbol ?? '').replace(/\s+/g, '').toUpperCase();
    return normalized.startsWith('SPX') || normalized.startsWith('NDX') || normalized.startsWith('RUT') || normalized.startsWith('VIX')
      ? 'Index Option'
      : 'Equity Option';
  };
  const legInstrumentType = isWheelEntry ? 'Equity Option' : engineInstrumentType(resolvedOcc || entry.symbol);

  // ── Live spread re-fetch (spread entries only) ─────────────────────────
  // Fetches current bid/ask for both legs on modal open. Updates entry limit
  // to live mid price so the credit shown matches what TastyTrade will show.
  const resolveSpreadLive = useCallback(async () => {
    if (isWheelEntry) return;
    if (!entry.shortOccSymbol || !entry.longOccSymbol) return;
    setResolvingOption(true); setLiveRefreshNote(''); setError('');
    try {
      const token = await getAccessToken();
      const qs = [
        `equity-option=${encodeURIComponent(entry.shortOccSymbol)}`,
        `equity-option=${encodeURIComponent(entry.longOccSymbol)}`,
      ].join('&');
      const md = await ttFetch(`/market-data/by-type?${qs}`, token);
      const items: any[] = md?.data?.items ?? [];
      const shortItem = items.find((i: any) => i.symbol === entry.shortOccSymbol);
      const longItem  = items.find((i: any) => i.symbol === entry.longOccSymbol);
      if (!shortItem || !longItem) {
        setLiveRefreshNote('Live price unavailable — using scan price. Verify in TastyTrade before placing.');
        return;
      }
      const shortMid = (parseFloat(shortItem.bid ?? '0') + parseFloat(shortItem.ask ?? '0')) / 2;
      const longMid  = (parseFloat(longItem.bid  ?? '0') + parseFloat(longItem.ask  ?? '0')) / 2;
      const liveMid  = parseFloat(Math.max(0, shortMid - longMid).toFixed(2));
      const staleCredit = parseFloat(entry.credit.toFixed(2));
      const drift = staleCredit > 0 ? Math.abs(liveMid - staleCredit) / staleCredit : 0;
      // Always update to live price
      if (liveMid > 0) {
        setEntryLimit(liveMid);
        setResolvedOcc(entry.shortOccSymbol);
        setResolvedLongOcc(entry.longOccSymbol);
        if (drift > 0.05) {
          setLiveRefreshNote(`Live mid $${liveMid.toFixed(2)} (scan was $${staleCredit.toFixed(2)}, ${(drift * 100).toFixed(0)}% drift) — entry limit updated.`);
        } else {
          setLiveRefreshNote(`Live mid $${liveMid.toFixed(2)} — confirmed current.`);
        }
      } else {
        setLiveRefreshNote('Live mid is $0.00 — market may be closed. Verify before placing.');
      }
    } catch (e: any) {
      setLiveRefreshNote('Live price fetch failed — using scan price. Verify in TastyTrade before placing.');
      console.warn('[EngineOrderModal] spread live re-fetch failed:', e?.message);
    } finally {
      setResolvingOption(false);
    }
  }, [isWheelEntry, entry.shortOccSymbol, entry.longOccSymbol, entry.credit]);

  const resolveWheelOption = useCallback(async () => {
    if (!isWheelEntry) return;
    setResolvingOption(true); setError('');
    try {
      const token = await getAccessToken();
      const nested = await ttFetch(`/option-chains/${encodeURIComponent(entry.symbol)}/nested`, token);
      const expirations = nested?.data?.items?.[0]?.expirations ?? [];
      const desiredDte = entry.dte || 35;
      const optionSide = entry.optionType ?? (entry.strategy === 'CC' ? 'C' : 'P');
      const ranked = expirations
        .map((e: any) => ({ date: e['expiration-date'], dte: daysUntil(e['expiration-date']), strikes: e.strikes ?? [] }))
        .filter((e: any) => e.dte >= 21 && e.dte <= 55)
        .sort((a: any, b: any) => Math.abs(a.dte - desiredDte) - Math.abs(b.dte - desiredDte));

      let found: any = null;
      let foundExp: any = null;
      for (const exp of ranked) {
        const strikes = [...exp.strikes].sort((a: any, b: any) => Math.abs(parseFloat(a['strike-price']) - entry.shortStrike) - Math.abs(parseFloat(b['strike-price']) - entry.shortStrike));
        for (const strikeRow of strikes) {
          const strike = parseFloat(strikeRow['strike-price']);
          if (Math.abs(strike - entry.shortStrike) > 2.51) continue;
          const rawLeg = optionSide === 'P' ? strikeRow.put : strikeRow.call;
          const legSymbol = typeof rawLeg === 'string' ? rawLeg : rawLeg?.symbol;
          if (!legSymbol) continue;
          found = { ...(typeof rawLeg === 'object' ? rawLeg : {}), symbol: legSymbol, strike };
          foundExp = exp;
          break;
        }
        if (found) break;
      }

      if (!found || !foundExp) throw new Error(`Could not resolve a live ${entry.symbol} ${entry.shortStrike}${optionSide} option around ${desiredDte} DTE. Refresh during market hours or choose another strike.`);

      let bid = parseFloat(found.bid ?? '0');
      let ask = parseFloat(found.ask ?? '0');
      let deltaRaw = found.delta != null ? parseFloat(found.delta) : NaN;
      let oiRaw = found['open-interest'] ?? found.oi;
      if ((!bid && !ask) || bid < 0 || ask < 0) {
        const qs = `equity-option=${encodeURIComponent(found.symbol)}`;
        const md = await ttFetch(`/market-data/by-type?${qs}`, token);
        const item = md?.data?.items?.[0];
        if (item) {
          bid = parseFloat(item.bid ?? '0');
          ask = parseFloat(item.ask ?? '0');
          deltaRaw = item.delta != null ? parseFloat(item.delta) : deltaRaw;
          oiRaw = item['open-interest'] ?? item.oi ?? oiRaw;
        }
      }
      const mid = parseFloat((((bid + ask) / 2) || 0).toFixed(2));
      const oi = oiRaw != null ? parseInt(oiRaw, 10) : null;
      setResolvedOcc(found.symbol);
      setResolvedExpiration(foundExp.date);
      setResolvedBidAsk({ bid, ask, mid, delta: isNaN(deltaRaw) ? null : deltaRaw, oi });
      if ((!entry.credit || entry.credit <= 0) && mid > 0) setEntryLimit(mid);
    } catch (e: any) {
      setError(e?.message ?? 'Could not resolve option contract.');
    } finally {
      setResolvingOption(false);
    }
  }, [entry.symbol, entry.shortStrike, entry.dte, entry.optionType, entry.strategy, entry.credit, isWheelEntry]);

  useEffect(() => {
    if (isWheelEntry) resolveWheelOption();
    else resolveSpreadLive();
  }, [isWheelEntry, resolveWheelOption, resolveSpreadLive]);

  const placeOrder = async () => {
    setPhase('placing'); setError('');
    try {
      const token = await getAccessToken();
      const accountsData = await ttFetch('/customers/me/accounts', token);
      const account = accountsData?.data?.items?.find((a: any) => a.account['account-number'] === '5WI51392')
        ?? accountsData?.data?.items?.[0];
      const accountNumber = account?.account?.['account-number'];
      if (!accountNumber) throw new Error('No account found');

      if (!hasOcc) throw new Error('Missing OCC option symbol(s). Refresh the engine during market hours and try again.');
      if (entryLimit <= 0) throw new Error('Entry credit must be greater than $0.00.');
      if (!isWheelEntry && entryLimit >= entry.spreadWidth) throw new Error(`Entry credit $${entryLimit.toFixed(2)} cannot be greater than/equal to spread width $${entry.spreadWidth.toFixed(2)}.`);

      const legs = isWheelEntry
        ? [{ 'instrument-type': legInstrumentType, symbol: resolvedOcc, quantity: contracts, action: 'Sell to Open' }]
        : [
            { 'instrument-type': legInstrumentType, symbol: resolvedOcc,    quantity: contracts, action: 'Sell to Open' },
            { 'instrument-type': legInstrumentType, symbol: resolvedLongOcc, quantity: contracts, action: 'Buy to Open'  },
          ];
      const closingLegs = legs.map(l => ({
        ...l,
        action: l.action === 'Sell to Open' ? 'Buy to Close' : 'Sell to Close',
      }));

      const payload = {
        type: 'OTOCO',
        'trigger-order': {
          'time-in-force': 'GTC', 'order-type': 'Limit',
          price: entryLimit.toFixed(2), 'price-effect': 'Credit', legs,
        },
        orders: [{
          'time-in-force': 'GTC', 'order-type': 'Limit',
          price: gtcBuyback.toFixed(2), 'price-effect': 'Debit', legs: closingLegs,
        }],
      };

      const res = await fetch(`${BASE}/accounts/${accountNumber}/complex-orders`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = data?.error?.message
          ?? data?.['error-message']
          ?? data?.errors?.[0]?.message
          ?? data?.error?.errors?.map((e: any) => e.message ?? e.reason ?? String(e)).join('; ')
          ?? JSON.stringify(data).slice(0, 500)
          ?? `Order failed (${res.status})`;
        console.error('Engine order rejected:', JSON.stringify({ payload, data }, null, 2));
        throw new Error(detail);
      }
      setOrderId(data?.data?.['complex-order']?.id ?? data?.data?.order?.id ?? 'submitted');
      setPhase('done');
    } catch (e: any) { setError(e.message); setPhase('error'); }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[70] p-4" onClick={onClose}>
      <div className={`${th.sidebar} border ${th.border} rounded-2xl p-6 w-full max-w-md`} onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-5">
          <h2 className={`text-sm font-bold ${th.text} tracking-widest`}>PLACE ORDER — {entry.symbol}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">✕</button>
        </div>

        {phase === 'done' ? (
          <div className="text-center py-4 space-y-2">
            <p className="text-2xl">✓</p>
            <p className="text-emerald-400 font-bold text-sm">Order submitted</p>
            <p className={`text-[10px] ${th.textFaint}`}>OTOCO ID: {orderId}</p>
            <p className={`text-[10px] ${th.textFaint}`}>Entry GTC + {gtcPct}% profit target GTC submitted as bracket order.</p>
            <button onClick={onClose} className="mt-3 text-xs px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg">Done</button>
          </div>
        ) : phase === 'error' ? (
          <div className="space-y-3">
            <p className="text-red-400 text-sm">{error}</p>
            <button onClick={() => setPhase('confirm')} className={`text-xs px-3 py-1.5 border ${th.border} rounded-lg ${th.textMuted}`}>Back</button>
          </div>
        ) : (
          <div className="space-y-4">
            {!hasOcc && (
              <div className="bg-amber-500/10 border border-amber-600/30 rounded-lg px-3 py-2">
                <p className="text-[10px] text-amber-400">OCC symbol not available yet — refreshing live option chain. Orders require live chain data.</p>
              </div>
            )}

            {/* Position summary */}
            <div className={`${th.card} border ${th.border} rounded-xl p-4 space-y-2`}>
              <div className="flex justify-between">
                <span className={`text-[10px] ${th.textFaint}`}>Strategy</span>
                <span className={`text-[10px] font-bold ${th.text}`}>{entry.strategy} · {entry.symbol}</span>
              </div>
              <div className="flex justify-between">
                <span className={`text-[10px] ${th.textFaint}`}>Strikes</span>
                <span className={`text-[10px] font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                  {isWheelEntry ? `${entry.shortStrike}${entry.strategy === 'CC' ? 'C' : 'P'}` : `${entry.shortStrike}/${entry.longStrike}${entry.strategy === 'BCS' ? 'C' : 'P'}`}
                </span>
              </div>
              <div className="flex justify-between">
                <span className={`text-[10px] ${th.textFaint}`}>DTE</span>
                <span className={`text-[10px] ${th.text}`}>{isWheelEntry && resolvedExpiration ? `${daysUntil(resolvedExpiration)}d (${resolvedExpiration})` : `${entry.dte}d`}</span>
              </div>
              {isWheelEntry && (
                <div className="flex justify-between gap-3">
                  <span className={`text-[10px] ${th.textFaint}`}>Resolved contract</span>
                  <span className={`text-[10px] ${th.text} text-right`} style={{ fontFamily: "'DM Mono', monospace" }}>{resolvingOption ? 'Resolving...' : resolvedOcc || 'Not resolved'}</span>
                </div>
              )}
              {!isWheelEntry && (
                <div className="flex justify-between gap-3">
                  <span className={`text-[10px] ${th.textFaint}`}>Live OCC symbols</span>
                  <span className={`text-[10px] ${th.text} text-right`} style={{ fontFamily: "'DM Mono', monospace" }}>
                    {resolvingOption ? 'Fetching live price...' : resolvedOcc ? `${resolvedOcc.trim()} / ${resolvedLongOcc.trim()}` : 'Pending'}
                  </span>
                </div>
              )}
              {isWheelEntry && resolvedBidAsk && (
                <div className="flex justify-between">
                  <span className={`text-[10px] ${th.textFaint}`}>Bid / Ask / Mid</span>
                  <span className={`text-[10px] ${th.text}`}>${resolvedBidAsk.bid.toFixed(2)} / ${resolvedBidAsk.ask.toFixed(2)} / ${resolvedBidAsk.mid.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className={`text-[10px] ${th.textFaint}`}>Instrument type</span>
                <span className={`text-[10px] ${th.text}`}>{legInstrumentType}</span>
              </div>
            </div>

            {liveRefreshNote && (
              <div className={`rounded-lg px-3 py-2 border ${liveRefreshNote.includes('drift') || liveRefreshNote.includes('failed') || liveRefreshNote.includes('unavailable') ? 'bg-amber-500/10 border-amber-600/30' : 'bg-emerald-500/10 border-emerald-700/30'}`}>
                <p className={`text-[10px] ${liveRefreshNote.includes('drift') || liveRefreshNote.includes('failed') || liveRefreshNote.includes('unavailable') ? 'text-amber-400' : 'text-emerald-400'}`}>
                  ◎ {liveRefreshNote}
                </p>
              </div>
            )}

            {/* Controls */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <span className={`text-[10px] ${th.textFaint} shrink-0`}>Contracts</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => setContracts(Math.max(1, contracts - 1))} className={`w-6 h-6 rounded border ${th.border} ${th.textMuted} hover:text-white flex items-center justify-center text-sm`}>−</button>
                  <span className={`text-sm font-bold ${th.text} w-6 text-center`}>{contracts}</span>
                  <button onClick={() => setContracts(contracts + 1)} className={`w-6 h-6 rounded border ${th.border} ${th.textMuted} hover:text-white flex items-center justify-center text-sm`}>+</button>
                </div>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className={`text-[10px] ${th.textFaint} shrink-0`}>Entry limit (credit)</span>
                <div className="flex items-center gap-1">
                  <span className={`text-[10px] ${th.textFaint}`}>$</span>
                  <input type="number" step="0.05" min="0.01" value={entryLimit}
                    onChange={e => setEntryLimit(parseFloat(e.target.value) || 0)}
                    className={`w-20 text-right text-sm font-bold ${th.text} ${th.input} border ${th.inputBorder} rounded px-2 py-1 focus:outline-none focus:border-emerald-500`} />
                </div>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className={`text-[10px] ${th.textFaint} shrink-0`}>GTC profit target</span>
                <div className="flex items-center gap-2">
                  {[40, 50, 60].map(pct => (
                    <button key={pct} onClick={() => setGtcPct(pct)}
                      className={`text-[10px] px-2 py-1 rounded border transition-colors ${gtcPct === pct ? 'border-emerald-600 text-emerald-400 bg-emerald-500/10' : `${th.border} ${th.textFaint} hover:text-white`}`}>
                      {pct}%
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Summary */}
            <div className={`${th.sidebar} rounded-xl p-3 space-y-1.5 border ${th.border}`}>
              <div className="flex justify-between">
                <span className={`text-[9px] ${th.textFaint}`}>Total credit received</span>
                <span className="text-[9px] text-emerald-400 font-bold">${totalCredit.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className={`text-[9px] ${th.textFaint}`}>GTC closes at</span>
                <span className={`text-[9px] ${th.text}`}>${gtcBuyback.toFixed(2)} debit ({gtcPct}% profit)</span>
              </div>
              <div className="flex justify-between">
                <span className={`text-[9px] ${th.textFaint}`}>Max loss</span>
                <span className="text-[9px] text-red-400">${maxLoss.toLocaleString()}</span>
              </div>
            </div>

            {contracts > 1 && entry.symbol === 'SPX' && (
              <div className="bg-amber-500/10 border border-amber-600/30 rounded-lg px-3 py-2">
                <p className="text-[10px] text-amber-400">⚠ Multiple SPX contracts on a single expiry concentrates risk. Consider spreading across expiries.</p>
              </div>
            )}

            <button onClick={placeOrder} disabled={!hasOcc || phase === 'placing' || resolvingOption || entryLimit <= 0}
              className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold rounded-xl transition-colors">
              {phase === 'placing' ? '⟳ Placing order...' : resolvingOption ? 'Resolving option...' : `Place OTOCO Order · ${contracts} contract${contracts > 1 ? 's' : ''}`}
            </button>
            <p className={`text-[9px] ${th.textFaint} text-center`}>Entry GTC + {gtcPct}% profit target GTC submitted as bracket order</p>
          </div>
        )}

      </div>
    </div>
  );
}


// ── Engine Advisor ─────────────────────────────────────────────────────────
interface AdvisorMessagePart { type: 'text'; text: string; }
interface AdvisorImagePart { type: 'image'; source: { type: 'base64'; media_type: string; data: string }; }
type AdvisorContentPart = AdvisorMessagePart | AdvisorImagePart;
interface AdvisorMessage { role: 'user' | 'assistant'; content: string | AdvisorContentPart[]; }

function buildAdvisorSystemPrompt(data: EngineData, watchlist: string[]): string {
  const capital = data.capital;

  const spxBlock = data.spxPositions.length > 0
    ? data.spxPositions.map(p =>
        `  • SPX ${p.shortStrike}/${p.longStrike}P | exp ${p.expiration} (${p.dte}d DTE) | POP ${p.pop.toFixed(0)}% | P&L ${p.pnlPct != null ? (p.pnlPct >= 0 ? '+' : '') + p.pnlPct.toFixed(0) + '%' : '?'} ($${p.pnl?.toFixed(0) ?? '?'}) | ${p.contracts} contracts | capital at risk $${p.capitalAtRisk.toLocaleString()} | status: ${p.status.toUpperCase()}`
      ).join('\n')
    : '  None';

  const spyBlock = data.spyPositions.length > 0
    ? data.spyPositions.map(p =>
        `  • SPY ${p.shortStrike}/${p.longStrike}P | exp ${p.expiration} (${p.dte}d DTE) | POP ${p.pop.toFixed(0)}% | P&L ${p.pnlPct != null ? (p.pnlPct >= 0 ? '+' : '') + p.pnlPct.toFixed(0) + '%' : '?'} ($${p.pnl?.toFixed(0) ?? '?'}) | ${p.contracts} contracts | status: ${p.status.toUpperCase()}`
      ).join('\n')
    : '  None';

  const spxEntryBlock = data.spxSuggestedEntry
    ? `  SPX ${data.spxSuggestedEntry.strategy} ${data.spxSuggestedEntry.shortStrike}/${data.spxSuggestedEntry.longStrike}P | exp ${data.spxSuggestedEntry.expiration} (${data.spxSuggestedEntry.dte}d) | POP ${data.spxSuggestedEntry.pop.toFixed(0)}% | credit $${data.spxSuggestedEntry.credit.toFixed(2)} | ratio ${(data.spxSuggestedEntry.creditRatio * 100).toFixed(0)}% | ROC ${data.spxSuggestedEntry.roc.toFixed(0)}% | ${data.spxSuggestedEntry.contracts} contracts | capital req $${data.spxSuggestedEntry.capitalRequired.toLocaleString()}\n  Rationale: ${data.spxSuggestedEntry.rationale}`
    : '  No qualifying entry found (capital unavailable or no strikes pass rules)';

  const spyEntryBlock = data.spySuggestedEntry
    ? `  SPY ${data.spySuggestedEntry.strategy} ${data.spySuggestedEntry.shortStrike}/${data.spySuggestedEntry.longStrike}P | exp ${data.spySuggestedEntry.expiration} (${data.spySuggestedEntry.dte}d) | POP ${data.spySuggestedEntry.pop.toFixed(0)}% | credit $${data.spySuggestedEntry.credit.toFixed(2)} | ratio ${(data.spySuggestedEntry.creditRatio * 100).toFixed(0)}% | ${data.spySuggestedEntry.contracts} contracts | capital req $${data.spySuggestedEntry.capitalRequired.toLocaleString()}\n  Rationale: ${data.spySuggestedEntry.rationale}`
    : '  No qualifying SPY entry found';

  const wheelBlock = data.wheelPositions.map(p => {
    if (p.phase === 'cash-secured-put')
      return `  • ${p.symbol} [CSP] ${p.strike}P | exp ${p.expiration} (${p.dte}d) | POP ${p.pop?.toFixed(0) ?? '?'}% | IVR ${p.ivr ?? '?'} | P&L ${p.pnlPct != null ? (p.pnlPct >= 0 ? '+' : '') + p.pnlPct.toFixed(0) + '%' : '?'} | status: ${p.status.toUpperCase()} | capital req $${p.capitalRequired?.toLocaleString() ?? '?'}`;
    if (p.phase === 'assigned')
      return `  • ${p.symbol} [ASSIGNED] ${p.sharesHeld} shares @ $${p.costBasis?.toFixed(2)} | current $${p.currentPrice?.toFixed(2) ?? '?'} | IVR ${p.ivr ?? '?'}`;
    if (p.phase === 'covered-call')
      return `  • ${p.symbol} [COVERED CALL] ${p.strike}C | exp ${p.expiration} (${p.dte}d) | IVR ${p.ivr ?? '?'}`;
    return `  • ${p.symbol} [IDLE] | price $${p.currentPrice?.toFixed(2) ?? '?'} | IVR ${p.ivr ?? '?'}${p.ivr != null && p.ivr < 30 ? ' <- IVR too low, wait' : ''}`;
  }).join('\n') || '  None';

  const wheelSugBlock = data.wheelSuggestions.filter(s => s.action !== 'wait').map(s =>
    `  • ${s.symbol} -> ${s.action === 'sell-put' ? `Sell ${s.strike}P ~${s.dte}d DTE | capital $${s.capitalRequired?.toLocaleString()}` : `Sell ${s.strike}C ~${s.dte}d DTE`} | ${s.rationale}`
  ).join('\n') || '  None';

  return `You are an expert options trading advisor embedded in the Income Engine of Options Hunter, a premium-selling trading platform.

You have full real-time context of the trader's portfolio and current opportunities. Be direct, specific, and concise. No disclaimers. No hedging. Answer as a senior options trader would.

TRADING RULES (Prosper Trading Academy methodology):
- IVR >= 30 required before selling premium
- Entry DTE: 30-45 days
- Short put delta: -0.20 to -0.30
- Credit >= 15% of spread width for SPX index spreads
- Credit >= 20% of spread width for ETFs/stocks
- POP >= 68% for index spreads
- OI >= 500 per leg
- No earnings within expiry window
- GTC close order at 50% profit placed at entry
- Close or roll at 21 DTE
- SPX: 25-wide spreads, Friday expirations only, 1256 tax treatment
- SPY: flexible width, fills vehicle when SPX capital insufficient
- Wheel: CSP -> assignment -> covered call cycle
- Reserve bucket is UNTOUCHABLE - never deploy reserve capital
- CRITICAL: If a wheel position's IVR or earnings data is missing/null, use web search to look up the actual next earnings date for that ticker before giving any earnings-related advice. Never hallucinate or guess earnings dates.

CAPITAL SUMMARY:
- Net Liquidating Value: $${capital.netLiq.toLocaleString()}
- Option Buying Power (OBP): $${capital.obp.toLocaleString()}
- SPX/Spread bucket: target $${capital.spxTarget.toLocaleString()} | deployed $${capital.spxDeployed.toLocaleString()} | available $${capital.spxAvailable.toLocaleString()}
- Wheel bucket: target $${capital.wheelTarget.toLocaleString()} | deployed $${capital.wheelDeployed.toLocaleString()} | available $${capital.wheelAvailable.toLocaleString()}
- Reserve: $${capital.reserveTarget.toLocaleString()} (protected, do not touch)
- Overall deployment: ${capital.deploymentPct}% of target

OPEN SPX POSITIONS:
${spxBlock}

OPEN SPY POSITIONS:
${spyBlock}

SUGGESTED SPX ENTRY:
${spxEntryBlock}

SUGGESTED SPY ENTRY:
${spyEntryBlock}

WHEEL POSITIONS (watchlist: ${watchlist.join(', ')}):
${wheelBlock}

WHEEL SUGGESTIONS (actionable):
${wheelSugBlock}

You can answer questions about: whether to enter the suggested trades, strike selection rationale, risk assessment, position sizing, roll decisions, closing logic, capital allocation, market conditions, and anything else related to managing this specific portfolio. Reference the actual numbers above in your answers.`;
}

function EngineAdvisor({ data, watchlist, th }: { data: EngineData; watchlist: string[]; th: typeof THEMES[Theme] }) {
  const [messages, setMessages] = useState<AdvisorMessage[]>([]);
  const [input, setInput] = useState('');
  const [pendingImage, setPendingImage] = useState<{ base64: string; mediaType: string; preview: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const systemPrompt = buildAdvisorSystemPrompt(data, watchlist);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const [meta, base64] = dataUrl.split(',');
      const mediaType = meta.match(/:(.*?);/)?.[1] ?? 'image/jpeg';
      setPendingImage({ base64, mediaType, preview: dataUrl });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const send = async () => {
    const text = input.trim();
    if (!text && !pendingImage || loading) return;
    setInput('');
    const parts: AdvisorContentPart[] = [];
    if (pendingImage) parts.push({ type: 'image', source: { type: 'base64', media_type: pendingImage.mediaType, data: pendingImage.base64 } });
    if (text) parts.push({ type: 'text', text });
    const userMsg: AdvisorMessage = { role: 'user', content: parts.length === 1 && !pendingImage ? text : parts };
    setPendingImage(null);
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setLoading(true);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-search-preview',
          max_tokens: 800,
          web_search: true,
          system: systemPrompt,
          messages: newMessages.map(m => ({ role: m.role, content: m.content })),
        }),
      });
      if (!res.ok) throw new Error('Advisor request failed');
      const d = await res.json();
      const reply = d?.content?.find((b: any) => b.type === 'text')?.text ?? 'No response.';
      setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch (e: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e.message}` }]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const SUGGESTED_QUESTIONS = [
    'Should I enter the suggested SPX trade today?',
    'How is my overall deployment looking?',
    'Which wheel position needs attention first?',
    'Is it a good day to sell premium?',
    'What should I do with idle wheel positions?',
  ];

  return (
    <div className="flex flex-col max-w-4xl" style={{ height: 'calc(100vh - 220px)' }}>
      {/* Header */}
      <div className={`border ${th.border} rounded-t-xl px-4 py-3 bg-violet-500/5 flex items-center gap-3 shrink-0`}>
        <span className="text-violet-400 text-sm font-bold">◈</span>
        <div>
          <p className="text-xs font-bold text-violet-400 tracking-widest">ENGINE ADVISOR</p>
          <p className={`text-[9px] ${th.textFaint}`}>Full portfolio context loaded · SPX/SPY strikes, wheel positions, capital</p>
        </div>
        {messages.length > 0 && (
          <button onClick={() => setMessages([])}
            className={`ml-auto text-[9px] px-2 py-1 border ${th.border} ${th.textFaint} hover:text-white/70 rounded transition-colors`}>
            Clear
          </button>
        )}
      </div>

      {/* Messages */}
      <div className={`flex-1 overflow-y-auto border-x ${th.border} px-4 py-4 space-y-4`}>
        {messages.length === 0 && (
          <div className="space-y-4">
            <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>
              Ask me anything about your current positions, the suggested SPX/SPY entries, wheel management, or capital deployment. I have full context of your portfolio.
            </p>
            <div className="space-y-2">
              <p className={`text-[9px] ${th.textFaint} tracking-widest uppercase font-bold`}>Suggested questions</p>
              {SUGGESTED_QUESTIONS.map((q, i) => (
                <button key={i} onClick={() => { setInput(q); inputRef.current?.focus(); }}
                  className={`block w-full text-left text-[10px] ${th.textMuted} px-3 py-2 border ${th.border} rounded-lg hover:border-violet-500/50 hover:text-violet-300 transition-colors`}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-xl px-3 py-2.5 ${
              msg.role === 'user'
                ? 'bg-violet-600/20 border border-violet-600/40'
                : `${th.card} border ${th.border}`
            }`}>
              {msg.role === 'assistant' && (
                <p className="text-[8px] text-violet-400 font-bold tracking-widest mb-1.5">◈ ADVISOR</p>
              )}
              {(() => {
                const imgSrc = typeof msg.content !== 'string'
                  ? (() => { const img = msg.content.find((p: any) => p.type === 'image'); return img ? `data:${(img as any).source.media_type};base64,${(img as any).source.data}` : null; })()
                  : null;
                const txt = typeof msg.content === 'string' ? msg.content : msg.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join(' ');
                return (<>
                  {imgSrc && <img src={imgSrc} alt="attachment" className="rounded-lg max-w-full mb-1.5" style={{ maxHeight: '180px', objectFit: 'contain' }} />}
                  {txt && <p className={`text-[11px] ${th.textMuted} leading-relaxed whitespace-pre-wrap`}>{txt}</p>}
                </>);
              })()}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className={`${th.card} border ${th.border} rounded-xl px-3 py-2.5`}>
              <p className="text-[8px] text-violet-400 font-bold tracking-widest mb-1.5">◈ ADVISOR</p>
              <div className="flex items-center gap-1.5">
                {[0, 1, 2].map(i => (
                  <div key={i} className="w-1.5 h-1.5 rounded-full bg-violet-400/60 animate-pulse" style={{ animationDelay: `${i * 150}ms` }} />
                ))}
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className={`border ${th.border} rounded-b-xl px-3 py-3 shrink-0 ${th.card} space-y-2`}>
        {/* Image preview */}
        {pendingImage && (
          <div className="relative inline-block">
            <img src={pendingImage.preview} alt="pending" className="rounded-lg max-h-24 object-contain border border-violet-500/40" />
            <button onClick={() => setPendingImage(null)}
              className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-slate-700 border border-slate-500 text-slate-300 text-[9px] flex items-center justify-center hover:bg-red-600 transition-colors">
              ✕
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          {/* Hidden file input */}
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageSelect} />
          {/* Attach button */}
          <button onClick={() => fileInputRef.current?.click()} disabled={loading}
            title="Attach image"
            className={`shrink-0 w-8 h-8 rounded-lg border ${th.border} ${th.textFaint} hover:border-violet-500 hover:text-violet-400 disabled:opacity-40 flex items-center justify-center transition-colors`}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
            </svg>
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Ask about your positions, entries, strikes, capital..."
            rows={2}
            className={`flex-1 resize-none ${th.input} border ${th.inputBorder} rounded-lg px-3 py-2 text-[11px] ${th.text} focus:outline-none focus:border-violet-500`}
            style={{ fontFamily: "'DM Sans', sans-serif" }}
          />
          <button onClick={send} disabled={(!input.trim() && !pendingImage) || loading}
            className="shrink-0 px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-[10px] font-bold rounded-lg transition-colors">
            {loading ? '...' : 'Send'}
          </button>
        </div>
        <p className={`text-[8px] ${th.textFaint}`}>Enter to send · Shift+Enter for new line</p>
      </div>
    </div>
  );
}


// ── Spread Comparison Panel ────────────────────────────────────────────────
function SpreadComparisonPanel({ spx, spy, available, th }: {
  spx: SpxSuggestion;
  spy: SpySuggestion;
  available: number;
  th: typeof THEMES[Theme];
}) {
  const totalCombined = spx.capitalRequired + spy.capitalRequired;
  const canAffordBoth = available >= totalCombined;
  const canAffordSpxOnly = available >= spx.capitalRequired;
  const canAffordSpyOnly = available >= spy.capitalRequired;

  const spxScore = (spx.pop * 0.4) + (spx.creditRatio * 100 * 0.4) + (spx.dte >= 30 ? 20 : 0);
  const spyScore = (spy.pop * 0.4) + (spy.creditRatio * 100 * 0.4) + (spy.dte >= 30 ? 20 : 0);

  let rec: string;
  let recColor: string;
  let badge: string;

  if (canAffordBoth) {
    rec = `Both fit within your $${available.toLocaleString()} available capital ($${totalCombined.toLocaleString()} combined). SPX gives 1256 tax treatment on the larger allocation. SPY fills remaining capital with more contracts. Enter SPX first, then SPY.`;
    recColor = 'text-emerald-400';
    badge = 'BOTH';
  } else if (canAffordSpxOnly && spxScore >= spyScore) {
    rec = `Not enough capital for both ($${totalCombined.toLocaleString()} needed, $${available.toLocaleString()} available). SPX wins — higher credit ($${spx.credit.toFixed(2)} vs $${spy.credit.toFixed(2)}), 1256 tax treatment, stronger liquidity. Use SPX today.`;
    recColor = 'text-violet-400';
    badge = 'SPX ONLY';
  } else if (canAffordSpyOnly) {
    rec = `Not enough capital for SPX ($${spx.capitalRequired.toLocaleString()} needed, $${available.toLocaleString()} available). SPY fits — lower credit but keeps the engine active.`;
    recColor = 'text-cyan-400';
    badge = 'SPY ONLY';
  } else {
    rec = `Neither suggestion fits current available capital ($${available.toLocaleString()}). Wait for an existing position to close or adjust allocation.`;
    recColor = 'text-amber-400';
    badge = 'WAIT';
  }

  return (
    <div className="border-b border-emerald-600/20 px-4 py-3 bg-slate-900/60">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-[9px] font-bold text-violet-400 tracking-widest">◈ ENGINE ANALYSIS</span>
        <span className={`text-[8px] px-2 py-0.5 border rounded font-bold ${
          badge === 'BOTH' ? 'border-emerald-700 text-emerald-400 bg-emerald-500/10' :
          badge === 'SPX ONLY' ? 'border-violet-700 text-violet-400 bg-violet-500/10' :
          badge === 'SPY ONLY' ? 'border-cyan-700 text-cyan-400 bg-cyan-500/10' :
          'border-amber-700 text-amber-400 bg-amber-500/10'
        }`}>{badge}</span>
        <span className={`text-[9px] ${th.textFaint}`}>
          Available: ${available.toLocaleString()} · SPX ${spx.capitalRequired.toLocaleString()} · SPY ${spy.capitalRequired.toLocaleString()}
          {!canAffordBoth && ` · combined $${totalCombined.toLocaleString()} exceeds available`}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-2">
        <div className={`rounded-lg p-2.5 border ${canAffordBoth || badge === 'SPX ONLY' ? 'border-violet-600/40 bg-violet-500/5' : `${th.border} opacity-50`}`}>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[8px] font-bold text-violet-400">SPX</span>
            <span className="text-[8px] text-violet-400/60">25-wide · 1256 tax</span>
          </div>
          <div className="grid grid-cols-3 gap-1">
            <div><p className={`text-[10px] font-bold ${th.text}`}>{spx.pop.toFixed(0)}%</p><p className={`text-[8px] ${th.textFaint}`}>POP</p></div>
            <div><p className={`text-[10px] font-bold ${th.text}`}>${spx.credit.toFixed(2)}</p><p className={`text-[8px] ${th.textFaint}`}>credit</p></div>
            <div><p className={`text-[10px] font-bold ${th.text}`}>{(spx.creditRatio * 100).toFixed(0)}%</p><p className={`text-[8px] ${th.textFaint}`}>ratio</p></div>
          </div>
        </div>
        <div className={`rounded-lg p-2.5 border ${canAffordBoth || badge === 'SPY ONLY' ? 'border-cyan-600/40 bg-cyan-500/5' : `${th.border} opacity-50`}`}>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[8px] font-bold text-cyan-400">SPY</span>
            <span className="text-[8px] text-cyan-400/60">{spy.spreadWidth}-wide · ST tax</span>
          </div>
          <div className="grid grid-cols-3 gap-1">
            <div><p className={`text-[10px] font-bold ${th.text}`}>{spy.pop.toFixed(0)}%</p><p className={`text-[8px] ${th.textFaint}`}>POP</p></div>
            <div><p className={`text-[10px] font-bold ${th.text}`}>${spy.credit.toFixed(2)}</p><p className={`text-[8px] ${th.textFaint}`}>credit</p></div>
            <div><p className={`text-[10px] font-bold ${th.text}`}>{(spy.creditRatio * 100).toFixed(0)}%</p><p className={`text-[8px] ${th.textFaint}`}>ratio</p></div>
          </div>
        </div>
      </div>
      <p className={`text-[10px] font-bold ${recColor} leading-relaxed`}>{rec}</p>
    </div>
  );
}


function MarketConditionsPanel({ mc, th, loading }: { mc: MarketConditions | null; th: typeof THEMES[Theme]; loading: boolean }) {
  const [expanded, setExpanded] = useState(true);

  const signalStyles = {
    'PRIME SETUP':  { bg: 'bg-yellow-500/10',   border: 'border-yellow-500/60',  text: 'text-yellow-300',  ring: 'border-yellow-400',  score: 'text-yellow-300',  detail: 'text-yellow-300/70' },
    'TRADE TODAY':  { bg: 'bg-emerald-500/10',  border: 'border-emerald-600/50', text: 'text-emerald-400', ring: 'border-emerald-500', score: 'text-emerald-400', detail: 'text-emerald-400/70' },
    'MANAGE ONLY':  { bg: 'bg-blue-500/10',     border: 'border-blue-600/50',    text: 'text-blue-400',    ring: 'border-blue-500',    score: 'text-blue-400',    detail: 'text-blue-400/70' },
    'CAUTION':      { bg: 'bg-amber-500/10',    border: 'border-amber-600/50',   text: 'text-amber-400',   ring: 'border-amber-500',   score: 'text-amber-400',   detail: 'text-amber-400/70' },
    'WAIT TODAY':   { bg: 'bg-red-500/10',      border: 'border-red-600/50',     text: 'text-red-400',     ring: 'border-red-500',     score: 'text-red-400',     detail: 'text-red-400/70' },
  };

  const flagStatusColors = {
    good: { pill: 'bg-emerald-500/15 text-emerald-400 border-emerald-700', dot: 'bg-emerald-500' },
    warn: { pill: 'bg-amber-500/15 text-amber-400 border-amber-700',       dot: 'bg-amber-500'   },
    bad:  { pill: 'bg-red-500/15 text-red-400 border-red-700',             dot: 'bg-red-500'     },
  };

  const signal = mc?.signal ?? 'TRADE TODAY';
  const ss = signalStyles[signal];

  const flagGroups = mc ? [
    { section: 'TIME & SESSION', items: [mc.flags.dayOfWeek, mc.flags.timeOfDay] },
    { section: 'FUTURES & VOLATILITY', items: [mc.flags.esFutures, mc.flags.vix, mc.flags.termStructure, mc.flags.spxMove] },
    { section: 'CALENDAR RISK', items: [mc.flags.fomc, mc.flags.expirationWeek, mc.flags.earnings] },
  ] : [];

  const flagCount = mc ? Object.values(mc.flags).filter(f => f.status !== 'good').length : 0;

  return (
    <div className={`border ${ss.border} ${ss.bg} rounded-xl overflow-hidden`}>
      {/* Header — always visible */}
      <button onClick={() => setExpanded(!expanded)} className="w-full text-left">
        <div className="flex items-center gap-4 px-4 py-3">
          {/* Score ring */}
          {loading ? (
            <div className="w-12 h-12 rounded-full border-2 border-slate-600 flex items-center justify-center shrink-0">
              <div className="w-4 h-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : mc ? (
            <div className={`w-12 h-12 rounded-full border-2 ${ss.ring} flex flex-col items-center justify-center shrink-0`}>
              <span className={`text-base font-bold leading-none ${ss.score}`}>{mc.score}</span>
              <span className={`text-[8px] ${ss.detail}`}>/100</span>
            </div>
          ) : null}

          {/* Signal */}
          <div className="flex-1 min-w-0">
            {loading ? (
              <p className={`text-xs font-bold ${th.textFaint} tracking-widest`}>ANALYZING MARKET CONDITIONS...</p>
            ) : mc ? (
              <>
                <p className={`text-sm font-bold tracking-widest ${ss.text}`}>{mc.signal}</p>
                <p className={`text-[10px] ${ss.detail} mt-0.5`}>{mc.signalDetail}</p>
              </>
            ) : null}
          </div>

          {/* Flag count + expand */}
          <div className="flex items-center gap-3 shrink-0">
            {mc && flagCount > 0 && (
              <span className={`text-[9px] px-2 py-0.5 border rounded font-medium ${
                signal === 'WAIT TODAY' ? 'border-red-700 text-red-400 bg-red-500/10'
                : signal === 'CAUTION' ? 'border-amber-700 text-amber-400 bg-amber-500/10'
                : 'border-blue-700 text-blue-400 bg-blue-500/10'
              }`}>{flagCount} flag{flagCount !== 1 ? 's' : ''}</span>
            )}
            {mc && (
              <span className={`text-[10px] ${th.textFaint}`}>{expanded ? '▲' : '▼'}</span>
            )}
          </div>
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && mc && (
        <div className={`border-t ${th.border}`}>

          {/* PRIME SETUP banner */}
          {mc.signal === 'PRIME SETUP' && mc.trendContext && (
            <div className="flex items-center gap-3 px-4 py-3 bg-yellow-500/10 border-b border-yellow-500/30">
              <span className="text-yellow-300 text-base shrink-0">★</span>
              <div className="flex-1">
                <p className="text-xs font-bold text-yellow-300 tracking-wider">PRIME SETUP DETECTED</p>
                <p className="text-[10px] text-yellow-300/70 mt-0.5">
                  {mc.trendContext.trendLabel} · VIX {mc.esFutures ? '' : ''}still elevated · fat premium + bullish reversal = maximum BPS entry conditions
                </p>
                {mc.trendContext.reversalAnchorPrice && (
                  <p className="text-[9px] text-yellow-300/60 mt-0.5">
                    Reversal anchor: ~{mc.trendContext.reversalAnchorPrice.toFixed(0)} — BPS short put strike should be below this level
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Trend context row */}
          {mc.trendContext && mc.signal !== 'PRIME SETUP' && (
            <div className={`flex items-center gap-4 px-4 py-2 border-b ${th.border} ${th.sidebar}`}>
              <span className={`text-[9px] font-bold tracking-widest shrink-0 ${
                mc.trendContext.currentVsSma === 'just_crossed_above' ? 'text-emerald-400'
                : mc.trendContext.currentVsSma === 'just_crossed_below' ? 'text-red-400'
                : mc.trendContext.currentVsSma === 'above' ? 'text-emerald-400/70'
                : 'text-red-400/70'
              }`}>ES=F TREND</span>
              <span className={`text-[9px] ${th.textFaint} flex-1`}>{mc.trendContext.trendLabel}</span>
              {mc.trendContext.recoverySetup && (
                <span className="text-[9px] font-bold text-emerald-400 border border-emerald-700 bg-emerald-500/10 px-2 py-0.5 rounded shrink-0">↑ RECOVERY SETUP</span>
              )}
            </div>
          )}
          {/* 50% profit alert */}
          {mc.fiftyPctPositions.length > 0 && (
            <div className="flex items-center gap-3 px-4 py-2.5 bg-emerald-500/10 border-b border-emerald-600/30">
              <span className="text-emerald-400 text-xs">✓</span>
              <p className="text-[10px] text-emerald-400 font-medium">
                {mc.fiftyPctPositions.join(', ')} at 50%+ profit — close before opening new positions
              </p>
            </div>
          )}

          {/* Flag grid */}
          <div className="grid grid-cols-3 divide-x" style={{ borderColor: 'inherit' }}>
            {flagGroups.map(group => (
              <div key={group.section} className={`divide-y ${th.border}`}>
                <p className={`text-[8px] ${th.textFaint} tracking-widest px-3 py-1.5 font-bold uppercase ${th.sidebar}`}>{group.section}</p>
                {group.items.map((flag, i) => (
                  <div key={i} className="flex items-start gap-2 px-3 py-2">
                    <div className={`w-1.5 h-1.5 rounded-full mt-1 shrink-0 ${flagStatusColors[flag.status].dot}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1 mb-0.5">
                        <p className={`text-[9px] ${th.textFaint} truncate`}>{flag.label}</p>
                        <span className={`text-[8px] px-1.5 py-0.5 border rounded shrink-0 font-medium ${flagStatusColors[flag.status].pill}`}>
                          {flag.status === 'good' ? '✓' : flag.status === 'warn' ? '⚠' : '✗'}
                        </span>
                      </div>
                      <p className={`text-[10px] font-medium ${th.textMuted} truncate`}>{flag.value}</p>
                      <p className={`text-[9px] ${th.textFaint} leading-tight mt-0.5`}>{flag.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* ES=F bias action strip */}
          {mc.esFutures && (
            <div className={`border-t ${th.border} px-4 py-2.5 flex items-center gap-4 ${th.sidebar}`}>
              <span className={`text-[9px] font-bold tracking-widest shrink-0 ${
                mc.esFutures.bias === 'bullish' ? 'text-emerald-400'
                : mc.esFutures.bias === 'bearish' ? 'text-red-400'
                : 'text-blue-400'
              }`}>
                {mc.esFutures.bias === 'bullish' ? '↑ BULLISH BIAS' : mc.esFutures.bias === 'bearish' ? '↓ BEARISH BIAS' : '↔ NEUTRAL BIAS'}
              </span>
              <span className={`text-[9px] px-2 py-0.5 border rounded font-bold shrink-0 ${
                mc.esFutures.bias === 'bullish' ? 'border-emerald-700 text-emerald-400 bg-emerald-500/10'
                : mc.esFutures.bias === 'bearish' ? 'border-red-700 text-red-400 bg-red-500/10'
                : 'border-blue-700 text-blue-400 bg-blue-500/10'
              }`}>{mc.esFutures.biasLabel}</span>
              <span className={`text-[9px] ${th.textFaint} flex-1`}>{mc.esFutures.strikeAnchorNote}</span>
              {mc.esFutures.settling && (
                <span className="text-[9px] font-bold text-amber-400 border border-amber-700 bg-amber-500/10 px-2 py-0.5 rounded shrink-0">⏳ WAIT FOR SETTLE</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────
export default function EnginePage() {
  const [theme, setTheme] = useState<Theme>(getSavedTheme);
  const [accent, setAccent] = useState<Accent>(getSavedAccent);
  const th = THEMES[theme];
  useEffect(() => { applyAccent(accent); injectAccentStyle(); }, [accent]);
  useEffect(() => { applyAccent(getSavedAccent()); }, []);

  const [subTab, setSubTab] = useState<SubTab>(() => {
    try { return (localStorage.getItem(LS_ENGINE_SUBTAB) as SubTab) ?? 'actions'; } catch { return 'actions'; }
  });
  const [alloc, setAlloc] = useState<Allocation>(() => {
    try { const s = localStorage.getItem(LS_ENGINE_ALLOC); return s ? JSON.parse(s) : DEFAULT_ALLOC; } catch { return DEFAULT_ALLOC; }
  });
  const [watchlist, setWatchlist] = useState<string[]>(() => {
    try { const s = localStorage.getItem(LS_ENGINE_WATCHLIST); return s ? JSON.parse(s) : DEFAULT_WATCHLIST; } catch { return DEFAULT_WATCHLIST; }
  });
  const [watchlistInput, setWatchlistInput] = useState(watchlist.join(', '));
  const [showSettings, setShowSettings] = useState(false);
  const [deltaRange, setDeltaRange] = useState<[number, number]>(() => {
    const r = getSavedEtfRules();
    return [r.SPREAD_DELTA_MIN, r.SPREAD_DELTA_MAX];
  });
  const saveDeltaRange = (min: number, max: number) => {
    const r = getSavedEtfRules();
    try { localStorage.setItem('hunter-etf-rules', JSON.stringify({ ...r, SPREAD_DELTA_MIN: min, SPREAD_DELTA_MAX: max })); } catch {}
    setDeltaRange([min, max]);
  };
  const [status, setStatus] = useState<EngineStatus>('idle');
  const [engineData, setEngineData] = useState<EngineData | null>(null);
  const [error, setError] = useState('');
  const [aiAnalysis, setAiAnalysis] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [marketConditions, setMarketConditions] = useState<MarketConditions | null>(null);
  const [mcLoading, setMcLoading] = useState(false);
  const [editingAlloc, setEditingAlloc] = useState({ ...alloc });
  const [includeMargin, setIncludeMargin] = useState(false);
  const [orderEntry, setOrderEntry] = useState<EngineOrderEntry | null>(null);

  const saveSubTab = (t: SubTab) => {
    setSubTab(t);
    try { localStorage.setItem(LS_ENGINE_SUBTAB, t); } catch {}
  };

  const saveAlloc = (a: Allocation) => {
    const total = a.reserve + a.wheel + a.spx + a.hunter + a.longBook;
    const reserve  = Math.round((a.reserve  / total) * 100);
    const wheel    = Math.round((a.wheel    / total) * 100);
    const spx      = Math.round((a.spx      / total) * 100);
    const hunter   = Math.round((a.hunter   / total) * 100);
    const normalized: Allocation = {
      reserve, wheel, spx, hunter,
      longBook: 100 - reserve - wheel - spx - hunter,
    };
    setEngineData(null);
    setAlloc(normalized);
    try { localStorage.setItem(LS_ENGINE_ALLOC, JSON.stringify(normalized)); } catch {}
    return normalized;
  };

  const saveWatchlist = (input: string) => {
    const list = input.toUpperCase().split(/[,\s]+/).map(s => s.trim()).filter(s => /^[A-Z]{1,5}$/.test(s));
    setEngineData(null); // prevent stale dashboard data while reloading
    setWatchlist(list);
    try { localStorage.setItem(LS_ENGINE_WATCHLIST, JSON.stringify(list)); } catch {}
    return list;
  };

  const runEngine = useCallback(async () => {
    setStatus('loading');
    setError('');
    try {
      // Fetch market conditions first so ES=F signal is available for screener
      setMcLoading(true);
      const mc = await loadMarketConditions(watchlist, null).catch(() => null);
      if (mc) setMarketConditions(mc);
      setMcLoading(false);

      // Now load engine data with ES=F signal wired in
      const data = await loadEngineData(watchlist, alloc, mc?.esFutures ?? null, mc?.trendContext ?? null);
      setEngineData(data);
      setStatus('ready');

      // Refresh market conditions with position data now available
      setMcLoading(true);
      loadMarketConditions(watchlist, data)
        .then(mc2 => setMarketConditions(mc2))
        .catch(() => {})
        .finally(() => setMcLoading(false));
      // Load AI analysis in background
      setAiLoading(true);
      try {
        const analysis = await getEngineAIAnalysis(data, watchlist);
        setAiAnalysis(analysis);
      } catch { setAiAnalysis('AI analysis unavailable.'); }
      finally { setAiLoading(false); }
    } catch (e: any) {
      setError(e.message);
      setStatus('error');
    }
  }, [watchlist, alloc]);

  useEffect(() => { runEngine(); }, [runEngine]);

  const d = engineData;

  const formatCurrency = (value: number) =>
    value.toLocaleString(undefined, { maximumFractionDigits: 0 });

  const allocationDollar = (pct: number) =>
    d?.capital?.obp ? (includeMargin ? d.capital.obp : d.capital.obpCash) * (pct / 100) : 0;

  const allocationLabel = (pct: number) =>
    d?.capital?.obp ? `$${formatCurrency(allocationDollar(pct))}` : '$—';

  // ── Timeline date helpers ──────────────────────────────────────────────
  const today = new Date();
  const timelineDays = 60;
  const timelineDates: Date[] = [];
  for (let i = 0; i <= timelineDays; i += 7) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    timelineDates.push(d);
  }
  const fmt = (d: Date) => `${d.toLocaleString('en', { month: 'short' })} ${d.getDate()}`;

  return (
    <div className={`min-h-screen ${th.bg} transition-colors duration-200`} style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      {/* Order modal */}
      {orderEntry && <EngineOrderModal entry={orderEntry} th={th} onClose={() => setOrderEntry(null)} />}
      {/* ── Header ── */}
      <div className={`${th.header} border-b ${th.border} px-6 pb-0 pt-3 sticky top-0 z-50 flex flex-col`}>
        <div className="flex items-center justify-between w-full pb-2">
          <div className="flex items-center gap-3">
            <svg width="46" height="46" viewBox="-26 -26 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle r="18" stroke="#00d4aa" strokeWidth="0.8" opacity="0.3"/>
              <circle r="12" stroke="#00d4aa" strokeWidth="0.8" opacity="0.6"/>
              <line x1="-23" y1="0" x2="-14" y2="0" stroke="#00d4aa" strokeWidth="1.1" strokeLinecap="round"/>
              <line x1="14" y1="0" x2="23" y2="0" stroke="#00d4aa" strokeWidth="1.1" strokeLinecap="round"/>
              <line x1="0" y1="-23" x2="0" y2="-14" stroke="#00d4aa" strokeWidth="1.1" strokeLinecap="round"/>
              <line x1="0" y1="14" x2="0" y2="23" stroke="#00d4aa" strokeWidth="1.1" strokeLinecap="round"/>
              <line x1="-6" y1="5" x2="-6" y2="-6" stroke="#ff5566" strokeWidth="1.8" strokeLinecap="round" opacity="0.85"/>
              <line x1="-1" y1="3" x2="-1" y2="-9" stroke="#00d4aa" strokeWidth="1.8" strokeLinecap="round"/>
              <line x1="4" y1="1" x2="4" y2="-12" stroke="#00d4aa" strokeWidth="1.8" strokeLinecap="round"/>
              <circle r="2" fill="#00d4aa"/>
            </svg>
            <div>
              <h1 className="text-lg font-bold tracking-widest text-white leading-tight" style={{ fontFamily: "'DM Mono', monospace" }}>TRADE<span style={{ color: '#00d4aa' }}>EDGE</span></h1>
              <p className="text-[9px] font-bold tracking-widest leading-tight" style={{ fontFamily: "'DM Mono', monospace", color: '#00d4aa', opacity: 0.75 }}>OPTIONS TRADING PLATFORM</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
          {d && <span className={`text-[9px] ${th.textFaint}`}>Updated {d.lastUpdated.toLocaleTimeString()}</span>}
          {/* Delta Range inline control */}
          <div className="flex items-center gap-1.5">
            <span className={`text-[9px] ${th.textFaint} tracking-wider`}>Δ RANGE</span>
            {([
              { label: 'Conservative', min: 0.15, max: 0.20 },
              { label: 'Standard',     min: 0.20, max: 0.25 },
              { label: 'Aggressive',   min: 0.25, max: 0.30 },
            ] as { label: string; min: number; max: number }[]).map(p => (
              <button key={p.label}
                onClick={() => { saveDeltaRange(p.min, p.max); runEngine(); }}
                className={`text-[9px] px-2 py-1 rounded border transition-colors font-bold ${
                  deltaRange[0] === p.min && deltaRange[1] === p.max
                    ? 'border-blue-500 text-blue-300 bg-blue-500/15'
                    : `${th.border} ${th.textFaint} hover:border-blue-500/50 hover:text-blue-400`
                }`}>
                {p.label} {deltaRange[0] === p.min && deltaRange[1] === p.max ? `(${p.min}–${p.max})` : ''}
              </button>
            ))}
            <input type="number" min="0.05" max="0.30" step="0.01" value={deltaRange[0]}
              onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) { saveDeltaRange(v, deltaRange[1]); } }}
              className={`w-14 text-[9px] px-1.5 py-1 rounded border ${th.inputBorder} ${th.input} ${th.text} outline-none focus:border-blue-500 text-center`}
              style={{ fontFamily: "'DM Mono', monospace" }} />
            <span className={`text-[9px] ${th.textFaint}`}>–</span>
            <input type="number" min="0.10" max="0.35" step="0.01" value={deltaRange[1]}
              onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) { saveDeltaRange(deltaRange[0], v); } }}
              className={`w-14 text-[9px] px-1.5 py-1 rounded border ${th.inputBorder} ${th.input} ${th.text} outline-none focus:border-blue-500 text-center`}
              style={{ fontFamily: "'DM Mono', monospace" }} />
          </div>
          <button onClick={runEngine} disabled={status === 'loading'}
            className={`text-[10px] px-3 py-1.5 border ${th.border} rounded-lg ${th.textMuted} hover:border-emerald-500 hover:text-emerald-400 transition-colors disabled:opacity-40`}>
            {status === 'loading' ? '⟳ Loading...' : '↺ Refresh'}
          </button>
          <button onClick={() => setShowSettings(!showSettings)}
            className={`text-[10px] px-3 py-1.5 border ${th.border} rounded-lg ${th.textMuted} hover:border-blue-500 hover:text-blue-400 transition-colors`}>
            ⚙ Settings
          </button>
          {/* Accent swatches */}
          <div className="flex items-center gap-1">
            {(Object.entries(ACCENTS) as [Accent, typeof ACCENTS[Accent]][]).map(([key, val]) => (
              <button key={key} onClick={() => { setAccent(key); applyAccent(key); try { localStorage.setItem(LS_ACCENT, key); } catch {} }}
                title={val.label}
                className={`w-3.5 h-3.5 rounded-full transition-all ${accent === key ? 'ring-2 ring-white/60 ring-offset-1 ring-offset-black scale-125' : 'opacity-60 hover:opacity-100'}`}
                style={{ backgroundColor: val.hex }} />
            ))}
          </div>
          <div className="w-px h-4 bg-white/20" />
          <div className="flex items-center gap-1 bg-black/20 rounded-lg p-1">
            {(['light', 'medium', 'dark'] as Theme[]).map((v, i) => (
              <button key={v} onClick={() => { setTheme(v); try { localStorage.setItem(LS_THEME, v); } catch {} }}
                className={`text-sm px-2 py-1 rounded transition-all ${theme === v ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white/80'}`}>
                {['☀', '◐', '☾'][i]}
              </button>
            ))}
          </div>
          </div>
        </div>
        <div className="flex items-center gap-0 w-full border-t border-white/10">
          <a href="/"            className="text-[10px] font-bold px-3 py-2 text-white/55 hover:text-white/80 transition-colors tracking-wider">HOME</a>
          <a href="/portfolio"   className="text-[10px] font-bold px-3 py-2 text-white/55 hover:text-white/80 transition-colors tracking-wider">PORTFOLIO</a>
          <a href="/screener"    className="text-[10px] font-bold px-3 py-2 text-white/55 hover:text-white/80 transition-colors tracking-wider">SCREENER</a>
          <span                  className="text-[10px] font-bold px-3 py-2 tracking-wider" style={{ color: '#00d4aa', borderBottom: '2px solid #00d4aa' }}>INCOME ENGINE</span>
          <a href="/rinse-repeat" className="text-[10px] font-bold px-3 py-2 text-white/55 hover:text-white/80 transition-colors tracking-wider">REPEAT STRATEGIES</a>
          <a href="/trade-log"   className="text-[10px] font-bold px-3 py-2 text-white/55 hover:text-white/80 transition-colors tracking-wider">TRADE LOG</a>
          <a href="/performance" className="text-[10px] font-bold px-3 py-2 text-white/55 hover:text-white/80 transition-colors tracking-wider">PERFORMANCE</a>
          <a href="/help"        className="text-[10px] font-bold px-3 py-2 text-white/55 hover:text-white/80 transition-colors tracking-wider">HELP</a>
        </div>
      </div>

      {/* ── Settings Panel ── */}
      {showSettings && (
        <div className={`${th.sidebar} border-b ${th.border} px-6 py-4`}>
          <div className="max-w-4xl mx-auto">
            <div className="grid grid-cols-2 gap-8">
              {/* Allocation sliders */}
              <div>
                <p className={`text-[9px] ${th.textFaint} tracking-widest uppercase font-bold mb-3`}>Capital Allocation</p>
                <div className="space-y-3">
                  {(['reserve', 'wheel', 'spx', 'hunter', 'longBook'] as const).map(key => {
                    const labels: Record<string, string> = { reserve: 'Reserve', wheel: 'Wheel', spx: 'SPX Engine', hunter: 'Hunter', longBook: 'Long Book' };
                    const colors: Record<string, string> = { reserve: 'text-slate-400', wheel: 'text-blue-400', spx: 'text-violet-400', hunter: 'text-amber-400', longBook: 'text-emerald-400' };
                    return (
                      <div key={key} className="flex items-center gap-3">
                        <span className={`text-[10px] w-24 shrink-0 ${colors[key]} font-medium`}>{labels[key]}</span>
                        <input type="range" min={2} max={70} step={1} value={editingAlloc[key]}
                          onChange={e => setEditingAlloc(prev => ({ ...prev, [key]: parseInt(e.target.value) }))}
                          className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer accent-blue-500" />
                        <span className={`text-[10px] font-bold ${th.text} w-24 text-right`}>
                          {editingAlloc[key]}% <span className={th.textFaint}>({allocationLabel(editingAlloc[key])})</span>
                        </span>
                      </div>
                    );
                  })}
                  <div className={`text-[9px] ${editingAlloc.reserve + editingAlloc.wheel + editingAlloc.spx + editingAlloc.hunter + editingAlloc.longBook === 100 ? 'text-emerald-400' : 'text-amber-400'}`}>
                    Total: {editingAlloc.reserve + editingAlloc.wheel + editingAlloc.spx + editingAlloc.hunter + editingAlloc.longBook}% {editingAlloc.reserve + editingAlloc.wheel + editingAlloc.spx + editingAlloc.hunter + editingAlloc.longBook !== 100 && '(will normalize to 100%)'}
                  </div>
                  <div className={`text-[9px] ${th.textFaint}`}>
                    Dollar amounts are based on current option buying power: {d?.capital?.obp ? `$${formatCurrency(d.capital.obp)}` : 'not loaded'}.
                  </div>
                  <button onClick={() => { saveAlloc(editingAlloc); setShowSettings(false); }}
                    className="text-[10px] px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors">
                    Apply & Reload
                  </button>
                </div>
              </div>
              {/* Watchlist */}
              <div>
                <p className={`text-[9px] ${th.textFaint} tracking-widest uppercase font-bold mb-3`}>Wheel Watchlist</p>
                <textarea value={watchlistInput} onChange={e => setWatchlistInput(e.target.value)}
                  className={`w-full ${th.input} border ${th.inputBorder} rounded-lg p-2 text-xs ${th.text} h-20 resize-none focus:outline-none focus:border-blue-500`}
                  placeholder="AAPL, MSFT, GOOGL..." />
                <button onClick={() => { saveWatchlist(watchlistInput); setShowSettings(false); }}
                  className="mt-2 text-[10px] px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors">
                  Save & Reload
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Capital Summary Strip ── */}
      {d && (
        <div className={`${th.sidebar} border-b ${th.border} px-6 py-3`}>
          <div className="flex items-center gap-8">
            <div className="shrink-0">
              <div className="flex items-center gap-2 mb-0.5">
                <p className={`text-[9px] ${th.textFaint} tracking-widest uppercase`}>Option Buying Power</p>
                <button
                  onClick={() => setIncludeMargin(v => !v)}
                  className={`text-[8px] px-1.5 py-0.5 rounded border transition-colors ${includeMargin ? 'border-amber-500 text-amber-400 bg-amber-500/10' : `${th.border} ${th.textFaint} hover:border-white/30`}`}
                  title={includeMargin ? 'Showing with margin — click for cash only' : 'Showing cash only — click to include margin'}>
                  {includeMargin ? 'w/ Margin' : 'Cash Only'}
                </button>
              </div>
              <p className={`text-xl font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                ${(includeMargin ? d.capital.obp : d.capital.obpCash).toLocaleString()}
              </p>
            </div>
            <div className="flex-1 grid grid-cols-4 gap-4">
              <CapitalBar label={`Spread Engine · SPX+SPY (${alloc.spx}% · $${formatCurrency(d.capital.spxTarget)})`} deployed={d.capital.spxDeployed} target={d.capital.spxTarget} color="bg-violet-500" />
              <CapitalBar label={`Wheel (${alloc.wheel}% · $${formatCurrency(d.capital.wheelTarget)})`} deployed={d.capital.wheelDeployed} target={d.capital.wheelTarget} color="bg-blue-500" />
              {d.capital.hunterDeployed > 0 ? (
                <CapitalBar label="Hunter Spreads · closing out" deployed={d.capital.hunterDeployed} target={d.capital.hunterDeployed} color="bg-amber-500" />
              ) : (
                <div />
              )}
              <div>
                <p className={`text-[9px] ${th.textFaint} mb-1`}>Reserve ({alloc.reserve}% · ${formatCurrency(d.capital.reserveTarget)})</p>
                <div className="h-1.5 rounded-full bg-slate-700/60 overflow-hidden mb-1">
                  <div className="h-full rounded-full bg-slate-500" style={{ width: '100%' }} />
                </div>
                <p className={`text-[9px] ${th.textFaint}`}>${d.capital.reserveTarget.toLocaleString()} protected</p>
              </div>
            </div>
            <div className="shrink-0 text-right">
              <p className={`text-[9px] ${th.textFaint}`}>Deployment</p>
              <p className={`text-lg font-bold ${d.capital.deploymentPct >= 80 ? 'text-emerald-400' : d.capital.deploymentPct >= 50 ? 'text-amber-400' : 'text-red-400'}`}>{d.capital.deploymentPct}%</p>
              <p className={`text-[9px] ${th.textFaint}`}>of target</p>
            </div>
          </div>
        </div>
      )}

      {/* ── Sub-tab bar ── */}
      <div className={`${th.sidebar} border-b ${th.border} px-6 sticky top-[85px] z-40`}>
        <div className="flex gap-0">
          {([
            { key: 'actions', label: 'Actions', icon: '⚡' },
            { key: 'dashboard', label: 'Dashboard', icon: '◈' },
            { key: 'timeline', label: 'Timeline', icon: '⟿' },
            { key: 'advisor', label: 'Advisor', icon: '◬' },
          ] as { key: SubTab; label: string; icon: string }[]).map(tab => (
            <button key={tab.key} onClick={() => saveSubTab(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-3 text-xs font-medium tracking-wider border-b-2 transition-colors ${
                subTab === tab.key
                  ? `text-white border-[var(--accent)]`
                  : `${th.textFaint} border-transparent hover:text-white/70`
              }`}>
              <span className="text-sm">{tab.icon}</span>
              {tab.label}
              {tab.key === 'actions' && d && d.actions.filter(a => a.priority === 'urgent').length > 0 && (
                <span className="text-[8px] bg-red-500 text-white px-1 rounded-full">{d.actions.filter(a => a.priority === 'urgent').length}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="p-5">
        {/* Loading */}
        {status === 'loading' && (
          <div className="flex items-center justify-center py-20">
            <div className="text-center space-y-2">
              <div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin mx-auto" />
              <p className={`text-[10px] ${th.textFaint} tracking-widest`}>LOADING ENGINE DATA...</p>
            </div>
          </div>
        )}

        {/* Error */}
        {status === 'error' && (
          <div className="max-w-lg mx-auto py-10 text-center">
            <p className="text-red-400 text-sm mb-3">{error}</p>
            <button onClick={runEngine} className="text-[10px] px-4 py-2 bg-blue-600 text-white rounded-lg">Retry</button>
          </div>
        )}

        {/* ── ACTIONS TAB ── */}
        {status === 'ready' && d && subTab === 'actions' && (
          <div className="space-y-4 max-w-5xl">
            {/* Market Conditions */}
            <MarketConditionsPanel mc={marketConditions} th={th} loading={mcLoading} />

            {/* AI summary */}
            <div className={`border ${th.border} rounded-xl px-4 py-3 bg-violet-500/5`}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-violet-400 text-xs font-bold">◈ AI ASSESSMENT</span>
                {aiLoading && <div className="w-3 h-3 border border-violet-500 border-t-transparent rounded-full animate-spin" />}
              </div>
              {aiLoading && !aiAnalysis && <p className={`text-[10px] ${th.textFaint} italic`}>Analyzing portfolio...</p>}
              {aiAnalysis && <p className={`text-[11px] ${th.textMuted} leading-relaxed`}>{aiAnalysis}</p>}
            </div>

            {/* Action counts */}
            <div className="flex items-center gap-3">
              <p className={`text-[9px] ${th.textFaint} tracking-widest uppercase font-bold`}>Today's Actions</p>
              {(['urgent', 'review', 'entry', 'hold'] as ActionPriority[]).map(p => {
                const count = d.actions.filter(a => a.priority === p).length;
                if (count === 0) return null;
                const colors = { urgent: 'text-red-400 border-red-700 bg-red-500/10', review: 'text-amber-400 border-amber-700 bg-amber-500/10', entry: 'text-blue-400 border-blue-700 bg-blue-500/10', hold: 'text-slate-400 border-slate-700 bg-slate-700/20' };
                return <span key={p} className={`text-[9px] px-2 py-0.5 border rounded font-bold ${colors[p]}`}>{count} {p}</span>;
              })}
              {d.actions.length === 0 && <span className={`text-[10px] ${th.textFaint}`}>No actions required today</span>}
            </div>

            {/* Action list */}
            {d.actions.length > 0 && (
              <div className="space-y-1.5">
                {d.actions.map(action => <ActionCard key={action.id} item={action} th={th} />)}
              </div>
            )}

            {/* No active positions message */}
            {d.actions.length === 0 && (
              <div className={`border ${th.border} rounded-xl px-6 py-8 text-center ${th.card}`}>
                <p className="text-2xl mb-2">✓</p>
                <p className={`text-sm font-medium ${th.text}`}>Portfolio is running smoothly</p>
                <p className={`text-[10px] ${th.textFaint} mt-1`}>No actions required. Check back tomorrow or refresh for updated data.</p>
              </div>
            )}
          </div>
        )}

        {/* ── DASHBOARD TAB ── */}
        {status === 'ready' && d && subTab === 'dashboard' && (
          <div className="space-y-5 max-w-5xl">
            {/* SPX Engine section */}
            <div className={`border ${th.border} rounded-xl overflow-hidden`}>
              <div className={`px-4 py-3 border-b ${th.border} flex items-center justify-between ${th.card}`}>
                <div className="flex items-center gap-3">
                  <span className="text-violet-400 font-bold text-xs tracking-widest">SPREAD ENGINE</span>
                  <span className="text-[8px] px-1.5 py-0.5 border border-violet-700 text-violet-400 bg-violet-500/10 rounded font-bold">SPX anchor · SPY fills</span>
                  <span className={`text-[9px] ${th.textFaint}`}>{alloc.spx}% · ${d.capital.spxTarget.toLocaleString()} target · ${d.capital.spxDeployed.toLocaleString()} deployed</span>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className={th.textFaint}>{d.spxPositions.length + d.spyPositions.length} active</span>
                  <span className={`${d.capital.spxDeployed >= d.capital.spxTarget * 0.8 ? 'text-emerald-400' : 'text-amber-400'} text-[9px]`}>
                    {d.capital.spxDeployed >= d.capital.spxTarget * 0.8 ? '✓ Well deployed' : '⚠ Under-deployed'}
                  </span>
                </div>
              </div>

              {/* SPX positions */}
              {d.spxPositions.length > 0 && (
                <>
                  <div className={`flex items-center gap-2 px-4 py-1.5 border-b ${th.border} ${th.sidebar}`}>
                    <span className="text-[8px] text-violet-400 font-bold tracking-widest">SPX · 25-WIDE · 1256 TAX</span>
                  </div>
                  <div className={`flex items-center gap-3 px-4 py-1.5 border-b ${th.border} ${th.sidebar}`}>
                    <div className={`w-32 text-[8px] ${th.textFaint} tracking-widest uppercase`}>Strikes</div>
                    <div className={`w-16 text-[8px] ${th.textFaint} tracking-widest uppercase text-center`}>POP</div>
                    <div className={`w-20 text-[8px] ${th.textFaint} tracking-widest uppercase text-center`}>P&L</div>
                    <div className={`w-20 text-[8px] ${th.textFaint} tracking-widest uppercase text-center`}>Capital</div>
                    <div className={`w-16 text-[8px] ${th.textFaint} tracking-widest uppercase text-center`}>Qty</div>
                    <div className="flex-1 text-right text-[8px] text-slate-500 uppercase tracking-widest">Status</div>
                  </div>
                  {d.spxPositions.map((pos, i) => <SpxPositionRow key={i} pos={pos} th={th} />)}
                </>
              )}

              {/* SPY positions */}
              {d.spyPositions.length > 0 && (
                <>
                  <div className={`flex items-center gap-2 px-4 py-1.5 border-b ${th.border} ${th.sidebar}`}>
                    <span className="text-[8px] text-cyan-400 font-bold tracking-widest">SPY · FLEXIBLE WIDTH · SHORT-TERM TAX</span>
                  </div>
                  <div className={`flex items-center gap-3 px-4 py-1.5 border-b ${th.border} ${th.sidebar}`}>
                    <div className={`w-32 text-[8px] ${th.textFaint} tracking-widest uppercase`}>Strikes</div>
                    <div className={`w-16 text-[8px] ${th.textFaint} tracking-widest uppercase text-center`}>POP</div>
                    <div className={`w-20 text-[8px] ${th.textFaint} tracking-widest uppercase text-center`}>P&L</div>
                    <div className={`w-20 text-[8px] ${th.textFaint} tracking-widest uppercase text-center`}>Capital</div>
                    <div className={`w-16 text-[8px] ${th.textFaint} tracking-widest uppercase text-center`}>Qty</div>
                    <div className="flex-1 text-right text-[8px] text-slate-500 uppercase tracking-widest">Status</div>
                  </div>
                  {d.spyPositions.map((pos, i) => <SpxPositionRow key={`spy-${i}`} pos={pos} th={th} />)}
                </>
              )}

              {d.spxPositions.length === 0 && d.spyPositions.length === 0 && (
                <div className={`px-4 py-4 text-center ${th.textFaint} text-[10px]`}>No active spread positions</div>
              )}

              {/* ── SUGGESTED NEW ENTRIES ── */}
              {(d.spxSuggestedEntry || d.spySuggestedEntry) && (
                <div className="border-t-2 border-dashed border-emerald-600/40">
                  {/* Section header */}
                  <div className="flex items-center gap-3 px-4 py-2 bg-emerald-500/5 border-b border-emerald-600/20">
                    <span className="text-[9px] font-bold tracking-widest text-emerald-400 uppercase">✦ Suggested New Positions</span>
                    <span className={`text-[9px] ${th.textFaint}`}>Engine recommends these entries based on available capital + market conditions</span>
                  </div>

                {/* ── AI COMPARISON — only when both suggestions exist ── */}
                {(d.spxSuggestedEntry && d.spySuggestedEntry) && (
                  <SpreadComparisonPanel
                    spx={d.spxSuggestedEntry}
                    spy={d.spySuggestedEntry}
                    available={d.capital.spxAvailable}
                    th={th}
                  />
                )}

                  {/* SPX suggestion */}
                  {d.spxSuggestedEntry && (
                    <div className={`px-4 py-3 border-b border-emerald-600/20 ${d.spxSuggestedEntry.rationale.startsWith('★') ? 'bg-yellow-500/5' : 'bg-emerald-500/5'}`}>
                      <div className="flex items-center gap-3 mb-1.5">
                        <span className={`text-xs font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>SPX</span>
                        <ChartButton symbol="SPX" th={th} />
                        <span className={`text-[8px] px-1.5 py-0.5 border rounded font-bold shrink-0 ${d.spxSuggestedEntry.rationale.startsWith('★') ? 'border-yellow-600 text-yellow-300 bg-yellow-500/10' : 'border-emerald-700 text-emerald-400 bg-emerald-500/10'}`}>
                          {d.spxSuggestedEntry.rationale.startsWith('★') ? '★ PRIME' : d.spxSuggestedEntry.strategy}
                        </span>
                        <span className="text-[8px] px-1.5 py-0.5 border border-violet-700 text-violet-400 bg-violet-500/10 rounded font-bold shrink-0">25-WIDE · 1256 TAX</span>
                        <span className={`text-[9px] ${th.textFaint} flex-1`}>Not yet placed — review and enter in TastyTrade</span>
                        <button
                          onClick={() => setOrderEntry({ mode: 'spread', symbol: 'SPX', shortOccSymbol: d.spxSuggestedEntry!.shortOccSymbol, longOccSymbol: d.spxSuggestedEntry!.longOccSymbol, credit: d.spxSuggestedEntry!.credit, contracts: d.spxSuggestedEntry!.contracts, strategy: d.spxSuggestedEntry!.strategy, dte: d.spxSuggestedEntry!.dte, shortStrike: d.spxSuggestedEntry!.shortStrike, longStrike: d.spxSuggestedEntry!.longStrike, spreadWidth: 25 })}
                          className="text-[9px] px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold shrink-0 transition-colors">
                          New Position
                        </button>
                      </div>
                      <div className="flex items-center gap-6 px-1">
                        <div>
                          <p className={`text-xs font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                            {d.spxSuggestedEntry.shortStrike}/{d.spxSuggestedEntry.longStrike}P
                          </p>
                          <p className={`text-[9px] ${th.textFaint}`}>{d.spxSuggestedEntry.expiration} · {d.spxSuggestedEntry.dte}d DTE</p>
                        </div>
                        <div className="text-center">
                          <p className="text-xs font-bold text-emerald-400">{d.spxSuggestedEntry.pop.toFixed(0)}%</p>
                          <p className={`text-[9px] ${th.textFaint}`}>POP</p>
                        </div>
                        <div className="text-center">
                          <p className={`text-xs font-bold ${th.text}`}>${d.spxSuggestedEntry.credit.toFixed(2)}</p>
                          <p className={`text-[9px] ${th.textFaint}`}>credit</p>
                        </div>
                        <div className="text-center">
                          <p className={`text-xs font-bold ${th.text}`}>{d.spxSuggestedEntry.contracts}×</p>
                          <p className={`text-[9px] ${th.textFaint}`}>contracts</p>
                        </div>
                        <div className="text-center">
                          <p className={`text-xs font-bold ${th.text}`}>${d.spxSuggestedEntry.capitalRequired.toLocaleString()}</p>
                          <p className={`text-[9px] ${th.textFaint}`}>capital req.</p>
                        </div>
                      </div>
                      <p className={`text-[9px] ${th.textFaint} mt-1.5 px-1`}>{d.spxSuggestedEntry.rationale}</p>
                    </div>
                  )}

                  {/* SPY suggestion */}
                  {d.spySuggestedEntry && (
                    <div className="px-4 py-3 bg-emerald-500/5">
                      <div className="flex items-center gap-3 mb-1.5">
                        <span className={`text-xs font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>SPY</span>
                        <ChartButton symbol="SPY" th={th} />
                        <span className="text-[8px] px-1.5 py-0.5 border border-emerald-700 text-emerald-400 bg-emerald-500/10 rounded font-bold shrink-0">{d.spySuggestedEntry.strategy}</span>
                        <span className="text-[8px] px-1.5 py-0.5 border border-cyan-700 text-cyan-400 bg-cyan-500/10 rounded font-bold shrink-0">{d.spySuggestedEntry.spreadWidth}-WIDE · ST TAX</span>
                        <span className={`text-[9px] ${th.textFaint} flex-1`}>Not yet placed — review and enter in TastyTrade</span>
                        <button
                          onClick={() => setOrderEntry({ mode: 'spread', symbol: 'SPY', shortOccSymbol: d.spySuggestedEntry!.shortOccSymbol, longOccSymbol: d.spySuggestedEntry!.longOccSymbol, credit: d.spySuggestedEntry!.credit, contracts: d.spySuggestedEntry!.contracts, strategy: d.spySuggestedEntry!.strategy, dte: d.spySuggestedEntry!.dte, shortStrike: d.spySuggestedEntry!.shortStrike, longStrike: d.spySuggestedEntry!.longStrike, spreadWidth: d.spySuggestedEntry!.spreadWidth })}
                          className="text-[9px] px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold shrink-0 transition-colors">
                          New Position
                        </button>
                      </div>
                      <div className="flex items-center gap-6 px-1">
                        <div>
                          <p className={`text-xs font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                            {d.spySuggestedEntry.shortStrike}/{d.spySuggestedEntry.longStrike}{d.spySuggestedEntry.strategy === 'BCS' ? 'C' : 'P'}
                          </p>
                          <p className={`text-[9px] ${th.textFaint}`}>{d.spySuggestedEntry.expiration} · {d.spySuggestedEntry.dte}d DTE · {d.spySuggestedEntry.strategy}</p>
                        </div>
                        <div className="text-center">
                          <p className="text-xs font-bold text-emerald-400">{d.spySuggestedEntry.pop.toFixed(0)}%</p>
                          <p className={`text-[9px] ${th.textFaint}`}>POP</p>
                        </div>
                        <div className="text-center">
                          <p className={`text-xs font-bold ${th.text}`}>${d.spySuggestedEntry.credit.toFixed(2)}</p>
                          <p className={`text-[9px] ${th.textFaint}`}>credit</p>
                        </div>
                        <div className="text-center">
                          <p className={`text-xs font-bold ${th.text}`}>{d.spySuggestedEntry.contracts}×</p>
                          <p className={`text-[9px] ${th.textFaint}`}>contracts</p>
                        </div>
                        <div className="text-center">
                          <p className={`text-xs font-bold ${th.text}`}>${d.spySuggestedEntry.capitalRequired.toLocaleString()}</p>
                          <p className={`text-[9px] ${th.textFaint}`}>capital req.</p>
                        </div>
                      </div>
                      <p className={`text-[9px] ${th.textFaint} mt-1.5 px-1`}>{d.spySuggestedEntry.rationale}</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Wheel Engine section */}
            <div className={`border ${th.border} rounded-xl overflow-hidden`}>
              <div className={`px-4 py-3 border-b ${th.border} flex items-center justify-between ${th.card}`}>
                <div className="flex items-center gap-3">
                  <span className="text-blue-400 font-bold text-xs tracking-widest">WHEEL ENGINE</span>
                  <span className={`text-[9px] ${th.textFaint}`}>{alloc.wheel}% · ${d.capital.wheelTarget.toLocaleString()} target · ${d.capital.wheelDeployed.toLocaleString()} deployed</span>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className={th.textFaint}>{d.wheelPositions.filter(p => p.phase !== 'idle').length} active / {watchlist.length} stocks</span>
                </div>
              </div>
              {[...d.wheelPositions]
                .sort((a, b) => {
                  const aActive = a.phase !== 'idle';
                  const bActive = b.phase !== 'idle';
                  if (aActive === bActive) return 0;
                  return aActive ? -1 : 1;
                })
                .map((pos, i) => <WheelPositionRow key={i} pos={pos} th={th} />)}

              {/* Wheel suggestions — idle capital deployment */}
              {d.wheelSuggestions.filter(s => s.action !== 'wait').length > 0 && (
                <div className={`border-t ${th.border} px-4 py-3 bg-blue-500/5`}>
                  <p className="text-[9px] text-blue-400 font-bold tracking-widest mb-2">◈ SUGGESTED ENTRIES</p>
                  <div className="space-y-2">
                    {d.wheelSuggestions.filter(s => s.action !== 'wait').map((sug, i) => (
                      <div key={i} className={`flex items-start gap-3 py-2 px-3 rounded-lg border ${th.border} ${th.card}`}>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${sug.action === 'sell-put' ? 'text-emerald-400 border-emerald-700 bg-emerald-500/10' : 'text-amber-400 border-amber-700 bg-amber-500/10'}`}>
                            {sug.action === 'sell-put' ? 'CSP' : 'CC'}
                          </span>
                          <div className="flex flex-col">
                            <div className="flex items-center gap-2">
                              <span className={`text-xs font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{sug.symbol}</span>
                              <ChartButton symbol={sug.symbol} th={th} />
                            </div>
                            {sug.strike && <span className={`text-[9px] ${th.textFaint}`}>{sug.strike}{sug.action === 'sell-put' ? 'P' : 'C'} · ~{sug.dte}d DTE</span>}
                          </div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-[9px] ${th.textMuted} leading-relaxed`}>{sug.rationale}</p>
                        </div>
                        {sug.capitalRequired && (
                          <div className="text-right shrink-0">
                            <p className={`text-[10px] font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>${sug.capitalRequired.toLocaleString()}</p>
                            <p className={`text-[9px] ${th.textFaint}`}>required</p>
                          </div>
                        )}
                        <button
                          onClick={() => setOrderEntry({
                            mode: 'wheel',
                            symbol: sug.symbol,
                            shortOccSymbol: '',
                            longOccSymbol: '',
                            credit: sug.credit ?? 0,
                            contracts: 1,
                            strategy: sug.action === 'sell-call' ? 'CC' : 'CSP',
                            dte: sug.dte ?? 35,
                            shortStrike: sug.strike ?? 0,
                            longStrike: undefined,
                            spreadWidth: 0,
                            optionType: sug.action === 'sell-call' ? 'C' : 'P',
                            action: sug.action === 'sell-call' ? 'sell-call' : 'sell-put',
                            capitalRequired: sug.capitalRequired,
                          })}
                          disabled={!sug.strike}
                          className="text-[9px] px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-bold shrink-0 transition-colors">
                          New Position
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Waiting symbols — IVR too low */}
              {d.wheelSuggestions.filter(s => s.action === 'wait').length > 0 && (
                <div className={`border-t ${th.border} px-4 py-2`}>
                  <p className={`text-[9px] ${th.textFaint}`}>
                    <span className="text-amber-400/70 font-bold">WAITING FOR IV: </span>
                    {d.wheelSuggestions.filter(s => s.action === 'wait').map(s => s.symbol).join(', ')}
                    <span className="ml-1 opacity-60">— IVR below 30</span>
                  </p>
                </div>
              )}
            </div>

            {/* AI summary */}
            {aiAnalysis && (
              <div className={`border ${th.border} rounded-xl px-4 py-3 bg-violet-500/5`}>
                <p className="text-[9px] text-violet-400 font-bold tracking-widest mb-2">◈ AI PORTFOLIO ASSESSMENT</p>
                <p className={`text-[11px] ${th.textMuted} leading-relaxed`}>{aiAnalysis}</p>
              </div>
            )}
          </div>
        )}

        {/* ── TIMELINE TAB ── */}
        {status === 'ready' && d && subTab === 'timeline' && (
          <div className="space-y-4 max-w-5xl">
            <div className={`border ${th.border} rounded-xl overflow-hidden`}>
              {/* Date headers */}
              <div className={`px-4 pt-3 pb-2 border-b ${th.border} ${th.card}`}>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-violet-400 font-bold text-xs tracking-widest">60-DAY TIMELINE</span>
                  <span className={`text-[9px] ${th.textFaint}`}>Rolling engine view</span>
                </div>
                <div className="flex" style={{ paddingLeft: '80px' }}>
                  {timelineDates.map((d, i) => (
                    <div key={i} className="flex-1 text-center">
                      <p className={`text-[8px] ${th.textFaint}`}>{fmt(d)}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Today marker */}
              <div className="relative px-4 pt-3 pb-2">
                <div className="absolute top-0 bottom-0" style={{ left: `calc(80px + 4px)`, width: '1px', background: 'rgba(239,68,68,0.4)' }} />

                {/* SPX positions */}
                <p className={`text-[8px] ${th.textFaint} tracking-widest uppercase font-bold mb-2`}>SPX · 25-Wide · 1256 Tax</p>
                {d.spxPositions.map((pos, i) => (
                  <div key={i} className="flex items-center mb-1.5">
                    <div className={`w-20 shrink-0 text-[9px] ${th.textFaint}`}>{pos.shortStrike}/{pos.longStrike}</div>
                    <div className="flex-1 relative">
                      <TimelineBar
                        startDte={0}
                        endDte={pos.dte}
                        totalDays={timelineDays}
                        color={pos.status === 'hold' ? 'bg-violet-600/80 text-violet-100' : pos.status === 'watch' ? 'bg-amber-600/80 text-amber-100' : 'bg-red-600/80 text-red-100'}
                        label={`${pos.pop.toFixed(0)}% POP`}
                        status={pos.status}
                      />
                    </div>
                  </div>
                ))}
                {d.spxPositions.length === 0 && (
                  <p className={`text-[9px] ${th.textFaint} italic mb-3`}>No SPX positions — spread bucket available for new entry</p>
                )}

                {/* SPY positions */}
                <p className={`text-[8px] ${th.textFaint} tracking-widest uppercase font-bold mb-2 mt-3`}>SPY · Flexible Width · ST Tax</p>
                {d.spyPositions.map((pos, i) => (
                  <div key={`spy-${i}`} className="flex items-center mb-1.5">
                    <div className={`w-20 shrink-0 text-[9px] ${th.textFaint}`}>{pos.shortStrike}/{pos.longStrike}</div>
                    <div className="flex-1 relative">
                      <TimelineBar
                        startDte={0}
                        endDte={pos.dte}
                        totalDays={timelineDays}
                        color={pos.status === 'hold' ? 'bg-cyan-600/80 text-cyan-100' : pos.status === 'watch' ? 'bg-amber-600/80 text-amber-100' : 'bg-red-600/80 text-red-100'}
                        label={`${pos.pop.toFixed(0)}% POP`}
                        status={pos.status}
                      />
                    </div>
                  </div>
                ))}
                {d.spyPositions.length === 0 && (
                  <p className={`text-[9px] ${th.textFaint} italic mb-3`}>No SPY positions — remaining spread capital available</p>
                )}

                {/* Divider */}
                <div className={`border-t ${th.border} my-3`} />

                {/* Wheel positions */}
                <p className={`text-[8px] ${th.textFaint} tracking-widest uppercase font-bold mb-2`}>Wheel</p>
                {d.wheelPositions.filter(p => p.phase !== 'idle').map((pos, i) => (
                  <div key={i} className="flex items-center mb-1.5">
                    <div className={`w-20 shrink-0 text-[9px] ${th.textFaint}`}>{pos.symbol}</div>
                    <div className="flex-1 relative">
                      {pos.phase === 'cash-secured-put' && pos.dte && (
                        <TimelineBar startDte={0} endDte={pos.dte} totalDays={timelineDays}
                          color="bg-blue-600/80 text-blue-100" label={`${pos.strike}P · ${pos.pop?.toFixed(0)}%`} status={pos.status} />
                      )}
                      {(pos.phase === 'assigned' || pos.phase === 'covered-call') && (
                        <div className="h-5 rounded flex items-center px-1.5 bg-amber-600/40 border border-amber-600/60" style={{ width: '40%' }}>
                          <span className="text-[9px] text-amber-200 truncate">{pos.sharesHeld} shares</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {d.wheelPositions.filter(p => p.phase === 'idle').length > 0 && (
                  <p className={`text-[9px] ${th.textFaint} italic`}>
                    Idle: {d.wheelPositions.filter(p => p.phase === 'idle').map(p => p.symbol).join(', ')} — eligible for new CSP
                  </p>
                )}
              </div>

              {/* Legend */}
              <div className={`border-t ${th.border} px-4 py-2 flex items-center gap-4 ${th.sidebar}`}>
                {[
                  { color: 'bg-violet-600/80', label: 'SPX BPS active' },
                  { color: 'bg-amber-600/80', label: 'Watch / manage' },
                  { color: 'bg-blue-600/80', label: 'Wheel CSP' },
                  { color: 'bg-amber-600/40 border border-amber-600/60', label: 'Shares held' },
                ].map(l => (
                  <div key={l.label} className="flex items-center gap-1.5">
                    <div className={`w-3 h-3 rounded ${l.color}`} />
                    <span className={`text-[9px] ${th.textFaint}`}>{l.label}</span>
                  </div>
                ))}
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded border border-dashed border-violet-500" />
                  <span className={`text-[9px] ${th.textFaint}`}>Suggested entry</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── ADVISOR TAB ── */}
        {status === 'ready' && d && subTab === 'advisor' && (
          <EngineAdvisor data={d} watchlist={watchlist} th={th} />
        )}
      </div>
    </div>
  );
}
