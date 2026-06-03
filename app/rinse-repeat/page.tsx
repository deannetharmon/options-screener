// path: app/rinse-repeat/page.tsx

'use client';
import { THEMES, ACCENTS, Theme, Accent, LS_THEME, LS_ACCENT, getSavedTheme, getSavedAccent, applyAccent, injectAccentStyle } from '@/lib/theme';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';

if (typeof document !== 'undefined') {
  if (!document.getElementById('hunter-font')) {
    const link = document.createElement('link');
    link.id = 'hunter-font';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=DM+Mono:wght@400;500&display=swap';
    document.head.appendChild(link);
  }
}

// ── Constants ─────────────────────────────────────────────────────────────
const BASE       = 'https://api.tastytrade.com';
const CLIENT_ID  = '4d4c851b-bdaf-4ac9-b39b-811e604739f2';
const LS_TL_3M   = 'hunter-tradelog-3m';
const LS_TL_6M   = 'hunter-tradelog-6m';
const LS_TL_12M  = 'hunter-tradelog-12m';
const INDEX_TICKERS = new Set(['SPY','QQQ','IWM','DIA','GLD','SLV','TLT','HYG','LQD','XLF','XLK','XLE','XLV','XLI','XLP','XLU','XLB','XLRE','XLC','XLY','EEM','EFA','VXX','UVXY','ARKK','SMH','SOXX','XBI','IBB','GDX']);


// ── Types ─────────────────────────────────────────────────────────────────
type TimeRange = '1w' | '2w' | '1m' | '3m' | '6m' | '12m';

interface ClosedTrade {
  id: string; symbol: string; strategy: string; openDate: string; closeDate: string;
  expiry: string; holdDays: number; strikes: string; creditReceived: number;
  closePrice: number; pnl: number; pnlPct: number; outcome: string; quantity: number;
  dteAtClose: number; dteAtEntry: number;
}

interface WinningProfile {
  symbol: string;
  winCount: number;
  totalTrades: number;
  winRate: number;           // 0-1
  avgPnlPct: number;
  avgDteAtEntry: number;
  preferredStrategy: 'BPS' | 'BCS' | 'IC';
  avgSpreadWidth: number;
  avgCreditRatio: number;
  lastWinDate: string;
  trades: ClosedTrade[];     // all trades on this symbol
}

interface ExistingPosition {
  symbol: string; strategy: string; expDate: string; strikes: string; qty: number;
}

interface SpreadCandidate {
  strategy: string; expiration: string; dte: number;
  shortStrike: number; longStrike: number; shortDelta: number;
  credit: number; spreadWidth: number; creditRatio: number;
  roc: number; pop: number | null; shortOI: number; longOI: number;
  shortCallStrike?: number; longCallStrike?: number;
  callCredit?: number; callWidth?: number; totalCredit?: number;
  shortOccSymbol?: string; longOccSymbol?: string;
  shortCallOccSymbol?: string; longCallOccSymbol?: string;
}

// ── Sector map ────────────────────────────────────────────────────────────
const SECTOR_MAP: Record<string, string> = {
  // Technology
  AAPL:'Technology', MSFT:'Technology', NVDA:'Technology', AMD:'Technology', INTC:'Technology',
  GOOGL:'Technology', GOOG:'Technology', META:'Technology', TSLA:'Technology', AVGO:'Technology',
  QCOM:'Technology', TXN:'Technology', MU:'Technology', AMAT:'Technology', LRCX:'Technology',
  KLAC:'Technology', MRVL:'Technology', ADBE:'Technology', CRM:'Technology', NOW:'Technology',
  ORCL:'Technology', IBM:'Technology', HPE:'Technology', DELL:'Technology', SNOW:'Technology',
  PLTR:'Technology', CRWD:'Technology', ZS:'Technology', PANW:'Technology', FTNT:'Technology',
  NET:'Technology', DDOG:'Technology', MDB:'Technology', TEAM:'Technology', SHOP:'Technology',
  // Financials
  JPM:'Financials', BAC:'Financials', GS:'Financials', MS:'Financials', WFC:'Financials',
  C:'Financials', BLK:'Financials', AXP:'Financials', V:'Financials', MA:'Financials',
  // Healthcare
  JNJ:'Healthcare', UNH:'Healthcare', PFE:'Healthcare', ABBV:'Healthcare', MRK:'Healthcare',
  LLY:'Healthcare', BMY:'Healthcare', AMGN:'Healthcare', GILD:'Healthcare', CVS:'Healthcare',
  // Consumer
  AMZN:'Consumer', WMT:'Consumer', HD:'Consumer', TGT:'Consumer', COST:'Consumer',
  NKE:'Consumer', MCD:'Consumer', SBUX:'Consumer', DIS:'Consumer', NFLX:'Consumer',
  // Energy
  XOM:'Energy', CVX:'Energy', COP:'Energy', OXY:'Energy', SLB:'Energy',
  // Industrials
  BA:'Industrials', CAT:'Industrials', GE:'Industrials', HON:'Industrials', UPS:'Industrials',
  // ETFs / Indexes (no sector concentration concern)
  SPY:'Index', QQQ:'Index', IWM:'Index', DIA:'Index', SMH:'Technology', SOXX:'Technology',
  XLF:'Financials', XLK:'Technology', XLE:'Energy', XLV:'Healthcare', XLI:'Industrials',
  XLP:'Consumer', XLY:'Consumer', GLD:'Commodity', SLV:'Commodity', TLT:'Bonds',
};

async function getSector(symbol: string): Promise<string> {
  if (SECTOR_MAP[symbol]) return SECTOR_MAP[symbol];
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`);
    const data = await res.json();
    const sector = data?.chart?.result?.[0]?.meta?.sector;
    return sector ?? 'Unknown';
  } catch { return 'Unknown'; }
}

// ── Portfolio risk types ───────────────────────────────────────────────────
type RiskLevel = 'clear' | 'same_symbol' | 'same_strikes' | 'synthetic_ic' | 'sector_concentration';

interface PortfolioRisk {
  level: RiskLevel;
  warnings: string[];           // specific factual flags
  recommendation: string;       // AI-style actionable guidance
  sectorName: string;
  sectorCount: number;          // how many open positions in same sector
}

function parseStrikesFromString(strikes: string): { puts: number[]; calls: number[] } {
  const puts: number[] = [], calls: number[] = [];
  const parts = strikes.replace(/·/g, '/').split('/');
  for (const p of parts) {
    const m = p.trim().match(/^(\d+(?:\.\d+)?)(P|C)$/i);
    if (!m) continue;
    const n = parseFloat(m[1]);
    if (m[2].toUpperCase() === 'P') puts.push(n);
    else calls.push(n);
  }
  return { puts, calls };
}

function checkPortfolioRisk(
  symbol: string,
  candidate: SpreadCandidate | null,
  existingPositions: ExistingPosition[],
  sectorName: string,
  allSectorCounts: Record<string, number>,
): PortfolioRisk {
  const warnings: string[] = [];
  let level: RiskLevel = 'clear';
  let recommendation = '';

  const sameSymbolPositions = existingPositions.filter(p => p.symbol === symbol);
  const sectorCount = allSectorCounts[sectorName] ?? 0;

  // ── Same strikes check ──────────────────────────────────────────────────
  if (candidate && sameSymbolPositions.length > 0) {
    for (const pos of sameSymbolPositions) {
      const existing = parseStrikesFromString(pos.strikes);
      const newPuts  = candidate.strategy === 'BPS' || candidate.strategy === 'IC'
        ? [candidate.shortStrike, candidate.longStrike] : [];
      const newCalls = candidate.strategy === 'BCS' || candidate.strategy === 'IC'
        ? [candidate.shortCallStrike ?? candidate.shortStrike, candidate.longCallStrike ?? candidate.longStrike] : [];

      const putOverlap  = newPuts.some(s  => existing.puts.some(e  => Math.abs(e - s)  < 1));
      const callOverlap = newCalls.some(s => existing.calls.some(e => Math.abs(e - s) < 1));
      const exactMatch  = putOverlap && (newCalls.length === 0 || callOverlap);

      if (exactMatch) {
        level = 'same_strikes';
        warnings.push(`Duplicate strikes: you already hold ${pos.strikes} on ${symbol} (exp ${pos.expDate})`);
        recommendation = `This is nearly identical to your existing ${pos.symbol} ${pos.strategy} position. Adding it doubles your notional risk on this ticker without diversification benefit. Only consider this if you intentionally want to scale up your position size — and only if your account can absorb a full loss on both spreads simultaneously.`;
        break;
      }
    }
  }

  // ── Same symbol, different strikes ─────────────────────────────────────
  if (level === 'clear' && sameSymbolPositions.length > 0 && candidate) {
    const existingStrategy = sameSymbolPositions[0].strategy;
    const newStrategy = candidate.strategy;

    // Check if adding this creates a synthetic IC
    const hasPuts  = sameSymbolPositions.some(p => p.strategy === 'BPS');
    const hasCalls = sameSymbolPositions.some(p => p.strategy === 'BCS');
    const addingCalls = newStrategy === 'BCS';
    const addingPuts  = newStrategy === 'BPS';

    if ((hasPuts && addingCalls) || (hasCalls && addingPuts)) {
      level = 'synthetic_ic';
      warnings.push(`Adding this ${newStrategy} would create a synthetic Iron Condor on ${symbol}`);
      recommendation = `You already have a ${existingStrategy} on ${symbol}. Adding this ${newStrategy} effectively builds an IC — which can be a valid strategy, but evaluate whether the combined structure has sufficient buffer on both sides and fits your current market view on ${symbol}. If you intended to enter an IC, it may be cleaner to close both and re-enter as a single IC order.`;
    } else {
      level = 'same_symbol';
      warnings.push(`You already have ${sameSymbolPositions.length} open position${sameSymbolPositions.length > 1 ? 's' : ''} on ${symbol}: ${sameSymbolPositions.map(p => p.strikes).join(', ')}`);
      const totalQty = sameSymbolPositions.reduce((s, p) => s + p.qty, 0);
      recommendation = `Adding this increases your ${symbol} exposure to ${totalQty + (candidate ? 1 : 0)} spread${totalQty > 0 ? 's' : ''}. This concentrates risk on a single name. Only add if your conviction on ${symbol} is high and the combined risk fits your position-sizing rules.`;
    }
  }

  // ── Sector concentration ────────────────────────────────────────────────
  const SECTOR_LIMIT = 3;
  if (sectorName !== 'Index' && sectorName !== 'Unknown' && sectorCount >= SECTOR_LIMIT) {
    const sectorWarning = `Sector concentration: you already have ${sectorCount} open position${sectorCount !== 1 ? 's' : ''} in ${sectorName}`;
    warnings.push(sectorWarning);
    if (level === 'clear') {
      level = 'sector_concentration';
      recommendation = `You have ${sectorCount} positions already in ${sectorName}. Adding another increases sector risk — a sector-wide event (regulatory, macro, earnings miss from a major player) could hit multiple positions simultaneously. Consider whether your portfolio has sufficient exposure to other sectors before adding this.`;
    } else {
      // Append sector note to existing recommendation
      recommendation += ` Additionally, you already have ${sectorCount} ${sectorName} positions open — sector concentration amplifies the risk here.`;
    }
  }

  if (level === 'clear') {
    recommendation = 'No portfolio conflicts detected. Evaluate on its own merits.';
  }

  return { level, warnings, recommendation, sectorName, sectorCount };
}

interface RRResult {
  profile: WinningProfile;
  candidate: SpreadCandidate | null;
  currentIvr: number | null;
  currentPrice: number | null;
  earningsDate: string | null;
  rrScore: number;            // composite score 0-100
  qualified: boolean;
  failReason: string;
}

const DEFAULT_RULES = {
  IVR_MIN: 30, IVR_IC_MAX: 70, OI_MIN: 500, BID_ASK_MAX: 0.10,
  CREDIT_RATIO_MIN: 0.33, SPREAD_DELTA_MIN: 0.20, SPREAD_DELTA_MAX: 0.30,
  IC_DELTA_MIN: 0.16, IC_DELTA_MAX: 0.20, DTE_MIN: 30, DTE_MAX: 45,
  MAX_SPREAD_WIDTH: 100, ROC_MIN_SPREAD: 20, ROC_MIN_IC: 30, POP_MIN: 65,
};
type RulesType = typeof DEFAULT_RULES;

// ── Auth ──────────────────────────────────────────────────────────────────
async function getAccessToken(): Promise<string> {
  const cached = sessionStorage.getItem('tt_access_token');
  if (cached) return cached;
  const refreshToken = localStorage.getItem('tt_refresh_token');
  const clientSecret = localStorage.getItem('tt_client_secret') ?? '';
  if (!refreshToken || !clientSecret) { window.location.href = '/login'; throw new Error('Not authenticated'); }
  const res = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID, client_secret: clientSecret }) });
  if (!res.ok) { sessionStorage.removeItem('tt_access_token'); localStorage.removeItem('tt_refresh_token'); window.location.href = '/login'; throw new Error('Session expired'); }
  const data = await res.json(); const token = data.access_token;
  if (!token) { window.location.href = '/login'; throw new Error('No token'); }
  sessionStorage.setItem('tt_access_token', token);
  if (data.refresh_token && data.refresh_token !== refreshToken) localStorage.setItem('tt_refresh_token', data.refresh_token);
  return token;
}
async function ttFetch(path: string, token: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store' });
  if (res.status === 401) { sessionStorage.removeItem('tt_access_token'); window.location.href = '/login'; throw new Error('Session expired'); }
  if (!res.ok) { const text = await res.text(); throw new Error(`${path} failed (${res.status}): ${text.slice(0, 120)}`); }
  return res.json();
}

// ── Order helpers (entry) ──────────────────────────────────────────────────
function buildOccSymbol(underlying: string, expiry: string, optType: 'P' | 'C', strike: number): string {
  const exp = expiry.replace(/-/g, '').slice(2);
  const under = underlying.padEnd(6, ' ');
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${under}${exp}${optType}${strikeStr}`;
}
function instrType(symbol: string): 'Equity Option' | 'Index Option' {
  return ['SPX', 'NDX', 'RUT', 'VIX'].includes(symbol.toUpperCase().trim()) ? 'Index Option' : 'Equity Option';
}
function formatTTReject(data: any): string {
  return data?.error?.message ?? data?.['error-message'] ??
    (Array.isArray(data?.error?.errors) ? data.error.errors.map((e: any) => e.reason ?? e.message ?? JSON.stringify(e)).join('; ') : null) ??
    JSON.stringify(data).slice(0, 300);
}
async function ttPost(path: string, token: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { sessionStorage.removeItem('tt_access_token'); window.location.href = '/login?redirect=/rinse-repeat'; throw new Error('Session expired'); }
  const data = await res.json();
  if (!res.ok) throw new Error(`Order rejected (${res.status}): ${formatTTReject(data)}`);
  return data;
}
async function ttPostComplex(path: string, token: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { sessionStorage.removeItem('tt_access_token'); window.location.href = '/login?redirect=/rinse-repeat'; throw new Error('Session expired'); }
  const data = await res.json();
  if (!res.ok) throw new Error(`Complex order rejected (${res.status}): ${formatTTReject(data)}`);
  return data;
}
function buildOpenSpreadOrder(
  underlying: string, expiry: string, optType: 'P' | 'C',
  shortStrike: number, longStrike: number, quantity: number, credit: number,
  shortSymbolOverride?: string, longSymbolOverride?: string
) {
  const itype = instrType(underlying);
  const shortSym = shortSymbolOverride ?? buildOccSymbol(underlying, expiry, optType, shortStrike);
  const longSym  = longSymbolOverride  ?? buildOccSymbol(underlying, expiry, optType, longStrike);
  return {
    'order-type': 'Limit', 'time-in-force': 'GTC',
    price: Math.abs(credit).toFixed(2), 'price-effect': 'Credit',
    legs: [
      { symbol: shortSym, quantity, action: 'Sell to Open', 'instrument-type': itype },
      { symbol: longSym,  quantity, action: 'Buy to Open',  'instrument-type': itype },
    ],
  };
}


// ── Helpers ───────────────────────────────────────────────────────────────
function daysUntil(dateStr: string): number {
  const target = new Date(dateStr + 'T12:00:00Z');
  const now = new Date();
  return Math.round((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}
function getBidAskMax(price: number | null): number {
  if (price == null) return 1.50;
  if (price >= 500) return 3.00;
  if (price >= 200) return 1.50;
  if (price >= 100) return 0.50;
  return 0.10;
}
function getWidthSteps(maxWidth: number, price: number | null): number[] {
  const stepSize = price == null ? 5 : price >= 2000 ? 25 : 5;
  const steps: number[] = [];
  for (let w = stepSize; w <= maxWidth; w += stepSize) steps.push(w);
  return steps;
}

// ── Profile building ───────────────────────────────────────────────────────
function loadTradesFromCache(range: TimeRange): ClosedTrade[] {
  const LS_TL_1W = 'hunter-tradelog-1w', LS_TL_2W = 'hunter-tradelog-2w', LS_TL_1M = 'hunter-tradelog-1m';
  const key = range === '1w' ? LS_TL_1W : range === '2w' ? LS_TL_2W : range === '1m' ? LS_TL_1M : range === '3m' ? LS_TL_3M : range === '6m' ? LS_TL_6M : LS_TL_12M;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return parsed.trades ?? [];
  } catch { return []; }
}

function parseStrikeWidth(strikes: string): number {
  // e.g. "450P/440P" → 10, "450P/440P · 470C/480C" → 10
  try {
    const nums = strikes.match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
    if (nums.length >= 2) return Math.abs(nums[0] - nums[1]);
    return 5;
  } catch { return 5; }
}

function buildProfiles(trades: ClosedTrade[], minWins: number): WinningProfile[] {
  const bySymbol: Record<string, ClosedTrade[]> = {};
  for (const t of trades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
    bySymbol[t.symbol].push(t);
  }

  const profiles: WinningProfile[] = [];

  for (const [symbol, symTrades] of Object.entries(bySymbol)) {
    const wins = symTrades.filter(t => t.outcome === 'WIN');
    if (wins.length < minWins) continue;

    const winRate = wins.length / symTrades.length;
    const avgPnlPct = wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length;
    const avgDteAtEntry = Math.round(wins.reduce((s, t) => s + t.dteAtEntry, 0) / wins.length);
    const avgSpreadWidth = wins.reduce((s, t) => s + parseStrikeWidth(t.strikes), 0) / wins.length;

    // Preferred strategy = most common among wins
    const stratCount: Record<string, number> = {};
    for (const t of wins) stratCount[t.strategy] = (stratCount[t.strategy] ?? 0) + 1;
    const preferredStrategy = (Object.entries(stratCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'BPS') as 'BPS' | 'BCS' | 'IC';

    const avgCreditRatio = wins.reduce((s, t) => {
      const w = parseStrikeWidth(t.strikes) * 100;
      return s + (w > 0 ? t.creditReceived / w : 0.33);
    }, 0) / wins.length;

    const lastWinDate = wins.map(t => t.closeDate).sort().reverse()[0];

    profiles.push({
      symbol, winCount: wins.length, totalTrades: symTrades.length, winRate,
      avgPnlPct, avgDteAtEntry, preferredStrategy, avgSpreadWidth, avgCreditRatio,
      lastWinDate, trades: symTrades,
    });
  }

  // Sort by composite attractiveness: winRate × winCount × avgPnlPct
  return profiles.sort((a, b) => (b.winRate * b.winCount * b.avgPnlPct) - (a.winRate * a.winCount * a.avgPnlPct));
}

// Build personalized rules from winning profile
function buildPersonalizedRules(profile: WinningProfile): RulesType {
  const base = { ...DEFAULT_RULES };

  // DTE: use history as a preference but keep a wide enough window to find setups.
  // If avg winning DTE was short (e.g. 10d), fall back to standard range.
  const avgDte = profile.avgDteAtEntry;
  if (avgDte >= 21 && avgDte <= 50) {
    base.DTE_MIN = Math.max(14, avgDte - 12);
    base.DTE_MAX = Math.min(60, avgDte + 12);
  } else {
    base.DTE_MIN = DEFAULT_RULES.DTE_MIN;
    base.DTE_MAX = DEFAULT_RULES.DTE_MAX;
  }

  // Spread width: 3x avg winning width, min $10
  const maxWidth = Math.max(10, Math.round(profile.avgSpreadWidth * 3 / 5) * 5);
  base.MAX_SPREAD_WIDTH = Math.min(200, maxWidth);

  // Credit ratio: relaxed from historical avg
  base.CREDIT_RATIO_MIN = Math.max(0.20, (profile.avgCreditRatio ?? 0.33) * 0.80);

  // Always relax rules for ETFs/indexes
  if (INDEX_TICKERS.has(profile.symbol)) {
    base.IVR_MIN = 15;
    base.OI_MIN = 100;
    base.BID_ASK_MAX = 0.25;
  }

  return base;
}

// ── API calls ─────────────────────────────────────────────────────────────
async function fetchMetrics(symbol: string, token: string): Promise<{ ivr: number | null; earnings: string | null }> {
  try {
    const data = await ttFetch(`/market-metrics?symbols=${encodeURIComponent(symbol)}`, token);
    const item = data?.data?.items?.[0];
    if (!item) return { ivr: null, earnings: null };
    const rawIvr = item['implied-volatility-index-rank'] ?? item['iv-rank'] ?? null;
    const parsedIvr = rawIvr != null ? parseFloat(String(rawIvr)) : NaN;
    const ivr = !isNaN(parsedIvr) ? (parsedIvr < 1 ? Math.round(parsedIvr * 100) : Math.round(parsedIvr)) : null;
    const earningsRaw = item['earnings'] ?? item['next-earnings-date'] ?? null;
    const earnings = earningsRaw?.['expected-report-date'] ?? (typeof earningsRaw === 'string' ? earningsRaw : null);
    return { ivr, earnings };
  } catch { return { ivr: null, earnings: null }; }
}

async function fetchQuote(symbol: string, token: string): Promise<number | null> {
  try {
    const data = await ttFetch(`/market-data/by-type?equity=${encodeURIComponent(symbol)}`, token);
    const item = data.data?.items?.[0]; if (!item) return null;
    const bid = item.bid != null ? parseFloat(item.bid) : null;
    const ask = item.ask != null ? parseFloat(item.ask) : null;
    const last = item.last != null ? parseFloat(item.last) : null;
    return last ?? (bid && ask ? (bid + ask) / 2 : null);
  } catch { return null; }
}

async function fetchChain(symbol: string, token: string, rules: RulesType): Promise<{ expirations: string[]; chains: Record<string, any[]>; isEtfOrIndex: boolean }> {
  const nested = await ttFetch(`/option-chains/${symbol}/nested`, token);
  const instrumentType: string = nested?.data?.items?.[0]?.['instrument-type'] ?? '';
  const isEtfOrIndex = ['ETF', 'Index', 'Future'].some(t => instrumentType.toLowerCase().includes(t.toLowerCase())) || INDEX_TICKERS.has(symbol.toUpperCase());
  const expirations: string[] = [], chains: Record<string, any[]> = {}, allOCCSymbols: string[] = [];
  const symbolMeta: Record<string, { expDate: string; strike: number; optionType: string }> = {};
  for (const expGroup of nested?.data?.items?.[0]?.expirations ?? []) {
    const expDate: string = expGroup['expiration-date']; if (!expDate) continue;
    const dte = daysUntil(expDate); if (dte < rules.DTE_MIN - 5 || dte > rules.DTE_MAX + 5) continue;
    for (const strike of expGroup.strikes ?? []) {
      const strikePrice = parseFloat(strike['strike-price'] ?? '0');
      const callSym: string = strike['call'], putSym: string = strike['put'];
      if (callSym) { allOCCSymbols.push(callSym); symbolMeta[callSym] = { expDate, strike: strikePrice, optionType: 'C' }; }
      if (putSym) { allOCCSymbols.push(putSym); symbolMeta[putSym] = { expDate, strike: strikePrice, optionType: 'P' }; }
    }
  }
  if (allOCCSymbols.length === 0) return { expirations, chains, isEtfOrIndex };
  for (let i = 0; i < allOCCSymbols.length; i += 100) {
    const chunk = allOCCSymbols.slice(i, i + 100);
    const qs = chunk.map(s => `equity-option=${encodeURIComponent(s)}`).join('&');
    let greeksData: any;
    try { greeksData = await ttFetch(`/market-data/by-type?${qs}`, token); } catch { continue; }
    for (const item of greeksData?.data?.items ?? []) {
      const meta = symbolMeta[item.symbol]; if (!meta) continue;
      const bid = parseFloat(item.bid ?? '0'), ask = parseFloat(item.ask ?? '0');
      const delta = item.delta != null ? parseFloat(item.delta) : null;
      const oi = parseInt(item['open-interest'] ?? '0', 10);
      if (!expirations.includes(meta.expDate)) expirations.push(meta.expDate);
      if (!chains[meta.expDate]) chains[meta.expDate] = [];
      chains[meta.expDate].push({ strikePrice: meta.strike, expirationDate: meta.expDate, optionType: meta.optionType, delta, openInterest: oi, bid, ask, mid: (bid + ask) / 2, occSymbol: item.symbol });
    }
  }
  expirations.sort();
  return { expirations, chains, isEtfOrIndex };
}

// ── Spread finders (copied from Hunter) ───────────────────────────────────
function trySpreadAtWidth(legs: any[], strategy: 'BPS' | 'BCS', expDate: string, width: number, price: number | null, RULES: RulesType): SpreadCandidate | null {
  const bidAskMax = getBidAskMax(price);
  const candidates: SpreadCandidate[] = [];
  for (const shortLeg of legs) {
    const delta = shortLeg.delta; if (delta == null) continue;
    const absDelta = Math.abs(delta);
    if (absDelta < RULES.SPREAD_DELTA_MIN || absDelta > RULES.SPREAD_DELTA_MAX) continue;
    if (shortLeg.openInterest < RULES.OI_MIN || shortLeg.ask - shortLeg.bid > bidAskMax) continue;
    const longStrike = strategy === 'BPS' ? shortLeg.strikePrice - width : shortLeg.strikePrice + width;
    const longLeg = legs.find((o: any) => Math.abs(o.strikePrice - longStrike) < 0.01);
    if (!longLeg || longLeg.openInterest < RULES.OI_MIN || longLeg.ask - longLeg.bid > bidAskMax) continue;
    const credit = parseFloat((shortLeg.mid - longLeg.mid).toFixed(2)); if (credit <= 0) continue;
    const creditRatio = credit / width; if (creditRatio < RULES.CREDIT_RATIO_MIN) continue;
    const maxLoss = width - credit; const roc = maxLoss > 0 ? (credit / maxLoss) * 100 : 0;
    if (roc < RULES.ROC_MIN_SPREAD) continue;
    const pop = (1 - absDelta) * 100; if (pop < RULES.POP_MIN) continue;
    candidates.push({ strategy, expiration: expDate, dte: daysUntil(expDate), shortStrike: shortLeg.strikePrice, longStrike, shortDelta: absDelta, shortOI: shortLeg.openInterest, longOI: longLeg.openInterest, credit, spreadWidth: width, creditRatio, roc, pop, shortOccSymbol: shortLeg.occSymbol, longOccSymbol: longLeg.occSymbol });
  }
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => { const pd = (b.pop ?? 0) - (a.pop ?? 0); if (Math.abs(pd) >= 5) return pd; return b.roc - a.roc; })[0];
}

function findBestSpread(chain: any[], strategy: 'BPS' | 'BCS', expDate: string, price: number | null, RULES: RulesType): SpreadCandidate | null {
  const legs = chain.filter(o => o.expirationDate === expDate && o.optionType === (strategy === 'BPS' ? 'P' : 'C'));
  const widthSteps = getWidthSteps(RULES.MAX_SPREAD_WIDTH, price);
  let best: SpreadCandidate | null = null;
  for (const w of widthSteps) { const c = trySpreadAtWidth(legs, strategy, expDate, w, price, RULES); if (c && (!best || c.roc > best.roc)) best = c; }
  return best;
}

function tryICSideAtWidth(legs: any[], side: 'put' | 'call', width: number, price: number | null, RULES: RulesType, minCallStrike?: number): any | null {
  const bidAskMax = getBidAskMax(price);
  const candidates: any[] = [];
  for (const shortLeg of legs) {
    if (side === 'call' && minCallStrike != null && shortLeg.strikePrice <= minCallStrike) continue;
    const delta = shortLeg.delta; if (delta == null) continue;
    const absDelta = Math.abs(delta);
    if (absDelta < RULES.IC_DELTA_MIN || absDelta > RULES.IC_DELTA_MAX) continue;
    if (shortLeg.openInterest < RULES.OI_MIN || shortLeg.ask - shortLeg.bid > bidAskMax) continue;
    const longStrike = side === 'put' ? shortLeg.strikePrice - width : shortLeg.strikePrice + width;
    const longLeg = legs.find((o: any) => Math.abs(o.strikePrice - longStrike) < 0.01);
    if (!longLeg || longLeg.openInterest < RULES.OI_MIN || longLeg.ask - longLeg.bid > bidAskMax) continue;
    const credit = parseFloat((shortLeg.mid - longLeg.mid).toFixed(2)); if (credit <= 0) continue;
    const creditRatio = credit / width; if (creditRatio < RULES.CREDIT_RATIO_MIN) continue;
    const maxLoss = width - credit; const roc = maxLoss > 0 ? (credit / maxLoss) * 100 : 0;
    const pop = (1 - absDelta) * 100; if (pop < RULES.POP_MIN) continue;
    candidates.push({ shortStrike: shortLeg.strikePrice, longStrike, shortDelta: absDelta, credit, creditRatio, roc, shortOI: shortLeg.openInterest, longOI: longLeg.openInterest, pop, shortOccSymbol: shortLeg.occSymbol, longOccSymbol: longLeg.occSymbol, width });
  }
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => { const pd = b.pop - a.pop; if (Math.abs(pd) >= 5) return pd; return b.roc - a.roc; })[0];
}

function findBestIC(chain: any[], expDate: string, price: number | null, RULES: RulesType): SpreadCandidate | null {
  const puts = chain.filter((o: any) => o.expirationDate === expDate && o.optionType === 'P');
  const calls = chain.filter((o: any) => o.expirationDate === expDate && o.optionType === 'C');
  const widthSteps = getWidthSteps(RULES.MAX_SPREAD_WIDTH, price);
  let bestPut: any = null;
  for (const w of widthSteps) { const c = tryICSideAtWidth(puts, 'put', w, price, RULES); if (c && (!bestPut || c.roc > bestPut.roc)) bestPut = { ...c, width: w }; }
  if (!bestPut) return null;
  let bestCall: any = null;
  for (const w of widthSteps) { const c = tryICSideAtWidth(calls, 'call', w, price, RULES, bestPut.shortStrike); if (c && (!bestCall || c.roc > bestCall.roc)) bestCall = { ...c, width: w }; }
  if (!bestCall) return null;
  const totalCredit = parseFloat((bestPut.credit + bestCall.credit).toFixed(2));
  const maxLoss = Math.max(bestPut.width - bestPut.credit, bestCall.width - bestCall.credit);
  const roc = maxLoss > 0 ? (totalCredit / maxLoss) * 100 : 0; if (roc < RULES.ROC_MIN_IC) return null;
  return { strategy: 'IC', expiration: expDate, dte: daysUntil(expDate), shortStrike: bestPut.shortStrike, longStrike: bestPut.longStrike, shortDelta: bestPut.shortDelta, shortOI: bestPut.shortOI, longOI: bestPut.longOI, credit: bestPut.credit, spreadWidth: bestPut.width, creditRatio: bestPut.creditRatio, roc, pop: (1 - bestPut.shortDelta - bestCall.shortDelta) * 100, shortCallStrike: bestCall.shortStrike, longCallStrike: bestCall.longStrike, callCredit: bestCall.credit, callWidth: bestCall.width, totalCredit, shortOccSymbol: bestPut.shortOccSymbol, longOccSymbol: bestPut.longOccSymbol, shortCallOccSymbol: bestCall.shortOccSymbol, longCallOccSymbol: bestCall.longOccSymbol };
}

// ── RR Score ──────────────────────────────────────────────────────────────
function computeRRScore(profile: WinningProfile, candidate: SpreadCandidate, ivr: number | null): number {
  // Components (all 0-100, weighted):
  // 40% — personal win rate on this symbol
  // 25% — current ROC
  // 20% — IVR quality
  // 15% — win count bonus (more history = more confidence)
  const winRateScore   = profile.winRate * 100 * 0.40;
  const rocScore       = Math.min(100, (candidate.roc / 50) * 100) * 0.25;
  const ivrScore       = ivr != null ? Math.min(100, (ivr / 60) * 100) * 0.20 : 15 * 0.20;
  const historyBonus   = Math.min(100, (profile.winCount / 5) * 100) * 0.15;
  return Math.round(winRateScore + rocScore + ivrScore + historyBonus);
}

// ── Formatting ────────────────────────────────────────────────────────────
function fmtDate(d: string) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m,10)-1]} ${parseInt(day,10)}`;
}
function stratColor(s: string) {
  if (s === 'BPS') return 'text-emerald-400 border-emerald-600 bg-emerald-500/10';
  if (s === 'BCS') return 'text-red-400 border-red-600 bg-red-500/10';
  if (s === 'IC')  return 'text-blue-400 ac-border ac-bg-10';
  return 'text-slate-400 border-slate-600 bg-slate-500/10';
}
function scoreColor(s: number) {
  if (s >= 70) return { text: 'text-emerald-400', border: 'border-emerald-600', bg: 'bg-emerald-500/10', label: 'Strong' };
  if (s >= 50) return { text: 'text-yellow-400',  border: 'border-yellow-600',  bg: 'bg-yellow-500/10',  label: 'Good' };
  if (s >= 35) return { text: 'text-orange-400',  border: 'border-orange-600',  bg: 'bg-orange-500/10',  label: 'Weak' };
  return           { text: 'text-red-400',    border: 'border-red-600',    bg: 'bg-red-500/10',    label: 'Poor' };
}


// ── Stock Research Component ──────────────────────────────────────────────
async function fetchStockResearch(symbol: string, riskContext?: string): Promise<string> {
  // Step 1: fetch recent news headlines from Yahoo Finance
  let headlines = '';
  try {
    const newsRes = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=8&quotesCount=0`,
      { cache: 'no-store' }
    );
    const newsData = await newsRes.json();
    const articles = newsData?.news ?? [];
    headlines = articles
      .slice(0, 6)
      .map((a: any) => `- ${a.title}`)
      .join('\n');
  } catch { headlines = 'News unavailable'; }

  // Step 2: send to GPT-4o for trading-focused summary
  const prompt = `You are a professional options trader analyzing ${symbol} before placing a trade.

Recent news headlines:
${headlines}

Give a concise 4-sentence trading analysis covering:
1. What is driving price action right now
2. Any near-term risks (earnings, macro, sector headwinds)
3. Analyst/market sentiment
4. Whether conditions currently favor selling premium (credit spreads) on this stock
${riskContext ? `\n5. Given this portfolio risk context, is adding this trade advisable: ${riskContext}` : ''}

Be direct and specific. No disclaimers. If the news is thin, say so.`;

  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 400,
      system: 'You are a concise, direct options trading analyst. No hedging. No disclaimers. Plain prose only.',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Research failed (${res.status})`);
  const data = await res.json();
  return data?.content?.find((b: any) => b.type === 'text')?.text ?? '';
}

function StockResearch({ symbol, th, riskContext }: { symbol: string; th: typeof THEMES[Theme]; riskContext?: string }) {
  const [open, setOpen]         = useState(false);
  const [loading, setLoading]   = useState(false);
  const [result, setResult]     = useState<string | null>(null);
  const [error, setError]       = useState('');

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (result) return; // already fetched — just re-open
    setLoading(true); setError('');
    try {
      const text = await fetchStockResearch(symbol, riskContext);
      setResult(text);
    } catch (err: any) {
      setError(err.message ?? 'Research failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div onClick={e => e.stopPropagation()}>
      <button
        onClick={handleClick}
        className={`inline-flex items-center gap-1 text-[9px] px-2 py-0.5 border rounded transition-colors ${
          open
            ? 'border-indigo-500 text-indigo-400 bg-indigo-500/10'
            : `${th.border} ${th.textFaint} hover:border-indigo-500 hover:text-indigo-400`
        }`}>
        <span className="text-[8px]">◎</span> Research
      </button>

      {open && (
        <div className={`mt-2 p-3 rounded-lg border ${th.borderLight} bg-indigo-500/5 text-[11px] leading-relaxed ${th.textMuted}`}>
          {loading && (
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin shrink-0" />
              <span className={`text-[10px] ${th.textFaint}`}>Researching {symbol}...</span>
            </div>
          )}
          {error && <p className="text-red-400 text-[10px]">{error}</p>}
          {result && (
            <>
              <p className="text-[9px] text-indigo-400 font-bold uppercase tracking-widest mb-1.5">◎ {symbol} Research</p>
              <p className="whitespace-pre-wrap">{result}</p>
              <button onClick={() => { setResult(null); setOpen(false); }}
                className={`mt-2 text-[9px] ${th.textFaint} hover:text-red-400 transition-colors`}>
                ✕ Dismiss
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Result Card ───────────────────────────────────────────────────────────
// ── EnterTradeModal ────────────────────────────────────────────────────────
function EnterTradeModal({ result, th, onClose }: {
  result: RRResult;
  th: typeof THEMES[Theme];
  onClose: () => void;
}) {
  const { profile, candidate: c } = result;
  if (!c) return null;

  const isIC = c.strategy === 'IC';
  const optType: 'P' | 'C' = c.strategy === 'BCS' ? 'C' : 'P';
  const defaultCredit = isIC ? (c.totalCredit ?? c.credit) : c.credit;

  const [qty,        setQty]        = useState(1);
  const [credit,     setCredit]     = useState(defaultCredit.toFixed(2));
  const [gtcPrice,   setGtcPrice]   = useState((defaultCredit * 0.50).toFixed(2));  // 50% profit target
  const [stopPrice,  setStopPrice]  = useState((defaultCredit * 2.00).toFixed(2));  // 2× stop
  const [phase,      setPhase]      = useState('');
  const [result2,    setResult2]    = useState<'success' | 'error' | null>(null);
  const [resultMsg,  setResultMsg]  = useState('');
  const [loading,    setLoading]    = useState(false);
  const [accountNum, setAccountNum] = useState<string | null>(null);

  // Fetch account number on mount
  useEffect(() => {
    getAccessToken().then(token =>
      ttFetch('/customers/me/accounts', token)
        .then(d => setAccountNum(d?.data?.items?.[0]?.account?.['account-number'] ?? null))
    ).catch(() => {});
  }, []);

  const creditNum = parseFloat(credit) || defaultCredit;
  const gtcNum    = parseFloat(gtcPrice) || creditNum * 0.50;
  const stopNum   = parseFloat(stopPrice) || creditNum * 2.00;
  const spreadWidth = isIC ? (c.spreadWidth ?? 5) : Math.abs(c.shortStrike - c.longStrike);
  const maxRisk = (spreadWidth - creditNum) * qty * 100;
  const targetProfit = gtcNum > 0 ? ((1 - gtcNum / creditNum) * 100).toFixed(0) : '50';
  const stopMultiple = stopNum > 0 ? (stopNum / creditNum).toFixed(1) : '2.0';

  const submit = async () => {
    if (!accountNum) { setResult2('error'); setResultMsg('Account not found — try refreshing'); return; }
    setLoading(true); setResult2(null); setResultMsg('');

    try {
      const token = await getAccessToken();

      // Step 1: Submit entry order
      setPhase('Submitting entry order...');
      let entryBody: any;
      if (isIC) {
        const itype = instrType(profile.symbol);
        entryBody = {
          'order-type': 'Limit', 'time-in-force': 'GTC',
          price: Math.abs(creditNum).toFixed(2), 'price-effect': 'Credit',
          legs: [
            { symbol: c.shortOccSymbol ?? buildOccSymbol(profile.symbol, c.expiration, 'P', c.shortStrike), quantity: qty, action: 'Sell to Open', 'instrument-type': itype },
            { symbol: c.longOccSymbol  ?? buildOccSymbol(profile.symbol, c.expiration, 'P', c.longStrike),  quantity: qty, action: 'Buy to Open',  'instrument-type': itype },
            { symbol: c.shortCallOccSymbol ?? buildOccSymbol(profile.symbol, c.expiration, 'C', c.shortCallStrike!), quantity: qty, action: 'Sell to Open', 'instrument-type': itype },
            { symbol: c.longCallOccSymbol  ?? buildOccSymbol(profile.symbol, c.expiration, 'C', c.longCallStrike!),  quantity: qty, action: 'Buy to Open',  'instrument-type': itype },
          ],
        };
      } else {
        entryBody = buildOpenSpreadOrder(
          profile.symbol, c.expiration, optType,
          c.shortStrike, c.longStrike, qty, creditNum,
          c.shortOccSymbol, c.longOccSymbol
        );
      }

      const entryRes = await ttPost(`/accounts/${accountNum}/orders`, token, entryBody);
      const entryId = String(entryRes?.data?.order?.id ?? entryRes?.data?.id ?? 'submitted');

      // Step 2: Place OCO (profit GTC + stop)
      setPhase('Placing OCO profit/stop orders...');
      const itype = instrType(profile.symbol);
      const closeLegs = isIC
        ? [
            { symbol: c.shortOccSymbol ?? buildOccSymbol(profile.symbol, c.expiration, 'P', c.shortStrike), quantity: qty, action: 'Buy to Close' as const, 'instrument-type': itype },
            { symbol: c.longOccSymbol  ?? buildOccSymbol(profile.symbol, c.expiration, 'P', c.longStrike),  quantity: qty, action: 'Sell to Close' as const, 'instrument-type': itype },
            { symbol: c.shortCallOccSymbol ?? buildOccSymbol(profile.symbol, c.expiration, 'C', c.shortCallStrike!), quantity: qty, action: 'Buy to Close' as const, 'instrument-type': itype },
            { symbol: c.longCallOccSymbol  ?? buildOccSymbol(profile.symbol, c.expiration, 'C', c.longCallStrike!),  quantity: qty, action: 'Sell to Close' as const, 'instrument-type': itype },
          ]
        : [
            { symbol: c.shortOccSymbol ?? buildOccSymbol(profile.symbol, c.expiration, optType, c.shortStrike), quantity: qty, action: 'Buy to Close' as const, 'instrument-type': itype },
            { symbol: c.longOccSymbol  ?? buildOccSymbol(profile.symbol, c.expiration, optType, c.longStrike),  quantity: qty, action: 'Sell to Close' as const, 'instrument-type': itype },
          ];

      const ocoBody = {
        type: 'OCO',
        orders: [
          { 'order-type': 'Limit',      'time-in-force': 'GTC', price: gtcNum.toFixed(2),  'price-effect': 'Debit', legs: closeLegs },
          { 'order-type': 'Stop Limit', 'time-in-force': 'GTC', 'stop-trigger': stopNum.toFixed(2), price: stopNum.toFixed(2), 'price-effect': 'Debit', legs: closeLegs },
        ],
      };
      const ocoRes = await ttPostComplex(`/accounts/${accountNum}/complex-orders`, token, ocoBody);
      const ocoId = String(ocoRes?.data?.['complex-order']?.id ?? ocoRes?.data?.id ?? 'submitted');

      setResult2('success');
      setResultMsg(`Entry #${entryId} submitted · OCO #${ocoId} placed (profit $${gtcNum.toFixed(2)} / stop $${stopNum.toFixed(2)})`);
    } catch (e: any) {
      setResult2('error');
      setResultMsg(e.message ?? 'Failed');
    } finally {
      setLoading(false);
      setPhase('');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className={`${th.sidebar} border ${th.border} rounded-2xl w-full max-w-md`}
        onClick={e => e.stopPropagation()}
        style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}
      >
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${th.border}`}>
          <div>
            <div className="flex items-center gap-2">
              <span className={`text-sm font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{profile.symbol}</span>
              <span className={`text-[10px] px-2 py-0.5 border rounded font-bold ${c.strategy === 'BPS' ? 'border-emerald-600 text-emerald-400' : c.strategy === 'BCS' ? 'border-red-600 text-red-400' : 'border-purple-600 text-purple-400'}`}>{c.strategy}</span>
              <span className={`text-[10px] ${th.textFaint}`}>{c.expiration} · {c.dte}d</span>
            </div>
            <p className={`text-[10px] ${th.textFaint} mt-0.5`}>
              {isIC
                ? `${c.shortStrike}P/${c.longStrike}P · ${c.shortCallStrike}C/${c.longCallStrike}C`
                : `${c.shortStrike}/${c.longStrike} · $${spreadWidth} wide`
              }
            </p>
          </div>
          <button onClick={onClose} className={`text-[11px] ${th.textFaint} hover:${th.text} px-2 py-1`}>✕</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Entry fields */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={`text-[10px] ${th.textFaint} block mb-1`}>QUANTITY</label>
              <input type="number" min={1} max={50} value={qty}
                onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))}
                className={`w-full px-3 py-2 ${th.input} border ${th.border} rounded text-sm ${th.text} focus:outline-none`} />
            </div>
            <div>
              <label className={`text-[10px] ${th.textFaint} block mb-1`}>ENTRY CREDIT</label>
              <input type="number" step={0.01} value={credit}
                onChange={e => {
                  setCredit(e.target.value);
                  const n = parseFloat(e.target.value);
                  if (!isNaN(n) && n > 0) {
                    setGtcPrice((n * 0.50).toFixed(2));
                    setStopPrice((n * 2.00).toFixed(2));
                  }
                }}
                className={`w-full px-3 py-2 ${th.input} border ${th.border} rounded text-sm ${th.text} focus:outline-none`} />
            </div>
          </div>

          {/* OCO fields */}
          <div className={`p-3 rounded-lg border ${th.border} space-y-3`}>
            <p className={`text-[10px] ${th.textFaint} font-bold tracking-wider`}>OCO EXIT ORDERS</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={`text-[10px] text-emerald-400 block mb-1`}>PROFIT TARGET (GTC)</label>
                <input type="number" step={0.01} value={gtcPrice}
                  onChange={e => setGtcPrice(e.target.value)}
                  className={`w-full px-3 py-2 ${th.input} border border-emerald-700/50 rounded text-sm text-emerald-400 focus:outline-none`} />
                <p className={`text-[9px] ${th.textFaint} mt-0.5`}>{targetProfit}% profit · ${(parseFloat(gtcPrice)||0 > 0 ? ((creditNum - parseFloat(gtcPrice)) * qty * 100).toFixed(0) : '—')} gain</p>
              </div>
              <div>
                <label className={`text-[10px] text-red-400 block mb-1`}>STOP LOSS</label>
                <input type="number" step={0.01} value={stopPrice}
                  onChange={e => setStopPrice(e.target.value)}
                  className={`w-full px-3 py-2 ${th.input} border border-red-700/50 rounded text-sm text-red-400 focus:outline-none`} />
                <p className={`text-[9px] ${th.textFaint} mt-0.5`}>{stopMultiple}× credit · -${((parseFloat(stopPrice)||0) * qty * 100).toFixed(0)} max loss</p>
              </div>
            </div>
          </div>

          {/* Summary */}
          <div className={`grid grid-cols-3 gap-2 text-center`}>
            {[
              ['Max Risk', `$${maxRisk.toFixed(0)}`],
              ['ROC', `${c.roc.toFixed(0)}%`],
              ['POP', `${c.pop?.toFixed(0) ?? '—'}%`],
            ].map(([label, val]) => (
              <div key={label} className={`${th.card} border ${th.border} rounded p-2`}>
                <p className={`text-[9px] ${th.textFaint}`}>{label}</p>
                <p className={`text-xs font-bold ${th.text}`}>{val}</p>
              </div>
            ))}
          </div>

          {/* Status */}
          {phase && <p className={`text-[10px] text-blue-400 animate-pulse`}>{phase}</p>}
          {result2 === 'success' && <p className="text-[10px] text-emerald-400 leading-relaxed">{resultMsg}</p>}
          {result2 === 'error'   && <p className="text-[10px] text-red-400 leading-relaxed whitespace-pre-wrap">{resultMsg}</p>}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button onClick={onClose} className={`flex-1 py-2.5 border ${th.border} ${th.textFaint} rounded text-xs`}>Cancel</button>
            {result2 !== 'success' && (
              <button
                onClick={submit}
                disabled={loading || !accountNum}
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded text-xs font-bold tracking-wider transition-colors">
                {loading ? phase || 'Submitting...' : 'Enter Trade + OCO'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


function RRCard({ result, th, existingPositions }: {
  result: RRResult;
  th: typeof THEMES[Theme];

  existingPositions?: ExistingPosition[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [portfolioRisk, setPortfolioRisk] = useState<PortfolioRisk | null>(null);
  const [showChart, setShowChart] = useState(false);
  const [sparkData, setSparkData] = useState<number[] | null>(null);
  const [sparkLoading, setSparkLoading] = useState(false);
  const [showEnterModal, setShowEnterModal] = useState(false);

  useEffect(() => {
    if (!existingPositions || existingPositions.length === 0) return;
    const sectorCounts: Record<string, number> = {};
    Promise.all(existingPositions.map((p: ExistingPosition) => getSector(p.symbol))).then(sectors => {
      sectors.forEach(s => { if (s !== 'Index' && s !== 'Unknown') sectorCounts[s] = (sectorCounts[s] ?? 0) + 1; });
      getSector(result.profile.symbol).then(sector => {
        const adjCounts = { ...sectorCounts };
        existingPositions.filter((p: ExistingPosition) => p.symbol === result.profile.symbol).forEach(() => {
          if (adjCounts[sector] > 0) adjCounts[sector]--;
        });
        setPortfolioRisk(checkPortfolioRisk(result.profile.symbol, result.candidate, existingPositions, sector, adjCounts));
      });
    });
  }, [existingPositions, result.profile.symbol, result.candidate]);
  const { profile, candidate: c, currentIvr, currentPrice, rrScore, qualified } = result;
  const sc = scoreColor(rrScore);
  const wins = profile.trades.filter(t => t.outcome === 'WIN');
  const losses = profile.trades.filter(t => t.outcome === 'LOSS');

  return (
    <>
    <div
      className={`border ${th.border} border-l-4 ${sc.border.replace('border-', 'border-l-')} ${th.card} rounded-lg cursor-pointer transition-all hover:shadow-md`}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Header row */}
      <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
        {/* Symbol + price */}
        <div className="w-20 shrink-0">
          <p className={`font-bold ${th.text} text-sm`} style={{ fontFamily: "'DM Mono', monospace" }}>{profile.symbol}</p>
          {currentPrice && <p className={`text-[10px] ${th.textFaint}`}>${currentPrice.toFixed(2)}</p>}
          <div className="relative mt-0.5">
            <button
              onClick={e => {
                e.stopPropagation();
                if (!showChart) {
                  setShowChart(true);
                  if (!sparkData) {
                    setSparkLoading(true);
                    fetch(`/api/chart?symbol=${encodeURIComponent(profile.symbol)}`)
                      .then(r => r.json())
                      .then(d => {
                        const allBars = (d?.bars ?? []).map((b: any) => b?.c).filter((v: any) => v != null);
                        const closes = allBars.slice(-90);
                        setSparkData(closes);
                      })
                      .catch(() => setSparkData([]))
                      .finally(() => setSparkLoading(false));
                  }
                } else { setShowChart(false); }
              }}
              className={`inline-flex items-center gap-0.5 text-[9px] transition-colors ${showChart ? 'text-blue-400' : 'text-slate-500 ac-hover-text'}`}
              title="Quick chart">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
              </svg>
              <span className="tracking-wide">chart</span>
            </button>

            {showChart && (
              <div className={`absolute top-full left-0 mt-1 z-40 ${th.sidebar} border ${th.border} rounded-xl shadow-2xl p-3`}
                style={{ width: '280px' }} onClick={e => e.stopPropagation()}>
                <div className="mb-2">
                  {sparkLoading && <div className="flex items-center justify-center h-16"><div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>}
                  {!sparkLoading && sparkData && sparkData.length > 1 && (() => {
                    const min = Math.min(...sparkData), max = Math.max(...sparkData);
                    const range = max - min || 1;
                    const w = 256, h = 56;
                    const pts = sparkData.map((v, i) => `${((i / (sparkData.length - 1)) * w).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`).join(' ');
                    const isUp = sparkData[sparkData.length - 1] >= sparkData[0];
                    const color = isUp ? '#10b981' : '#ef4444';
                    const lastPrice = sparkData[sparkData.length - 1];
                    const changePct = ((lastPrice - sparkData[0]) / sparkData[0] * 100).toFixed(1);
                    return (
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className={`text-[10px] font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{profile.symbol}</span>
                          <span className="text-[10px] font-bold" style={{ color }}>${lastPrice.toFixed(2)} <span className="text-[9px]">{isUp ? '+' : ''}{changePct}% 30d</span></span>
                        </div>
                        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: '56px' }}>
                          <defs><linearGradient id={`grad-rr-${profile.symbol}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.3" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>
                          <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
                          <polygon points={`0,${h} ${pts} ${w},${h}`} fill={`url(#grad-rr-${profile.symbol})`} />
                        </svg>
                      </div>
                    );
                  })()}
                  {!sparkLoading && sparkData && sparkData.length === 0 && <p className={`text-[9px] ${th.textFaint} text-center py-3`}>Chart data unavailable</p>}
                </div>
                <a href={`https://www.tradingview.com/chart/?symbol=${profile.symbol}`} target="_blank" rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="flex items-center justify-center gap-2 w-full py-2 ac-bg-20 ac-hover-bg/30 border ac-border/40 rounded-lg text-[10px] text-blue-400 font-bold tracking-wider transition-colors">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                  Open in TradingView
                </a>
              </div>
            )}
          </div>
          <StockResearch symbol={profile.symbol} th={th} riskContext={portfolioRisk && portfolioRisk.level !== 'clear' ? portfolioRisk.recommendation : undefined} />
        </div>

        {/* Strategy + RR score */}
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-[10px] px-2 py-0.5 border rounded font-bold ${stratColor(profile.preferredStrategy)}`}>{profile.preferredStrategy}</span>
          <span className={`text-[10px] px-2 py-0.5 border rounded font-bold ${sc.text} ${sc.border} ${sc.bg}`}>
            ◈ {rrScore} — {sc.label}
          </span>
        </div>

        {/* Your history on this symbol */}
        <div className="shrink-0">
          <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest`}>Your History</p>
          <p className={`text-xs font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>
            <span className="text-emerald-400">{profile.winCount}W</span>
            <span className={th.textFaint}>/</span>
            <span className="text-red-400">{losses.length}L</span>
            <span className={`ml-1.5 text-[10px] ${profile.winRate >= 0.6 ? 'text-emerald-400' : 'text-yellow-400'}`}>
              {Math.round(profile.winRate * 100)}%
            </span>
          </p>
          <p className={`text-[9px] ${th.textFaint}`}>avg +{profile.avgPnlPct.toFixed(0)}% · last {fmtDate(profile.lastWinDate)}</p>
        </div>

        {/* Current opportunity */}
        {c && (
          <>
            <div className="shrink-0">
              <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest`}>Expiry</p>
              <p className={`text-xs ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{c.expiration} <span className={th.textFaint}>({c.dte}d)</span></p>
            </div>
            <div className="shrink-0">
              <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest`}>Strikes</p>
              <p className={`text-xs ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                {c.strategy === 'IC'
                  ? `${c.shortStrike}P/${c.longStrike}P · ${c.shortCallStrike}C/${c.longCallStrike}C`
                  : `${c.shortStrike}/${c.longStrike}`}
              </p>
            </div>
            <div className="shrink-0">
              <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest`}>Credit</p>
              <p className="text-xs font-bold text-emerald-400" style={{ fontFamily: "'DM Mono', monospace" }}>${(c.totalCredit ?? c.credit).toFixed(2)}</p>
            </div>
            <div className="shrink-0">
              <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest`}>ROC</p>
              <p className={`text-xs font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{c.roc.toFixed(0)}%</p>
            </div>
            <div className="shrink-0">
              <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest`}>POP</p>
              <p className={`text-xs ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{c.pop?.toFixed(0) ?? '—'}%</p>
            </div>
          </>
        )}

        {currentIvr != null && (
          <div className="shrink-0">
            <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest`}>IVR</p>
            <p className={`text-xs font-bold ${currentIvr >= 30 ? 'text-emerald-400' : 'text-yellow-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>{currentIvr.toFixed(0)}%</p>
          </div>
        )}

        {!qualified && result.failReason && (
          <p className="text-[10px] text-red-400/80 flex-1">{result.failReason}</p>
        )}

        <div className="ml-auto flex items-center gap-2">
          {result.candidate && (
            <button
              onClick={e => { e.stopPropagation(); setShowEnterModal(true); }}
              className="text-[9px] px-2.5 py-1 border border-emerald-700 text-emerald-400 rounded font-bold hover:bg-emerald-600/20 transition-colors">
              ▶ Enter Trade
            </button>
          )}
          <span className={`text-[10px] ${th.textFaint}`}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Portfolio risk banner */}
      {portfolioRisk && portfolioRisk.level !== 'clear' && (
        <div className={`border-t px-4 py-2.5 ${
          portfolioRisk.level === 'same_strikes' ? 'border-red-500/40 bg-red-500/8'
          : portfolioRisk.level === 'synthetic_ic' ? 'border-purple-500/30 bg-purple-500/8'
          : portfolioRisk.level === 'sector_concentration' ? 'border-orange-500/30 bg-orange-500/8'
          : 'border-amber-500/30 bg-amber-500/8'
        }`} onClick={e => e.stopPropagation()}>
          <div className="flex items-start gap-2 mb-1">
            <span className={`text-sm shrink-0 ${portfolioRisk.level === 'same_strikes' ? 'text-red-400' : portfolioRisk.level === 'synthetic_ic' ? 'text-purple-400' : portfolioRisk.level === 'sector_concentration' ? 'text-orange-400' : 'text-amber-400'}`}>⚠</span>
            <div>
              {portfolioRisk.warnings.map((w, i) => (
                <p key={i} className={`text-[10px] font-bold ${portfolioRisk.level === 'same_strikes' ? 'text-red-300' : portfolioRisk.level === 'synthetic_ic' ? 'text-purple-300' : portfolioRisk.level === 'sector_concentration' ? 'text-orange-300' : 'text-amber-300'}`}>{w}</p>
              ))}
              <p className={`text-[10px] mt-1 leading-relaxed ${portfolioRisk.level === 'same_strikes' ? 'text-red-400/80' : portfolioRisk.level === 'synthetic_ic' ? 'text-purple-400/80' : portfolioRisk.level === 'sector_concentration' ? 'text-orange-400/80' : 'text-amber-400/80'}`}>{portfolioRisk.recommendation}</p>
            </div>
          </div>
        </div>
      )}

      {/* Expanded: trade history + setup details */}
      {expanded && (
        <div className={`border-t ${th.border} px-4 py-3 space-y-3`}>

          {/* Personalization note */}
          <div className={`text-[10px] ${th.textFaint} p-2 rounded border ${th.borderLight}`}>
            <span className="font-medium text-indigo-400">◈ Why this setup:</span>
            {' '}DTE range {Math.max(14, profile.avgDteAtEntry - 8)}–{Math.min(60, profile.avgDteAtEntry + 8)}d tuned to your avg {profile.avgDteAtEntry}d entry · spread width up to ${Math.round(profile.avgSpreadWidth * 2)}
            {' · '}{profile.winRate >= 0.7 ? 'Strong win rate on this ticker' : profile.winRate >= 0.5 ? 'Positive edge on this ticker' : 'Limited history — proceed carefully'}
          </div>

          {/* Past trades table */}
          <div>
            <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-2`}>Your Trade History — {profile.symbol}</p>
            <div className="space-y-1">
              {profile.trades.sort((a, b) => b.closeDate.localeCompare(a.closeDate)).map(t => (
                <div key={t.id} className={`flex items-center gap-3 text-[10px] px-2 py-1 rounded ${t.outcome === 'WIN' ? 'bg-emerald-500/5' : t.outcome === 'LOSS' ? 'bg-red-500/5' : 'bg-white/2'}`}>
                  <span className={`w-3 h-3 rounded-full shrink-0 ${t.outcome === 'WIN' ? 'bg-emerald-500' : t.outcome === 'LOSS' ? 'bg-red-500' : 'bg-yellow-500'}`} />
                  <span className={th.textFaint}>{fmtDate(t.openDate)} → {fmtDate(t.closeDate)}</span>
                  <span className={`${th.textFaint} font-mono`}>{t.strikes}</span>
                  <span className={th.textFaint}>{t.dteAtEntry}d DTE</span>
                  <span className="text-emerald-400 font-mono">${t.creditReceived.toFixed(0)}</span>
                  <span className={`font-bold font-mono ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {t.pnl >= 0 ? '+' : ''}{t.pnlPct.toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Current candidate details */}
          {c && (
            <div className={`border-t ${th.border} pt-3`}>
              <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-2`}>Current Setup</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div><span className={th.label}>Strategy </span><span className={th.text}>{c.strategy}</span></div>
                <div><span className={th.label}>Expiry </span><span className={th.text}>{c.expiration} ({c.dte}d)</span></div>
                <div><span className={th.label}>Credit </span><span className="text-emerald-400 font-bold">${(c.totalCredit ?? c.credit).toFixed(2)}</span></div>
                <div><span className={th.label}>ROC </span><span className={th.text}>{c.roc.toFixed(0)}%</span></div>
                <div><span className={th.label}>Delta </span><span className={th.text}>{c.shortDelta.toFixed(2)}</span></div>
                <div><span className={th.label}>POP </span><span className={th.text}>{c.pop?.toFixed(0) ?? '—'}%</span></div>
                <div><span className={th.label}>Short OI </span><span className={th.text}>{c.shortOI}</span></div>
                <div><span className={th.label}>Long OI </span><span className={th.text}>{c.longOI}</span></div>
              </div>
              {result.earningsDate && (
                <p className="text-[10px] text-yellow-400 mt-2">⚠ Earnings: {result.earningsDate}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
    {showEnterModal && result.candidate && (
      <EnterTradeModal result={result} th={th} onClose={() => setShowEnterModal(false)} />
    )}
  </>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────
export default function RinseRepeatPage() {
  const [theme, setTheme]     = useState<Theme>(getSavedTheme);
  const th = THEMES[theme];
  const [accent, setAccent] = useState<Accent>(getSavedAccent);
  useEffect(() => { applyAccent(accent); }, [accent]);
  useEffect(() => { injectAccentStyle(); applyAccent(getSavedAccent()); }, []);
  const [range, setRange]     = useState<TimeRange>('3m');
  const [results, setResults] = useState<RRResult[]>([]);
  const [profiles, setProfiles] = useState<WinningProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus]   = useState('');
  const [error, setError]     = useState('');
  const [minWins, setMinWins] = useState(1);
  const [existingPositions, setExistingPositions] = useState<ExistingPosition[]>([]);


  // Load existing portfolio positions on mount
  useEffect(() => {
    // Reuse the same loadExistingPositions logic inline
    (async () => {
      try {
        const token = await getAccessToken();
        const accountsData = await ttFetch('/customers/me/accounts', token);
        const accountNumber = accountsData?.data?.items?.[0]?.account?.['account-number'];
        if (!accountNumber) return;
        const posData = await ttFetch(`/accounts/${accountNumber}/positions`, token);
        const rawPositions: any[] = posData?.data?.items ?? [];
        const optionLegs = rawPositions.filter((p: any) =>
          (p['instrument-type'] === 'Equity Option' || p['instrument-type'] === 'Index Option')
          && parseFloat(p['quantity'] ?? '0') > 0
        );
        const groups: Record<string, any[]> = {};
        for (const leg of optionLegs) {
          const sym = leg['underlying-symbol'];
          const exp = (leg['expires-at'] ?? leg['expiration-date'] ?? 'unknown').slice(0, 10);
          const key = `${sym}::${exp}`;
          if (!groups[key]) groups[key] = [];
          groups[key].push(leg);
        }
        const positions: ExistingPosition[] = [];
        for (const [key, legs] of Object.entries(groups)) {
          const [symbol, expDate] = key.split('::');
          const shortLeg = legs.find((l: any) => l['quantity-direction'] === 'Short');
          const qty = shortLeg ? parseInt(shortLeg['quantity'] ?? '1', 10) : 1;
          const getOT = (occ: string) => { const m = occ.replace(/\s+/g,'').match(/^[A-Z]+\d{6}([CP])\d{8}$/); return m?.[1] ?? null; };
          const getStrike = (occ: string) => { const m = occ.replace(/\s+/g,'').match(/\d{8}$/); return m ? parseInt(m[0],10)/1000 : 0; };
          const putLegs  = legs.filter((l: any) => getOT(l.symbol) === 'P');
          const callLegs = legs.filter((l: any) => getOT(l.symbol) === 'C');
          let strategy = 'SPREAD';
          if (putLegs.length >= 2 && callLegs.length === 0) strategy = 'BPS';
          else if (callLegs.length >= 2 && putLegs.length === 0) strategy = 'BCS';
          else if (putLegs.length >= 2 && callLegs.length >= 2) strategy = 'IC';
          const sp = putLegs.map((l: any) => getStrike(l.symbol)).sort((a: number,b: number) => b-a);
          const sc = callLegs.map((l: any) => getStrike(l.symbol)).sort((a: number,b: number) => a-b);
          let strikes = '';
          if (strategy === 'BPS' && sp.length >= 2) strikes = `${sp[0]}P/${sp[1]}P`;
          else if (strategy === 'BCS' && sc.length >= 2) strikes = `${sc[0]}C/${sc[1]}C`;
          else if (strategy === 'IC' && sp.length >= 2 && sc.length >= 2) strikes = `${sp[0]}P/${sp[1]}P · ${sc[0]}C/${sc[1]}C`;
          else strikes = legs.map((l: any) => `${getStrike(l.symbol)}${getOT(l.symbol)}`).join('/');
          positions.push({ symbol, strategy, expDate, strikes, qty });
        }
        setExistingPositions(positions);
      } catch {}
    })();
  }, []);

  // Load profiles from cache on mount/range change
  useEffect(() => {
    console.log('[RR] loading cache for range:', range);
    const trades = loadTradesFromCache(range);
    if (trades.length === 0) { setProfiles([]); return; }
    const p = buildProfiles(trades, minWins);
    console.log('[RR] trades from cache:', trades.length, 'profiles built:', p.length, 'outcomes:', trades.map(t => t.outcome));
    setProfiles(p);
  }, [range, minWins]);

  const runScan = async () => {
    if (profiles.length === 0) { setError('No winning trades found in your trade log for this period. Try a longer range or run more trades.'); return; }
    setLoading(true); setError(''); setResults([]);
    try {
      const token = await getAccessToken();
      const scanResults: RRResult[] = [];

      for (const profile of profiles) {
        setStatus(`Scanning ${profile.symbol} (${profiles.indexOf(profile) + 1}/${profiles.length})...`);
        try {
          const rules = buildPersonalizedRules(profile);
          const [{ ivr, earnings }, price, chainData] = await Promise.all([
            fetchMetrics(profile.symbol, token),
            fetchQuote(profile.symbol, token),
            fetchChain(profile.symbol, token, rules).catch(() => ({ expirations: [], chains: {}, isEtfOrIndex: false })),
          ]);

          // Earnings check
          if (earnings) {
            const eDate = daysUntil(earnings);
            if (eDate >= 0 && eDate <= rules.DTE_MAX + 5) {
              scanResults.push({ profile, candidate: null, currentIvr: ivr, currentPrice: price, earningsDate: earnings, rrScore: 0, qualified: false, failReason: `Earnings in ${eDate}d — wait until after` });
              continue;
            }
          }

          // Find best candidate using personalized rules
          let candidate: SpreadCandidate | null = null;
          const validExps = chainData.expirations.filter(exp => { const d = daysUntil(exp); return d >= rules.DTE_MIN && d <= rules.DTE_MAX; });

          for (const exp of validExps) {
            const chain = (chainData.chains as Record<string, any[]>)[exp] ?? [];
            candidate = profile.preferredStrategy === 'IC'
              ? findBestIC(chain, exp, price, rules)
              : findBestSpread(chain, profile.preferredStrategy, exp, price, rules);
            if (candidate) break;
          }

          if (!candidate && validExps.length === 0) {
            scanResults.push({ profile, candidate: null, currentIvr: ivr, currentPrice: price, earningsDate: earnings, rrScore: 0, qualified: false, failReason: 'No valid expirations in your DTE range' });
            continue;
          }
          if (!candidate) {
            scanResults.push({ profile, candidate: null, currentIvr: ivr, currentPrice: price, earningsDate: earnings, rrScore: 0, qualified: false, failReason: 'No qualifying strikes found at current prices' });
            continue;
          }

          const rrScore = computeRRScore(profile, candidate, ivr);
          scanResults.push({ profile, candidate, currentIvr: ivr, currentPrice: price, earningsDate: earnings ?? null, rrScore, qualified: true, failReason: '' });

        } catch (e: any) {
          scanResults.push({ profile, candidate: null, currentIvr: null, currentPrice: null, earningsDate: null, rrScore: 0, qualified: false, failReason: e.message ?? 'Scan error' });
        }
      }

      // Sort: qualified first by RR score, then unqualified
      scanResults.sort((a, b) => {
        if (a.qualified && !b.qualified) return -1;
        if (!a.qualified && b.qualified) return 1;
        return b.rrScore - a.rrScore;
      });
      setResults(scanResults);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false); setStatus('');
    }
  };

  const qualified = results.filter(r => r.qualified);
  const unqualified = results.filter(r => !r.qualified);

  return (
    <div className={`min-h-screen ${th.bg} transition-colors duration-200`} style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>

      {/* Header */}
      <div className={`${th.header} border-b ${th.border} px-6 py-4 flex items-center justify-between sticky top-0 z-50`}>
        <div className="flex items-center gap-6">
          <div>
            <h1 className="text-base font-bold tracking-widest text-white" style={{ fontFamily: "'DM Mono', monospace" }}>OPTIONS HUNTER</h1>
            <p className="text-[10px] text-white/50 mt-0.5 tracking-wider" style={{ fontFamily: "'DM Mono', monospace" }}>RINSE & REPEAT</p>
          </div>
          <nav className="flex items-center gap-1 bg-black/20 rounded-lg p-1">
            <Link href="/"              className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">HUNTER</Link>
            <Link href="/portfolio"     className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">PORTFOLIO</Link>
            <Link href="/engine" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">ENGINE</Link>
            <span className="text-xs px-3 py-1.5 rounded text-white tracking-wider active-nav" style={{ backgroundColor: `rgba(var(--accent-r),var(--accent-g),var(--accent-b),0.25)`, borderBottom: `2px solid var(--accent)` }}>RINSE & REPEAT</span>            <Link href="/trade-log"     className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">TRADE LOG</Link>
            <Link href="/performance"   className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">PERFORMANCE</Link>
          </nav>
        </div>
        <div className="flex items-center gap-2">

          {/* Accent swatches */}
          <div className="flex items-center gap-1 mr-1">
            {(Object.entries(ACCENTS) as [Accent, typeof ACCENTS[Accent]][]).map(([key, val]) => (
              <button key={key} onClick={() => { setAccent(key); applyAccent(key); try { localStorage.setItem(LS_ACCENT, key); } catch {} }}
                title={val.label}
                className={`w-3.5 h-3.5 rounded-full transition-all ${accent === key ? 'ring-2 ring-white/60 ring-offset-1 ring-offset-black scale-125' : 'opacity-60 hover:opacity-100'}`}
                style={{ backgroundColor: val.hex }}
              />
            ))}
          </div>
          <div className="w-px h-4 bg-white/20 mr-1" />
          {(['dark','medium','light'] as Theme[]).map(t => (
            <button key={t} onClick={() => { setTheme(t); try { localStorage.setItem(LS_THEME, t); } catch {} }}
              className={`text-[9px] px-2 py-1 border rounded transition-colors ${theme === t ? 'ac-btn' : `${th.border} ${th.textFaint}`}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Sticky controls */}
      <div className={`${th.header} border-b ${th.border} px-6 py-3 sticky top-[57px] z-40`}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            {/* Range */}
            <div className="flex items-center gap-1">
              {([['1w','1 WK'],['2w','2 WK'],['1m','1 MO'],['3m','3 MO'],['6m','6 MO'],['12m','12 MO']] as [TimeRange,string][]).map(([r,label]) => (
                <button key={r} onClick={() => setRange(r)}
                  className={`text-[10px] px-2.5 py-1.5 border rounded font-bold tracking-wider transition-colors ${range === r ? 'ac-btn ac-bg-10' : `${th.border} ${th.textFaint} hover:ac-border-faint`}`}>
                  {label}
                </button>
              ))}
            </div>
            {/* Min wins */}
            <div className="flex items-center gap-2">
              <span className={`text-[10px] ${th.textFaint}`}>Min wins:</span>
              {[1,2,3].map(n => (
                <button key={n} onClick={() => setMinWins(n)}
                  className={`text-[10px] w-6 h-6 border rounded font-bold transition-colors ${minWins === n ? 'ac-btn ac-bg-10' : `${th.border} ${th.textFaint} hover:ac-border-faint`}`}>
                  {n}
                </button>
              ))}
            </div>
            {profiles.length > 0 && (
              <span className={`text-[10px] ${th.textFaint}`}>
                {profiles.length} symbol{profiles.length !== 1 ? 's' : ''} with ≥{minWins} win{minWins !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">

            <button onClick={runScan} disabled={loading || profiles.length === 0}
              className="text-[10px] px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded font-bold tracking-wider transition-colors">
              {loading ? '↺ Scanning...' : '▶ Run Scan'}
            </button>
          </div>
        </div>
      </div>

      <div className="px-6 py-4 max-w-[1600px] mx-auto space-y-4 pb-24">

        {/* Status */}
        {(loading || status) && (
          <div className="flex items-center gap-3 p-3 rounded-lg border border-blue-500/20 bg-blue-500/5">
            {loading && <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0" />}
            <p className={`text-xs ${th.textFaint}`}>{status || 'Scanning...'}</p>
          </div>
        )}
        {error && <div className="p-3 rounded-lg border border-red-500/40 bg-red-500/8"><p className="text-xs text-red-400">{error}</p></div>}

        {/* Empty state */}
        {!loading && results.length === 0 && profiles.length === 0 && (
          <div className={`text-center py-16 ${th.textFaint}`}>
            <div className="text-4xl mb-3 opacity-20">↺</div>
            <p className="text-sm font-medium">No winning trades found in the last {range === '3m' ? '3 months' : range === '6m' ? '6 months' : '12 months'}</p>
            <p className="text-[10px] mt-2 opacity-60">Make sure your Trade Log is synced, or try a longer range.</p>
            <Link href="/trade-log" className="inline-block mt-3 text-[10px] text-blue-400 hover:ac-text underline">Go to Trade Log →</Link>
          </div>
        )}

        {!loading && results.length === 0 && profiles.length > 0 && (
          <div className={`text-center py-12 ${th.textFaint}`}>
            <p className="text-sm">Found {profiles.length} symbol{profiles.length !== 1 ? 's' : ''} with winning history.</p>
            <p className="text-[10px] mt-1 opacity-60">Hit Run Scan to find current setups tuned to your winning trades.</p>
          </div>
        )}

        {/* Results */}
        {results.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center gap-4 text-[10px] tracking-wider">
              <span className="text-emerald-400 font-medium">{qualified.length} OPPORTUNITIES FOUND</span>
              {unqualified.length > 0 && <span className={`${th.textFaint}`}>{unqualified.length} NO SETUP</span>}
            </div>

            {qualified.length > 0 && (
              <div className="space-y-2">
                {qualified.map(r => (
                  <RRCard key={r.profile.symbol} result={r} th={th} existingPositions={existingPositions} />
                ))}
              </div>
            )}

            {unqualified.length > 0 && (
              <div>
                <p className={`text-[9px] ${th.textFaint} tracking-widest mb-2 font-medium`}>NO QUALIFYING SETUP TODAY</p>
                <div className="space-y-2">
                  {unqualified.map(r => (
                    <RRCard key={r.profile.symbol} result={r} th={th} existingPositions={existingPositions} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
