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

const DEFAULT_ALLOC = { reserve: 20, wheel: 50, spx: 30 };

type SubTab = 'actions' | 'dashboard' | 'timeline';
type ActionPriority = 'urgent' | 'review' | 'entry' | 'hold';
type EngineStatus = 'idle' | 'loading' | 'ready' | 'error';

interface Allocation { reserve: number; wheel: number; spx: number; }

interface CapitalSummary {
  obp: number;
  reserveTarget: number;
  wheelTarget: number;
  spxTarget: number;
  wheelDeployed: number;
  spxDeployed: number;
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
  const obp = parseFloat(balData['derivative-buying-power'] ?? balData['option-buying-power'] ?? '0');

  const capital: CapitalSummary = {
    obp,
    reserveTarget: obp * (alloc.reserve / 100),
    wheelTarget: obp * (alloc.wheel / 100),
    spxTarget: obp * (alloc.spx / 100),
    wheelDeployed: 0, spxDeployed: 0,
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
      ivrMap[sym] = ivrRaw != null ? Math.round(parseFloat(ivrRaw) * 100) : null;
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
  capital.deploymentPct = obp > 0 ? Math.round(((wheelDeployed + spxDeployed) / (capital.wheelTarget + capital.spxTarget)) * 100) : 0;

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
      // Find best 30-45 DTE expiration
      const validExps = expirations
        .map((e: any) => ({ date: e['expiration-date'], dte: daysUntil(e['expiration-date']), strikes: e.strikes }))
        .filter((e: any) => e.dte >= 28 && e.dte <= 48)
        .sort((a: any, b: any) => Math.abs(a.dte - 38) - Math.abs(b.dte - 38));

      // Strategy: BPS when bullish or neutral, BCS when bearish
      // IC conditions (neutral) → still use BPS — simpler, more liquid, puts have better credit
      const esBias = esFuturesSignal?.bias ?? 'bullish';
      const strategy: 'BPS' | 'BCS' = esBias === 'bearish' ? 'BCS' : 'BPS';
      const deltaMin = etfRules.SPREAD_DELTA_MIN;
      const deltaMax = etfRules.SPREAD_DELTA_MAX;

      for (const exp of validExps.slice(0, 5)) {
        // Skip expiries that already have an open position — always spread across expiries
        if (spxPositions.some(p => p.expiration === exp.date) || spyPositions.some(p => p.expiration === exp.date)) {
          console.log(`[SPX screener] Skipping ${exp.date} — already have open position on this expiry`);
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
              const shortStrike = parseInt(shortMatch[1]) / 1000;
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
        // Skip expiries already used by SPX or SPY positions
        if (spxPositions.some(p => p.expiration === exp.date) || spyPositions.some(p => p.expiration === exp.date)) {
          console.log(`[SPY screener] Skipping ${exp.date} — already have open position on this expiry`);
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
              const shortStrike = parseInt(shortMatch[1]) / 1000;
              const longStrike = strategy === 'BCS' ? shortStrike + SPY_WIDTH : shortStrike - SPY_WIDTH;

              // ES=F strike anchor (scaled to SPY price — SPY ≈ SPX ÷ 10)
              if (esFuturesSignal) {
                const buffer = 0.005;
                const spyOvernight = { low: esFuturesSignal.overnightLow / 10, high: esFuturesSignal.overnightHigh / 10 };
                if (strategy === 'BPS' && shortStrike > spyOvernight.low * (1 - buffer)) continue;
                if (strategy === 'BCS' && shortStrike < spyOvernight.high * (1 + buffer)) continue;
              }

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

              spySuggestedEntry = {
                shortStrike, longStrike, expiration: exp.date, dte: exp.dte,
                pop, credit, creditRatio, roc, contracts,
                spreadWidth: SPY_WIDTH,
                capitalRequired: SPY_MAX_LOSS * contracts,
                strategy,
                shortOccSymbol: shortOccSymbolSpy,
                longOccSymbol: longOccSymbolSpy,
                rationale: `${biasNote}${exp.dte}d DTE · ${pop.toFixed(0)}% POP · ${(creditRatio * 100).toFixed(0)}% credit ratio · ${SPY_WIDTH}-wide · ${contracts} contracts · ${taxNote}`
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
  for (const pos of wheelPositions.filter(p => p.phase === 'idle' || p.phase === 'assigned')) {
    if (pos.phase === 'idle' && capital.wheelAvailable > 0 && pos.currentPrice) {
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
      const strike = Math.floor(pos.currentPrice * 0.95 / 5) * 5;
      const capitalReq = strike * 100;
      if (capitalReq > capital.wheelAvailable) continue;
      wheelSuggestions.push({
        symbol: pos.symbol,
        action: 'sell-put',
        strike,
        dte: 35,
        pop: 75,
        delta: 0.25,
        capitalRequired: capitalReq,
        rationale: `${pos.symbol} idle · ${ivrStr} ✓ · Sell ${strike}P ~35 DTE at Δ0.25 · Capital: $${capitalReq.toLocaleString()}`
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
    actions.push({ id: 'spx-new-entry', priority: 'entry', category: 'spx', symbol: 'SPX', title: `New ${spxSuggestedEntry.rationale.startsWith('★') ? '★ ' : ''}BPS ${spxSuggestedEntry.shortStrike}/${spxSuggestedEntry.longStrike}P`, detail: `${spxSuggestedEntry.dte}d · ${spxSuggestedEntry.pop.toFixed(0)}% POP · $${spxSuggestedEntry.credit.toFixed(2)} cr · ${spxSuggestedEntry.contracts} contract${spxSuggestedEntry.contracts > 1 ? 's' : ''} · 25-wide · 1256`, action: 'Enter SPX anchor position', urgency: 'Fill SPX spread allocation' });
  }
  if (spySuggestedEntry) {
    actions.push({ id: 'spy-new-entry', priority: 'entry', category: 'spx', symbol: 'SPY', title: `New ${spySuggestedEntry.strategy} ${spySuggestedEntry.shortStrike}/${spySuggestedEntry.longStrike}${spySuggestedEntry.strategy === 'BCS' ? 'C' : 'P'}`, detail: `${spySuggestedEntry.dte}d · ${spySuggestedEntry.pop.toFixed(0)}% POP · $${spySuggestedEntry.credit.toFixed(2)} cr · ${spySuggestedEntry.contracts} contracts · ${spySuggestedEntry.spreadWidth}-wide · ST tax`, action: 'Enter SPY fill position', urgency: 'Deploy remaining spread capital' });
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

Capital: $${data.capital.obp.toLocaleString()} OBP
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
  const etOffsetMs = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })
    ? -(new Date().getTime() - new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getTime()) / 3600000
    : -5;
  const etOffset = Math.round(etOffsetMs); // -5 (EST) or -4 (EDT)
  const etHour = (now.getUTCHours() + 24 + etOffset) % 24;
  const etMinutes = now.getMinutes();
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
      let biasLabel = 'IC';
      if (overnightChangePct > 0.5) { bias = 'bullish'; biasLabel = 'BPS'; }
      else if (overnightChangePct < -0.5) { bias = 'bearish'; biasLabel = 'BCS'; }
      // Strike anchor note
      const bufferPct = 0.5;
      const strikeAnchorNote = bias === 'bullish'
        ? `Overnight low ~${overnightLow.toFixed(0)} — short put strike should clear this by ${bufferPct}% (≥${(overnightLow * (1 - bufferPct / 100)).toFixed(0)})`
        : bias === 'bearish'
        ? `Overnight high ~${overnightHigh.toFixed(0)} — short call strike should clear this by ${bufferPct}% (≤${(overnightHigh * (1 + bufferPct / 100)).toFixed(0)})`
        : `ES=F flat — IC strikes: puts below ${overnightLow.toFixed(0)}, calls above ${overnightHigh.toFixed(0)}`;
      // Settling: market just opened and ES still moving > 0.3% intraday
      const etHourNow = (new Date().getUTCHours() + 24 - 5) % 24;
      const etMinNow = new Date().getMinutes();
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
  const daysToFomc = nextFomc ? Math.round((new Date(nextFomc).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : 999;
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
        <p className={`text-[9px] ${th.textFaint} mt-1 ml-1 italic`}>Not yet placed — review details and enter manually in TastyTrade</p>
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
          <p className={`text-xs font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{pos.shortStrike}/{pos.longStrike}P</p>
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
          <p className="text-[9px] text-amber-400/80">Multiple contracts on a single SPX expiry concentrates risk. Consider spreading across expiries.</p>
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
  symbol: string;
  shortOccSymbol: string;
  longOccSymbol: string;
  credit: number;
  contracts: number;
  strategy: 'BPS' | 'BCS';
  dte: number;
  shortStrike: number;
  longStrike: number;
  spreadWidth: number;
}

function EngineOrderModal({ entry, th, onClose }: { entry: EngineOrderEntry; th: typeof THEMES[Theme]; onClose: () => void }) {
  const [phase, setPhase] = useState<'confirm' | 'placing' | 'done' | 'error'>('confirm');
  const [contracts, setContracts] = useState(entry.contracts);
  const [entryLimit, setEntryLimit] = useState(parseFloat(entry.credit.toFixed(2)));
  const [gtcPct, setGtcPct] = useState(50);
  const [error, setError] = useState('');
  const [orderId, setOrderId] = useState('');

  const gtcBuyback = parseFloat((entryLimit * (1 - gtcPct / 100)).toFixed(2));
  const totalCredit = entryLimit * contracts;
  const maxLoss = (entry.spreadWidth - entryLimit) * contracts * 100;
  const hasOcc = entry.shortOccSymbol && entry.longOccSymbol;

  const placeOrder = async () => {
    setPhase('placing'); setError('');
    try {
      const token = await getAccessToken();
      const accountsData = await ttFetch('/customers/me/accounts', token);
      const account = accountsData?.data?.items?.find((a: any) => a.account['account-number'] === '5WI51392')
        ?? accountsData?.data?.items?.[0];
      const accountNumber = account?.account?.['account-number'];
      if (!accountNumber) throw new Error('No account found');

      const legs = [
        { 'instrument-type': 'Equity Option', symbol: entry.shortOccSymbol, quantity: contracts, action: 'Sell to Open' },
        { 'instrument-type': 'Equity Option', symbol: entry.longOccSymbol,  quantity: contracts, action: 'Buy to Open'  },
      ];
      const closingLegs = legs.map(l => ({ ...l, action: l.action === 'Sell to Open' ? 'Buy to Close' : 'Sell to Close' }));

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

      const res = await fetch(`https://api.tastytrade.com/accounts/${accountNumber}/complex-orders`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? data?.errors?.[0]?.message ?? `Order failed (${res.status})`);
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
                <p className="text-[10px] text-amber-400">OCC symbols not available — market may be closed. Orders can only be placed during market hours when live chain data is available.</p>
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
                <span className={`text-[10px] font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{entry.shortStrike}/{entry.longStrike}{entry.strategy === 'BCS' ? 'C' : 'P'}</span>
              </div>
              <div className="flex justify-between">
                <span className={`text-[10px] ${th.textFaint}`}>DTE</span>
                <span className={`text-[10px] ${th.text}`}>{entry.dte}d</span>
              </div>
            </div>

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

            <button onClick={placeOrder} disabled={!hasOcc || phase === 'placing'}
              className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold rounded-xl transition-colors">
              {phase === 'placing' ? '⟳ Placing order...' : `Place OTOCO Order · ${contracts} contract${contracts > 1 ? 's' : ''}`}
            </button>
            <p className={`text-[9px] ${th.textFaint} text-center`}>Entry GTC + {gtcPct}% profit target GTC submitted as bracket order</p>
          </div>
        )}
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
      <p className={`text-[10px] ${recColor} leading-relaxed`}>{rec}</p>
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
  const [status, setStatus] = useState<EngineStatus>('idle');
  const [engineData, setEngineData] = useState<EngineData | null>(null);
  const [error, setError] = useState('');
  const [aiAnalysis, setAiAnalysis] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [marketConditions, setMarketConditions] = useState<MarketConditions | null>(null);
  const [mcLoading, setMcLoading] = useState(false);
  const [editingAlloc, setEditingAlloc] = useState({ ...alloc });
  const [orderEntry, setOrderEntry] = useState<EngineOrderEntry | null>(null);

  const saveSubTab = (t: SubTab) => {
    setSubTab(t);
    try { localStorage.setItem(LS_ENGINE_SUBTAB, t); } catch {}
  };

  const saveAlloc = (a: Allocation) => {
    // Normalize to sum to 100
    const total = a.reserve + a.wheel + a.spx;
    const normalized = { reserve: Math.round(a.reserve / total * 100), wheel: Math.round(a.wheel / total * 100), spx: 100 - Math.round(a.reserve / total * 100) - Math.round(a.wheel / total * 100) };
    setAlloc(normalized);
    try { localStorage.setItem(LS_ENGINE_ALLOC, JSON.stringify(normalized)); } catch {}
  };

  const saveWatchlist = (input: string) => {
    const list = input.toUpperCase().split(/[,\s]+/).map(s => s.trim()).filter(s => /^[A-Z]{1,5}$/.test(s));
    setWatchlist(list);
    try { localStorage.setItem(LS_ENGINE_WATCHLIST, JSON.stringify(list)); } catch {}
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

  useEffect(() => { runEngine(); }, []);

  const d = engineData;

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
      <div className={`${th.header} border-b ${th.border} px-6 py-4 flex items-center justify-between sticky top-0 z-50`}>
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-base font-bold tracking-widest text-white" style={{ fontFamily: "'DM Mono', monospace" }}>OPTIONS HUNTER</h1>
            <p className="text-[10px] text-white/50 mt-0.5 tracking-wider" style={{ fontFamily: "'DM Mono', monospace" }}>INCOME ENGINE</p>
          </div>
          <nav className="flex items-center gap-1 bg-black/20 rounded-lg p-1">
            <a href="/" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">HUNTER</a>
            <a href="/portfolio" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">PORTFOLIO</a>
            <span className="text-xs px-3 py-1.5 rounded text-white tracking-wider active-nav" style={{ backgroundColor: `rgba(var(--accent-r),var(--accent-g),var(--accent-b),0.25)`, borderBottom: `2px solid var(--accent)` }}>INCOME ENGINE</span>
            <a href="/rinse-repeat" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">RINSE & REPEAT</a>
            <a href="/trade-log" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">TRADE LOG</a>
            <a href="/performance" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">PERFORMANCE</a>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {d && <span className={`text-[9px] ${th.textFaint}`}>Updated {d.lastUpdated.toLocaleTimeString()}</span>}
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

      {/* ── Settings Panel ── */}
      {showSettings && (
        <div className={`${th.sidebar} border-b ${th.border} px-6 py-4`}>
          <div className="max-w-4xl mx-auto">
            <div className="grid grid-cols-2 gap-8">
              {/* Allocation sliders */}
              <div>
                <p className={`text-[9px] ${th.textFaint} tracking-widest uppercase font-bold mb-3`}>Capital Allocation</p>
                <div className="space-y-3">
                  {(['reserve', 'wheel', 'spx'] as const).map(key => (
                    <div key={key} className="flex items-center gap-3">
                      <span className={`text-[10px] ${th.textMuted} w-16 shrink-0 capitalize`}>{key}</span>
                      <input type="range" min={5} max={60} step={5} value={editingAlloc[key]}
                        onChange={e => setEditingAlloc(prev => ({ ...prev, [key]: parseInt(e.target.value) }))}
                        className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer accent-blue-500" />
                      <span className={`text-[10px] font-bold ${th.text} w-8 text-right`}>{editingAlloc[key]}%</span>
                    </div>
                  ))}
                  <div className={`text-[9px] ${editingAlloc.reserve + editingAlloc.wheel + editingAlloc.spx === 100 ? 'text-emerald-400' : 'text-amber-400'}`}>
                    Total: {editingAlloc.reserve + editingAlloc.wheel + editingAlloc.spx}% {editingAlloc.reserve + editingAlloc.wheel + editingAlloc.spx !== 100 && '(will normalize to 100%)'}
                  </div>
                  <button onClick={() => { saveAlloc(editingAlloc); setShowSettings(false); runEngine(); }}
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
                <button onClick={() => { saveWatchlist(watchlistInput); setShowSettings(false); runEngine(); }}
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
              <p className={`text-[9px] ${th.textFaint} tracking-widest uppercase`}>Option Buying Power</p>
              <p className={`text-xl font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>${d.capital.obp.toLocaleString()}</p>
            </div>
            <div className="flex-1 grid grid-cols-3 gap-4">
              <CapitalBar label={`Spread Engine · SPX+SPY (${alloc.spx}%)`} deployed={d.capital.spxDeployed} target={d.capital.spxTarget} color="bg-violet-500" />
              <CapitalBar label={`Wheel (${alloc.wheel}%)`} deployed={d.capital.wheelDeployed} target={d.capital.wheelTarget} color="bg-blue-500" />
              <div>
                <p className={`text-[9px] ${th.textFaint} mb-1`}>Reserve ({alloc.reserve}%)</p>
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
      <div className={`${th.sidebar} border-b ${th.border} px-6 sticky top-[57px] z-40`}>
        <div className="flex gap-0">
          {([
            { key: 'actions', label: 'Actions', icon: '⚡' },
            { key: 'dashboard', label: 'Dashboard', icon: '◈' },
            { key: 'timeline', label: 'Timeline', icon: '⟿' },
          ] as { key: SubTab; label: string; icon: string }[]).map(tab => (
            <button key={tab.key} onClick={() => saveSubTab(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-3 text-xs font-medium tracking-wider border-b-2 transition-colors ${
                subTab === tab.key
                  ? `text-white border-[var(--accent)]`
                  : `${th.textFaint} border-transparent hover:${th.textMuted}`
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
                        <span className="text-[8px] px-1.5 py-0.5 border border-violet-700 text-violet-400 bg-violet-500/10 rounded font-bold shrink-0">SPX</span>
                        <span className={`text-[8px] px-1.5 py-0.5 border rounded font-bold shrink-0 ${d.spxSuggestedEntry.rationale.startsWith('★') ? 'border-yellow-600 text-yellow-300 bg-yellow-500/10' : 'border-emerald-700 text-emerald-400 bg-emerald-500/10'}`}>
                          {d.spxSuggestedEntry.rationale.startsWith('★') ? '★ PRIME' : d.spxSuggestedEntry.strategy}
                        </span>
                        <span className="text-[8px] px-1.5 py-0.5 border border-violet-700 text-violet-400 bg-violet-500/10 rounded font-bold shrink-0">25-WIDE · 1256 TAX</span>
                        <span className={`text-[9px] ${th.textFaint} flex-1`}>Not yet placed — review and enter in TastyTrade</span>
                        <button
                          onClick={() => setOrderEntry({ symbol: 'SPX', shortOccSymbol: d.spxSuggestedEntry!.shortOccSymbol, longOccSymbol: d.spxSuggestedEntry!.longOccSymbol, credit: d.spxSuggestedEntry!.credit, contracts: d.spxSuggestedEntry!.contracts, strategy: d.spxSuggestedEntry!.strategy, dte: d.spxSuggestedEntry!.dte, shortStrike: d.spxSuggestedEntry!.shortStrike, longStrike: d.spxSuggestedEntry!.longStrike, spreadWidth: 25 })}
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
                        <span className="text-[8px] px-1.5 py-0.5 border border-cyan-700 text-cyan-400 bg-cyan-500/10 rounded font-bold shrink-0">SPY</span>
                        <span className="text-[8px] px-1.5 py-0.5 border border-emerald-700 text-emerald-400 bg-emerald-500/10 rounded font-bold shrink-0">{d.spySuggestedEntry.strategy}</span>
                        <span className="text-[8px] px-1.5 py-0.5 border border-cyan-700 text-cyan-400 bg-cyan-500/10 rounded font-bold shrink-0">{d.spySuggestedEntry.spreadWidth}-WIDE · ST TAX</span>
                        <span className={`text-[9px] ${th.textFaint} flex-1`}>Not yet placed — review and enter in TastyTrade</span>
                        <button
                          onClick={() => setOrderEntry({ symbol: 'SPY', shortOccSymbol: d.spySuggestedEntry!.shortOccSymbol, longOccSymbol: d.spySuggestedEntry!.longOccSymbol, credit: d.spySuggestedEntry!.credit, contracts: d.spySuggestedEntry!.contracts, strategy: d.spySuggestedEntry!.strategy, dte: d.spySuggestedEntry!.dte, shortStrike: d.spySuggestedEntry!.shortStrike, longStrike: d.spySuggestedEntry!.longStrike, spreadWidth: d.spySuggestedEntry!.spreadWidth })}
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
              {d.wheelPositions.map((pos, i) => <WheelPositionRow key={i} pos={pos} th={th} />)}
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
      </div>
    </div>
  );
}
