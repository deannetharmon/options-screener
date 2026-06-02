// app/long-book/page.tsx
'use client';
import { THEMES, ACCENTS, Theme, Accent, LS_THEME, LS_ACCENT, getSavedTheme, getSavedAccent, applyAccent, injectAccentStyle } from '@/lib/theme';
import { useState, useEffect, useCallback, useRef } from 'react';

// ── Font injection ─────────────────────────────────────────────────────────
if (typeof document !== 'undefined') {
  if (!document.getElementById('lb-font')) {
    const link = document.createElement('link');
    link.id = 'lb-font';
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
const LS_LB_POSITIONS = 'lb-positions';
const LS_LB_ALLOC = 'lb-allocation';
const LS_LB_WATCHLIST = 'lb-watchlist';
const DEFAULT_LB_WATCHLIST = ['NVDA', 'AMD', 'MU', 'META', 'GOOGL', 'MSFT', 'AMZN', 'AAPL', 'TSLA'];

// ── Default allocation: 5 buckets sum to 100 ──────────────────────────────
const DEFAULT_ALLOC = { reserve: 5, wheel: 51, spx: 30, hunter: 7, longBook: 7 };
interface Allocation5 { reserve: number; wheel: number; spx: number; hunter: number; longBook: number; }

// ── Types ──────────────────────────────────────────────────────────────────

// A LEAP position stored locally (TastyTrade doesn't tag these differently)
interface LeapPosition {
  id: string;                    // uuid
  symbol: string;
  optionType: 'C' | 'P';
  strike: number;
  expiration: string;            // YYYY-MM-DD
  contracts: number;
  debitPaid: number;             // per-share credit paid at entry (e.g. 45.20)
  entryDate: string;             // YYYY-MM-DD
  occSymbol: string;             // space-padded OCC symbol
  // live fields — populated on refresh
  currentMid?: number;
  currentDelta?: number;
  currentIv?: number;
  dte?: number;
  unrealizedPnl?: number;
  unrealizedPct?: number;
  lastRefreshed?: string;
  // PMCC short calls sold against this LEAP
  shortCalls: PmccShortCall[];
  notes?: string;
}

interface PmccShortCall {
  id: string;
  strike: number;
  expiration: string;
  contracts: number;
  creditReceived: number;        // per-share
  entryDate: string;
  occSymbol: string;
  // live
  currentMid?: number;
  dte?: number;
  pnl?: number;                  // positive = profit (short call going down in value)
  status?: 'open' | 'closed';
  closePrice?: number;
  closedPnl?: number;
}

// Chain lookup result
interface ChainStrike {
  strike: number;
  bid: number;
  ask: number;
  mid: number;
  delta: number | null;
  iv: number | null;
  oi: number;
  occSymbol: string;
  dte: number;
  expiration: string;
}

// Alert types
type AlertLevel = 'green' | 'amber' | 'red';
interface Alert { level: AlertLevel; message: string; }

function getAlerts(pos: LeapPosition): Alert[] {
  const alerts: Alert[] = [];
  const dte = pos.dte ?? daysUntil(pos.expiration);
  const pct = pos.unrealizedPct ?? null;

  if (dte < 180 && dte > 0)
    alerts.push({ level: 'amber', message: `${dte}d remaining — evaluate roll or hold` });
  if (dte <= 0)
    alerts.push({ level: 'red', message: 'Expired or expiring today' });
  if (pct !== null && pct >= 50)
    alerts.push({ level: 'green', message: `+${pct.toFixed(0)}% gain — consider partial profit or trail` });
  if (pct !== null && pct <= -40)
    alerts.push({ level: 'red', message: `${pct.toFixed(0)}% loss — thesis check: cut or hold` });

  for (const sc of pos.shortCalls.filter(c => c.status !== 'closed')) {
    const scDte = sc.dte ?? daysUntil(sc.expiration);
    if (scDte <= 21)
      alerts.push({ level: 'amber', message: `Short call ${sc.strike}C at ${scDte}d — close or roll` });
  }
  return alerts;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function daysUntil(dateStr: string): number {
  const parts = dateStr.split('-');
  const target = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  return Math.round((target.getTime() - todayUtc.getTime()) / (1000 * 60 * 60 * 24));
}

function uuid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function fmtDate(d: string): string {
  const parts = d.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(parts[1]) - 1]} ${parseInt(parts[2])}, ${parts[0]}`;
}

function buildOccSymbol(underlying: string, expiration: string, optType: 'C' | 'P', strike: number): string {
  const parts = expiration.split('-');
  const yy = parts[0].slice(2);
  const mm = parts[1];
  const dd = parts[2];
  const strikePadded = Math.round(strike * 1000).toString().padStart(8, '0');
  const base = `${underlying}${yy}${mm}${dd}${optType}${strikePadded}`;
  // space-pad to 21 chars (TastyTrade OCC format)
  return base.padEnd(21, ' ');
}

// ── Auth ───────────────────────────────────────────────────────────────────
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
  return token;
}

async function ttFetch(path: string, token: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    sessionStorage.removeItem('tt_access_token');
    try { localStorage.removeItem(LS_ACCESS_TOKEN); localStorage.removeItem(LS_ACCESS_TOKEN_EXPIRY); } catch {}
    const fresh = await getAccessToken();
    const retry = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${fresh}` } });
    if (!retry.ok) throw new Error(`${path} failed (${retry.status})`);
    return retry.json();
  }
  if (!res.ok) throw new Error(`${path} failed (${res.status})`);
  return res.json();
}

// ── Chain lookup ───────────────────────────────────────────────────────────
async function fetchLeapChain(symbol: string, optionType: 'C' | 'P', token: string): Promise<ChainStrike[]> {
  const nested = await ttFetch(`/option-chains/${encodeURIComponent(symbol)}/nested`, token);
  const expirations = nested?.data?.items?.[0]?.expirations ?? [];

  // LEAP expirations: 365+ days out
  const validExps = expirations
    .map((e: any) => ({ date: e['expiration-date'], dte: daysUntil(e['expiration-date']), strikes: e.strikes ?? [] }))
    .filter((e: any) => e.dte >= 365)
    .sort((a: any, b: any) => a.dte - b.dte);

  const results: ChainStrike[] = [];

  for (const exp of validExps.slice(0, 4)) {
    const symbols: string[] = [];
    for (const s of exp.strikes) {
      const leg = optionType === 'C' ? s.call : s.put;
      if (leg) symbols.push(typeof leg === 'string' ? leg : leg.symbol);
    }
    if (symbols.length === 0) continue;

    for (let i = 0; i < symbols.length; i += 100) {
      const chunk = symbols.slice(i, i + 100);
      const qs = chunk.map((s: string) => `equity-option=${encodeURIComponent(s)}`).join('&');
      try {
        const md = await ttFetch(`/market-data/by-type?${qs}`, token);
        for (const item of md?.data?.items ?? []) {
          const bid = parseFloat(item.bid ?? '0');
          const ask = parseFloat(item.ask ?? '0');
          const mid = (bid + ask) / 2;
          if (mid <= 0) continue;
          const delta = item.delta != null ? parseFloat(item.delta) : null;
          const iv = item['implied-volatility'] != null ? parseFloat(item['implied-volatility']) * 100 : null;
          const oi = parseInt(item['open-interest'] ?? item.oi ?? '0', 10);
          const strikeMatch = item.symbol?.match(/(\d{8})$/);
          if (!strikeMatch) continue;
          const strike = parseInt(strikeMatch[1], 10) / 1000;
          results.push({ strike, bid, ask, mid, delta, iv, oi, occSymbol: item.symbol, dte: exp.dte, expiration: exp.date });
        }
      } catch {}
    }
  }

  // Sort by expiration then strike
  results.sort((a, b) => a.dte - b.dte || a.strike - b.strike);
  return results;
}

// ── Live refresh for existing positions ───────────────────────────────────
async function refreshPositionLive(pos: LeapPosition, token: string): Promise<Partial<LeapPosition>> {
  const updates: Partial<LeapPosition> = { lastRefreshed: new Date().toLocaleTimeString() };

  try {
    const occTrimmed = pos.occSymbol.trim();
    const qs = `equity-option=${encodeURIComponent(occTrimmed)}`;
    const md = await ttFetch(`/market-data/by-type?${qs}`, token);
    const item = md?.data?.items?.[0];
    if (item) {
      const bid = parseFloat(item.bid ?? '0');
      const ask = parseFloat(item.ask ?? '0');
      updates.currentMid = parseFloat(((bid + ask) / 2).toFixed(2));
      updates.currentDelta = item.delta != null ? Math.abs(parseFloat(item.delta)) : undefined;
      updates.currentIv = item['implied-volatility'] != null ? parseFloat((parseFloat(item['implied-volatility']) * 100).toFixed(1)) : undefined;
    }
  } catch {}

  updates.dte = daysUntil(pos.expiration);

  if (updates.currentMid != null) {
    const currentValue = updates.currentMid * pos.contracts * 100;
    const costBasis = pos.debitPaid * pos.contracts * 100;
    updates.unrealizedPnl = parseFloat((currentValue - costBasis).toFixed(2));
    updates.unrealizedPct = costBasis > 0 ? parseFloat(((updates.unrealizedPnl / costBasis) * 100).toFixed(1)) : 0;
  }

  // Refresh open short calls
  const updatedShortCalls = [...pos.shortCalls];
  for (let i = 0; i < updatedShortCalls.length; i++) {
    const sc = updatedShortCalls[i];
    if (sc.status === 'closed') continue;
    try {
      const scOcc = sc.occSymbol.trim();
      const scQs = `equity-option=${encodeURIComponent(scOcc)}`;
      const scMd = await ttFetch(`/market-data/by-type?${scQs}`, token);
      const scItem = scMd?.data?.items?.[0];
      if (scItem) {
        const bid = parseFloat(scItem.bid ?? '0');
        const ask = parseFloat(scItem.ask ?? '0');
        const scMid = (bid + ask) / 2;
        updatedShortCalls[i] = {
          ...sc,
          currentMid: parseFloat(scMid.toFixed(2)),
          dte: daysUntil(sc.expiration),
          // Short call P&L: we collected credit, current cost to close is scMid
          pnl: parseFloat(((sc.creditReceived - scMid) * sc.contracts * 100).toFixed(2)),
        };
      }
    } catch {}
  }
  updates.shortCalls = updatedShortCalls;

  return updates;
}

// ── Net cost basis (after PMCC credits collected) ─────────────────────────
function netCostBasis(pos: LeapPosition): number {
  const totalDebits = pos.debitPaid * pos.contracts * 100;
  const totalCredits = pos.shortCalls.reduce((sum, sc) => {
    if (sc.status === 'closed') return sum + (sc.closedPnl ?? 0);
    return sum + sc.creditReceived * sc.contracts * 100;
  }, 0);
  return Math.max(0, totalDebits - totalCredits);
}

function netCostBasisPerShare(pos: LeapPosition): number {
  const basis = netCostBasis(pos);
  return pos.contracts > 0 ? basis / (pos.contracts * 100) : 0;
}

function shortCallTotalPnl(pos: LeapPosition): number {
  return pos.shortCalls.reduce((sum, sc) => {
    if (sc.status === 'closed') return sum + (sc.closedPnl ?? 0);
    return sum + (sc.pnl ?? 0);
  }, 0);
}

// ── Combined P&L (LEAP value + short calls) ───────────────────────────────
function combinedPnl(pos: LeapPosition): number | null {
  if (pos.currentMid == null) return null;
  const leapValue = pos.currentMid * pos.contracts * 100;
  const leapCost  = pos.debitPaid * pos.contracts * 100;
  const leapPnl   = leapValue - leapCost;
  const scPnl     = shortCallTotalPnl(pos);
  return parseFloat((leapPnl + scPnl).toFixed(2));
}

function combinedPct(pos: LeapPosition): number | null {
  const pnl = combinedPnl(pos);
  if (pnl == null) return null;
  const costBasis = pos.debitPaid * pos.contracts * 100;
  return costBasis > 0 ? parseFloat(((pnl / costBasis) * 100).toFixed(1)) : 0;
}

// ── Order builder ──────────────────────────────────────────────────────────
function buildLeapOpenOrder(pos: LeapPosition | null, occSymbol: string, contracts: number, debit: number) {
  if (!occSymbol.trim()) throw new Error('Missing OCC symbol');
  const instrumentType = 'Equity Option'; // LEAPs on equities
  return {
    type: 'OTOCO',
    'trigger-order': {
      'time-in-force': 'GTC',
      'order-type': 'Limit',
      price: debit.toFixed(2),
      'price-effect': 'Debit',
      legs: [{ 'instrument-type': instrumentType, symbol: occSymbol, quantity: contracts, action: 'Buy to Open' }],
    },
    orders: [], // No bracket GTC for LEAPs — exit is thesis-based
  };
}

function buildShortCallOrder(occSymbol: string, contracts: number, credit: number) {
  return {
    type: 'OTOCO',
    'trigger-order': {
      'time-in-force': 'GTC',
      'order-type': 'Limit',
      price: credit.toFixed(2),
      'price-effect': 'Credit',
      legs: [{ 'instrument-type': 'Equity Option', symbol: occSymbol, quantity: contracts, action: 'Sell to Open' }],
    },
    orders: [{
      'time-in-force': 'GTC',
      'order-type': 'Limit',
      price: parseFloat((credit * 0.5).toFixed(2)).toFixed(2),
      'price-effect': 'Debit',
      legs: [{ 'instrument-type': 'Equity Option', symbol: occSymbol, quantity: contracts, action: 'Buy to Close' }],
    }],
  };
}

// ── LEAP Scanner types ─────────────────────────────────────────────────────
interface LeapScanResult {
  symbol: string;
  rank: number;                  // 1 = best
  direction: 'C' | 'P';
  recommendedStrike: number;
  recommendedExpiration: string;
  recommendedDte: number;
  recommendedDelta: number | null;
  estimatedMid: number;
  estimatedCost: number;         // 1 contract × 100
  ivLevel: string;               // 'LOW' | 'MODERATE' | 'ELEVATED'
  currentPrice: number;
  thesis: string;                // AI rationale
  risks: string;                 // AI risk summary
  score: number;                 // 0–100
  occSymbol: string;
  expiration: string;
}

// ── Fetch market data for a ticker (price + IV proxy) ─────────────────────
async function fetchTickerSnapshot(symbol: string, token: string): Promise<{ price: number; ivr: number | null; change1d: number | null }> {
  try {
    const md = await ttFetch(`/market-data/by-type?equity=${encodeURIComponent(symbol)}`, token);
    const item = md?.data?.items?.[0];
    if (!item) return { price: 0, ivr: null, change1d: null };
    const last = parseFloat(item.last ?? '0');
    const bid  = parseFloat(item.bid ?? '0');
    const ask  = parseFloat(item.ask ?? '0');
    const price = last > 0 ? last : (bid + ask) / 2;
    const ivrRaw = item['implied-volatility-index-rank'];
    const ivr = ivrRaw != null
      ? parseFloat(ivrRaw) > 1 ? Math.round(parseFloat(ivrRaw)) : Math.round(parseFloat(ivrRaw) * 100)
      : null;
    const prevClose = parseFloat(item['prev-close'] ?? item['previous-close'] ?? '0');
    const change1d = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null;
    return { price, ivr, change1d };
  } catch { return { price: 0, ivr: null, change1d: null }; }
}

// ── Find best LEAP strike for a ticker ────────────────────────────────────
async function findBestLeapStrike(
  symbol: string, direction: 'C' | 'P', price: number, token: string
): Promise<{ strike: number; expiration: string; dte: number; delta: number | null; mid: number; occSymbol: string } | null> {
  try {
    const nested = await ttFetch(`/option-chains/${encodeURIComponent(symbol)}/nested`, token);
    const expirations = nested?.data?.items?.[0]?.expirations ?? [];
    // Target Jan expirations 365–760 DTE — sweet spot for LEAPs
    const validExps = expirations
      .map((e: any) => ({ date: e['expiration-date'], dte: daysUntil(e['expiration-date']), strikes: e.strikes ?? [] }))
      .filter((e: any) => e.dte >= 365 && e.dte <= 760)
      .sort((a: any, b: any) => Math.abs(a.dte - 550) - Math.abs(b.dte - 550)); // prefer ~18 months

    for (const exp of validExps.slice(0, 2)) {
      const symbols: string[] = exp.strikes
        .map((s: any) => direction === 'C' ? s.call : s.put)
        .filter(Boolean)
        .map((leg: any) => typeof leg === 'string' ? leg : leg?.symbol)
        .filter(Boolean);

      for (let i = 0; i < symbols.length; i += 100) {
        const chunk = symbols.slice(i, i + 100);
        const qs = chunk.map((s: string) => `equity-option=${encodeURIComponent(s)}`).join('&');
        try {
          const md = await ttFetch(`/market-data/by-type?${qs}`, token);
          // Find strike closest to 0.75 delta (sweet spot)
          let best: any = null;
          let bestDiff = Infinity;
          for (const item of md?.data?.items ?? []) {
            const delta = item.delta != null ? Math.abs(parseFloat(item.delta)) : null;
            if (delta == null) continue;
            const diff = Math.abs(delta - 0.75);
            if (diff < bestDiff && delta >= 0.55 && delta <= 0.85) {
              bestDiff = diff;
              best = item;
            }
          }
          if (best) {
            const bid = parseFloat(best.bid ?? '0');
            const ask = parseFloat(best.ask ?? '0');
            const mid = (bid + ask) / 2;
            if (mid <= 0) continue;
            const strikeMatch = best.symbol?.match(/(\d{8})$/);
            if (!strikeMatch) continue;
            const strike = parseInt(strikeMatch[1], 10) / 1000;
            return { strike, expiration: exp.date, dte: exp.dte, delta: Math.abs(parseFloat(best.delta)), mid, occSymbol: best.symbol };
          }
        } catch {}
      }
    }
  } catch {}
  return null;
}

// ── AI LEAP scanner ────────────────────────────────────────────────────────
async function runLeapAiScan(
  watchlist: string[],
  snapshots: Record<string, { price: number; ivr: number | null; change1d: number | null }>,
  strikes: Record<string, { strike: number; expiration: string; dte: number; delta: number | null; mid: number; occSymbol: string } | null>
): Promise<LeapScanResult[]> {
  const today = new Date().toISOString().slice(0, 10);

  const tickerData = watchlist.map(sym => {
    const snap = snapshots[sym] ?? { price: 0, ivr: null, change1d: null };
    const sk = strikes[sym];
    return {
      symbol: sym,
      price: snap.price,
      ivr: snap.ivr,
      change1d: snap.change1d,
      bestCallStrike: sk?.strike ?? null,
      bestCallExpiration: sk?.expiration ?? null,
      bestCallDte: sk?.dte ?? null,
      bestCallDelta: sk?.delta ?? null,
      bestCallMid: sk?.mid ?? null,
    };
  }).filter(t => t.price > 0);

  const prompt = `You are a professional options trader evaluating LEAP call opportunities for a premium-selling account looking to add directional long exposure.

Today: ${today}

Ticker data (price, IVR, 1-day change, best call strike at ~0.75 delta):
${tickerData.map(t => `${t.symbol}: price=$${t.price.toFixed(2)}, IVR=${t.ivr ?? 'N/A'}, 1d change=${t.change1d != null ? t.change1d.toFixed(2) + '%' : 'N/A'}, best call strike=${t.bestCallStrike ?? 'N/A'} exp=${t.bestCallExpiration ?? 'N/A'} (${t.bestCallDte ?? '?'}d) delta=${t.bestCallDelta?.toFixed(2) ?? 'N/A'} mid=$${t.bestCallMid?.toFixed(2) ?? 'N/A'}`).join('\n')}

For each ticker evaluate:
1. Directional thesis strength for the next 12-24 months (AI capex cycle, earnings growth, product cycles, valuation)
2. IV level — lower IVR is better for buying LEAPs (you pay less premium when IV is cheap)
3. Risk/reward on the specific strike shown
4. Whether this is a CALL (bullish) or PUT (bearish) setup — most should be calls given the AI supercycle, but flag any bearish setups if warranted

Rank ALL tickers from best to worst LEAP opportunity. Be direct and specific. No hedging.

Respond ONLY with a JSON array, no markdown, no backticks:
[
  {
    "symbol": "NVDA",
    "rank": 1,
    "direction": "C",
    "score": 88,
    "thesis": "2-3 sentence directional thesis specific to this stock right now",
    "risks": "1-2 sentence key risks",
    "ivLevel": "LOW|MODERATE|ELEVATED"
  }
]`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error('AI scan failed');
  const data = await res.json();
  const text = data.content?.find((b: any) => b.type === 'text')?.text ?? '[]';
  const clean = text.replace(/```json|```/g, '').trim();
  const aiResults: { symbol: string; rank: number; direction: 'C' | 'P'; score: number; thesis: string; risks: string; ivLevel: string }[] = JSON.parse(clean);

  // Merge AI analysis with chain data
  return aiResults.map(ai => {
    const snap = snapshots[ai.symbol] ?? { price: 0, ivr: null, change1d: null };
    const sk = strikes[ai.symbol];
    return {
      symbol: ai.symbol,
      rank: ai.rank,
      direction: ai.direction,
      score: ai.score,
      thesis: ai.thesis,
      risks: ai.risks,
      ivLevel: ai.ivLevel,
      currentPrice: snap.price,
      recommendedStrike: sk?.strike ?? 0,
      recommendedExpiration: sk?.expiration ?? '',
      recommendedDte: sk?.dte ?? 0,
      recommendedDelta: sk?.delta ?? null,
      estimatedMid: sk?.mid ?? 0,
      estimatedCost: sk ? Math.round(sk.mid * 100) : 0,
      occSymbol: sk?.occSymbol ?? '',
      expiration: sk?.expiration ?? '',
    } as LeapScanResult;
  }).sort((a, b) => a.rank - b.rank);
}

// ── Scan Result Card ───────────────────────────────────────────────────────
function ScanResultCard({
  result, th, onOpenChain,
}: {
  result: LeapScanResult;
  th: typeof THEMES[Theme];
  onOpenChain: (symbol: string, direction: 'C' | 'P') => void;
}) {
  const rankColors = ['text-yellow-300', 'text-slate-300', 'text-amber-600', 'text-slate-400'];
  const rankColor = rankColors[Math.min(result.rank - 1, 3)];
  const scoreColor = result.score >= 75 ? 'text-emerald-400' : result.score >= 55 ? 'text-amber-400' : 'text-red-400';
  const ivColor = result.ivLevel === 'LOW' ? 'text-emerald-400 border-emerald-700 bg-emerald-500/10'
    : result.ivLevel === 'MODERATE' ? 'text-amber-400 border-amber-700 bg-amber-500/10'
    : 'text-red-400 border-red-700 bg-red-500/10';

  return (
    <div className={`border ${th.border} rounded-xl overflow-hidden ${result.rank === 1 ? 'border-[var(--accent)]/40' : ''}`}
      style={result.rank === 1 ? { boxShadow: `0 0 0 1px rgba(var(--accent-r),var(--accent-g),var(--accent-b),0.2)` } : {}}>
      <div className={`flex items-center gap-4 px-4 py-3 ${th.card}`}>
        {/* Rank */}
        <div className="shrink-0 w-8 text-center">
          <span className={`text-lg font-bold ${rankColor}`} style={{ fontFamily: "'DM Mono', monospace" }}>#{result.rank}</span>
        </div>

        {/* Symbol + direction */}
        <div className="w-28 shrink-0">
          <div className="flex items-center gap-2">
            <p className={`text-sm font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{result.symbol}</p>
            <span className={`text-[8px] px-1.5 py-0.5 rounded border font-bold ${result.direction === 'C' ? 'text-emerald-400 border-emerald-700 bg-emerald-500/10' : 'text-red-400 border-red-700 bg-red-500/10'}`}>
              {result.direction === 'C' ? '▲ CALL' : '▼ PUT'}
            </span>
          </div>
          <p className={`text-[9px] ${th.textFaint}`}>${result.currentPrice.toFixed(2)}</p>
        </div>

        {/* Strike recommendation */}
        <div className="w-40 shrink-0">
          {result.recommendedStrike > 0 ? (
            <>
              <p className={`text-[10px] font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                {result.recommendedStrike}{result.direction} {fmtDate(result.recommendedExpiration)}
              </p>
              <p className={`text-[9px] ${th.textFaint}`}>
                {result.recommendedDte}d · δ{result.recommendedDelta?.toFixed(2) ?? '—'} · mid ${result.estimatedMid.toFixed(2)}
              </p>
              <p className={`text-[9px] ${th.textFaint}`}>~${result.estimatedCost.toLocaleString()} / contract</p>
            </>
          ) : (
            <p className={`text-[9px] ${th.textFaint} italic`}>Chain unavailable</p>
          )}
        </div>

        {/* IV badge */}
        <div className="shrink-0">
          <span className={`text-[8px] px-2 py-0.5 border rounded font-bold ${ivColor}`}>{result.ivLevel} IV</span>
          <p className={`text-[9px] ${th.textFaint} mt-1`}>buy when low</p>
        </div>

        {/* Score */}
        <div className="shrink-0 text-center w-16">
          <p className={`text-base font-bold ${scoreColor}`}>{result.score}</p>
          <p className={`text-[9px] ${th.textFaint}`}>/100</p>
        </div>

        {/* Thesis */}
        <div className="flex-1 min-w-0">
          <p className={`text-[10px] ${th.textMuted} leading-relaxed`}>{result.thesis}</p>
          <p className={`text-[9px] text-red-400/70 mt-0.5`}>⚠ {result.risks}</p>
        </div>

        {/* Action */}
        <div className="shrink-0">
          <button
            onClick={() => onOpenChain(result.symbol, result.direction)}
            disabled={result.recommendedStrike === 0}
            className="text-[9px] px-3 py-1.5 bg-[var(--accent)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg font-bold transition-opacity">
            Open Chain →
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Chain Picker Modal ─────────────────────────────────────────────────────
function ChainPickerModal({
  symbol, optionType, th, onSelect, onClose,
}: {
  symbol: string;
  optionType: 'C' | 'P';
  th: typeof THEMES[Theme];
  onSelect: (strike: ChainStrike) => void;
  onClose: () => void;
}) {
  const [chain, setChain] = useState<ChainStrike[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterExp, setFilterExp] = useState<string>('all');
  const [deltaFilter, setDeltaFilter] = useState<'all' | 'high' | 'mid'>('high');

  useEffect(() => {
    (async () => {
      try {
        const token = await getAccessToken();
        const strikes = await fetchLeapChain(symbol, optionType, token);
        setChain(strikes);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [symbol, optionType]);

  const expirations = [...new Set(chain.map(s => s.expiration))].sort();
  const filtered = chain.filter(s => {
    if (filterExp !== 'all' && s.expiration !== filterExp) return false;
    const absDelta = s.delta != null ? Math.abs(s.delta) : null;
    if (deltaFilter === 'high' && absDelta != null && absDelta < 0.60) return false;
    if (deltaFilter === 'mid' && absDelta != null && (absDelta < 0.40 || absDelta > 0.65)) return false;
    return true;
  });

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[80] p-4" onClick={onClose}>
      <div className={`${th.sidebar} border ${th.border} rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col`} onClick={e => e.stopPropagation()}>
        <div className={`px-5 py-4 border-b ${th.border} flex items-center justify-between shrink-0`}>
          <div>
            <h2 className={`text-sm font-bold ${th.text} tracking-widest`}>{symbol} LEAP CHAIN — {optionType === 'C' ? 'CALLS' : 'PUTS'}</h2>
            <p className={`text-[10px] ${th.textFaint} mt-0.5`}>365+ DTE only · Select a strike to pre-fill the order</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">✕</button>
        </div>

        {/* Filters */}
        <div className={`px-5 py-3 border-b ${th.border} flex items-center gap-4 shrink-0`}>
          <div className="flex items-center gap-2">
            <span className={`text-[10px] ${th.textFaint}`}>Expiry:</span>
            <select value={filterExp} onChange={e => setFilterExp(e.target.value)}
              className={`text-[10px] ${th.input} border ${th.inputBorder} rounded px-2 py-1 ${th.text}`}>
              <option value="all">All</option>
              {expirations.map(e => <option key={e} value={e}>{fmtDate(e)} ({daysUntil(e)}d)</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <span className={`text-[10px] ${th.textFaint} mr-1`}>Delta:</span>
            {([['all', 'All'], ['high', '0.65–0.85 (stock sub)'], ['mid', '0.40–0.65 (leverage)']] as [string, string][]).map(([v, l]) => (
              <button key={v} onClick={() => setDeltaFilter(v as any)}
                className={`text-[9px] px-2 py-1 rounded border transition-colors ${deltaFilter === v ? 'border-[var(--accent)] text-white bg-[rgba(var(--accent-r),var(--accent-g),var(--accent-b),0.2)]' : `${th.border} ${th.textFaint}`}`}>
                {l}
              </button>
            ))}
          </div>
        </div>

        {/* Chain table */}
        <div className="overflow-y-auto flex-1">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
              <span className={`ml-3 text-[10px] ${th.textFaint}`}>Fetching LEAP chain...</span>
            </div>
          )}
          {error && <p className="text-red-400 text-sm px-5 py-4">{error}</p>}
          {!loading && !error && filtered.length === 0 && (
            <p className={`text-[10px] ${th.textFaint} px-5 py-4`}>No strikes match current filters.</p>
          )}
          {!loading && !error && filtered.length > 0 && (
            <table className="w-full text-[10px]">
              <thead className={`sticky top-0 ${th.sidebar} border-b ${th.border}`}>
                <tr>
                  <th className={`px-4 py-2 text-left ${th.textFaint} font-medium`}>Expiry</th>
                  <th className={`px-4 py-2 text-right ${th.textFaint} font-medium`}>Strike</th>
                  <th className={`px-4 py-2 text-right ${th.textFaint} font-medium`}>Delta</th>
                  <th className={`px-4 py-2 text-right ${th.textFaint} font-medium`}>Bid</th>
                  <th className={`px-4 py-2 text-right ${th.textFaint} font-medium`}>Ask</th>
                  <th className={`px-4 py-2 text-right ${th.textFaint} font-medium`}>Mid</th>
                  <th className={`px-4 py-2 text-right ${th.textFaint} font-medium`}>IV%</th>
                  <th className={`px-4 py-2 text-right ${th.textFaint} font-medium`}>OI</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((s, i) => {
                  const absDelta = s.delta != null ? Math.abs(s.delta) : null;
                  const isIdeal = absDelta != null && absDelta >= 0.70 && absDelta <= 0.80;
                  return (
                    <tr key={i} className={`border-b ${th.border} hover:bg-white/5 cursor-pointer transition-colors ${isIdeal ? 'bg-[rgba(var(--accent-r),var(--accent-g),var(--accent-b),0.06)]' : ''}`}
                      onClick={() => onSelect(s)}>
                      <td className={`px-4 py-2.5 ${th.textFaint}`}>{fmtDate(s.expiration)} <span className="opacity-60">({s.dte}d)</span></td>
                      <td className={`px-4 py-2.5 text-right font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{s.strike.toFixed(0)}</td>
                      <td className={`px-4 py-2.5 text-right font-bold ${absDelta != null && absDelta >= 0.70 ? 'text-emerald-400' : absDelta != null && absDelta >= 0.50 ? 'text-amber-400' : th.textMuted}`}>
                        {absDelta != null ? absDelta.toFixed(2) : '—'}
                        {isIdeal && <span className="ml-1 text-[8px] text-emerald-400/70">★</span>}
                      </td>
                      <td className={`px-4 py-2.5 text-right ${th.textFaint}`}>${s.bid.toFixed(2)}</td>
                      <td className={`px-4 py-2.5 text-right ${th.textFaint}`}>${s.ask.toFixed(2)}</td>
                      <td className={`px-4 py-2.5 text-right font-bold ${th.text}`}>${s.mid.toFixed(2)}</td>
                      <td className={`px-4 py-2.5 text-right ${th.textFaint}`}>{s.iv != null ? `${s.iv.toFixed(0)}%` : '—'}</td>
                      <td className={`px-4 py-2.5 text-right ${th.textFaint}`}>{s.oi.toLocaleString()}</td>
                      <td className="px-4 py-2.5">
                        <button className="text-[9px] px-2 py-1 bg-[var(--accent)] text-white rounded font-bold opacity-80 hover:opacity-100 transition-opacity">Select</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className={`px-5 py-2 border-t ${th.border} shrink-0`}>
          <p className={`text-[9px] ${th.textFaint}`}>★ = 0.70–0.80 delta sweet spot (stock substitute). Lower delta = more leverage, more theta drag.</p>
        </div>
      </div>
    </div>
  );
}

// ── New LEAP Order Modal ───────────────────────────────────────────────────
function NewLeapModal({
  th, onClose, onSaved, preFill,
}: {
  th: typeof THEMES[Theme];
  onClose: () => void;
  onSaved: (pos: LeapPosition) => void;
  preFill?: { symbol: string; direction: 'C' | 'P' };
}) {
  const [step, setStep] = useState<'ticker' | 'chain' | 'confirm' | 'placing' | 'done' | 'error'>(preFill ? 'chain' : 'ticker');
  const [symbol, setSymbol] = useState(preFill?.symbol ?? '');
  const [optionType, setOptionType] = useState<'C' | 'P'>(preFill?.direction ?? 'C');
  const [selectedStrike, setSelectedStrike] = useState<ChainStrike | null>(null);
  const [contracts, setContracts] = useState(1);
  const [limitPrice, setLimitPrice] = useState(0);
  const [notes, setNotes] = useState('');
  const [orderId, setOrderId] = useState('');
  const [error, setError] = useState('');

  const handleStrikeSelect = (strike: ChainStrike) => {
    setSelectedStrike(strike);
    setLimitPrice(parseFloat(strike.mid.toFixed(2)));
    setStep('confirm');
  };

  const placeOrder = async () => {
    if (!selectedStrike) return;
    setStep('placing'); setError('');
    try {
      const token = await getAccessToken();
      const accountsData = await ttFetch('/customers/me/accounts', token);
      const account = accountsData?.data?.items?.find((a: any) => a.account['account-number'] === '5WI51392')
        ?? accountsData?.data?.items?.[0];
      const accountNumber = account?.account?.['account-number'];
      if (!accountNumber) throw new Error('No account found');

      const payload = buildLeapOpenOrder(null, selectedStrike.occSymbol, contracts, limitPrice);
      const res = await fetch(`${BASE}/accounts/${accountNumber}/complex-orders`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = data?.error?.message ?? data?.['error-message'] ?? data?.errors?.[0]?.message ?? JSON.stringify(data).slice(0, 400);
        throw new Error(detail);
      }
      setOrderId(data?.data?.['complex-order']?.id ?? data?.data?.order?.id ?? 'submitted');

      // Save position locally
      const newPos: LeapPosition = {
        id: uuid(),
        symbol: symbol.toUpperCase(),
        optionType,
        strike: selectedStrike.strike,
        expiration: selectedStrike.expiration,
        contracts,
        debitPaid: limitPrice,
        entryDate: new Date().toISOString().slice(0, 10),
        occSymbol: selectedStrike.occSymbol,
        currentMid: selectedStrike.mid,
        currentDelta: selectedStrike.delta ?? undefined,
        currentIv: selectedStrike.iv ?? undefined,
        dte: selectedStrike.dte,
        unrealizedPnl: 0,
        unrealizedPct: 0,
        shortCalls: [],
        notes,
      };
      onSaved(newPos);
      setStep('done');
    } catch (e: any) {
      setError(e.message);
      setStep('error');
    }
  };

  const totalDebit = limitPrice * contracts * 100;
  const maxLoss = totalDebit;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[70] p-4" onClick={step === 'chain' ? undefined : onClose}>
      {step === 'chain' && selectedStrike === null ? (
        <ChainPickerModal symbol={symbol.toUpperCase()} optionType={optionType} th={th}
          onSelect={handleStrikeSelect} onClose={() => setStep('ticker')} />
      ) : (
        <div className={`${th.sidebar} border ${th.border} rounded-2xl p-6 w-full max-w-md`} onClick={e => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-5">
            <h2 className={`text-sm font-bold ${th.text} tracking-widest`}>NEW LEAP — LONG BOOK</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">✕</button>
          </div>

          {step === 'ticker' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className={`text-[10px] ${th.textFaint}`}>Ticker</label>
                <input
                  value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())}
                  placeholder="NVDA"
                  className={`w-full ${th.input} border ${th.inputBorder} rounded-lg px-3 py-2 text-sm font-bold ${th.text} focus:outline-none focus:border-[var(--accent)] uppercase`} />
              </div>
              <div className="space-y-2">
                <label className={`text-[10px] ${th.textFaint}`}>Direction</label>
                <div className="flex gap-2">
                  {(['C', 'P'] as const).map(t => (
                    <button key={t} onClick={() => setOptionType(t)}
                      className={`flex-1 py-2 rounded-lg border text-sm font-bold transition-colors ${optionType === t ? 'border-[var(--accent)] text-white bg-[rgba(var(--accent-r),var(--accent-g),var(--accent-b),0.2)]' : `${th.border} ${th.textFaint}`}`}>
                      {t === 'C' ? '▲ Bullish (Call)' : '▼ Bearish (Put)'}
                    </button>
                  ))}
                </div>
              </div>
              <div className={`${th.card} border ${th.border} rounded-xl px-3 py-2.5`}>
                <p className={`text-[10px] ${th.textFaint} leading-relaxed`}>
                  The chain will show all expirations 365+ days out. Look for <span className="text-emerald-400 font-bold">★ 0.70–0.80 delta</span> strikes — they behave like stock ownership with defined risk.
                </p>
              </div>
              <button onClick={() => { if (symbol.trim().length >= 1) setStep('chain'); }}
                disabled={symbol.trim().length < 1}
                className="w-full py-2.5 bg-[var(--accent)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold rounded-xl transition-opacity">
                Fetch LEAP Chain →
              </button>
            </div>
          )}

          {step === 'confirm' && selectedStrike && (
            <div className="space-y-4">
              {/* Position summary */}
              <div className={`${th.card} border ${th.border} rounded-xl p-4 space-y-2`}>
                <div className="flex justify-between">
                  <span className={`text-[10px] ${th.textFaint}`}>Position</span>
                  <span className={`text-[10px] font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                    {symbol.toUpperCase()} {selectedStrike.strike}{optionType} {fmtDate(selectedStrike.expiration)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className={`text-[10px] ${th.textFaint}`}>DTE</span>
                  <span className={`text-[10px] ${th.text}`}>{selectedStrike.dte} days</span>
                </div>
                <div className="flex justify-between">
                  <span className={`text-[10px] ${th.textFaint}`}>Delta</span>
                  <span className={`text-[10px] font-bold ${selectedStrike.delta != null && Math.abs(selectedStrike.delta) >= 0.70 ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {selectedStrike.delta != null ? Math.abs(selectedStrike.delta).toFixed(2) : '—'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className={`text-[10px] ${th.textFaint}`}>IV</span>
                  <span className={`text-[10px] ${th.text}`}>{selectedStrike.iv != null ? `${selectedStrike.iv.toFixed(0)}%` : '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className={`text-[10px] ${th.textFaint}`}>Bid / Ask</span>
                  <span className={`text-[10px] ${th.text}`}>${selectedStrike.bid.toFixed(2)} / ${selectedStrike.ask.toFixed(2)}</span>
                </div>
              </div>

              {/* Controls */}
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <span className={`text-[10px] ${th.textFaint} shrink-0`}>Contracts</span>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setContracts(Math.max(1, contracts - 1))}
                      className={`w-6 h-6 rounded border ${th.border} ${th.textMuted} hover:text-white flex items-center justify-center`}>−</button>
                    <span className={`text-sm font-bold ${th.text} w-6 text-center`}>{contracts}</span>
                    <button onClick={() => setContracts(contracts + 1)}
                      className={`w-6 h-6 rounded border ${th.border} ${th.textMuted} hover:text-white flex items-center justify-center`}>+</button>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className={`text-[10px] ${th.textFaint} shrink-0`}>Limit (debit)</span>
                  <div className="flex items-center gap-1">
                    <span className={`text-[10px] ${th.textFaint}`}>$</span>
                    <input type="number" step="0.05" min="0.01" value={limitPrice}
                      onChange={e => setLimitPrice(parseFloat(e.target.value) || 0)}
                      className={`w-20 text-right text-sm font-bold ${th.text} ${th.input} border ${th.inputBorder} rounded px-2 py-1 focus:outline-none focus:border-[var(--accent)]`} />
                  </div>
                </div>
                <div className="space-y-1">
                  <span className={`text-[10px] ${th.textFaint}`}>Notes (optional)</span>
                  <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. NVDA AI thesis, Vera Rubin cycle"
                    className={`w-full ${th.input} border ${th.inputBorder} rounded-lg px-3 py-2 text-[11px] ${th.text} focus:outline-none focus:border-[var(--accent)]`} />
                </div>
              </div>

              {/* Summary */}
              <div className={`${th.sidebar} rounded-xl p-3 space-y-1.5 border ${th.border}`}>
                <div className="flex justify-between">
                  <span className={`text-[9px] ${th.textFaint}`}>Total debit</span>
                  <span className="text-[9px] text-amber-400 font-bold">${totalDebit.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                </div>
                <div className="flex justify-between">
                  <span className={`text-[9px] ${th.textFaint}`}>Max loss</span>
                  <span className="text-[9px] text-red-400">${maxLoss.toLocaleString(undefined, { maximumFractionDigits: 0 })} (premium paid)</span>
                </div>
                <div className="flex justify-between">
                  <span className={`text-[9px] ${th.textFaint}`}>No GTC at entry</span>
                  <span className={`text-[9px] ${th.textFaint}`}>Exit is thesis-based</span>
                </div>
              </div>

              <div className="flex gap-2">
                <button onClick={() => { setSelectedStrike(null); setStep('chain'); }}
                  className={`flex-1 py-2 border ${th.border} rounded-xl text-[10px] ${th.textMuted} hover:text-white transition-colors`}>
                  ← Back to Chain
                </button>
                <button onClick={placeOrder}
                  className="flex-1 py-2.5 bg-[var(--accent)] hover:opacity-90 text-white text-sm font-bold rounded-xl transition-opacity">
                  Place Order · {contracts} contract{contracts > 1 ? 's' : ''}
                </button>
              </div>
              <p className={`text-[9px] ${th.textFaint} text-center`}>GTC limit order — no bracket. Manage exit manually.</p>
            </div>
          )}

          {step === 'placing' && (
            <div className="flex items-center justify-center py-10 gap-3">
              <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
              <p className={`text-[11px] ${th.textFaint}`}>Placing order...</p>
            </div>
          )}

          {step === 'done' && (
            <div className="text-center py-6 space-y-2">
              <p className="text-2xl">✓</p>
              <p className="text-emerald-400 font-bold text-sm">Order submitted</p>
              <p className={`text-[10px] ${th.textFaint}`}>Order ID: {orderId}</p>
              <p className={`text-[10px] ${th.textFaint}`}>Position saved to Long Book. Refresh to see live P&L.</p>
              <button onClick={onClose} className="mt-3 text-xs px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg">Done</button>
            </div>
          )}

          {step === 'error' && (
            <div className="space-y-3">
              <p className="text-red-400 text-sm">{error}</p>
              <button onClick={() => setStep('confirm')} className={`text-xs px-3 py-1.5 border ${th.border} rounded-lg ${th.textMuted}`}>Back</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sell Short Call Modal (PMCC) ───────────────────────────────────────────
function SellShortCallModal({
  leapPos, th, onClose, onSaved,
}: {
  leapPos: LeapPosition;
  th: typeof THEMES[Theme];
  onClose: () => void;
  onSaved: (sc: PmccShortCall) => void;
}) {
  const [step, setStep] = useState<'chain' | 'confirm' | 'placing' | 'done' | 'error'>('chain');
  const [chain, setChain] = useState<ChainStrike[]>([]);
  const [loadingChain, setLoadingChain] = useState(true);
  const [chainError, setChainError] = useState('');
  const [selected, setSelected] = useState<ChainStrike | null>(null);
  const [contracts, setContracts] = useState(leapPos.contracts);
  const [limitPrice, setLimitPrice] = useState(0);
  const [orderId, setOrderId] = useState('');
  const [error, setError] = useState('');

  // Short-term expirations for covered calls (21–60 DTE)
  useEffect(() => {
    (async () => {
      try {
        const token = await getAccessToken();
        const nested = await ttFetch(`/option-chains/${encodeURIComponent(leapPos.symbol)}/nested`, token);
        const expirations = nested?.data?.items?.[0]?.expirations ?? [];
        const validExps = expirations
          .map((e: any) => ({ date: e['expiration-date'], dte: daysUntil(e['expiration-date']), strikes: e.strikes ?? [] }))
          .filter((e: any) => e.dte >= 21 && e.dte <= 60)
          .sort((a: any, b: any) => a.dte - b.dte);

        const results: ChainStrike[] = [];
        for (const exp of validExps.slice(0, 3)) {
          const symbols: string[] = exp.strikes.map((s: any) => s.call).filter(Boolean).map((c: any) => typeof c === 'string' ? c : c?.symbol).filter(Boolean);
          for (let i = 0; i < symbols.length; i += 100) {
            const chunk = symbols.slice(i, i + 100);
            const qs = chunk.map((s: string) => `equity-option=${encodeURIComponent(s)}`).join('&');
            try {
              const md = await ttFetch(`/market-data/by-type?${qs}`, token);
              for (const item of md?.data?.items ?? []) {
                const bid = parseFloat(item.bid ?? '0');
                const ask = parseFloat(item.ask ?? '0');
                const mid = (bid + ask) / 2;
                if (mid <= 0) continue;
                const delta = item.delta != null ? parseFloat(item.delta) : null;
                const absDelta = delta != null ? Math.abs(delta) : null;
                // Show OTM calls only (delta 0.20–0.40 for PMCC)
                if (absDelta == null || absDelta < 0.15 || absDelta > 0.45) continue;
                const strikeMatch = item.symbol?.match(/(\d{8})$/);
                if (!strikeMatch) continue;
                const strike = parseInt(strikeMatch[1], 10) / 1000;
                // Must be above LEAP strike to avoid assignment risk
                if (strike <= leapPos.strike) continue;
                results.push({ strike, bid, ask, mid, delta, iv: null, oi: 0, occSymbol: item.symbol, dte: exp.dte, expiration: exp.date });
              }
            } catch {}
          }
        }
        results.sort((a, b) => a.dte - b.dte || a.strike - b.strike);
        setChain(results);
      } catch (e: any) { setChainError(e.message); }
      finally { setLoadingChain(false); }
    })();
  }, [leapPos.symbol, leapPos.strike]);

  const handleSelect = (s: ChainStrike) => {
    setSelected(s);
    setLimitPrice(parseFloat(s.mid.toFixed(2)));
    setStep('confirm');
  };

  const placeOrder = async () => {
    if (!selected) return;
    setStep('placing'); setError('');
    try {
      const token = await getAccessToken();
      const accountsData = await ttFetch('/customers/me/accounts', token);
      const account = accountsData?.data?.items?.find((a: any) => a.account['account-number'] === '5WI51392') ?? accountsData?.data?.items?.[0];
      const accountNumber = account?.account?.['account-number'];
      if (!accountNumber) throw new Error('No account found');

      const payload = buildShortCallOrder(selected.occSymbol, contracts, limitPrice);
      const res = await fetch(`${BASE}/accounts/${accountNumber}/complex-orders`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = data?.error?.message ?? data?.['error-message'] ?? data?.errors?.[0]?.message ?? JSON.stringify(data).slice(0, 400);
        throw new Error(detail);
      }
      setOrderId(data?.data?.['complex-order']?.id ?? data?.data?.order?.id ?? 'submitted');

      const newSc: PmccShortCall = {
        id: uuid(),
        strike: selected.strike,
        expiration: selected.expiration,
        contracts,
        creditReceived: limitPrice,
        entryDate: new Date().toISOString().slice(0, 10),
        occSymbol: selected.occSymbol,
        status: 'open',
        dte: selected.dte,
        currentMid: selected.mid,
        pnl: 0,
      };
      onSaved(newSc);
      setStep('done');
    } catch (e: any) { setError(e.message); setStep('error'); }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[75] p-4" onClick={onClose}>
      <div className={`${th.sidebar} border ${th.border} rounded-2xl p-6 w-full max-w-lg`} onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <div>
            <h2 className={`text-sm font-bold ${th.text} tracking-widest`}>SELL COVERED CALL — {leapPos.symbol}</h2>
            <p className={`text-[10px] ${th.textFaint} mt-0.5`}>PMCC · 21–60 DTE · Strike above {leapPos.strike} (LEAP strike)</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">✕</button>
        </div>

        {step === 'chain' && (
          <>
            {loadingChain && (
              <div className="flex items-center justify-center py-8 gap-2">
                <div className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                <span className={`text-[10px] ${th.textFaint}`}>Loading calls...</span>
              </div>
            )}
            {chainError && <p className="text-red-400 text-sm">{chainError}</p>}
            {!loadingChain && !chainError && (
              <div className="space-y-1 max-h-72 overflow-y-auto">
                {chain.length === 0 && <p className={`text-[10px] ${th.textFaint}`}>No qualifying strikes found (Δ 0.15–0.45, above {leapPos.strike}).</p>}
                {chain.map((s, i) => (
                  <button key={i} onClick={() => handleSelect(s)}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border ${th.border} hover:border-[var(--accent)] transition-colors text-left`}>
                    <div>
                      <span className={`text-[10px] font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{s.strike}C</span>
                      <span className={`text-[9px] ${th.textFaint} ml-2`}>{fmtDate(s.expiration)} · {s.dte}d</span>
                    </div>
                    <div className="flex items-center gap-4 text-right">
                      <div>
                        <p className={`text-[10px] font-bold ${th.text}`}>${s.mid.toFixed(2)}</p>
                        <p className={`text-[9px] ${th.textFaint}`}>mid</p>
                      </div>
                      <div>
                        <p className={`text-[10px] ${s.delta != null ? 'text-amber-400' : th.textFaint}`}>{s.delta != null ? Math.abs(s.delta).toFixed(2) : '—'}</p>
                        <p className={`text-[9px] ${th.textFaint}`}>delta</p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {step === 'confirm' && selected && (
          <div className="space-y-4">
            <div className={`${th.card} border ${th.border} rounded-xl p-3 space-y-1.5`}>
              <div className="flex justify-between">
                <span className={`text-[10px] ${th.textFaint}`}>Selling</span>
                <span className={`text-[10px] font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{leapPos.symbol} {selected.strike}C {fmtDate(selected.expiration)}</span>
              </div>
              <div className="flex justify-between">
                <span className={`text-[10px] ${th.textFaint}`}>DTE</span>
                <span className={`text-[10px] ${th.text}`}>{selected.dte}d</span>
              </div>
              <div className="flex justify-between">
                <span className={`text-[10px] ${th.textFaint}`}>Delta</span>
                <span className={`text-[10px] text-amber-400`}>{selected.delta != null ? Math.abs(selected.delta).toFixed(2) : '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className={`text-[10px] ${th.textFaint}`}>LEAP long strike</span>
                <span className={`text-[10px] ${th.text}`}>{leapPos.strike} — short call is {(selected.strike - leapPos.strike).toFixed(0)} pts above</span>
              </div>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className={`text-[10px] ${th.textFaint} shrink-0`}>Contracts</span>
              <div className="flex items-center gap-2">
                <button onClick={() => setContracts(Math.max(1, contracts - 1))}
                  className={`w-6 h-6 rounded border ${th.border} ${th.textMuted} hover:text-white flex items-center justify-center`}>−</button>
                <span className={`text-sm font-bold ${th.text} w-6 text-center`}>{contracts}</span>
                <button onClick={() => setContracts(Math.min(leapPos.contracts, contracts + 1))}
                  className={`w-6 h-6 rounded border ${th.border} ${th.textMuted} hover:text-white flex items-center justify-center`}>+</button>
              </div>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className={`text-[10px] ${th.textFaint} shrink-0`}>Credit limit</span>
              <div className="flex items-center gap-1">
                <span className={`text-[10px] ${th.textFaint}`}>$</span>
                <input type="number" step="0.05" min="0.01" value={limitPrice}
                  onChange={e => setLimitPrice(parseFloat(e.target.value) || 0)}
                  className={`w-20 text-right text-sm font-bold ${th.text} ${th.input} border ${th.inputBorder} rounded px-2 py-1 focus:outline-none focus:border-[var(--accent)]`} />
              </div>
            </div>
            <div className={`${th.sidebar} rounded-xl p-3 space-y-1 border ${th.border}`}>
              <div className="flex justify-between">
                <span className={`text-[9px] ${th.textFaint}`}>Credit collected</span>
                <span className="text-[9px] text-emerald-400 font-bold">${(limitPrice * contracts * 100).toFixed(0)}</span>
              </div>
              <div className="flex justify-between">
                <span className={`text-[9px] ${th.textFaint}`}>GTC at 50%</span>
                <span className={`text-[9px] ${th.text}`}>${(limitPrice * 0.5).toFixed(2)} debit</span>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setStep('chain')} className={`flex-1 py-2 border ${th.border} rounded-xl text-[10px] ${th.textMuted} hover:text-white`}>← Back</button>
              <button onClick={placeOrder} className="flex-1 py-2.5 bg-[var(--accent)] hover:opacity-90 text-white text-sm font-bold rounded-xl">
                Sell {contracts} Call{contracts > 1 ? 's' : ''}
              </button>
            </div>
          </div>
        )}

        {step === 'placing' && (
          <div className="flex items-center justify-center py-8 gap-3">
            <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
            <p className={`text-[11px] ${th.textFaint}`}>Placing OTOCO order...</p>
          </div>
        )}

        {step === 'done' && (
          <div className="text-center py-6 space-y-2">
            <p className="text-2xl">✓</p>
            <p className="text-emerald-400 font-bold text-sm">Short call submitted</p>
            <p className={`text-[10px] ${th.textFaint}`}>OTOCO ID: {orderId}</p>
            <p className={`text-[10px] ${th.textFaint}`}>50% GTC bracket placed automatically.</p>
            <button onClick={onClose} className="mt-3 text-xs px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg">Done</button>
          </div>
        )}

        {step === 'error' && (
          <div className="space-y-3">
            <p className="text-red-400 text-sm">{error}</p>
            <button onClick={() => setStep('confirm')} className={`text-xs px-3 py-1.5 border ${th.border} rounded-lg ${th.textMuted}`}>Back</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Position Card ──────────────────────────────────────────────────────────
function LeapCard({
  pos, th, onSellCall, onClose, onRefresh,
}: {
  pos: LeapPosition;
  th: typeof THEMES[Theme];
  onSellCall: () => void;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const alerts = getAlerts(pos);
  const combPnl = combinedPnl(pos);
  const combPct = combinedPct(pos);
  const netBasis = netCostBasisPerShare(pos);
  const scPnl = shortCallTotalPnl(pos);
  const openShortCalls = pos.shortCalls.filter(sc => sc.status !== 'closed');
  const costReduction = pos.shortCalls.reduce((s, sc) => s + sc.creditReceived * sc.contracts * 100, 0);

  const pnlColor = combPct != null
    ? combPct >= 20 ? 'text-emerald-400'
    : combPct >= 0 ? 'text-emerald-400/70'
    : combPct >= -20 ? 'text-amber-400'
    : 'text-red-400'
    : 'text-slate-400';

  return (
    <div className={`border ${th.border} rounded-xl overflow-hidden`}>
      {/* Alerts strip */}
      {alerts.length > 0 && (
        <div className={`px-4 py-1.5 flex items-center gap-2 flex-wrap ${
          alerts.some(a => a.level === 'red') ? 'bg-red-500/10 border-b border-red-600/30' :
          alerts.some(a => a.level === 'amber') ? 'bg-amber-500/10 border-b border-amber-600/30' :
          'bg-emerald-500/10 border-b border-emerald-600/30'
        }`}>
          {alerts.map((a, i) => (
            <span key={i} className={`text-[9px] font-medium ${a.level === 'red' ? 'text-red-400' : a.level === 'amber' ? 'text-amber-400' : 'text-emerald-400'}`}>
              {a.level === 'red' ? '⚠' : a.level === 'amber' ? '◉' : '✓'} {a.message}
            </span>
          ))}
        </div>
      )}

      {/* Main row */}
      <div className={`flex items-center gap-4 px-4 py-3 ${th.card}`}>
        {/* Symbol + details */}
        <div className="w-44 shrink-0">
          <div className="flex items-center gap-2">
            <p className={`text-sm font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>
              {pos.symbol} {pos.strike}{pos.optionType}
            </p>
            <span className={`text-[8px] px-1.5 py-0.5 rounded border font-bold ${pos.optionType === 'C' ? 'text-emerald-400 border-emerald-700 bg-emerald-500/10' : 'text-red-400 border-red-700 bg-red-500/10'}`}>
              {pos.optionType === 'C' ? 'CALL' : 'PUT'}
            </span>
          </div>
          <p className={`text-[9px] ${th.textFaint}`}>{fmtDate(pos.expiration)} · {pos.dte ?? daysUntil(pos.expiration)}d</p>
          <p className={`text-[9px] ${th.textFaint}`}>{pos.contracts} contract{pos.contracts > 1 ? 's' : ''} · paid ${pos.debitPaid.toFixed(2)}/sh</p>
        </div>

        {/* Greeks */}
        <div className="flex items-center gap-5 flex-1">
          <div className="text-center">
            <p className={`text-xs font-bold ${pos.currentDelta != null && pos.currentDelta >= 0.65 ? 'text-emerald-400' : 'text-amber-400'}`}>
              {pos.currentDelta != null ? pos.currentDelta.toFixed(2) : '—'}
            </p>
            <p className={`text-[9px] ${th.textFaint}`}>delta</p>
          </div>
          <div className="text-center">
            <p className={`text-xs font-bold ${th.text}`}>${pos.currentMid?.toFixed(2) ?? '—'}</p>
            <p className={`text-[9px] ${th.textFaint}`}>current mid</p>
          </div>
          <div className="text-center">
            <p className={`text-xs font-bold ${th.text}`}>${netBasis.toFixed(2)}</p>
            <p className={`text-[9px] ${th.textFaint}`}>net basis/sh</p>
          </div>
          {openShortCalls.length > 0 && (
            <div className="text-center">
              <p className={`text-xs font-bold ${scPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {scPnl >= 0 ? '+' : ''}${scPnl.toFixed(0)}
              </p>
              <p className={`text-[9px] ${th.textFaint}`}>{openShortCalls.length} call{openShortCalls.length > 1 ? 's' : ''} P&L</p>
            </div>
          )}
        </div>

        {/* Combined P&L */}
        <div className="text-right shrink-0">
          <p className={`text-base font-bold ${pnlColor}`}>
            {combPnl != null ? `${combPnl >= 0 ? '+' : ''}$${combPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
          </p>
          <p className={`text-[9px] ${pnlColor}`}>
            {combPct != null ? `${combPct >= 0 ? '+' : ''}${combPct.toFixed(1)}% combined` : 'refresh for P&L'}
          </p>
          {costReduction > 0 && (
            <p className={`text-[9px] text-emerald-400/70`}>−${costReduction.toFixed(0)} basis via calls</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={onRefresh} title="Refresh live prices"
            className={`text-[9px] px-2 py-1.5 border ${th.border} rounded-lg ${th.textFaint} hover:text-white transition-colors`}>↺</button>
          <button onClick={onSellCall}
            className="text-[9px] px-2.5 py-1.5 bg-amber-600/80 hover:bg-amber-600 text-white rounded-lg font-bold transition-colors">
            + Call
          </button>
          <button onClick={() => setExpanded(!expanded)}
            className={`text-[9px] px-2.5 py-1.5 border ${th.border} rounded-lg ${th.textFaint} hover:text-white transition-colors`}>
            {expanded ? '▲' : '▼'}
          </button>
          <button onClick={onClose}
            className="text-[9px] px-2.5 py-1.5 bg-red-600/60 hover:bg-red-600 text-white rounded-lg font-bold transition-colors">
            Close
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className={`border-t ${th.border} px-4 py-3 space-y-3`}>
          {/* LEAP details */}
          <div className="grid grid-cols-4 gap-3">
            <div>
              <p className={`text-[9px] ${th.textFaint}`}>Entry date</p>
              <p className={`text-[10px] ${th.text}`}>{fmtDate(pos.entryDate)}</p>
            </div>
            <div>
              <p className={`text-[9px] ${th.textFaint}`}>IV</p>
              <p className={`text-[10px] ${th.text}`}>{pos.currentIv != null ? `${pos.currentIv.toFixed(0)}%` : '—'}</p>
            </div>
            <div>
              <p className={`text-[9px] ${th.textFaint}`}>LEAP cost basis</p>
              <p className={`text-[10px] ${th.text}`}>${(pos.debitPaid * pos.contracts * 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
            </div>
            <div>
              <p className={`text-[9px] ${th.textFaint}`}>Net cost basis</p>
              <p className={`text-[10px] text-emerald-400`}>${netCostBasis(pos).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
            </div>
          </div>
          {pos.notes && (
            <p className={`text-[10px] ${th.textFaint} italic`}>"{pos.notes}"</p>
          )}

          {/* Short calls */}
          {pos.shortCalls.length > 0 && (
            <div>
              <p className={`text-[9px] ${th.textFaint} tracking-widest uppercase font-bold mb-2`}>PMCC Short Calls</p>
              <div className="space-y-1">
                {pos.shortCalls.map((sc, i) => (
                  <div key={sc.id} className={`flex items-center gap-4 px-3 py-2 rounded-lg border ${th.border} text-[10px]`}>
                    <span className={`font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{sc.strike}C</span>
                    <span className={th.textFaint}>{fmtDate(sc.expiration)} · {sc.dte ?? daysUntil(sc.expiration)}d</span>
                    <span className={th.textFaint}>{sc.contracts}× · collected ${sc.creditReceived.toFixed(2)}/sh</span>
                    <span className={`ml-auto font-bold ${sc.pnl != null && sc.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {sc.status === 'closed' ? `Closed $${sc.closedPnl?.toFixed(0) ?? '—'}` : sc.pnl != null ? `${sc.pnl >= 0 ? '+' : ''}$${sc.pnl.toFixed(0)}` : '—'}
                    </span>
                    <span className={`text-[8px] px-1.5 py-0.5 border rounded font-bold ${sc.status === 'closed' ? `${th.textFaint} ${th.border}` : 'text-emerald-400 border-emerald-700 bg-emerald-500/10'}`}>
                      {sc.status === 'closed' ? 'CLOSED' : 'OPEN'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {pos.shortCalls.length === 0 && (
            <p className={`text-[9px] ${th.textFaint} italic`}>No short calls sold yet. Use "+ Call" to start reducing cost basis via PMCC.</p>
          )}
          {pos.lastRefreshed && (
            <p className={`text-[9px] ${th.textFaint}`}>Last refreshed: {pos.lastRefreshed}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Close Confirmation Modal ───────────────────────────────────────────────
function CloseLeapModal({ pos, th, onClose, onConfirm }: { pos: LeapPosition; th: typeof THEMES[Theme]; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[70] p-4" onClick={onClose}>
      <div className={`${th.sidebar} border ${th.border} rounded-2xl p-6 w-full max-w-sm`} onClick={e => e.stopPropagation()}>
        <h2 className={`text-sm font-bold ${th.text} mb-3`}>Remove from Long Book?</h2>
        <p className={`text-[11px] ${th.textMuted} mb-1`}>{pos.symbol} {pos.strike}{pos.optionType} {fmtDate(pos.expiration)}</p>
        <p className={`text-[10px] ${th.textFaint} mb-5`}>This removes the position from tracking only. Close the actual position in TastyTrade separately.</p>
        <div className="flex gap-2">
          <button onClick={onClose} className={`flex-1 py-2 border ${th.border} rounded-xl text-[10px] ${th.textMuted} hover:text-white`}>Cancel</button>
          <button onClick={onConfirm} className="flex-1 py-2 bg-red-600 hover:bg-red-500 text-white text-[10px] font-bold rounded-xl">Remove</button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────
export default function LongBookPage() {
  const [theme, setTheme] = useState<Theme>(getSavedTheme);
  const [accent, setAccent] = useState<Accent>(getSavedAccent);
  const th = THEMES[theme];
  useEffect(() => { applyAccent(accent); injectAccentStyle(); }, [accent]);
  useEffect(() => { applyAccent(getSavedAccent()); }, []);

  const [positions, setPositions] = useState<LeapPosition[]>(() => {
    try { const s = localStorage.getItem(LS_LB_POSITIONS); return s ? JSON.parse(s) : []; } catch { return []; }
  });

  const [watchlist, setWatchlist] = useState<string[]>(() => {
    try { const s = localStorage.getItem(LS_LB_WATCHLIST); return s ? JSON.parse(s) : DEFAULT_LB_WATCHLIST; } catch { return DEFAULT_LB_WATCHLIST; }
  });
  const [watchlistInput, setWatchlistInput] = useState(watchlist.join(', '));

  // Scan state
  const [scanResults, setScanResults] = useState<LeapScanResult[]>([]);
  const [scanStatus, setScanStatus] = useState<'idle' | 'scanning' | 'done' | 'error'>('idle');
  const [scanError, setScanError] = useState('');
  const [scanProgress, setScanProgress] = useState('');
  const [showScan, setShowScan] = useState(false);

  // Pre-fill chain picker from scan result
  const [chainPreFill, setChainPreFill] = useState<{ symbol: string; direction: 'C' | 'P' } | null>(null);

  const [alloc, setAlloc] = useState<Allocation5>(() => {
    try { const s = localStorage.getItem(LS_LB_ALLOC); return s ? { ...DEFAULT_ALLOC, ...JSON.parse(s) } : { ...DEFAULT_ALLOC }; } catch { return { ...DEFAULT_ALLOC }; }
  });
  const [editingAlloc, setEditingAllocState] = useState({ ...alloc });
  const [showSettings, setShowSettings] = useState(false);
  const [showNewLeap, setShowNewLeap] = useState(false);
  const [sellCallFor, setSellCallFor] = useState<LeapPosition | null>(null);
  const [closingPos, setClosingPos] = useState<LeapPosition | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [netLiq, setNetLiq] = useState<number | null>(null);

  // Persist positions
  const savePositions = (p: LeapPosition[]) => {
    setPositions(p);
    try { localStorage.setItem(LS_LB_POSITIONS, JSON.stringify(p)); } catch {}
  };

  const saveAlloc = (a: Allocation5) => {
    const total = a.reserve + a.wheel + a.spx + a.hunter + a.longBook;
    const normalized: Allocation5 = {
      reserve:  Math.round((a.reserve  / total) * 100),
      wheel:    Math.round((a.wheel    / total) * 100),
      spx:      Math.round((a.spx      / total) * 100),
      hunter:   Math.round((a.hunter   / total) * 100),
      longBook: 100 - Math.round((a.reserve / total) * 100) - Math.round((a.wheel / total) * 100) - Math.round((a.spx / total) * 100) - Math.round((a.hunter / total) * 100),
    };
    setAlloc(normalized);
    try { localStorage.setItem(LS_LB_ALLOC, JSON.stringify(normalized)); } catch {}
  };

  const saveWatchlist = (input: string) => {
    const list = input.toUpperCase().split(/[,\s]+/).map(s => s.trim()).filter(s => /^[A-Z]{1,5}$/.test(s));
    setWatchlist(list);
    try { localStorage.setItem(LS_LB_WATCHLIST, JSON.stringify(list)); } catch {}
    return list;
  };

  const runScan = useCallback(async () => {
    setScanStatus('scanning');
    setScanError('');
    setScanResults([]);
    setShowScan(true);
    try {
      const token = await getAccessToken();

      // Step 1: fetch price + IVR snapshots for all watchlist tickers
      setScanProgress(`Fetching market data for ${watchlist.length} tickers...`);
      const snapshots: Record<string, { price: number; ivr: number | null; change1d: number | null }> = {};
      await Promise.all(watchlist.map(async sym => {
        snapshots[sym] = await fetchTickerSnapshot(sym, token);
      }));

      // Step 2: find best LEAP strike for each ticker (sequential to avoid rate limits)
      const strikes: Record<string, { strike: number; expiration: string; dte: number; delta: number | null; mid: number; occSymbol: string } | null> = {};
      for (let i = 0; i < watchlist.length; i++) {
        const sym = watchlist[i];
        setScanProgress(`Scanning LEAP chain ${i + 1}/${watchlist.length}: ${sym}...`);
        // Default to calls; AI will override to PUT if bearish thesis
        strikes[sym] = await findBestLeapStrike(sym, 'C', snapshots[sym]?.price ?? 0, token);
      }

      // Step 3: AI analysis and ranking
      setScanProgress('Running AI analysis and ranking...');
      const results = await runLeapAiScan(watchlist, snapshots, strikes);

      // Step 4: for any AI-flagged PUT direction, fetch the put chain
      const putSymbols = results.filter(r => r.direction === 'P' && r.recommendedStrike === 0);
      for (const r of putSymbols) {
        setScanProgress(`Fetching put chain for ${r.symbol}...`);
        const putStrike = await findBestLeapStrike(r.symbol, 'P', snapshots[r.symbol]?.price ?? 0, token);
        if (putStrike) {
          r.recommendedStrike = putStrike.strike;
          r.recommendedExpiration = putStrike.expiration;
          r.recommendedDte = putStrike.dte;
          r.recommendedDelta = putStrike.delta;
          r.estimatedMid = putStrike.mid;
          r.estimatedCost = Math.round(putStrike.mid * 100);
          r.occSymbol = putStrike.occSymbol;
          r.expiration = putStrike.expiration;
        }
      }

      setScanResults(results);
      setScanStatus('done');
      setScanProgress('');
    } catch (e: any) {
      setScanError(e.message ?? 'Scan failed');
      setScanStatus('error');
      setScanProgress('');
    }
  }, [watchlist]);

  // Fetch net liq on mount
  useEffect(() => {
    (async () => {
      try {
        const token = await getAccessToken();
        const accountsData = await ttFetch('/customers/me/accounts', token);
        const account = accountsData?.data?.items?.find((a: any) => a.account['account-number'] === '5WI51392') ?? accountsData?.data?.items?.[0];
        const accountNumber = account?.account?.['account-number'];
        if (!accountNumber) return;
        const balData = await ttFetch(`/accounts/${accountNumber}/balances`, token);
        const nlv = parseFloat(balData?.data?.['net-liquidating-value'] ?? balData?.data?.['net-liq'] ?? '0');
        if (nlv > 0) setNetLiq(nlv);
      } catch {}
    })();
  }, []);

  // Refresh all positions
  const refreshAll = useCallback(async () => {
    if (positions.length === 0) return;
    setRefreshing(true);
    try {
      const token = await getAccessToken();
      const updated = await Promise.all(
        positions.map(async pos => {
          const updates = await refreshPositionLive(pos, token);
          return { ...pos, ...updates };
        })
      );
      savePositions(updated);
    } catch {}
    finally { setRefreshing(false); }
  }, [positions]);

  const refreshOne = async (posId: string) => {
    try {
      const token = await getAccessToken();
      const pos = positions.find(p => p.id === posId);
      if (!pos) return;
      const updates = await refreshPositionLive(pos, token);
      savePositions(positions.map(p => p.id === posId ? { ...p, ...updates } : p));
    } catch {}
  };

  const handleSaved = (pos: LeapPosition) => {
    savePositions([...positions, pos]);
    setShowNewLeap(false);
  };

  const handleShortCallSaved = (leapId: string, sc: PmccShortCall) => {
    savePositions(positions.map(p => p.id === leapId ? { ...p, shortCalls: [...p.shortCalls, sc] } : p));
    setSellCallFor(null);
  };

  const handleRemove = (posId: string) => {
    savePositions(positions.filter(p => p.id !== posId));
    setClosingPos(null);
  };

  // Summary stats
  const totalCost = positions.reduce((s, p) => s + p.debitPaid * p.contracts * 100, 0);
  const totalCombinedPnl = positions.reduce((s, p) => s + (combinedPnl(p) ?? 0), 0);
  const totalCombinedPct = totalCost > 0 ? (totalCombinedPnl / totalCost) * 100 : 0;
  const allocTarget = netLiq ? netLiq * (alloc.longBook / 100) : null;
  const allocPct = allocTarget && allocTarget > 0 ? Math.round((totalCost / allocTarget) * 100) : null;
  const allocTotal = editingAlloc.reserve + editingAlloc.wheel + editingAlloc.spx + editingAlloc.hunter + editingAlloc.longBook;

  const bucketColors: Record<keyof Allocation5, string> = {
    reserve: 'text-slate-400', wheel: 'text-blue-400', spx: 'text-violet-400', hunter: 'text-amber-400', longBook: 'text-emerald-400',
  };

  return (
    <div className={`min-h-screen ${th.bg} transition-colors duration-200`} style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      {/* Modals */}
      {(showNewLeap || chainPreFill) && (
        <NewLeapModal
          th={th}
          preFill={chainPreFill ?? undefined}
          onClose={() => { setShowNewLeap(false); setChainPreFill(null); }}
          onSaved={handleSaved}
        />
      )}
      {sellCallFor && (
        <SellShortCallModal leapPos={sellCallFor} th={th}
          onClose={() => setSellCallFor(null)}
          onSaved={sc => handleShortCallSaved(sellCallFor.id, sc)} />
      )}
      {closingPos && (
        <CloseLeapModal pos={closingPos} th={th}
          onClose={() => setClosingPos(null)}
          onConfirm={() => handleRemove(closingPos.id)} />
      )}

      {/* ── Header ── */}
      <div className={`${th.header} border-b ${th.border} px-6 py-4 flex items-center justify-between sticky top-0 z-50`}>
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-base font-bold tracking-widest text-white" style={{ fontFamily: "'DM Mono', monospace" }}>OPTIONS HUNTER</h1>
            <p className="text-[10px] text-white/50 mt-0.5 tracking-wider" style={{ fontFamily: "'DM Mono', monospace" }}>LONG BOOK</p>
          </div>
          <nav className="flex items-center gap-1 bg-black/20 rounded-lg p-1">
            <a href="/" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">HUNTER</a>
            <a href="/portfolio" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">PORTFOLIO</a>
            <a href="/engine" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">INCOME ENGINE</a>
            <a href="/rinse-repeat" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">RINSE & REPEAT</a>
            <a href="/trade-log" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">TRADE LOG</a>
            <a href="/performance" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">PERFORMANCE</a>
            <span className="text-xs px-3 py-1.5 rounded text-white tracking-wider"
              style={{ backgroundColor: `rgba(var(--accent-r),var(--accent-g),var(--accent-b),0.25)`, borderBottom: `2px solid var(--accent)` }}>
              LONG BOOK
            </span>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={refreshAll} disabled={refreshing || positions.length === 0}
            className={`text-[10px] px-3 py-1.5 border ${th.border} rounded-lg ${th.textMuted} hover:border-emerald-500 hover:text-emerald-400 transition-colors disabled:opacity-40`}>
            {refreshing ? '⟳ Refreshing...' : '↺ Refresh P&L'}
          </button>
          <button onClick={runScan} disabled={scanStatus === 'scanning'}
            className={`text-[10px] px-3 py-1.5 border rounded-lg font-bold transition-colors disabled:opacity-40 ${scanStatus === 'scanning' ? `${th.border} ${th.textFaint}` : 'border-violet-600/60 text-violet-400 hover:border-violet-500 hover:bg-violet-500/10'}`}>
            {scanStatus === 'scanning' ? '⟳ Scanning...' : '◈ Scan for LEAPs'}
          </button>
          <button onClick={() => setShowNewLeap(true)}
            className="text-[10px] px-3 py-1.5 bg-[var(--accent)] hover:opacity-90 text-white rounded-lg font-bold transition-opacity">
            + New LEAP
          </button>
          <button onClick={() => setShowSettings(!showSettings)}
            className={`text-[10px] px-3 py-1.5 border ${th.border} rounded-lg ${th.textMuted} hover:border-blue-500 hover:text-blue-400 transition-colors`}>
            ⚙ Allocation
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

      {/* ── Allocation Settings Panel ── */}
      {showSettings && (
        <div className={`${th.sidebar} border-b ${th.border} px-6 py-4`}>
          <div className="max-w-3xl">
            <p className={`text-[9px] ${th.textFaint} tracking-widest uppercase font-bold mb-3`}>Capital Allocation — All 5 Buckets</p>
            <p className={`text-[10px] ${th.textFaint} mb-4`}>Changes here sync with the Income Engine. All buckets must sum to 100%.</p>
            <div className="space-y-3 mb-4">
              {(Object.keys(DEFAULT_ALLOC) as (keyof Allocation5)[]).map(key => {
                const labels: Record<keyof Allocation5, string> = { reserve: 'Reserve', wheel: 'Wheel (CSP/CC)', spx: 'SPX Engine', hunter: 'Hunter Spreads', longBook: 'Long Book (LEAPs)' };
                return (
                  <div key={key} className="flex items-center gap-3">
                    <span className={`text-[10px] w-36 shrink-0 ${bucketColors[key]} font-medium`}>{labels[key]}</span>
                    <input type="range" min={2} max={70} step={1} value={editingAlloc[key]}
                      onChange={e => setEditingAllocState(prev => ({ ...prev, [key]: parseInt(e.target.value) }))}
                      className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer accent-blue-500" />
                    <span className={`text-[10px] font-bold ${th.text} w-28 text-right`}>
                      {editingAlloc[key]}%
                      {netLiq && <span className={`${th.textFaint} font-normal`}> · ${Math.round(netLiq * editingAlloc[key] / 100).toLocaleString()}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className={`flex items-center gap-4`}>
              <span className={`text-[10px] font-bold ${allocTotal === 100 ? 'text-emerald-400' : 'text-amber-400'}`}>
                Total: {allocTotal}% {allocTotal !== 100 && '— will normalize to 100% on save'}
              </span>
              <button onClick={() => { saveAlloc(editingAlloc); setShowSettings(false); }}
                className="text-[10px] px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors">
                Save Allocation
              </button>
              <button onClick={() => setShowSettings(false)}
                className={`text-[10px] px-3 py-1.5 border ${th.border} rounded-lg ${th.textMuted}`}>
                Cancel
              </button>
            </div>
            <div className="mt-6 border-t border-white/10 pt-4">
              <p className={`text-[9px] ${th.textFaint} tracking-widest uppercase font-bold mb-2`}>Long Book Watchlist — AI Scan Tickers</p>
              <p className={`text-[10px] ${th.textFaint} mb-2`}>Separate from wheel watchlist. These tickers are evaluated for LEAP opportunities.</p>
              <textarea value={watchlistInput} onChange={e => setWatchlistInput(e.target.value)}
                className={`w-full max-w-lg ${th.input} border ${th.inputBorder} rounded-lg p-2 text-xs ${th.text} h-16 resize-none focus:outline-none focus:border-[var(--accent)]`}
                placeholder="NVDA, AMD, MU, META, GOOGL..." />
              <button onClick={() => { saveWatchlist(watchlistInput); setShowSettings(false); }}
                className="mt-2 text-[10px] px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors">
                Save Watchlist
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Capital Summary Strip ── */}
      <div className={`${th.sidebar} border-b ${th.border} px-6 py-3`}>
        <div className="flex items-center gap-8">
          <div className="shrink-0">
            <p className={`text-[9px] ${th.textFaint} tracking-widest uppercase`}>Long Book Allocation</p>
            <p className={`text-xl font-bold text-emerald-400`} style={{ fontFamily: "'DM Mono', monospace" }}>
              {alloc.longBook}%{netLiq ? ` · $${Math.round(netLiq * alloc.longBook / 100).toLocaleString()}` : ''}
            </p>
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between mb-1">
              <span className={`text-[9px] ${th.textFaint}`}>Deployed vs target</span>
              <span className={`text-[9px] ${th.textFaint}`}>${totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 })} of ${allocTarget ? allocTarget.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</span>
            </div>
            <div className="h-1.5 rounded-full bg-slate-700/60 overflow-hidden">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.min(100, allocPct ?? 0)}%` }} />
            </div>
            {allocPct != null && <p className={`text-[9px] mt-1 ${allocPct > 100 ? 'text-amber-400' : th.textFaint}`}>{allocPct}% deployed{allocPct > 100 ? ' — over allocation target' : ''}</p>}
          </div>
          <div className="shrink-0 text-right">
            <p className={`text-[9px] ${th.textFaint}`}>Total positions</p>
            <p className={`text-lg font-bold ${th.text}`}>{positions.length}</p>
          </div>
          {positions.length > 0 && (
            <div className="shrink-0 text-right">
              <p className={`text-[9px] ${th.textFaint}`}>Combined P&L</p>
              <p className={`text-lg font-bold ${totalCombinedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {totalCombinedPnl >= 0 ? '+' : ''}${totalCombinedPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </p>
              <p className={`text-[9px] ${totalCombinedPnl >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
                {totalCombinedPct >= 0 ? '+' : ''}{totalCombinedPct.toFixed(1)}% on cost
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="p-5 max-w-5xl space-y-3">

        {/* ── AI Scan Panel ── */}
        {showScan && (
          <div className={`border ${th.border} rounded-xl overflow-hidden`}>
            <div className={`px-4 py-3 border-b ${th.border} flex items-center justify-between ${th.card}`}>
              <div className="flex items-center gap-3">
                <span className="text-violet-400 font-bold text-xs tracking-widest">◈ AI LEAP SCAN</span>
                <span className={`text-[9px] ${th.textFaint}`}>{watchlist.join(', ')}</span>
                {scanStatus === 'done' && <span className="text-[9px] text-emerald-400">{scanResults.length} tickers ranked</span>}
              </div>
              <button onClick={() => setShowScan(false)} className={`text-[9px] ${th.textFaint} hover:text-white`}>✕ Hide</button>
            </div>

            {/* Scanning progress */}
            {scanStatus === 'scanning' && (
              <div className={`px-4 py-6 flex items-center gap-3 ${th.card}`}>
                <div className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin shrink-0" />
                <p className={`text-[10px] ${th.textFaint}`}>{scanProgress || 'Initializing scan...'}</p>
              </div>
            )}

            {/* Error */}
            {scanStatus === 'error' && (
              <div className="px-4 py-4">
                <p className="text-red-400 text-sm mb-2">{scanError}</p>
                <button onClick={runScan} className="text-[10px] px-3 py-1.5 bg-blue-600 text-white rounded-lg">Retry</button>
              </div>
            )}

            {/* Results */}
            {scanStatus === 'done' && scanResults.length > 0 && (
              <div className="divide-y divide-white/5">
                {/* Legend */}
                <div className={`px-4 py-2 flex items-center gap-6 ${th.sidebar}`}>
                  <span className={`text-[9px] ${th.textFaint}`}>Score = AI conviction 0–100 · IV level = cost to buy premium · ★ recommended delta 0.70–0.80</span>
                  <span className={`text-[9px] text-emerald-400 ml-auto`}>LOW IV = best time to buy LEAPs</span>
                </div>
                {scanResults.map(r => (
                  <ScanResultCard key={r.symbol} result={r} th={th}
                    onOpenChain={(sym, dir) => {
                      setChainPreFill({ symbol: sym, direction: dir });
                    }} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Empty state */}
        {positions.length === 0 && (
          <div className={`border ${th.border} rounded-xl px-6 py-16 text-center ${th.card}`}>
            <p className="text-4xl mb-4">◎</p>
            <p className={`text-sm font-bold ${th.text} mb-2`}>Long Book is empty</p>
            <p className={`text-[11px] ${th.textFaint} mb-6 max-w-md mx-auto leading-relaxed`}>
              Add a LEAP position to start tracking directional long-term trades. LEAPs are separate from your premium-selling engine — they're thesis-driven, not rules-driven.
            </p>
            <div className={`${th.sidebar} border ${th.border} rounded-xl p-4 max-w-sm mx-auto mb-6 text-left space-y-2`}>
              <p className={`text-[9px] text-[var(--accent)] font-bold tracking-widest`}>RECOMMENDED STARTING POINT</p>
              <p className={`text-[10px] ${th.textMuted}`}>NVDA Jan 2028 Call · 0.70–0.75 delta · ~$190–200 strike</p>
              <p className={`text-[10px] ${th.textFaint}`}>AI infrastructure cycle, Vera Rubin product gap, Jensen "demand parabolic" Q1 2027 print.</p>
            </div>
            <button onClick={() => setShowNewLeap(true)}
              className="px-6 py-2.5 bg-[var(--accent)] hover:opacity-90 text-white text-sm font-bold rounded-xl transition-opacity">
              + Add First LEAP
            </button>
          </div>
        )}

        {/* Position cards */}
        {positions.map(pos => (
          <LeapCard
            key={pos.id}
            pos={pos}
            th={th}
            onSellCall={() => setSellCallFor(pos)}
            onClose={() => setClosingPos(pos)}
            onRefresh={() => refreshOne(pos.id)}
          />
        ))}

        {/* Info footer */}
        {positions.length > 0 && (
          <div className={`border ${th.border} rounded-xl px-4 py-3 ${th.card}`}>
            <p className={`text-[9px] ${th.textFaint} font-bold tracking-widest mb-2`}>MANAGEMENT RULES — LONG BOOK</p>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1">
              {[
                ['◉ < 180 DTE', 'Evaluate roll or hold — don\'t let time decay accelerate without a plan'],
                ['✓ +50% gain', 'Consider partial profit or trailing stop on remaining contracts'],
                ['⚠ −40% loss', 'Thesis check required — cut if thesis is broken, hold if intact'],
                ['◉ Short call 21 DTE', 'Close or roll the PMCC short call — gamma risk rising'],
                ['No GTC at entry', 'Exit is thesis-based, not percentage-based'],
                ['PMCC rule', 'Short call strike must always be above LEAP long strike'],
              ].map(([rule, detail]) => (
                <div key={rule} className="flex items-start gap-2">
                  <span className={`text-[9px] ${th.textFaint} shrink-0 w-28`}>{rule}</span>
                  <span className={`text-[9px] ${th.textFaint} opacity-60`}>{detail}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
