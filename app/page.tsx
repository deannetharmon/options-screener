'use client';
import { useState, useRef, useEffect, useCallback } from 'react';

// ── Theme ──────────────────────────────────────────────────────────────────
type Theme = 'dark' | 'medium' | 'light';
const LS_THEME = 'prosper-theme';

const THEMES: Record<Theme, {
  bg: string; sidebar: string; card: string; cardQualified: string;
  border: string; borderLight: string; header: string;
  text: string; textMuted: string; textFaint: string;
  input: string; inputBorder: string; tag: string;
  label: string;
}> = {
  dark: {
    bg: 'bg-[#080c14]',
    sidebar: 'bg-[#0d1117]',
    card: 'bg-slate-900/30',
    cardQualified: 'bg-slate-900/60',
    border: 'border-slate-700',
    borderLight: 'border-slate-800',
    header: 'bg-gradient-to-r from-[#0d1117] to-[#080c14]',
    text: 'text-white',
    textMuted: 'text-slate-200',
    textFaint: 'text-slate-400',
    input: 'bg-slate-900/80',
    inputBorder: 'border-slate-700',
    tag: 'bg-slate-800',
    label: 'text-slate-300',
  },
  medium: {
    bg: 'bg-[#1a1f2e]',
    sidebar: 'bg-[#1e2436]',
    card: 'bg-[#222840]/50',
    cardQualified: 'bg-[#222840]/80',
    border: 'border-slate-600',
    borderLight: 'border-slate-700',
    header: 'bg-gradient-to-r from-[#1e2436] to-[#1a1f2e]',
    text: 'text-white',
    textMuted: 'text-slate-200',
    textFaint: 'text-slate-400',
    input: 'bg-[#1a1f2e]',
    inputBorder: 'border-slate-600',
    tag: 'bg-slate-700',
    label: 'text-slate-300',
  },
    light: {
    bg: 'bg-slate-50',
    sidebar: 'bg-white',
    card: 'bg-white',
    cardQualified: 'bg-white',
    border: 'border-slate-300',
    borderLight: 'border-slate-200',
    header: 'bg-gradient-to-r from-slate-800 to-slate-950',
    text: 'text-slate-950',
    textMuted: 'text-slate-900',
    textFaint: 'text-slate-700',
    input: 'bg-slate-50',
    inputBorder: 'border-slate-400',
    tag: 'bg-slate-100',
    label: 'text-slate-950',
  },
};

// ── Types ──────────────────────────────────────────────────────────────────
interface CheckResult {
  status: 'pass' | 'fail' | 'warn' | 'pending';
  value: string;
  reason: string;
}
interface SpreadCandidate {
  strategy: string; expiration: string; dte: number;
  shortStrike: number; longStrike: number; shortDelta: number;
  credit: number; spreadWidth: number; creditRatio: number;
  roc: number; pop: number | null; shortOI: number; longOI: number;
  shortCallStrike?: number; longCallStrike?: number;
  callCredit?: number; callWidth?: number; totalCredit?: number; optimized?: boolean;
}
interface TrendResult {
  trend: 'uptrend' | 'downtrend' | 'sideways' | 'unknown';
  strategy: 'BPS' | 'BCS' | 'IC'; ma20: number; ma50: number; reason: string;
}
interface ScreenResult {
  symbol: string; strategy: string; price: number | null; ivr: number | null;
  qualified: boolean; bestCandidate: SpreadCandidate | null;
  failReasons: string[]; earningsDate?: string | null; trendResult?: TrendResult;
  checks: { ivr: CheckResult; earnings: CheckResult; oi: CheckResult; delta: CheckResult; credit: CheckResult; roc: CheckResult; };
}
interface FilterSuggestion {
  priority: number; rule: keyof RulesType; currentValue: number; suggestedValue: number;
  label: string; rationale: string; tradeoff: string; wouldQualify: number;
}
type SavedFilters = Record<string, string[]>;
type GlobalFilters = Record<string, { bps: string[]; bcs: string[]; ic: string[] }>;
interface LoadPromptState {
  show: boolean; name: string; type: 'strategy' | 'global'; onLoad?: (merge: boolean) => void;
}

// ── Rules ──────────────────────────────────────────────────────────────────
const DEFAULT_RULES = {
  IVR_MIN: 30, IVR_IC_MAX: 70, OI_MIN: 200, BID_ASK_MAX: 0.10,
  CREDIT_RATIO_MIN: 0.15, SPREAD_DELTA_MIN: 0.20, SPREAD_DELTA_MAX: 0.30,
  IC_DELTA_MIN: 0.16, IC_DELTA_MAX: 0.20, DTE_MIN: 30, DTE_MAX: 45,
  MAX_SPREAD_WIDTH: 50, ROC_MIN_SPREAD: 15, ROC_MIN_IC: 30,
};
type RulesType = typeof DEFAULT_RULES;

const RULE_LABELS: Record<string, string> = {
  IVR_MIN: 'IVR Min %', IVR_IC_MAX: 'IVR IC Max %', OI_MIN: 'Min Open Interest',
  BID_ASK_MAX: 'Max Bid-Ask $', CREDIT_RATIO_MIN: 'Min Credit Ratio',
  SPREAD_DELTA_MIN: 'Spread Delta Min', SPREAD_DELTA_MAX: 'Spread Delta Max',
  IC_DELTA_MIN: 'IC Delta Min', IC_DELTA_MAX: 'IC Delta Max',
  DTE_MIN: 'DTE Min', DTE_MAX: 'DTE Max', MAX_SPREAD_WIDTH: 'Max Spread Width $',
  ROC_MIN_SPREAD: 'Min ROC Spread %', ROC_MIN_IC: 'Min ROC IC %',
};

const LS_RULES = 'prosper-rules';
const AUTO_TICKER_LIMIT = 5;
const LS_BPS = 'prosper-tickers-bps';
const LS_BCS = 'prosper-tickers-bcs';
const LS_IC = 'prosper-tickers-ic';
const LS_BROKEN = 'prosper-tickers-broken';   // ← NEW
const LS_CAL = 'prosper-cal-scheduled';
const LS_CAL_ENTRY = 'prosper-cal-entry';
const DTE_ALERT_THRESHOLD = 25;
const SCREENER_URL = 'https://options-screener-dun.vercel.app';

function daysUntil(dateStr: string): number {
  const target = new Date(dateStr);
  const now = new Date();
  return Math.round((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}
function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
function getSavedRules(): RulesType {
  try { const saved = localStorage.getItem(LS_RULES); return saved ? { ...DEFAULT_RULES, ...JSON.parse(saved) } : { ...DEFAULT_RULES }; }
  catch { return { ...DEFAULT_RULES }; }
}
function saveRulesToStorage(rules: RulesType) {
  try { localStorage.setItem(LS_RULES, JSON.stringify(rules)); } catch {}
}
function getSavedTheme(): Theme {
  try { const t = localStorage.getItem(LS_THEME); return (t === 'dark' || t === 'medium' || t === 'light') ? t : 'dark'; }
  catch { return 'dark'; }
}

// ── Business day calculator ────────────────────────────────────────────────
function addBusinessDays(dateStr: string, days: number): Date {
  const date = new Date(dateStr);
  let added = 0;
  while (added < days) { date.setDate(date.getDate() + 1); const dow = date.getDay(); if (dow !== 0 && dow !== 6) added++; }
  return date;
}
function formatCalDate(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

// ── Google Calendar URLs ───────────────────────────────────────────────────
function buildEarningsCalUrl(symbol: string, strategy: string, earningsDate: string, ivr: number | null): string {
  const followUp = addBusinessDays(earningsDate, 2);
  const end = new Date(followUp); end.setDate(end.getDate() + 1);
  const title = encodeURIComponent(`Re-screen ${symbol} — earnings passed`);
  const details = encodeURIComponent(`${symbol} was blocked by earnings on ${earningsDate}.\n\nStrategy: ${strategy}\nIVR at screen time: ${ivr != null ? ivr.toFixed(1) + '%' : 'N/A'}\n\nChecklist:\n• IVR still ≥ 30%\n• No new earnings within 30-45 DTE\n• Chain liquidity\n• Credit ratio and ROC\n\nRe-screen: ${SCREENER_URL}`);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${formatCalDate(followUp)}/${formatCalDate(end)}&details=${details}`;
}
function buildEntryCalUrl(result: ScreenResult): string {
  const c = result.bestCandidate!;
  const followUp = addBusinessDays(new Date().toISOString().split('T')[0], 1);
  const end = new Date(followUp); end.setDate(end.getDate() + 1);
  const title = encodeURIComponent(`Enter trade — ${result.symbol} ${result.strategy}`);
  const details = encodeURIComponent(`Re-verify and enter if setup still valid:\n\nSymbol: ${result.symbol}\nStrategy: ${result.strategy}\nIVR: ${result.ivr?.toFixed(1)}%\nExpiration: ${c.expiration} (${c.dte}d)\nStrikes: ${c.shortStrike}/${c.longStrike} ·$${c.spreadWidth}·\nCredit: $${(c.totalCredit ?? c.credit).toFixed(2)}\nROC: ${c.roc.toFixed(0)}%\nDelta: ${c.shortDelta.toFixed(2)}\n\nChecklist:\n• IVR still ≥ 30%\n• No new earnings\n• Credit and ROC still qualify\n• Enter GTC at 50% profit immediately after fill\n\nRe-screen: ${SCREENER_URL}`);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${formatCalDate(followUp)}/${formatCalDate(end)}&details=${details}`;
}

// ── Width steps ────────────────────────────────────────────────────────────
function getWidthSteps(maxWidth: number, price: number | null): number[] {
  const minWidth = price == null ? 5 : price >= 500 ? 50 : price >= 200 ? 20 : price >= 100 ? 10 : 5;
  const steps: number[] = [];
  for (let w = minWidth; w <= maxWidth; w += minWidth) steps.push(w);
  return steps;
}
function getBidAskMax(price: number | null): number {
  if (price == null) return 1.50;
  if (price >= 500) return 3.00;
  if (price >= 200) return 1.50;
  if (price >= 100) return 0.50;
  return 0.10;
}

// ── Smart Suggestion Engine ────────────────────────────────────────────────
function generateSuggestions(results: ScreenResult[], rules: RulesType): FilterSuggestion[] {
  const disqualified = results.filter(r => !r.qualified);
  if (disqualified.length === 0) return [];
  const total = disqualified.length;
  const suggestions: FilterSuggestion[] = [];
  const dteFails = disqualified.filter(r => r.failReasons.some(f => f.includes('DTE') || f.includes('expirations'))).length;
  const ivrFails = disqualified.filter(r => r.failReasons.some(f => f.includes('IVR'))).length;
  const creditFails = disqualified.filter(r => r.checks.credit.status === 'fail' || r.failReasons.some(f => f.includes('qualifying strikes'))).length;
  const rocFails = disqualified.filter(r => r.checks.roc.status === 'fail').length;
  if (dteFails > 0 && rules.DTE_MAX < 60) {
    const suggestedDTE = Math.min(60, rules.DTE_MAX + 10);
    suggestions.push({ priority: 1, rule: 'DTE_MAX', currentValue: rules.DTE_MAX, suggestedValue: suggestedDTE, label: 'Expand DTE window', rationale: `${dteFails} of ${total} stocks have no expirations in your ${rules.DTE_MIN}–${rules.DTE_MAX} day window.`, tradeoff: 'Wider DTE captures monthly-only chains. Theta decay is slightly slower but risk profile is similar.', wouldQualify: dteFails });
  }
  if (ivrFails > total * 0.5) suggestions.push({ priority: 2, rule: 'IVR_MIN', currentValue: rules.IVR_MIN, suggestedValue: 20, label: 'Lower IVR minimum', rationale: `${ivrFails} stocks failed IVR ≥ ${rules.IVR_MIN}%. Market volatility may be suppressed.`, tradeoff: 'Lower IVR means less premium collected. Reduce position size to compensate.', wouldQualify: ivrFails });
  if (creditFails > 1 && rules.CREDIT_RATIO_MIN > 0.10) { const newRatio = Math.max(0.10, rules.CREDIT_RATIO_MIN - 0.05); suggestions.push({ priority: 3, rule: 'CREDIT_RATIO_MIN', currentValue: rules.CREDIT_RATIO_MIN, suggestedValue: newRatio, label: 'Relax credit ratio', rationale: `${creditFails} stocks couldn't generate enough credit relative to spread width.`, tradeoff: `Lowering to ${(newRatio * 100).toFixed(0)}% reduces minimum credit requirement. Only do this if IVR is elevated.`, wouldQualify: creditFails }); }
  if (rocFails > 0 && rules.ROC_MIN_SPREAD > 10) { const newROC = Math.max(10, rules.ROC_MIN_SPREAD - 5); suggestions.push({ priority: 4, rule: 'ROC_MIN_SPREAD', currentValue: rules.ROC_MIN_SPREAD, suggestedValue: newROC, label: 'Lower ROC minimum', rationale: `${rocFails} spreads found valid strikes but couldn't reach ${rules.ROC_MIN_SPREAD}% ROC.`, tradeoff: `${newROC}% ROC still profitable but leaves less cushion. Only accept if POP is strong (>70%).`, wouldQualify: rocFails }); }
  return suggestions.sort((a, b) => a.priority - b.priority);
}

// ── Saved Filters API ──────────────────────────────────────────────────────
async function loadFilters(strategy: string): Promise<SavedFilters | GlobalFilters> {
  try { const res = await fetch(`/api/filters?strategy=${strategy}`); const data = await res.json(); return data.filters ?? {}; }
  catch { return {}; }
}
async function saveFilter(strategy: string, name: string, payload: { tickers?: string[]; bps?: string[]; bcs?: string[]; ic?: string[] }, replace = false): Promise<{ success?: boolean; conflict?: boolean; message?: string }> {
  const res = await fetch('/api/filters', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategy, name, replace, ...payload }) });
  return res.json();
}
async function deleteFilter(strategy: string, name: string): Promise<void> {
  await fetch('/api/filters', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategy, name }) });
}

// ── Tesseract OCR ──────────────────────────────────────────────────────────
async function extractTickersFromImage(file: File): Promise<string[]> {
  const Tesseract = await import('tesseract.js');
  const { data: { text } } = await Tesseract.recognize(file, 'eng', { logger: () => {} });
  const blacklist = new Set(['USA','ETF','CEO','IPO','NYSE','NASDAQ','OTC','ADR','INC','LLC','LTD','PLC','THE','AND','FOR','REQ','BPS','BCS','PUT','CALL','OTM','ITM','ATM','IVR','DTE','ROC','POP','GTC','OCO','AI','AN','IS','IT','AT','OR','AS','BY','IN']);
  const tickers: string[] = [];
  const tickerPattern = /\b([A-Z]{2,5})\b/g;
  for (const line of text.split('\n')) { let match; while ((match = tickerPattern.exec(line)) !== null) { if (!blacklist.has(match[1])) tickers.push(match[1]); } }
  return Array.from(new Set(tickers));
}
function mergeTickers(existing: string, newTickers: string[]): string {
  const existingList = existing.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  const existingSet = new Set(existingList);
  const toAdd = newTickers.filter(t => !existingSet.has(t));
  if (toAdd.length === 0) return existing;
  return [...existingList, ...toAdd].join(', ');
}
function tickersToString(tickers: string[]): string { return tickers.join(', '); }

// ── Polygon API ────────────────────────────────────────────────────────────
async function getTrend(symbol: string): Promise<TrendResult> {
  const apiKey = process.env.NEXT_PUBLIC_POLYGON_API_KEY;
  if (!apiKey) throw new Error('NEXT_PUBLIC_POLYGON_API_KEY not set');
  const to = new Date(), from = new Date(); from.setMonth(from.getMonth() - 6);
  const res = await fetch(`https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${from.toISOString().split('T')[0]}/${to.toISOString().split('T')[0]}?adjusted=true&sort=asc&limit=150&apiKey=${apiKey}`);
  if (!res.ok) throw new Error(`Polygon fetch failed (${res.status})`);
  const data = await res.json();
  const bars: { c: number }[] = data.results ?? [];
  if (bars.length < 50) return { trend: 'unknown', strategy: 'BCS', ma20: 0, ma50: 0, reason: 'Not enough price history' };
  const closes = bars.map(b => b.c);
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const currentPrice = closes[closes.length - 1];
  const maDiff = (ma20 - ma50) / ma50, priceVsMa50 = (currentPrice - ma50) / ma50;
  if (Math.abs(maDiff) < 0.03 && Math.abs(priceVsMa50) < 0.07) return { trend: 'sideways', strategy: 'IC', ma20, ma50, reason: `20MA $${ma20.toFixed(2)} ≈ 50MA $${ma50.toFixed(2)} — range-bound` };
  if (maDiff > 0 && currentPrice > ma50) return { trend: 'uptrend', strategy: 'BPS', ma20, ma50, reason: `20MA $${ma20.toFixed(2)} > 50MA $${ma50.toFixed(2)} — uptrend` };
  return { trend: 'downtrend', strategy: 'BCS', ma20, ma50, reason: `20MA $${ma20.toFixed(2)} < 50MA $${ma50.toFixed(2)} — downtrend` };
}

// ── TastyTrade API ─────────────────────────────────────────────────────────
const BASE = 'https://api.tastytrade.com';
async function ttFetch(path: string, token: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) { const text = await res.text(); throw new Error(`${path} failed (${res.status}): ${text.slice(0, 200)}`); }
  return res.json();
}
async function getAccessToken(): Promise<string> {
  const r = process.env.NEXT_PUBLIC_TASTYTRADE_REFRESH_TOKEN, s = process.env.NEXT_PUBLIC_TASTYTRADE_CLIENT_SECRET, c = process.env.NEXT_PUBLIC_TASTYTRADE_CLIENT_ID;
  if (!r || !s || !c) throw new Error('TastyTrade credentials not configured');
  const res = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: r.trim(), client_id: c.trim(), client_secret: s.trim() }) });
  if (!res.ok) { const text = await res.text(); throw new Error(`Token refresh failed (${res.status}): ${text.slice(0, 200)}`); }
  return (await res.json()).access_token;
}
async function getMarketMetrics(symbols: string[], token: string) {
  const data = await ttFetch(`/market-metrics?symbols=${symbols.join(',')}`, token);
  return (data.data?.items || []).map((item: any) => ({ symbol: item.symbol, ivRank: item['implied-volatility-index-rank'] != null ? parseFloat(item['implied-volatility-index-rank']) * 100 : null, earningsExpectedDate: item['earnings']?.['expected-report-date'] || null }));
}
async function getQuote(symbol: string, token: string): Promise<number | null> {
  try {
    const data = await ttFetch(`/market-data/by-type?equity=${encodeURIComponent(symbol)}`, token);
    const item = data.data?.items?.[0]; if (!item) return null;
    const last = item.last != null ? parseFloat(item.last) : null;
    const bid = item.bid != null ? parseFloat(item.bid) : null;
    const ask = item.ask != null ? parseFloat(item.ask) : null;
    return last ?? (bid && ask ? (bid + ask) / 2 : null);
  } catch { return null; }
}
async function getChain(symbol: string, token: string, RULES: RulesType) {
  const nested = await ttFetch(`/option-chains/${symbol}/nested`, token);
  const expirations: string[] = [], chains: Record<string, any[]> = {}, allOCCSymbols: string[] = [];
  const symbolMeta: Record<string, { expDate: string; strike: number; optionType: string }> = {};
  for (const expGroup of nested?.data?.items?.[0]?.expirations ?? []) {
    const expDate: string = expGroup['expiration-date']; if (!expDate) continue;
    const dte = daysUntil(expDate); if (dte < RULES.DTE_MIN - 5 || dte > RULES.DTE_MAX + 5) continue;
    for (const strike of expGroup.strikes ?? []) {
      const strikePrice = parseFloat(strike['strike-price'] ?? '0');
      const callSym: string = strike['call'], putSym: string = strike['put'];
      if (callSym) { allOCCSymbols.push(callSym); symbolMeta[callSym] = { expDate, strike: strikePrice, optionType: 'C' }; }
      if (putSym) { allOCCSymbols.push(putSym); symbolMeta[putSym] = { expDate, strike: strikePrice, optionType: 'P' }; }
    }
  }
  if (allOCCSymbols.length === 0) return { expirations, chains };
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
      chains[meta.expDate].push({ strikePrice: meta.strike, expirationDate: meta.expDate, optionType: meta.optionType, delta, openInterest: oi, bid, ask, mid: (bid + ask) / 2 });
    }
  }
  expirations.sort(); return { expirations, chains };
}

// ── Screener Logic ─────────────────────────────────────────────────────────
function trySpreadAtWidth(legs: any[], strategy: 'BPS' | 'BCS', expDate: string, width: number, price: number | null, RULES: RulesType): SpreadCandidate | null {
  const bidAskMax = getBidAskMax(price);
  const sorted = strategy === 'BPS' ? [...legs].sort((a, b) => b.strikePrice - a.strikePrice) : [...legs].sort((a, b) => a.strikePrice - b.strikePrice);
  for (const shortLeg of sorted) {
    const delta = shortLeg.delta; if (delta == null) continue;
    const absDelta = Math.abs(delta);
    if (absDelta < RULES.SPREAD_DELTA_MIN || absDelta > RULES.SPREAD_DELTA_MAX) continue;
    if (shortLeg.openInterest < RULES.OI_MIN || shortLeg.ask - shortLeg.bid > bidAskMax) continue;
    const longStrike = strategy === 'BPS' ? shortLeg.strikePrice - width : shortLeg.strikePrice + width;
    const longLeg = legs.find((o: any) => Math.abs(o.strikePrice - longStrike) < 0.01);
    if (!longLeg || longLeg.openInterest < RULES.OI_MIN || longLeg.ask - longLeg.bid > bidAskMax) continue;
    const credit = parseFloat((shortLeg.mid - longLeg.mid).toFixed(2)); if (credit <= 0) continue;
    const creditRatio = credit / width; if (creditRatio < RULES.CREDIT_RATIO_MIN) continue;
    const maxLoss = width - credit; const roc = maxLoss > 0 ? (credit / maxLoss) * 100 : 0; if (roc < RULES.ROC_MIN_SPREAD) continue;
    return { strategy, expiration: expDate, dte: daysUntil(expDate), shortStrike: shortLeg.strikePrice, longStrike, shortDelta: absDelta, shortOI: shortLeg.openInterest, longOI: longLeg.openInterest, credit, spreadWidth: width, creditRatio, roc, pop: (1 - absDelta) * 100, optimized: true };
  }
  return null;
}
function findBestSpread(chain: any[], strategy: 'BPS' | 'BCS', expDate: string, price: number | null, RULES: RulesType): SpreadCandidate | null {
  const legs = chain.filter(o => o.expirationDate === expDate && o.optionType === (strategy === 'BPS' ? 'P' : 'C'));
  let best: SpreadCandidate | null = null;
  for (const width of getWidthSteps(RULES.MAX_SPREAD_WIDTH, price)) { const c = trySpreadAtWidth(legs, strategy, expDate, width, price, RULES); if (c && (best === null || c.roc > best.roc)) best = c; }
  return best;
}
function tryICSideAtWidth(legs: any[], side: 'put' | 'call', width: number, price: number | null, RULES: RulesType, minCallStrike?: number): { shortStrike: number; longStrike: number; shortDelta: number; credit: number; creditRatio: number; roc: number; shortOI: number; longOI: number } | null {
  const bidAskMax = getBidAskMax(price);
  const sorted = side === 'put' ? [...legs].sort((a, b) => b.strikePrice - a.strikePrice) : [...legs].sort((a, b) => a.strikePrice - b.strikePrice);
  for (const shortLeg of sorted) {
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
    return { shortStrike: shortLeg.strikePrice, longStrike, shortDelta: absDelta, credit, creditRatio, roc, shortOI: shortLeg.openInterest, longOI: longLeg.openInterest };
  }
  return null;
}
function findBestIC(chain: any[], expDate: string, price: number | null, RULES: RulesType): SpreadCandidate | null {
  const puts = chain.filter((o: any) => o.expirationDate === expDate && o.optionType === 'P');
  const calls = chain.filter((o: any) => o.expirationDate === expDate && o.optionType === 'C');
  const widthSteps = getWidthSteps(RULES.MAX_SPREAD_WIDTH, price);
  let bestPut: (ReturnType<typeof tryICSideAtWidth> & { width: number }) | null = null;
  for (const width of widthSteps) { const c = tryICSideAtWidth(puts, 'put', width, price, RULES); if (c && (bestPut === null || c.roc > bestPut.roc)) bestPut = { ...c, width }; }
  if (!bestPut) return null;
  let bestCall: (ReturnType<typeof tryICSideAtWidth> & { width: number }) | null = null;
  for (const width of widthSteps) { const c = tryICSideAtWidth(calls, 'call', width, price, RULES, bestPut.shortStrike); if (c && (bestCall === null || c.roc > bestCall.roc)) bestCall = { ...c, width }; }
  if (!bestCall) return null;
  const totalCredit = parseFloat((bestPut.credit + bestCall.credit).toFixed(2));
  const maxLoss = Math.max(bestPut.width - bestPut.credit, bestCall.width - bestCall.credit);
  const roc = maxLoss > 0 ? (totalCredit / maxLoss) * 100 : 0; if (roc < RULES.ROC_MIN_IC) return null;
  return { strategy: 'IC', expiration: expDate, dte: daysUntil(expDate), shortStrike: bestPut.shortStrike, longStrike: bestPut.longStrike, shortDelta: bestPut.shortDelta, shortOI: bestPut.shortOI, longOI: bestPut.longOI, credit: bestPut.credit, spreadWidth: bestPut.width, creditRatio: bestPut.creditRatio, roc, pop: (1 - bestPut.shortDelta - bestCall.shortDelta) * 100, shortCallStrike: bestCall.shortStrike, longCallStrike: bestCall.longStrike, callCredit: bestCall.credit, callWidth: bestCall.width, totalCredit, optimized: true };
}
function runChecklist(symbol: string, strategy: 'BPS' | 'BCS' | 'IC', metrics: any, chainData: { expirations: string[]; chains: Record<string, any[]> }, price: number | null, RULES: RulesType, trendResult?: TrendResult): ScreenResult {
  const failReasons: string[] = [], ivrValue = metrics.ivRank, earningsDate = metrics.earningsExpectedDate;
  const ivrCheck: CheckResult = ivrValue == null ? { status: 'warn', value: 'N/A', reason: 'Not available' } : ivrValue < RULES.IVR_MIN ? (() => { failReasons.push(`IVR ${ivrValue.toFixed(1)}% < ${RULES.IVR_MIN}%`); return { status: 'fail' as const, value: `${ivrValue.toFixed(1)}%`, reason: `Below ${RULES.IVR_MIN}% minimum` }; })() : { status: 'pass', value: `${ivrValue.toFixed(1)}%`, reason: 'Above minimum' };
  let earningsCheck: CheckResult;
  if (!earningsDate) { earningsCheck = { status: 'pass', value: 'None found', reason: 'Safe to trade' }; }
  else { const d = daysUntil(earningsDate); if (d < 0) { earningsCheck = { status: 'pass', value: `${earningsDate} (past)`, reason: 'Already reported' }; } else if (d < 30) { failReasons.push(`Earnings in ${d}d`); earningsCheck = { status: 'fail', value: `${d}d (${earningsDate})`, reason: 'Within expiry window' }; } else { earningsCheck = { status: 'pass', value: `${d}d (${earningsDate})`, reason: 'Outside expiry window' }; } }
  const validExpirations = chainData.expirations.filter(exp => { const dte = daysUntil(exp); if (dte < RULES.DTE_MIN || dte > RULES.DTE_MAX) return false; if (earningsDate) { const ed = daysUntil(earningsDate); if (ed >= 0 && ed <= dte) return false; } return true; });
  let bestCandidate: SpreadCandidate | null = null;
  if (ivrCheck.status !== 'fail' && earningsCheck.status !== 'fail' && validExpirations.length > 0) { for (const exp of validExpirations) { const chainItems = chainData.chains[exp] || []; bestCandidate = strategy === 'IC' ? findBestIC(chainItems, exp, price, RULES) : findBestSpread(chainItems, strategy, exp, price, RULES); if (bestCandidate) break; } }
  if (!bestCandidate && validExpirations.length === 0 && !failReasons.some(r => r.includes('IVR') || r.includes('Earnings'))) failReasons.push('No 30-45 DTE expirations');
  else if (!bestCandidate && validExpirations.length > 0 && !failReasons.length) failReasons.push('No qualifying strikes found');
  const oiCheck: CheckResult = bestCandidate ? { status: 'pass', value: `${bestCandidate.shortOI}/${bestCandidate.longOI}`, reason: `Both legs ≥ ${RULES.OI_MIN}` } : { status: 'fail', value: 'None', reason: failReasons[failReasons.length - 1] || 'No candidate' };
  const deltaCheck: CheckResult = bestCandidate ? { status: 'pass', value: bestCandidate.shortDelta.toFixed(2), reason: 'Within target range' } : { status: 'pending', value: '—', reason: 'No candidate' };
  const creditCheck: CheckResult = bestCandidate ? { status: 'pass', value: `$${(bestCandidate.totalCredit ?? bestCandidate.credit).toFixed(2)}`, reason: `${(bestCandidate.creditRatio * 100).toFixed(0)}% of width` } : { status: 'pending', value: '—', reason: 'No candidate' };
  const rocMin = strategy === 'IC' ? RULES.ROC_MIN_IC : RULES.ROC_MIN_SPREAD;
  const rocCheck: CheckResult = bestCandidate ? { status: bestCandidate.roc >= rocMin ? 'pass' : 'fail', value: `${bestCandidate.roc.toFixed(0)}%`, reason: `Min ${rocMin}%` } : { status: 'pending', value: '—', reason: 'No candidate' };
  const qualified = ivrCheck.status === 'pass' && earningsCheck.status === 'pass' && oiCheck.status === 'pass' && deltaCheck.status === 'pass' && creditCheck.status === 'pass' && rocCheck.status === 'pass' && bestCandidate !== null;
  return { symbol, strategy, price, ivr: ivrValue, qualified, bestCandidate, failReasons, earningsDate, trendResult, checks: { ivr: ivrCheck, earnings: earningsCheck, oi: oiCheck, delta: deltaCheck, credit: creditCheck, roc: rocCheck } };
}

// ── UI Helpers ─────────────────────────────────────────────────────────────
const statusColor = (s: string) => s === 'pass' ? 'text-emerald-500' : s === 'fail' ? 'text-red-500' : s === 'warn' ? 'text-yellow-500' : 'text-slate-400';
const statusIcon = (s: string) => s === 'pass' ? '✓' : s === 'fail' ? '✗' : s === 'warn' ? '⚠' : '—';
const trendColor = (t: string) => t === 'uptrend' ? 'text-emerald-500' : t === 'downtrend' ? 'text-red-500' : t === 'sideways' ? 'text-blue-500' : 'text-slate-400';
const trendIcon = (t: string) => t === 'uptrend' ? '↑' : t === 'downtrend' ? '↓' : t === 'sideways' ? '→' : '?';
const strategyAccent = (s: string) => s === 'BPS' ? 'border-l-4 border-l-emerald-500' : s === 'BCS' ? 'border-l-4 border-l-red-500' : 'border-l-4 border-l-blue-500';

// ── Theme Toggle ───────────────────────────────────────────────────────────
function ThemeToggle({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const options: { value: Theme; icon: string; label: string }[] = [
    { value: 'light', icon: '☀', label: 'Light' },
    { value: 'medium', icon: '◐', label: 'Medium' },
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

// ── Calendar Buttons ───────────────────────────────────────────────────────
function CalendarButton({ symbol, strategy, earningsDate, ivr, th }: { symbol: string; strategy: string; earningsDate: string; ivr: number | null; th: typeof THEMES[Theme] }) {
  const key = `${symbol}-${earningsDate}`;
  const [scheduled, setScheduled] = useState(() => { try { const s = localStorage.getItem(LS_CAL); return s ? JSON.parse(s)[key] === true : false; } catch { return false; } });
  const handleClick = () => {
    window.open(buildEarningsCalUrl(symbol, strategy, earningsDate, ivr), '_blank');
    try { const s = localStorage.getItem(LS_CAL); const all = s ? JSON.parse(s) : {}; all[key] = true; localStorage.setItem(LS_CAL, JSON.stringify(all)); } catch {}
    setScheduled(true);
  };
  if (scheduled) return <span className="text-[9px] text-emerald-500 border border-emerald-600 rounded px-1.5 py-0.5 font-medium">✓ scheduled</span>;
  return <button onClick={handleClick} className={`text-[9px] px-1.5 py-0.5 border ${th.inputBorder} rounded ${th.textMuted} hover:border-blue-500 hover:text-blue-400 transition-colors font-medium`} title={`Schedule follow-up 2 business days after earnings (${earningsDate})`}>📅 follow up</button>;
}
function EntryCalendarButton({ result, th }: { result: ScreenResult; th: typeof THEMES[Theme] }) {
  const key = `entry-${result.symbol}-${result.bestCandidate?.expiration}`;
  const [scheduled, setScheduled] = useState(() => { try { const s = localStorage.getItem(LS_CAL_ENTRY); return s ? JSON.parse(s)[key] === true : false; } catch { return false; } });
  const handleClick = () => {
    window.open(buildEntryCalUrl(result), '_blank');
    try { const s = localStorage.getItem(LS_CAL_ENTRY); const all = s ? JSON.parse(s) : {}; all[key] = true; localStorage.setItem(LS_CAL_ENTRY, JSON.stringify(all)); } catch {}
    setScheduled(true);
  };
  if (scheduled) return <span className="text-[9px] text-emerald-500 border border-emerald-600 rounded px-1.5 py-0.5 font-medium">✓ entry scheduled</span>;
  return <button onClick={handleClick} className={`text-[9px] px-1.5 py-0.5 border ${th.inputBorder} rounded ${th.textMuted} hover:border-emerald-500 hover:text-emerald-400 transition-colors font-medium`} title="Schedule trade entry for next business day">📅 enter tomorrow</button>;
}

// ── DTE Alert Banner ───────────────────────────────────────────────────────
function DTEAlertBanner({ results }: { results: ScreenResult[] }) {
  const approaching = results.filter(r => r.qualified && r.bestCandidate && r.bestCandidate.dte <= DTE_ALERT_THRESHOLD);
  if (approaching.length === 0) return null;
  return (
    <div className="border border-yellow-500/50 bg-yellow-500/10 rounded-lg px-4 py-3 flex items-start gap-3">
      <span className="text-yellow-400 text-base mt-0.5">⚠</span>
      <div className="flex-1">
        <p className="text-xs text-yellow-400 font-bold tracking-wider mb-1">APPROACHING 21 DTE — ACTION REQUIRED</p>
        <p className="text-[10px] text-yellow-300 mb-2">Close these positions regardless of profit/loss when they hit 21 DTE.</p>
        <div className="flex flex-wrap gap-2">
          {approaching.map(r => (
            <span key={r.symbol} className="text-[10px] bg-yellow-500/10 border border-yellow-600 rounded px-2 py-0.5 text-yellow-300 font-medium">
              {r.symbol} {r.bestCandidate?.expiration} — <span className={r.bestCandidate!.dte <= 21 ? 'text-red-400 font-bold' : 'text-yellow-400'}>{r.bestCandidate?.dte}d</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Smart Suggestions Panel ────────────────────────────────────────────────
function SmartSuggestionsPanel({ results, rules, th, onApplyAndRerun }: { results: ScreenResult[]; rules: RulesType; th: typeof THEMES[Theme]; onApplyAndRerun: (r: RulesType) => void }) {
  const [expanded, setExpanded] = useState(false);
  const disqualified = results.filter(r => !r.qualified);
  const earningsFails = disqualified.filter(r => r.failReasons.some(f => f.includes('Earnings'))).length;
  if (disqualified.length === 0 || results.length === 0) return null;
  const suggestions = generateSuggestions(results, rules);
  if (suggestions.length === 0 && earningsFails === 0) return null;
  return (
    <div className={`border ${th.border} ${th.card} rounded-lg overflow-hidden`}>
      <button onClick={() => setExpanded(!expanded)} className={`w-full px-4 py-3 flex items-center justify-between hover:bg-blue-500/5 transition-colors`}>
        <div className="flex items-center gap-2">
          <span className="text-blue-400 text-sm">◈</span>
          <div className="text-left">
            <p className={`text-xs font-bold tracking-wider ${th.text}`}>FILTER SUGGESTIONS</p>
            <p className={`text-[9px] ${th.textFaint}`}>{suggestions.length} suggestion{suggestions.length !== 1 ? 's' : ''} · {disqualified.length} disqualified stocks analyzed</p>
          </div>
        </div>
        <span className={`${th.textFaint} text-xs`}>{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className={`border-t ${th.border} px-4 py-3 space-y-3`}>
          {earningsFails > 0 && (
            <div className={`flex items-start gap-2 p-2 ${th.tag} rounded border ${th.borderLight}`}>
              <span className={`${th.textFaint} text-xs mt-0.5`}>ℹ</span>
              <div>
                <p className={`text-[10px] ${th.textMuted} font-medium`}>{earningsFails} stock{earningsFails !== 1 ? 's' : ''} blocked by upcoming earnings</p>
                <p className={`text-[9px] ${th.textFaint}`}>Earnings filter is a hard rule. Use the 📅 follow up button to schedule a re-screen.</p>
              </div>
            </div>
          )}
          {suggestions.map((s, i) => (
            <div key={i} className={`border ${th.border} rounded p-3 space-y-2`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[9px] bg-blue-500/20 text-blue-400 border border-blue-600 rounded px-1.5 py-0.5 font-medium">#{s.priority}</span>
                    <p className={`text-xs ${th.text} font-medium`}>{s.label}</p>
                  </div>
                  <p className={`text-[10px] ${th.textMuted} mb-1`}>{s.rationale}</p>
                  <p className={`text-[9px] ${th.textFaint} italic`}>⚖ {s.tradeoff}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className={`text-[9px] ${th.textFaint}`}>{RULE_LABELS[s.rule]}</p>
                  <p className={`text-xs ${th.textFaint} line-through`}>{s.currentValue}</p>
                  <p className="text-xs text-emerald-500 font-bold">→ {s.suggestedValue}</p>
                  <p className={`text-[9px] ${th.textFaint}`}>+{s.wouldQualify} stocks</p>
                </div>
              </div>
              <button onClick={() => onApplyAndRerun({ ...rules, [s.rule]: s.suggestedValue })} className="w-full text-[9px] py-1.5 border border-blue-600 text-blue-400 rounded hover:bg-blue-500/10 transition-colors font-medium tracking-wider">APPLY & RE-RUN</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Load Prompt Modal ──────────────────────────────────────────────────────
function LoadPromptModal({ state, onClose, th }: { state: LoadPromptState; onClose: () => void; th: typeof THEMES[Theme] }) {
  if (!state.show) return null;
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className={`${th.sidebar} border ${th.border} rounded-xl p-5 w-80 shadow-2xl`}>
        <h3 className={`text-xs font-bold ${th.text} mb-1 tracking-wider`}>LOAD {state.type === 'global' ? 'SESSION' : 'FILTER'}</h3>
        <p className={`text-[10px] ${th.textMuted} mb-4`}>Load <span className={`${th.text} font-medium`}>"{state.name}"</span> — how should it be applied?</p>
        <div className="space-y-2 mb-4">
          <button onClick={() => { state.onLoad?.(false); onClose(); }} className={`w-full text-left px-3 py-2.5 border ${th.border} rounded-lg hover:bg-blue-500/10 hover:border-blue-500 transition-colors`}>
            <p className={`text-xs ${th.text} font-medium`}>Replace</p>
            <p className={`text-[9px] ${th.textFaint} mt-0.5`}>Clear current tickers and load this {state.type === 'global' ? 'session' : 'filter'}</p>
          </button>
          <button onClick={() => { state.onLoad?.(true); onClose(); }} className={`w-full text-left px-3 py-2.5 border ${th.border} rounded-lg hover:bg-blue-500/10 hover:border-blue-500 transition-colors`}>
            <p className={`text-xs ${th.text} font-medium`}>Merge</p>
            <p className={`text-[9px] ${th.textFaint} mt-0.5`}>Add tickers from this {state.type === 'global' ? 'session' : 'filter'} to existing ones</p>
          </button>
        </div>
        <button onClick={onClose} className={`w-full text-[10px] ${th.textFaint} hover:${th.textMuted} transition-colors py-1`}>Cancel</button>
      </div>
    </div>
  );
}

// ── Sessions Panel ─────────────────────────────────────────────────────────
function SessionsPanel({ bps, bcs, ic, onLoadAll, onLoadPrompt, th }: { bps: string; bcs: string; ic: string; onLoadAll: (bps: string, bcs: string, ic: string) => void; onLoadPrompt: (state: Omit<LoadPromptState, 'show'>) => void; th: typeof THEMES[Theme] }) {
  const [globalFilters, setGlobalFilters] = useState<GlobalFilters>({});
  const [showSave, setShowSave] = useState(false);
  const [showLoad, setShowLoad] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveError, setSaveError] = useState('');
  const parseTickers = (input: string) => input.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  const refreshFilters = useCallback(async () => { const f = await loadFilters('global') as GlobalFilters; setGlobalFilters(f); }, []);
  useEffect(() => { refreshFilters(); }, [refreshFilters]);
  const handleSave = async (replace = false) => {
    if (!saveName.trim()) { setSaveError('Enter a session name'); return; }
    const result = await saveFilter('global', saveName.trim(), { bps: parseTickers(bps), bcs: parseTickers(bcs), ic: parseTickers(ic) }, replace);
    if (result.conflict) { setSaveError(`"${saveName}" exists — replace?`); return; }
    await refreshFilters(); setShowSave(false); setSaveName(''); setSaveError('');
  };
  const handleLoadSelect = (name: string) => {
    const session = globalFilters[name]; if (!session) return; setShowLoad(false);
    onLoadPrompt({ name, type: 'global', onLoad: (doMerge: boolean) => { if (doMerge) onLoadAll(mergeTickers(bps, session.bps), mergeTickers(bcs, session.bcs), mergeTickers(ic, session.ic)); else onLoadAll(tickersToString(session.bps), tickersToString(session.bcs), tickersToString(session.ic)); } });
  };
  const handleDelete = async (name: string) => { await deleteFilter('global', name); await refreshFilters(); };
  const filterNames = Object.keys(globalFilters);
  return (
    <div className={`border-t ${th.border} pt-3`}>
      <p className={`text-[9px] ${th.textMuted} tracking-widest font-medium mb-2`}>SESSIONS</p>
      <div className="flex gap-2">
        <button onClick={() => onLoadAll('', '', '')} className={`text-[9px] px-2 py-1.5 border border-red-800 rounded-lg text-red-500 hover:border-red-500 hover:text-red-400 transition-colors font-medium flex items-center justify-center gap-1 shrink-0`}>✕ Clear</button>
        <div className="relative flex-1">
          <button onClick={() => { setShowSave(!showSave); setShowLoad(false); setSaveError(''); }} className={`w-full text-[9px] px-2 py-1.5 border ${th.inputBorder} rounded-lg ${th.textMuted} hover:border-blue-500 hover:text-blue-400 transition-colors font-medium flex items-center justify-center gap-1`}>💾 Save Session</button>
          {showSave && (
            <div className={`absolute top-8 left-0 z-40 ${th.sidebar} border ${th.border} rounded-lg p-2 w-56 shadow-xl`}>
              <p className={`text-[9px] ${th.textFaint} mb-1.5`}>Saves all three scan lists as one session</p>
              <div className="flex gap-1 mb-1">
                <input type="text" value={saveName} onChange={e => { setSaveName(e.target.value); setSaveError(''); }} placeholder="Session name..." onKeyDown={e => e.key === 'Enter' && handleSave()}
                  className={`flex-1 ${th.input} border ${th.inputBorder} rounded px-2 py-1 text-[10px] ${th.text} focus:outline-none focus:border-blue-500 placeholder-slate-500`} />
                <button onClick={() => handleSave()} className="text-[9px] px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium transition-colors">Save</button>
              </div>
              {saveError && (<div className="flex gap-1 items-center mt-1"><span className="text-[9px] text-yellow-400">{saveError}</span>{saveError.includes('exists') && <button onClick={() => handleSave(true)} className="text-[9px] px-1.5 py-0.5 bg-yellow-600 hover:bg-yellow-500 text-white rounded font-medium">Replace</button>}</div>)}
            </div>
          )}
        </div>
        <div className="relative flex-1">
          <button onClick={() => { setShowLoad(!showLoad); setShowSave(false); if (!showLoad) refreshFilters(); }} className={`w-full text-[9px] px-2 py-1.5 border ${th.inputBorder} rounded-lg ${th.textMuted} hover:border-blue-500 hover:text-blue-400 transition-colors font-medium flex items-center justify-center gap-1`}>▼ Load Session</button>
          {showLoad && (
            <div className={`absolute top-8 right-0 z-40 ${th.sidebar} border ${th.border} rounded-lg overflow-hidden w-56 shadow-xl`}>
              {filterNames.length === 0 ? <p className={`text-[9px] ${th.textFaint} px-3 py-2`}>No saved sessions yet</p>
                : filterNames.map(name => (
                  <div key={name} className={`flex items-center justify-between px-3 py-2 hover:bg-blue-500/10 group cursor-pointer`}>
                    <button onClick={() => handleLoadSelect(name)} className={`text-[10px] ${th.textMuted} hover:${th.text} text-left flex-1 font-medium`}>{name}</button>
                    <button onClick={() => handleDelete(name)} className="text-[9px] text-slate-500 hover:text-red-500 ml-2 opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Strategy Box ──────────────────────────────────────────────────────────
function StrategyBox({ label, badge, badgeColor, borderFocus, value, onChange, strategy, disabled, onLoadPrompt, th }: { 
  label: string; 
  badge: string; 
  badgeColor: string; 
  borderFocus: string; 
  value: string; 
  onChange: (v: string) => void; 
  strategy: 'BPS' | 'BCS' | 'IC' | 'broken';   // ← updated type
  disabled?: boolean; 
  onLoadPrompt: (state: Omit<LoadPromptState, 'show'>) => void; 
  th: typeof THEMES[Theme] 
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingTickersRef = useRef<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [savedFilters, setSavedFilters] = useState<SavedFilters>({});
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveError, setSaveError] = useState('');
  const [showLoad, setShowLoad] = useState(false);
  const [loadingFilters, setLoadingFilters] = useState(false);
  const parseTickers = (input: string) => input.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  const refreshFilters = useCallback(async () => { setLoadingFilters(true); const f = await loadFilters(strategy) as SavedFilters; setSavedFilters(f); setLoadingFilters(false); }, [strategy]);
  useEffect(() => { refreshFilters(); }, [refreshFilters]);

  const handleImgClick = () => {
    if (fileRef.current) fileRef.current.value = '';
    fileRef.current?.click();
  };

  const handleOCR = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return; setScanning(true);
    try {
      const tickers = await extractTickersFromImage(file);
      if (tickers.length > 0) {
        const hasExisting = parseTickers(value).length > 0;
        if (hasExisting) {
          pendingTickersRef.current = tickers;
          onLoadPrompt({
            name: `${tickers.length} ticker${tickers.length !== 1 ? 's' : ''} from image`,
            type: 'strategy',
            onLoad: (doMerge: boolean) => {
              if (doMerge) onChange(mergeTickers(value, pendingTickersRef.current));
              else onChange(tickersToString(pendingTickersRef.current));
            },
          });
        } else {
          onChange(tickersToString(tickers));
        }
      }
    } catch (err) { console.error(err); }
    setScanning(false);
  };

  const handleSave = async (replace = false) => {
    if (!saveName.trim()) { setSaveError('Enter a name'); return; }
    const tickers = parseTickers(value); if (tickers.length === 0) { setSaveError('No tickers to save'); return; }
    const result = await saveFilter(strategy, saveName.trim(), { tickers }, replace);
    if (result.conflict) { setSaveError(`"${saveName}" exists — replace?`); return; }
    await refreshFilters(); setShowSaveInput(false); setSaveName(''); setSaveError('');
  };
  const handleLoadSelect = (name: string) => {
    const tickers = savedFilters[name] ?? []; setShowLoad(false);
    onLoadPrompt({ name, type: 'strategy', onLoad: (doMerge: boolean) => { if (doMerge) onChange(mergeTickers(value, tickers)); else onChange(tickersToString(tickers)); } });
  };
  const handleDelete = async (name: string) => { await deleteFilter(strategy, name); await refreshFilters(); };
  const filterNames = Object.keys(savedFilters);
  const hasValue = parseTickers(value).length > 0;
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className={`text-[9px] px-1.5 py-0.5 rounded-md tracking-wider border font-bold ${badgeColor}`}>{badge}</span>
          <span className={`text-[11px] ${th.textMuted} tracking-wider font-medium`}>{label}</span>
        </div>
        <div className="flex items-center gap-1">
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleOCR} />
          <button onClick={handleImgClick} disabled={disabled || scanning} className={`text-[9px] px-1.5 py-0.5 border ${th.inputBorder} rounded ${th.textMuted} hover:border-blue-500 hover:text-blue-400 transition-colors disabled:opacity-40`}>{scanning ? '⟳' : '↑ img'}</button>
          {hasValue && <button onClick={() => onChange('')} disabled={disabled} className={`text-[9px] px-1.5 py-0.5 border border-red-800 rounded text-red-500 hover:border-red-500 hover:text-red-400 transition-colors disabled:opacity-40`}>✕</button>}
          <button onClick={() => { setShowSaveInput(!showSaveInput); setShowLoad(false); setSaveError(''); }} disabled={disabled} className={`text-[9px] px-1.5 py-0.5 border ${th.inputBorder} rounded ${th.textMuted} hover:border-blue-500 hover:text-blue-400 transition-colors disabled:opacity-40`}>💾</button>
          <button onClick={() => { setShowLoad(!showLoad); setShowSaveInput(false); if (!showLoad) refreshFilters(); }} disabled={disabled} className={`text-[9px] px-1.5 py-0.5 border ${th.inputBorder} rounded ${th.textMuted} hover:border-blue-500 hover:text-blue-400 transition-colors disabled:opacity-40`}>▼</button>
        </div>
      </div>
      {showSaveInput && (
        <div className="mb-1.5 flex flex-col gap-1">
          <div className="flex gap-1">
            <input type="text" value={saveName} onChange={e => { setSaveName(e.target.value); setSaveError(''); }} placeholder="Filter name..." onKeyDown={e => e.key === 'Enter' && handleSave()}
              className={`flex-1 ${th.input} border ${th.inputBorder} rounded px-2 py-1 text-[10px] ${th.text} focus:outline-none focus:border-blue-500 placeholder-slate-500`} />
            <button onClick={() => handleSave()} className="text-[9px] px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium transition-colors">Save</button>
          </div>
          {saveError && (<div className="flex gap-1 items-center"><span className="text-[9px] text-yellow-400">{saveError}</span>{saveError.includes('exists') && <button onClick={() => handleSave(true)} className="text-[9px] px-1.5 py-0.5 bg-yellow-600 hover:bg-yellow-500 text-white rounded font-medium">Replace</button>}</div>)}
        </div>
      )}
      {showLoad && (
        <div className={`mb-1.5 ${th.input} border ${th.border} rounded-lg overflow-hidden`}>
          {loadingFilters ? <p className={`text-[9px] ${th.textFaint} px-2 py-1.5`}>Loading...</p>
            : filterNames.length === 0 ? <p className={`text-[9px] ${th.textFaint} px-2 py-1.5`}>No saved filters</p>
            : filterNames.map(name => (
              <div key={name} className={`flex items-center justify-between px-2 py-1.5 hover:bg-blue-500/10 group`}>
                <button onClick={() => handleLoadSelect(name)} className={`text-[10px] ${th.textMuted} hover:${th.text} text-left flex-1 font-medium`}>{name}</button>
                <button onClick={() => handleDelete(name)} className="text-[9px] text-slate-500 hover:text-red-500 ml-2 opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
              </div>
            ))}
        </div>
      )}
      <textarea value={value} onChange={e => onChange(e.target.value)} placeholder="Tickers..."
        className={`w-full ${th.input} border ${th.inputBorder} rounded-lg p-2 text-xs ${th.text} h-16 resize-none focus:outline-none ${borderFocus} placeholder-slate-500 leading-relaxed`} />
    </div>
  );
}

// ── Result Card ────────────────────────────────────────────────────────────
function StrikesDisplay({ c, th }: { c: SpreadCandidate; th: typeof THEMES[Theme] }) {
  const widthTag = (w: number) => <span className={`${th.textFaint} mx-0.5`}>·${w}·</span>;
  if (c.strategy === 'IC' && c.shortCallStrike != null && c.longCallStrike != null) {
    return <div className="text-xs shrink-0"><span className={th.label}>Strikes </span><span className={th.text}>{c.shortStrike}/{c.longStrike}</span>{widthTag(c.spreadWidth)}<span className={th.text}>{c.shortCallStrike}/{c.longCallStrike}</span>{widthTag(c.callWidth ?? c.spreadWidth)}</div>;
  }
  return <div className="text-xs shrink-0"><span className={th.label}>Strikes </span><span className={`${th.text} font-medium`}>{c.shortStrike}/{c.longStrike}</span>{widthTag(c.spreadWidth)}</div>;
}

function ResultCard({ result, th }: { result: ScreenResult; th: typeof THEMES[Theme] }) {
  const [expanded, setExpanded] = useState(false);
  const c = result.bestCandidate, t = result.trendResult;
  const stratBadge = result.strategy === 'BPS' ? 'bg-emerald-500/15 border-emerald-500 text-emerald-500' : result.strategy === 'BCS' ? 'bg-red-500/15 border-red-500 text-red-500' : 'bg-blue-500/15 border-blue-500 text-blue-500';
  const isApproaching = c && c.dte <= DTE_ALERT_THRESHOLD;
  const hasEarningsBlock = result.failReasons.some(f => f.includes('Earnings')) && result.earningsDate && daysUntil(result.earningsDate) >= 0;
  const cardBorder = result.qualified ? (isApproaching ? 'border-yellow-500/50' : th.border) : th.borderLight;
  return (
    <div className={`border ${cardBorder} ${result.qualified ? `${th.cardQualified} ${strategyAccent(result.strategy)}` : `${th.card} opacity-60`} rounded-lg overflow-hidden cursor-pointer transition-all hover:shadow-md`} onClick={() => setExpanded(!expanded)}>
      <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="w-16 shrink-0">
          <p className={`font-bold ${th.text} text-sm`}>{result.symbol}</p>
          {result.price && <p className={`text-[10px] ${th.textFaint}`}>${result.price.toFixed(2)}</p>}
        </div>
        <span className={`text-[10px] px-2 py-0.5 border rounded-md shrink-0 font-bold ${stratBadge}`}>{result.strategy}</span>
        {t && <span className={`text-[10px] shrink-0 font-medium ${trendColor(t.trend)}`}>{trendIcon(t.trend)} {t.trend}</span>}
        <div className={`text-xs ${th.label} shrink-0`}>IVR <span className={result.ivr != null && result.ivr >= 30 ? 'text-emerald-500 font-bold' : 'text-red-500 font-bold'}>{result.ivr != null ? `${result.ivr.toFixed(1)}%` : 'N/A'}</span></div>
        {c && <>
          <div className="text-xs shrink-0"><span className={th.label}>Exp </span><span className={`${th.text} font-medium`}>{c.expiration}</span><span className={`ml-1 font-medium ${c.dte <= 21 ? 'text-red-500' : c.dte <= DTE_ALERT_THRESHOLD ? 'text-yellow-500' : th.textFaint}`}>({c.dte}d)</span></div>
          <StrikesDisplay c={c} th={th} />
          <div className="text-xs shrink-0"><span className={th.label}>Credit </span><span className="text-emerald-500 font-bold">${(c.totalCredit ?? c.credit).toFixed(2)}</span></div>
          <div className="text-xs shrink-0"><span className={th.label}>ROC </span><span className={`${th.text} font-medium`}>{c.roc.toFixed(0)}%</span></div>
          {c.pop != null && <div className="text-xs shrink-0"><span className={th.label}>POP </span><span className={`${th.text} font-medium`}>{c.pop.toFixed(0)}%</span></div>}
          <div className="text-xs shrink-0"><span className={th.label}>δ </span><span className={`${th.text} font-medium`}>{c.shortDelta.toFixed(2)}</span></div>
          <span className={`text-[9px] ${th.textFaint} border ${th.borderLight} rounded px-1 py-0.5 shrink-0`}>opt</span>
          {result.qualified && <span onClick={e => e.stopPropagation()} className="shrink-0"><EntryCalendarButton result={result} th={th} /></span>}
          {isApproaching && <span className="text-[9px] text-yellow-500 border border-yellow-600 rounded px-1 py-0.5 shrink-0 font-medium">⚠ DTE</span>}
        </>}
        {!result.qualified && result.failReasons.length > 0 && (
          <div className="flex items-center gap-2 ml-auto flex-wrap justify-end">
            <span className={`text-[10px] text-red-500 font-medium`}>{result.failReasons.slice(0, 2).join(' · ')}</span>
            {hasEarningsBlock && result.earningsDate && <span onClick={e => e.stopPropagation()}><CalendarButton symbol={result.symbol} strategy={result.strategy} earningsDate={result.earningsDate} ivr={result.ivr} th={th} /></span>}
          </div>
        )}
        <div className={`ml-auto ${th.textFaint} text-xs shrink-0`}>{expanded ? '▲' : '▼'}</div>
      </div>
      {expanded && (
        <div className={`border-t ${th.border} px-4 py-3 space-y-3`}>
          {t && <div className={`text-[10px] ${th.textMuted} pb-2 border-b ${th.border}`}><span className={`${trendColor(t.trend)} mr-2 font-medium`}>{trendIcon(t.trend)} {t.trend.toUpperCase()}</span>{t.reason}</div>}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {Object.entries(result.checks).map(([key, check]) => (
              <div key={key} className="flex items-start gap-2">
                <span className={`text-xs mt-0.5 font-bold ${statusColor(check.status)}`}>{statusIcon(check.status)}</span>
                <div>
                  <p className={`text-[10px] ${th.textFaint} uppercase tracking-wider`}>{key}</p>
                  <p className={`text-xs ${th.text} font-medium`}>{check.value}</p>
                  <p className={`text-[10px] ${th.textMuted}`}>{check.reason}</p>
                </div>
              </div>
            ))}
          </div>
          {hasEarningsBlock && result.earningsDate && (
            <div className={`pt-2 border-t ${th.border} flex items-center gap-3`}>
              <p className={`text-[10px] ${th.textFaint} flex-1`}>Schedule a re-screen 2 business days after earnings ({result.earningsDate})</p>
              <span onClick={e => e.stopPropagation()}><CalendarButton symbol={result.symbol} strategy={result.strategy} earningsDate={result.earningsDate} ivr={result.ivr} th={th} /></span>
            </div>
          )}
          {c && c.strategy === 'IC' && c.callWidth != null && c.callWidth !== c.spreadWidth && <div className={`pt-2 border-t ${th.border}`}><p className={`text-[10px] ${th.textMuted}`}>Asymmetric widths — Put: ${c.spreadWidth} · Call: ${c.callWidth}</p></div>}
          {result.failReasons.length > 0 && <div className={`pt-2 border-t ${th.border}`}><p className="text-[10px] text-red-500 font-medium">{result.failReasons.join(' · ')}</p></div>}
        </div>
      )}
    </div>
  );
}

// ── Rules Modal Subcomponents (defined OUTSIDE RulesModal to prevent remount on render) ──
function RuleInput({ ruleKey, rawValues, editedRules, onRawChange, onBlur, th }: {
  ruleKey: keyof RulesType;
  rawValues: Record<string, string>;
  editedRules: RulesType;
  onRawChange: (key: string, raw: string) => void;
  onBlur: (key: keyof RulesType, raw: string) => void;
  th: typeof THEMES[Theme];
}) {
  return (
    <div>
      <p className={`text-[9px] ${th.textFaint} tracking-wider mb-1 uppercase`}>
        {RULE_LABELS[ruleKey]}{ruleKey === 'MAX_SPREAD_WIDTH' && <span className={`${th.textFaint} ml-1 normal-case opacity-60`}>(optimizer cap)</span>}
      </p>
      <input
        type="text"
        inputMode="decimal"
        value={rawValues[ruleKey] ?? String(editedRules[ruleKey])}
        onChange={e => onRawChange(ruleKey, e.target.value)}
        onBlur={e => onBlur(ruleKey, e.target.value)}
        onFocus={e => e.target.select()}
        className={`w-full ${th.input} border ${th.inputBorder} rounded-lg px-3 py-2 text-sm ${th.text} focus:outline-none focus:border-blue-500 font-medium`}
      />
    </div>
  );
}

function SectionHeader({ label, th }: { label: string; th: typeof THEMES[Theme] }) {
  return (
    <div className={`col-span-2 pt-2 pb-1 border-b ${th.border}`}>
      <p className={`text-[9px] ${th.textFaint} tracking-widest uppercase font-medium`}>{label}</p>
    </div>
  );
}

// ── Rules Modal ────────────────────────────────────────────────────────────
function RulesModal({ rules, onClose, onRun, th }: { rules: RulesType; onClose: () => void; onRun: (rules: RulesType) => void; th: typeof THEMES[Theme] }) {
  const [rawValues, setRawValues] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, String(v)])));
  const [editedRules, setEditedRules] = useState<RulesType>({ ...rules });

  const handleChange = (key: string, raw: string) => setRawValues(prev => ({ ...prev, [key]: raw }));
  const handleBlur = (key: keyof RulesType, raw: string) => {
    const val = parseFloat(raw);
    if (!isNaN(val)) { const updated = { ...editedRules, [key]: val }; setEditedRules(updated); setRawValues(prev => ({ ...prev, [key]: String(val) })); }
    else setRawValues(prev => ({ ...prev, [key]: String(editedRules[key]) }));
  };
  const handleReset = () => { setEditedRules({ ...DEFAULT_RULES }); setRawValues(Object.fromEntries(Object.entries(DEFAULT_RULES).map(([k, v]) => [k, String(v)]))); localStorage.removeItem(LS_RULES); };
  const handleRun = () => { saveRulesToStorage(editedRules); onRun(editedRules); };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className={`${th.sidebar} border ${th.border} rounded-xl p-6 w-[500px] max-h-[85vh] overflow-auto shadow-2xl`}>
        <h2 className="text-sm font-bold tracking-widest text-red-500 mb-1">SCREENING RULES</h2>
        <p className={`text-[9px] ${th.textFaint} mb-5 tracking-wider`}>Width optimizer tries $5 → ${editedRules.MAX_SPREAD_WIDTH} in steps and returns best ROC. IC sides optimized independently.</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 mb-6">
          <SectionHeader label="Implied Volatility Rank" th={th} />
          <RuleInput ruleKey="IVR_MIN" rawValues={rawValues} editedRules={editedRules} onRawChange={handleChange} onBlur={handleBlur} th={th} />
          <RuleInput ruleKey="IVR_IC_MAX" rawValues={rawValues} editedRules={editedRules} onRawChange={handleChange} onBlur={handleBlur} th={th} />
          <SectionHeader label="Days to Expiration" th={th} />
          <RuleInput ruleKey="DTE_MIN" rawValues={rawValues} editedRules={editedRules} onRawChange={handleChange} onBlur={handleBlur} th={th} />
          <RuleInput ruleKey="DTE_MAX" rawValues={rawValues} editedRules={editedRules} onRawChange={handleChange} onBlur={handleBlur} th={th} />
          <SectionHeader label="Delta — Spread / IC" th={th} />
          <RuleInput ruleKey="SPREAD_DELTA_MIN" rawValues={rawValues} editedRules={editedRules} onRawChange={handleChange} onBlur={handleBlur} th={th} />
          <RuleInput ruleKey="SPREAD_DELTA_MAX" rawValues={rawValues} editedRules={editedRules} onRawChange={handleChange} onBlur={handleBlur} th={th} />
          <RuleInput ruleKey="IC_DELTA_MIN" rawValues={rawValues} editedRules={editedRules} onRawChange={handleChange} onBlur={handleBlur} th={th} />
          <RuleInput ruleKey="IC_DELTA_MAX" rawValues={rawValues} editedRules={editedRules} onRawChange={handleChange} onBlur={handleBlur} th={th} />
          <SectionHeader label="Liquidity" th={th} />
          <RuleInput ruleKey="BID_ASK_MAX" rawValues={rawValues} editedRules={editedRules} onRawChange={handleChange} onBlur={handleBlur} th={th} />
          <RuleInput ruleKey="OI_MIN" rawValues={rawValues} editedRules={editedRules} onRawChange={handleChange} onBlur={handleBlur} th={th} />
          <SectionHeader label="Credit Quality" th={th} />
          <RuleInput ruleKey="CREDIT_RATIO_MIN" rawValues={rawValues} editedRules={editedRules} onRawChange={handleChange} onBlur={handleBlur} th={th} />
          <RuleInput ruleKey="MAX_SPREAD_WIDTH" rawValues={rawValues} editedRules={editedRules} onRawChange={handleChange} onBlur={handleBlur} th={th} />
          <SectionHeader label="Return on Capital" th={th} />
          <RuleInput ruleKey="ROC_MIN_SPREAD" rawValues={rawValues} editedRules={editedRules} onRawChange={handleChange} onBlur={handleBlur} th={th} />
          <RuleInput ruleKey="ROC_MIN_IC" rawValues={rawValues} editedRules={editedRules} onRawChange={handleChange} onBlur={handleBlur} th={th} />
        </div>
        <div className="flex gap-3">
          <button onClick={handleReset} className="flex-1 border border-yellow-600 text-yellow-500 py-2 rounded-lg text-xs tracking-widest hover:bg-yellow-500/10 font-medium">RESET</button>
          <button onClick={onClose} className={`flex-1 border ${th.border} ${th.textMuted} py-2 rounded-lg text-xs tracking-widest hover:border-blue-500`}>CANCEL</button>
          <button onClick={handleRun} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white py-2 rounded-lg text-xs font-bold tracking-widest transition-colors">RUN</button>
        </div>
      </div>
    </div>
  );
}

// ── NEW: Trend Detection & Auto-Assign (replaces old AUTO scanning behavior) ──
async function runTrendDetection(
  autoTickers: string,
  bpsTickers: string,
  bcsTickers: string,
  icTickers: string,
  brokenTickers: string,
  handleBpsChange: (v: string) => void,
  handleBcsChange: (v: string) => void,
  handleIcChange: (v: string) => void,
  handleBrokenChange: (v: string) => void,
  setError: (e: string) => void,
  setStatus: (s: string) => void,
  setLoading: (l: boolean) => void,
  parseTickers: (s: string) => string[]
) {
  const autoList = parseTickers(autoTickers).slice(0, AUTO_TICKER_LIMIT);
  if (!autoList.length) { setError('Enter at least one ticker for trend detection.'); return; }

  setError('');
  setLoading(true);
  try {
    setStatus('Analyzing trends...');
    const distributions: { bps: string[]; bcs: string[]; ic: string[]; broken: string[] } = { bps: [], bcs: [], ic: [], broken: [] };

    for (let i = 0; i < autoList.length; i++) {
      const symbol = autoList[i];
      setStatus(`Analyzing trend for ${symbol} (${i + 1}/${autoList.length})...`);
      let trendResult: TrendResult | undefined;
      try {
        trendResult = await getTrend(symbol);
      } catch (e: any) {
        console.warn(e.message);
        distributions.broken.push(symbol);
        continue;
      }
      if (i < autoList.length - 1) await sleep(12000);

      if (trendResult?.trend === 'unknown' || !trendResult) {
        distributions.broken.push(symbol);
      } else if (trendResult.strategy === 'BPS') {
        distributions.bps.push(symbol);
      } else if (trendResult.strategy === 'BCS') {
        distributions.bcs.push(symbol);
      } else if (trendResult.strategy === 'IC') {
        distributions.ic.push(symbol);
      } else {
        distributions.broken.push(symbol);
      }
    }

    // Auto-merge into target boxes (prevents accidental data loss)
    if (distributions.bps.length > 0) handleBpsChange(mergeTickers(bpsTickers, distributions.bps));
    if (distributions.bcs.length > 0) handleBcsChange(mergeTickers(bcsTickers, distributions.bcs));
    if (distributions.ic.length > 0) handleIcChange(mergeTickers(icTickers, distributions.ic));
    if (distributions.broken.length > 0) handleBrokenChange(mergeTickers(brokenTickers, distributions.broken));

    setStatus(`✅ Assigned ${autoList.length} tickers to strategy / review boxes`);
  } catch (e: any) {
    setError(e.message);
  } finally {
    setLoading(false);
  }
}

// ── Main App ───────────────────────────────────────────────────────────────
export default function Home() {
  const [theme, setTheme] = useState<Theme>(getSavedTheme);
  const th = THEMES[theme];

  const [autoTickers, setAutoTickers] = useState('');
  const [bpsTickers, setBpsTickers] = useState('');
  const [bcsTickers, setBcsTickers] = useState('');
  const [icTickers, setIcTickers] = useState('');
  const [brokenTickers, setBrokenTickers] = useState('');   // ← NEW 4th box
  const [results, setResults] = useState<ScreenResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [loadPrompt, setLoadPrompt] = useState<LoadPromptState>({ show: false, name: '', type: 'strategy' });
  const [runtimeRules, setRuntimeRules] = useState<RulesType>(getSavedRules);
  const [lastRunRules, setLastRunRules] = useState<RulesType | null>(null);

  useEffect(() => {
    try { 
      setBpsTickers(localStorage.getItem(LS_BPS) || ''); 
      setBcsTickers(localStorage.getItem(LS_BCS) || ''); 
      setIcTickers(localStorage.getItem(LS_IC) || ''); 
      setBrokenTickers(localStorage.getItem(LS_BROKEN) || '');   // ← NEW
    } catch {}
  }, []);

  const handleBpsChange = (v: string) => { setBpsTickers(v); try { localStorage.setItem(LS_BPS, v); } catch {} };
  const handleBcsChange = (v: string) => { setBcsTickers(v); try { localStorage.setItem(LS_BCS, v); } catch {} };
  const handleIcChange = (v: string) => { setIcTickers(v); try { localStorage.setItem(LS_IC, v); } catch {} };
  const handleBrokenChange = (v: string) => { setBrokenTickers(v); try { localStorage.setItem(LS_BROKEN, v); } catch {} };   // ← NEW
  const handleGlobalLoad = (newBps: string, newBcs: string, newIc: string) => { handleBpsChange(newBps); handleBcsChange(newBcs); handleIcChange(newIc); };
  const showLoadPrompt = (state: Omit<LoadPromptState, 'show'>) => { setLoadPrompt({ show: true, ...state }); };

  const parseTickers = (input: string) => input.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  const autoTickerList = parseTickers(autoTickers);
  const autoOverLimit = autoTickerList.length > AUTO_TICKER_LIMIT;

  const downloadCSV = () => {
    const headers = ['Symbol','Strategy','Trend','Qualified','Price','IVR','Expiration','DTE','Short Put Strike','Long Put Strike','Put Width','Short Call Strike','Long Call Strike','Call Width','Short Delta','Credit','ROC%','POP%','Short OI','Long OI','Total Credit','Earnings Date','Fail Reasons'];
    const rows = results.map(r => { const c = r.bestCandidate; return [r.symbol,r.strategy,r.trendResult?.trend||'',r.qualified?'YES':'NO',r.price?.toFixed(2)||'',r.ivr?.toFixed(1)||'',c?.expiration||'',c?.dte||'',c?.shortStrike||'',c?.longStrike||'',c?.spreadWidth||'',c?.shortCallStrike||'',c?.longCallStrike||'',c?.callWidth||'',c?.shortDelta?.toFixed(2)||'',c?.credit?.toFixed(2)||'',c?.roc?.toFixed(0)||'',c?.pop?.toFixed(0)||'',c?.shortOI||'',c?.longOI||'',c?.totalCredit?.toFixed(2)||'',r.earningsDate||'',r.failReasons.join('; ')].map(v=>`"${v}"`).join(','); });
    const blob = new Blob([[headers.join(','),...rows].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `prosper-screen-${new Date().toISOString().split('T')[0]}.csv`; a.click();
  };

  // ── UPDATED: AUTO now only does trend detection + assignment (no full scan) ──
  const runTrendDetectionWrapper = () => {
    runTrendDetection(
      autoTickers,
      bpsTickers,
      bcsTickers,
      icTickers,
      brokenTickers,
      handleBpsChange,
      handleBcsChange,
      handleIcChange,
      handleBrokenChange,
      setError,
      setStatus,
      setLoading,
      parseTickers
    );
  };

  const runScreen = async (rules: RulesType) => {
    setError(''); setResults([]);
    const autoList = parseTickers(autoTickers).slice(0, AUTO_TICKER_LIMIT);
    const bps = parseTickers(bpsTickers), bcs = parseTickers(bcsTickers), ic = parseTickers(icTickers);
    if (!autoList.length && !bps.length && !bcs.length && !ic.length) { setError('Enter at least one ticker.'); return; }
    if (autoOverLimit) { setError(`AUTO box limited to ${AUTO_TICKER_LIMIT} tickers.`); return; }
    setRuntimeRules(rules);
    setLastRunRules(rules);
    setLoading(true);
    try {
      setStatus('Getting access token...'); const token = await getAccessToken();
      const allSymbols = Array.from(new Set([...autoList,...bps,...bcs,...ic]));
      setStatus('Fetching market metrics...'); const metricsArray = await getMarketMetrics(allSymbols, token);
      const metricsMap = Object.fromEntries(metricsArray.map((m: any) => [m.symbol, m]));
      const screenResults: ScreenResult[] = [];
      const errResult = (symbol: string, strategy: string, msg: string, trendResult?: TrendResult): ScreenResult => ({ symbol, strategy, price: null, ivr: null, qualified: false, bestCandidate: null, failReasons: [msg], trendResult, checks: { ivr: { status: 'fail', value: 'Error', reason: msg }, earnings: { status: 'pending', value: '—', reason: '—' }, oi: { status: 'pending', value: '—', reason: '—' }, delta: { status: 'pending', value: '—', reason: '—' }, credit: { status: 'pending', value: '—', reason: '—' }, roc: { status: 'pending', value: '—', reason: '—' } } });
      for (let i = 0; i < autoList.length; i++) {
        const symbol = autoList[i]; setStatus(`Fetching trend: ${symbol} (${i+1}/${autoList.length})...`);
        let trendResult: TrendResult | undefined;
        try { trendResult = await getTrend(symbol); } catch (e: any) { console.warn(e.message); }
        if (i < autoList.length - 1) await sleep(12000);
        setStatus(`Scanning ${symbol} (${i+1}/${autoList.length})...`);
        const strategy = trendResult?.strategy ?? 'BCS';
        try { const metrics = metricsMap[symbol] || { symbol, ivRank: null, earningsExpectedDate: null }; const [chainData, price] = await Promise.all([getChain(symbol, token, rules), getQuote(symbol, token)]); screenResults.push(runChecklist(symbol, strategy, metrics, chainData, price, rules, trendResult)); }
        catch (e: any) { screenResults.push(errResult(symbol, strategy, e.message, trendResult)); }
      }
      for (const { symbols, strategy } of [{ symbols: bps, strategy: 'BPS' as const }, { symbols: bcs, strategy: 'BCS' as const }, { symbols: ic, strategy: 'IC' as const }]) {
        for (const symbol of symbols) {
          setStatus(`Scanning ${symbol}...`);
          try { const metrics = metricsMap[symbol] || { symbol, ivRank: null, earningsExpectedDate: null }; const [chainData, price] = await Promise.all([getChain(symbol, token, rules), getQuote(symbol, token)]); screenResults.push(runChecklist(symbol, strategy, metrics, chainData, price, rules)); }
          catch (e: any) { screenResults.push(errResult(symbol, strategy, e.message)); }
        }
      }
      screenResults.sort((a, b) => { if (a.qualified && !b.qualified) return -1; if (!a.qualified && b.qualified) return 1; return (b.ivr ?? 0) - (a.ivr ?? 0); });
      setResults(screenResults);
    } catch (e: any) { setError(e.message); }
    setStatus(''); setLoading(false);
  };

  const qualified = results.filter(r => r.qualified);
  const disqualified = results.filter(r => !r.qualified);

  return (
    <div className={`min-h-screen ${th.bg} text-slate-100 font-mono transition-colors duration-200`}>
      {/* Header */}
      <div className={`${th.header} border-b ${th.border} px-6 py-4 flex items-center justify-between`}>
        <div>
          <h1 className="text-base font-bold tracking-widest text-white">OPTIONS HUNTER</h1>
          <p className="text-[10px] text-white/50 mt-0.5 tracking-wider">BPS · BCS · IRON CONDOR</p>
        </div>
        <img src="/header-bg.png" alt="" className="flex-1 mx-6 hidden sm:block" style={{height: '57px', marginTop: '-1rem', marginBottom: '-1rem', objectFit: 'cover'}} />
        <div className="flex items-center gap-3">
        <a href="/help" target="_blank" className="text-white/50 hover:text-white/90 text-xs font-medium tracking-wider transition-colors" title="Help">?</a>
        <ThemeToggle theme={theme} setTheme={setTheme} />
      </div>
      </div>

      <div className="flex h-[calc(100vh-57px)]">
        {/* Sidebar */}
        <div className={`w-80 border-r ${th.border} ${th.sidebar} p-4 overflow-auto flex flex-col gap-4 shrink-0`}>
          {/* AUTO / TREND DETECT */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[9px] px-1.5 py-0.5 bg-purple-500/20 text-purple-400 border border-purple-500 rounded-md tracking-wider font-bold">AUTO</span>
                <span className={`text-[11px] ${th.textMuted} tracking-wider font-medium`}>TREND DETECT</span>
              </div>
              <span className={`text-[9px] font-medium ${autoOverLimit ? 'text-red-500' : th.textFaint}`}>{autoTickerList.length}/{AUTO_TICKER_LIMIT}</span>
            </div>
            <textarea value={autoTickers} onChange={e => setAutoTickers(e.target.value)} placeholder="AAPL, MSFT, XOM&#10;auto-detects BPS/BCS/IC → assigns to boxes below"
              className={`w-full ${th.input} border ${autoOverLimit ? 'border-red-500' : th.inputBorder} rounded-lg p-2 text-xs ${th.text} h-16 resize-none focus:outline-none focus:border-purple-500 placeholder-slate-500 leading-relaxed`} />
            {autoOverLimit && <p className="text-[9px] text-red-500 mt-1 font-medium">Max {AUTO_TICKER_LIMIT} tickers</p>}
            <div className="flex items-center justify-between mt-1">
              <p className={`text-[9px] ${th.textFaint}`}>~{autoTickerList.length * 12}s analysis</p>
              <button
                onClick={runTrendDetectionWrapper}
                disabled={loading || autoOverLimit || autoTickerList.length === 0}
                className="text-[9px] px-2 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded font-bold tracking-wider transition-colors disabled:opacity-40"
              >
                {loading ? '...' : 'ANALYZE TRENDS'}
              </button>
            </div>
          </div>

          <SessionsPanel bps={bpsTickers} bcs={bcsTickers} ic={icTickers} onLoadAll={handleGlobalLoad} onLoadPrompt={showLoadPrompt} th={th} />

          <div className={`border-t ${th.border} pt-3 space-y-4`}>
            <p className={`text-[9px] ${th.textMuted} tracking-widest font-medium`}>SCAN LISTS</p>
            <StrategyBox label="BPS" badge="BULLISH" badgeColor="bg-emerald-500/15 text-emerald-500 border-emerald-500" borderFocus="focus:border-emerald-500" value={bpsTickers} onChange={handleBpsChange} strategy="BPS" disabled={loading} onLoadPrompt={showLoadPrompt} th={th} />
            <StrategyBox label="BCS" badge="BEARISH" badgeColor="bg-red-500/15 text-red-500 border-red-500" borderFocus="focus:border-red-500" value={bcsTickers} onChange={handleBcsChange} strategy="BCS" disabled={loading} onLoadPrompt={showLoadPrompt} th={th} />
            <StrategyBox label="IC" badge="NEUTRAL" badgeColor="bg-blue-500/15 text-blue-500 border-blue-500" borderFocus="focus:border-blue-500" value={icTickers} onChange={handleIcChange} strategy="IC" disabled={loading} onLoadPrompt={showLoadPrompt} th={th} />
            
            {/* ← NEW 4th box */}
            <StrategyBox 
              label="Broken (Review)" 
              badge="REVIEW" 
              badgeColor="bg-amber-500/15 text-amber-500 border-amber-500" 
              borderFocus="focus:border-amber-500" 
              value={brokenTickers} 
              onChange={handleBrokenChange} 
              strategy="broken" 
              disabled={loading} 
              onLoadPrompt={showLoadPrompt} 
              th={th} 
            />
          </div>

          {error && <div className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-2 leading-relaxed font-medium">{error}</div>}

          <button onClick={() => setShowRulesModal(true)} disabled={loading || autoOverLimit}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white py-2.5 rounded-lg text-xs font-bold tracking-widest transition-colors disabled:opacity-40 shadow-lg border border-blue-400/30">
            {loading ? 'SCANNING...' : 'RUN SCREENER'}
          </button>

          {/* Last Rules Used */}
          <div className={`text-[9px] space-y-1 border-t ${th.border} pt-3`}>
            <p className={`${th.textMuted} mb-2 tracking-widest font-medium`}>LAST RULES USED</p>
            {lastRunRules === null
              ? <p className={`${th.textFaint} italic`}>No screen run yet</p>
              : [['IVR',`≥ ${lastRunRules.IVR_MIN}%`],['DTE',`${lastRunRules.DTE_MIN}–${lastRunRules.DTE_MAX} days`],['BPS/BCS delta',`${lastRunRules.SPREAD_DELTA_MIN}–${lastRunRules.SPREAD_DELTA_MAX}`],['IC delta',`${lastRunRules.IC_DELTA_MIN}–${lastRunRules.IC_DELTA_MAX}`],['Credit ratio',`≥ ${(lastRunRules.CREDIT_RATIO_MIN * 100).toFixed(0)}%`],['OI per leg',`≥ ${lastRunRules.OI_MIN}`],['Bid-Ask',`≤ $${lastRunRules.BID_ASK_MAX}`],['Max width',`$${lastRunRules.MAX_SPREAD_WIDTH} (opt)`],['Min ROC spread',`${lastRunRules.ROC_MIN_SPREAD}%`],['Min ROC IC',`${lastRunRules.ROC_MIN_IC}%`]].map(([k,v]) => (
                <div key={k} className="flex justify-between"><span className={th.textFaint}>{k}</span><span className={`${th.textMuted} font-medium`}>{v}</span></div>
              ))
            }
          </div>
        </div>

        {/* Main content */}
        <div className="flex-1 overflow-auto p-5">
          {results.length === 0 && !loading && (
            <div className={`h-full flex flex-col items-center justify-center ${th.textFaint}`}>
              <div className="text-4xl mb-3 opacity-20">◈</div>
              <p className={`text-[10px] tracking-widest ${th.textMuted}`}>ADD TICKERS AND RUN SCREENER</p>
              <p className={`text-[9px] mt-2 ${th.textFaint}`}>Save sessions · Load scan lists · Upload Finviz screenshots</p>
            </div>
          )}
          {loading && <div className="h-full flex flex-col items-center justify-center gap-2"><div className={`text-[10px] tracking-widest ${th.textMuted} animate-pulse font-medium`}>{status || 'SCANNING...'}</div></div>}
          {results.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex gap-4 text-[10px] tracking-wider font-medium">
                  <span className="text-emerald-500">{qualified.length} QUALIFIED</span>
                  <span className={th.textFaint}>{disqualified.length} DISQUALIFIED</span>
                  <span className={th.textFaint}>{results.length} SCANNED</span>
                </div>
                <button onClick={downloadCSV} className={`text-[10px] px-3 py-1.5 border ${th.border} rounded-lg ${th.textMuted} hover:border-blue-500 hover:text-blue-400 transition-colors tracking-wider`}>↓ CSV</button>
              </div>
              <DTEAlertBanner results={results} />
              <SmartSuggestionsPanel results={results} rules={runtimeRules} th={th} onApplyAndRerun={runScreen} />
              {qualified.length > 0 && <div><p className="text-[9px] text-emerald-500 tracking-widest mb-2 font-medium">QUALIFIED</p><div className="space-y-2">{qualified.map(r => <ResultCard key={`${r.symbol}-${r.strategy}`} result={r} th={th} />)}</div></div>}
              {disqualified.length > 0 && <div><p className={`text-[9px] ${th.textFaint} tracking-widest mb-2 font-medium`}>DISQUALIFIED</p><div className="space-y-2">{disqualified.map(r => <ResultCard key={`${r.symbol}-${r.strategy}`} result={r} th={th} />)}</div></div>}
            </div>
          )}
        </div>
      </div>

      <LoadPromptModal state={loadPrompt} onClose={() => setLoadPrompt(p => ({ ...p, show: false }))} th={th} />
      {showRulesModal && <RulesModal rules={runtimeRules} onClose={() => setShowRulesModal(false)} onRun={(rules) => { setShowRulesModal(false); setRuntimeRules(rules); runScreen(rules); }} th={th} />}
    </div>
  );
}
