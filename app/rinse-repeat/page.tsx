// path: app/rinse-repeat/page.tsx
'use client';
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
const LS_THEME   = 'hunter-theme';
const LS_TL_3M   = 'hunter-tradelog-3m';
const LS_TL_6M   = 'hunter-tradelog-6m';
const LS_TL_12M  = 'hunter-tradelog-12m';
const INDEX_TICKERS = new Set(['SPY','QQQ','IWM','DIA','GLD','SLV','TLT','HYG','LQD','XLF','XLK','XLE','XLV','XLI','XLP','XLU','XLB','XLRE','XLC','XLY','EEM','EFA','VXX','UVXY','ARKK','SMH','SOXX','XBI','IBB','GDX']);

// ── Theme ─────────────────────────────────────────────────────────────────
type Theme = 'dark' | 'medium' | 'light';
const THEMES = {
  dark:   { bg: 'bg-[#0a0a0a]', sidebar: 'bg-[#0f0f0f]', card: 'bg-[#171717]', border: 'border-[#2c2c2c]', borderLight: 'border-[#202020]', header: 'bg-[#0f0f0f]', text: 'text-white', textMuted: 'text-[#e0e0e0]', textFaint: 'text-[#808080]', input: 'bg-[#141414]', inputBorder: 'border-[#353535]', label: 'text-[#aaaaaa]' },
  medium: { bg: 'bg-[#141414]', sidebar: 'bg-[#1a1a1a]', card: 'bg-[#202020]', border: 'border-[#333333]', borderLight: 'border-[#282828]', header: 'bg-[#1a1a1a]', text: 'text-white', textMuted: 'text-[#d8d8d8]', textFaint: 'text-[#777777]', input: 'bg-[#1e1e1e]', inputBorder: 'border-[#3a3a3a]', label: 'text-[#999999]' },
  light:  { bg: 'bg-[#f5f5f5]', sidebar: 'bg-white', card: 'bg-white', border: 'border-[#e0e0e0]', borderLight: 'border-[#ebebeb]', header: 'bg-[#111111]', text: 'text-[#111111]', textMuted: 'text-[#1a1a1a]', textFaint: 'text-[#666666]', input: 'bg-white', inputBorder: 'border-[#cccccc]', label: 'text-[#444444]' },
};
function getSavedTheme(): Theme {
  try { const t = localStorage.getItem(LS_THEME); return (t === 'dark' || t === 'medium' || t === 'light') ? t : 'dark'; } catch { return 'dark'; }
}

// ── Types ─────────────────────────────────────────────────────────────────
type TimeRange = '3m' | '6m' | '12m';

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
  const key = range === '3m' ? LS_TL_3M : range === '6m' ? LS_TL_6M : LS_TL_12M;
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

  // DTE range centered on their winning entry DTE
  const dte = Math.max(14, Math.min(60, profile.avgDteAtEntry));
  base.DTE_MIN = Math.max(14, dte - 8);
  base.DTE_MAX = Math.min(60, dte + 8);

  // Spread width cap: 2x their avg winning width, min $5
  const maxWidth = Math.max(5, Math.round(profile.avgSpreadWidth * 2 / 5) * 5);
  base.MAX_SPREAD_WIDTH = Math.min(200, maxWidth);

  // Credit ratio: slightly relaxed from their historical avg
  base.CREDIT_RATIO_MIN = Math.max(0.20, (profile.avgCreditRatio ?? 0.33) * 0.85);

  // Relax IVR slightly for ETFs/indexes
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
  if (s === 'IC')  return 'text-blue-400 border-blue-600 bg-blue-500/10';
  return 'text-slate-400 border-slate-600 bg-slate-500/10';
}
function scoreColor(s: number) {
  if (s >= 70) return { text: 'text-emerald-400', border: 'border-emerald-600', bg: 'bg-emerald-500/10', label: 'Strong' };
  if (s >= 50) return { text: 'text-yellow-400',  border: 'border-yellow-600',  bg: 'bg-yellow-500/10',  label: 'Good' };
  if (s >= 35) return { text: 'text-orange-400',  border: 'border-orange-600',  bg: 'bg-orange-500/10',  label: 'Weak' };
  return           { text: 'text-red-400',    border: 'border-red-600',    bg: 'bg-red-500/10',    label: 'Poor' };
}

// ── Result Card ───────────────────────────────────────────────────────────
function RRCard({ result, th, onAddToHunter }: {
  result: RRResult;
  th: typeof THEMES[Theme];
  onAddToHunter: (symbol: string, strategy: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { profile, candidate: c, currentIvr, currentPrice, rrScore, qualified } = result;
  const sc = scoreColor(rrScore);
  const wins = profile.trades.filter(t => t.outcome === 'WIN');
  const losses = profile.trades.filter(t => t.outcome === 'LOSS');

  return (
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
          <a href={`https://www.tradingview.com/chart/?symbol=${profile.symbol}`} target="_blank" rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className={`text-[9px] ${th.textFaint} hover:text-blue-400 transition-colors`}>chart ↗</a>
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
          <button
            onClick={e => { e.stopPropagation(); onAddToHunter(profile.symbol, profile.preferredStrategy); }}
            className={`text-[9px] px-2.5 py-1 border border-blue-700 text-blue-400 rounded hover:border-blue-500 hover:bg-blue-500/10 transition-colors`}>
            + Add to Hunter
          </button>
          <span className={`text-[10px] ${th.textFaint}`}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

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
  );
}

// ── Main ──────────────────────────────────────────────────────────────────
export default function RinseRepeatPage() {
  const [theme, setTheme]     = useState<Theme>(getSavedTheme);
  const th = THEMES[theme];
  const [range, setRange]     = useState<TimeRange>('6m');
  const [results, setResults] = useState<RRResult[]>([]);
  const [profiles, setProfiles] = useState<WinningProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus]   = useState('');
  const [error, setError]     = useState('');
  const [minWins, setMinWins] = useState(1);
  const [hunterQueue, setHunterQueue] = useState<{ symbol: string; strategy: string }[]>([]);
  const [addedToHunter, setAddedToHunter] = useState(false);

  // Load profiles from cache on mount/range change
  useEffect(() => {
    const trades = loadTradesFromCache(range);
    if (trades.length === 0) { setProfiles([]); return; }
    const p = buildProfiles(trades, minWins);
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

  const handleAddToHunter = (symbol: string, strategy: string) => {
    setHunterQueue(prev => {
      const exists = prev.find(h => h.symbol === symbol);
      return exists ? prev : [...prev, { symbol, strategy }];
    });
  };

  const sendToHunter = () => {
    if (hunterQueue.length === 0) return;
    const bps = hunterQueue.filter(h => h.strategy === 'BPS').map(h => h.symbol).join(', ');
    const bcs = hunterQueue.filter(h => h.strategy === 'BCS').map(h => h.symbol).join(', ');
    const ic  = hunterQueue.filter(h => h.strategy === 'IC').map(h => h.symbol).join(', ');
    if (bps) try { localStorage.setItem('hunter-tickers-bps', bps); } catch {}
    if (bcs) try { localStorage.setItem('hunter-tickers-bcs', bcs); } catch {}
    if (ic)  try { localStorage.setItem('hunter-tickers-ic', ic);   } catch {}
    setAddedToHunter(true);
    setTimeout(() => setAddedToHunter(false), 3000);
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
            <span                       className="text-xs px-3 py-1.5 rounded bg-white/20 text-white tracking-wider">RINSE & REPEAT</span>
            <Link href="/trade-log"     className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">TRADE LOG</Link>
            <Link href="/performance"   className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">PERFORMANCE</Link>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          {(['dark','medium','light'] as Theme[]).map(t => (
            <button key={t} onClick={() => { setTheme(t); try { localStorage.setItem(LS_THEME, t); } catch {} }}
              className={`text-[9px] px-2 py-1 border rounded transition-colors ${theme === t ? 'border-blue-500 text-blue-400' : `${th.border} ${th.textFaint}`}`}>
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
              {(['3m','6m','12m'] as TimeRange[]).map(r => (
                <button key={r} onClick={() => setRange(r)}
                  className={`text-[10px] px-2.5 py-1.5 border rounded font-bold tracking-wider transition-colors ${range === r ? 'border-blue-500 text-blue-400 bg-blue-500/10' : `${th.border} ${th.textFaint} hover:border-blue-700`}`}>
                  {r === '3m' ? '3 MO' : r === '6m' ? '6 MO' : '12 MO'}
                </button>
              ))}
            </div>
            {/* Min wins */}
            <div className="flex items-center gap-2">
              <span className={`text-[10px] ${th.textFaint}`}>Min wins:</span>
              {[1,2,3].map(n => (
                <button key={n} onClick={() => setMinWins(n)}
                  className={`text-[10px] w-6 h-6 border rounded font-bold transition-colors ${minWins === n ? 'border-blue-500 text-blue-400 bg-blue-500/10' : `${th.border} ${th.textFaint} hover:border-blue-700`}`}>
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
            {hunterQueue.length > 0 && (
              <button onClick={sendToHunter}
                className={`text-[10px] px-3 py-1.5 border rounded font-bold tracking-wider transition-colors ${addedToHunter ? 'border-emerald-600 text-emerald-400' : 'border-blue-700 text-blue-400 hover:border-blue-500 hover:bg-blue-500/10'}`}>
                {addedToHunter ? `✓ Sent to Hunter` : `→ Send ${hunterQueue.length} to Hunter`}
              </button>
            )}
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
            <Link href="/trade-log" className="inline-block mt-3 text-[10px] text-blue-400 hover:text-blue-300 underline">Go to Trade Log →</Link>
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
                  <RRCard key={r.profile.symbol} result={r} th={th} onAddToHunter={handleAddToHunter} />
                ))}
              </div>
            )}

            {unqualified.length > 0 && (
              <div>
                <p className={`text-[9px] ${th.textFaint} tracking-widest mb-2 font-medium`}>NO QUALIFYING SETUP TODAY</p>
                <div className="space-y-2">
                  {unqualified.map(r => (
                    <RRCard key={r.profile.symbol} result={r} th={th} onAddToHunter={handleAddToHunter} />
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
