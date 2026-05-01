'use client';
import { useState, useRef, useEffect, useCallback } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────
interface CheckResult {
  status: 'pass' | 'fail' | 'warn' | 'pending';
  value: string;
  reason: string;
}
interface SpreadCandidate {
  strategy: string;
  expiration: string;
  dte: number;
  shortStrike: number;
  longStrike: number;
  shortDelta: number;
  credit: number;
  spreadWidth: number;
  creditRatio: number;
  roc: number;
  pop: number | null;
  shortOI: number;
  longOI: number;
  shortCallStrike?: number;
  longCallStrike?: number;
  callCredit?: number;
  callWidth?: number;
  totalCredit?: number;
  optimized?: boolean;
}
interface TrendResult {
  trend: 'uptrend' | 'downtrend' | 'sideways' | 'unknown';
  strategy: 'BPS' | 'BCS' | 'IC';
  ma20: number;
  ma50: number;
  reason: string;
}
interface ScreenResult {
  symbol: string;
  strategy: string;
  price: number | null;
  ivr: number | null;
  qualified: boolean;
  bestCandidate: SpreadCandidate | null;
  failReasons: string[];
  trendResult?: TrendResult;
  checks: {
    ivr: CheckResult;
    earnings: CheckResult;
    oi: CheckResult;
    delta: CheckResult;
    credit: CheckResult;
    roc: CheckResult;
  };
}
type SavedFilters = Record<string, string[]>;
type GlobalFilters = Record<string, { bps: string[]; bcs: string[]; ic: string[] }>;

interface LoadPromptState {
  show: boolean;
  name: string;
  type: 'strategy' | 'global';
  data?: { tickers?: string[]; bps?: string[]; bcs?: string[]; ic?: string[] };
  onLoad?: (merge: boolean) => void;
}

// ── Rules ──────────────────────────────────────────────────────────────────
const DEFAULT_RULES = {
  IVR_MIN: 30, IVR_IC_MAX: 70, OI_MIN: 0, BID_ASK_MAX: 0.10,
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

const AUTO_TICKER_LIMIT = 5;
const LS_BPS = 'prosper-tickers-bps';
const LS_BCS = 'prosper-tickers-bcs';
const LS_IC = 'prosper-tickers-ic';

function daysUntil(dateStr: string): number {
  const target = new Date(dateStr);
  const now = new Date();
  return Math.round((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}
function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

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

// ── Saved Filters API ──────────────────────────────────────────────────────
async function loadFilters(strategy: string): Promise<SavedFilters | GlobalFilters> {
  try {
    const res = await fetch(`/api/filters?strategy=${strategy}`);
    const data = await res.json();
    return data.filters ?? {};
  } catch { return {}; }
}

async function saveFilter(strategy: string, name: string, payload: { tickers?: string[]; bps?: string[]; bcs?: string[]; ic?: string[] }, replace = false): Promise<{ success?: boolean; conflict?: boolean; message?: string }> {
  const res = await fetch('/api/filters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategy, name, replace, ...payload }),
  });
  return res.json();
}

async function deleteFilter(strategy: string, name: string): Promise<void> {
  await fetch('/api/filters', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategy, name }),
  });
}

// ── Tesseract OCR ──────────────────────────────────────────────────────────
async function extractTickersFromImage(file: File): Promise<string[]> {
  const Tesseract = await import('tesseract.js');
  const { data: { text } } = await Tesseract.recognize(file, 'eng', { logger: () => {} });
  const blacklist = new Set(['USA','ETF','CEO','IPO','NYSE','NASDAQ','OTC','ADR','INC','LLC','LTD','PLC','THE','AND','FOR','REQ','BPS','BCS','PUT','CALL','OTM','ITM','ATM','IVR','DTE','ROC','POP','GTC','OCO','AI','S','P','C','B','N','E']);
  const tickers: string[] = [];
  const tickerPattern = /\b([A-Z]{2,5})\b/g;
  for (const line of text.split('\n')) {
    let match;
    while ((match = tickerPattern.exec(line)) !== null) {
      if (!blacklist.has(match[1])) tickers.push(match[1]);
    }
  }
  return Array.from(new Set(tickers));
}

function mergeTickers(existing: string, newTickers: string[]): string {
  const existingList = existing.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  const existingSet = new Set(existingList);
  const toAdd = newTickers.filter(t => !existingSet.has(t));
  if (toAdd.length === 0) return existing;
  return [...existingList, ...toAdd].join(', ');
}

function tickersToString(tickers: string[]): string {
  return tickers.join(', ');
}

// ── Polygon API ────────────────────────────────────────────────────────────
async function getTrend(symbol: string): Promise<TrendResult> {
  const apiKey = process.env.NEXT_PUBLIC_POLYGON_API_KEY;
  if (!apiKey) throw new Error('NEXT_PUBLIC_POLYGON_API_KEY not set');
  const to = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - 6);
  const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${from.toISOString().split('T')[0]}/${to.toISOString().split('T')[0]}?adjusted=true&sort=asc&limit=150&apiKey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polygon fetch failed (${res.status})`);
  const data = await res.json();
  const bars: { c: number }[] = data.results ?? [];
  if (bars.length < 50) return { trend: 'unknown', strategy: 'BCS', ma20: 0, ma50: 0, reason: 'Not enough price history' };
  const closes = bars.map(b => b.c);
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const currentPrice = closes[closes.length - 1];
  const maDiff = (ma20 - ma50) / ma50;
  const priceVsMa50 = (currentPrice - ma50) / ma50;
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
  const r = process.env.NEXT_PUBLIC_TASTYTRADE_REFRESH_TOKEN;
  const s = process.env.NEXT_PUBLIC_TASTYTRADE_CLIENT_SECRET;
  const c = process.env.NEXT_PUBLIC_TASTYTRADE_CLIENT_ID;
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
  const expirations: string[] = [];
  const chains: Record<string, any[]> = {};
  const allOCCSymbols: string[] = [];
  const symbolMeta: Record<string, { expDate: string; strike: number; optionType: string }> = {};
  for (const expGroup of nested?.data?.items?.[0]?.expirations ?? []) {
    const expDate: string = expGroup['expiration-date']; if (!expDate) continue;
    const dte = daysUntil(expDate);
    if (dte < RULES.DTE_MIN - 5 || dte > RULES.DTE_MAX + 5) continue;
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
  expirations.sort();
  return { expirations, chains };
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
    const maxLoss = width - credit;
    const roc = maxLoss > 0 ? (credit / maxLoss) * 100 : 0; if (roc < RULES.ROC_MIN_SPREAD) continue;
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
    const maxLoss = width - credit;
    const roc = maxLoss > 0 ? (credit / maxLoss) * 100 : 0;
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
  const roc = maxLoss > 0 ? (totalCredit / maxLoss) * 100 : 0;
  if (roc < RULES.ROC_MIN_IC) return null;
  return { strategy: 'IC', expiration: expDate, dte: daysUntil(expDate), shortStrike: bestPut.shortStrike, longStrike: bestPut.longStrike, shortDelta: bestPut.shortDelta, shortOI: bestPut.shortOI, longOI: bestPut.longOI, credit: bestPut.credit, spreadWidth: bestPut.width, creditRatio: bestPut.creditRatio, roc, pop: (1 - bestPut.shortDelta - bestCall.shortDelta) * 100, shortCallStrike: bestCall.shortStrike, longCallStrike: bestCall.longStrike, callCredit: bestCall.credit, callWidth: bestCall.width, totalCredit, optimized: true };
}
function runChecklist(symbol: string, strategy: 'BPS' | 'BCS' | 'IC', metrics: any, chainData: { expirations: string[]; chains: Record<string, any[]> }, price: number | null, RULES: RulesType, trendResult?: TrendResult): ScreenResult {
  const failReasons: string[] = [];
  const ivrValue = metrics.ivRank, earningsDate = metrics.earningsExpectedDate;
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
  return { symbol, strategy, price, ivr: ivrValue, qualified, bestCandidate, failReasons, trendResult, checks: { ivr: ivrCheck, earnings: earningsCheck, oi: oiCheck, delta: deltaCheck, credit: creditCheck, roc: rocCheck } };
}

// ── UI Helpers ─────────────────────────────────────────────────────────────
const statusColor = (s: string) => s === 'pass' ? 'text-emerald-400' : s === 'fail' ? 'text-red-400' : s === 'warn' ? 'text-yellow-400' : 'text-slate-400';
const statusIcon = (s: string) => s === 'pass' ? '✓' : s === 'fail' ? '✗' : s === 'warn' ? '⚠' : '—';
const trendColor = (t: string) => t === 'uptrend' ? 'text-emerald-400' : t === 'downtrend' ? 'text-red-400' : t === 'sideways' ? 'text-blue-400' : 'text-slate-300';
const trendIcon = (t: string) => t === 'uptrend' ? '↑' : t === 'downtrend' ? '↓' : t === 'sideways' ? '→' : '?';

// ── Load Prompt Modal ──────────────────────────────────────────────────────
function LoadPromptModal({ state, onClose }: { state: LoadPromptState; onClose: () => void }) {
  if (!state.show) return null;
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-slate-900 border border-slate-600 rounded-lg p-5 w-80">
        <h3 className="text-xs font-bold text-white mb-1 tracking-wider">LOAD FILTER</h3>
        <p className="text-[10px] text-slate-300 mb-4">Load <span className="text-white font-medium">"{state.name}"</span> — how should it be applied?</p>
        <div className="space-y-2 mb-5">
          <button onClick={() => { state.onLoad?.(false); onClose(); }}
            className="w-full text-left px-3 py-2 border border-slate-600 rounded hover:border-slate-400 hover:bg-slate-800 transition-colors">
            <p className="text-xs text-white font-medium">Replace</p>
            <p className="text-[9px] text-slate-400">Clear current tickers and load this filter</p>
          </button>
          <button onClick={() => { state.onLoad?.(true); onClose(); }}
            className="w-full text-left px-3 py-2 border border-slate-600 rounded hover:border-slate-400 hover:bg-slate-800 transition-colors">
            <p className="text-xs text-white font-medium">Merge</p>
            <p className="text-[9px] text-slate-400">Add tickers from this filter to existing ones</p>
          </button>
        </div>
        <button onClick={onClose} className="w-full text-[10px] text-slate-400 hover:text-slate-200 transition-colors">Cancel</button>
      </div>
    </div>
  );
}

// ── Strategy Box ──────────────────────────────────────────────────────────
interface StrategyBoxProps {
  label: string;
  badge: string;
  badgeColor: string;
  borderFocus: string;
  value: string;
  onChange: (v: string) => void;
  strategy: 'BPS' | 'BCS' | 'IC';
  disabled?: boolean;
  onLoadPrompt: (state: Omit<LoadPromptState, 'show'>) => void;
}

function StrategyBox({ label, badge, badgeColor, borderFocus, value, onChange, strategy, disabled, onLoadPrompt }: StrategyBoxProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [scanning, setScanning] = useState(false);
  const [savedFilters, setSavedFilters] = useState<SavedFilters>({});
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveError, setSaveError] = useState('');
  const [showLoad, setShowLoad] = useState(false);
  const [loadingFilters, setLoadingFilters] = useState(false);

  const parseTickers = (input: string) => input.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);

  const refreshFilters = useCallback(async () => {
    setLoadingFilters(true);
    const f = await loadFilters(strategy) as SavedFilters;
    setSavedFilters(f);
    setLoadingFilters(false);
  }, [strategy]);

  useEffect(() => { refreshFilters(); }, [refreshFilters]);

  const handleOCR = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setScanning(true);
    try { const tickers = await extractTickersFromImage(file); if (tickers.length > 0) onChange(mergeTickers(value, tickers)); }
    catch (err) { console.error(err); }
    setScanning(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleSave = async (replace = false) => {
    if (!saveName.trim()) { setSaveError('Enter a name'); return; }
    const tickers = parseTickers(value);
    if (tickers.length === 0) { setSaveError('No tickers to save'); return; }
    const result = await saveFilter(strategy, saveName.trim(), { tickers }, replace);
    if (result.conflict) { setSaveError(`"${saveName}" exists — replace?`); return; }
    await refreshFilters();
    setShowSaveInput(false); setSaveName(''); setSaveError('');
  };

  const handleLoadSelect = (name: string) => {
    const tickers = savedFilters[name] ?? [];
    setShowLoad(false);
    onLoadPrompt({
      name,
      type: 'strategy',
      data: { tickers },
      onLoad: (doMerge: boolean) => {
        if (doMerge) onChange(mergeTickers(value, tickers));
        else onChange(tickersToString(tickers));
      },
    });
  };

  const handleDelete = async (name: string) => {
    await deleteFilter(strategy, name);
    await refreshFilters();
  };

  const filterNames = Object.keys(savedFilters);

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className={`text-[9px] px-1.5 py-0.5 rounded tracking-wider border font-medium ${badgeColor}`}>{badge}</span>
          <span className="text-[11px] text-slate-200 tracking-wider font-medium">{label}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleOCR} />
          <button onClick={() => fileRef.current?.click()} disabled={disabled || scanning}
            className="text-[9px] px-1.5 py-0.5 border border-slate-600 rounded text-slate-300 hover:border-slate-400 hover:text-white transition-colors disabled:opacity-40">
            {scanning ? '⟳' : '↑ img'}
          </button>
          <button onClick={() => { setShowSaveInput(!showSaveInput); setShowLoad(false); setSaveError(''); }} disabled={disabled}
            className="text-[9px] px-1.5 py-0.5 border border-slate-600 rounded text-slate-300 hover:border-slate-400 hover:text-white transition-colors disabled:opacity-40" title="Save ticker list">
            💾
          </button>
          <button onClick={() => { setShowLoad(!showLoad); setShowSaveInput(false); if (!showLoad) refreshFilters(); }} disabled={disabled}
            className="text-[9px] px-1.5 py-0.5 border border-slate-600 rounded text-slate-300 hover:border-slate-400 hover:text-white transition-colors disabled:opacity-40" title="Load saved list">
            ▼
          </button>
        </div>
      </div>

      {showSaveInput && (
        <div className="mb-1.5 flex flex-col gap-1">
          <div className="flex gap-1">
            <input type="text" value={saveName} onChange={e => { setSaveName(e.target.value); setSaveError(''); }}
              placeholder="Filter name..." onKeyDown={e => e.key === 'Enter' && handleSave()}
              className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-[10px] text-white focus:outline-none focus:border-slate-400 placeholder-slate-500" />
            <button onClick={() => handleSave()} className="text-[9px] px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded transition-colors font-medium">Save</button>
          </div>
          {saveError && (
            <div className="flex gap-1 items-center">
              <span className="text-[9px] text-yellow-400">{saveError}</span>
              {saveError.includes('exists') && <button onClick={() => handleSave(true)} className="text-[9px] px-1.5 py-0.5 bg-yellow-700 hover:bg-yellow-600 text-white rounded font-medium">Replace</button>}
            </div>
          )}
        </div>
      )}

      {showLoad && (
        <div className="mb-1.5 bg-slate-800 border border-slate-600 rounded overflow-hidden">
          {loadingFilters ? <p className="text-[9px] text-slate-400 px-2 py-1.5">Loading...</p>
            : filterNames.length === 0 ? <p className="text-[9px] text-slate-500 px-2 py-1.5">No saved filters</p>
            : filterNames.map(name => (
              <div key={name} className="flex items-center justify-between px-2 py-1.5 hover:bg-slate-700 group">
                <button onClick={() => handleLoadSelect(name)} className="text-[10px] text-slate-200 hover:text-white text-left flex-1 font-medium">{name}</button>
                <button onClick={() => handleDelete(name)} className="text-[9px] text-slate-600 hover:text-red-400 ml-2 opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
              </div>
            ))}
        </div>
      )}

      <textarea value={value} onChange={e => onChange(e.target.value)} placeholder="Tickers..."
        className={`w-full bg-slate-900/80 border border-slate-700 rounded p-2 text-xs text-white h-16 resize-none focus:outline-none ${borderFocus} placeholder-slate-600 leading-relaxed`} />
    </div>
  );
}

// ── Global Session Bar ─────────────────────────────────────────────────────
interface GlobalSessionBarProps {
  bps: string; bcs: string; ic: string;
  onLoad: (bps: string, bcs: string, ic: string) => void;
  onLoadPrompt: (state: Omit<LoadPromptState, 'show'>) => void;
}

function GlobalSessionBar({ bps, bcs, ic, onLoad, onLoadPrompt }: GlobalSessionBarProps) {
  const [globalFilters, setGlobalFilters] = useState<GlobalFilters>({});
  const [showSave, setShowSave] = useState(false);
  const [showLoad, setShowLoad] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveError, setSaveError] = useState('');
  const parseTickers = (input: string) => input.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);

  const refreshFilters = async () => {
    const f = await loadFilters('global') as GlobalFilters;
    setGlobalFilters(f);
  };

  const handleSave = async (replace = false) => {
    if (!saveName.trim()) { setSaveError('Enter a session name'); return; }
    const result = await saveFilter('global', saveName.trim(), { bps: parseTickers(bps), bcs: parseTickers(bcs), ic: parseTickers(ic) }, replace);
    if (result.conflict) { setSaveError(`"${saveName}" exists — replace?`); return; }
    await refreshFilters();
    setShowSave(false); setSaveName(''); setSaveError('');
  };

  const handleLoadSelect = (name: string) => {
    const session = globalFilters[name];
    if (!session) return;
    setShowLoad(false);
    onLoadPrompt({
      name,
      type: 'global',
      data: session,
      onLoad: (doMerge: boolean) => {
        if (doMerge) {
          onLoad(mergeTickers(bps, session.bps), mergeTickers(bcs, session.bcs), mergeTickers(ic, session.ic));
        } else {
          onLoad(tickersToString(session.bps), tickersToString(session.bcs), tickersToString(session.ic));
        }
      },
    });
  };

  const handleDelete = async (name: string) => {
    await deleteFilter('global', name);
    await refreshFilters();
  };

  const filterNames = Object.keys(globalFilters);

  return (
    <div className="flex items-center gap-2">
      {/* Save session */}
      <div className="relative">
        <button onClick={() => { setShowSave(!showSave); setShowLoad(false); setSaveError(''); }}
          className="text-[9px] px-2 py-1 border border-slate-600 rounded text-slate-300 hover:border-slate-400 hover:text-white transition-colors font-medium flex items-center gap-1">
          💾 <span>Save Session</span>
        </button>
        {showSave && (
          <div className="absolute top-7 right-0 z-40 bg-slate-900 border border-slate-600 rounded p-2 w-52 shadow-xl">
            <div className="flex gap-1 mb-1">
              <input type="text" value={saveName} onChange={e => { setSaveName(e.target.value); setSaveError(''); }}
                placeholder="Session name..." onKeyDown={e => e.key === 'Enter' && handleSave()}
                className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-[10px] text-white focus:outline-none focus:border-slate-400 placeholder-slate-500" />
              <button onClick={() => handleSave()} className="text-[9px] px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded font-medium">Save</button>
            </div>
            {saveError && (
              <div className="flex gap-1 items-center mt-1">
                <span className="text-[9px] text-yellow-400">{saveError}</span>
                {saveError.includes('exists') && <button onClick={() => handleSave(true)} className="text-[9px] px-1.5 py-0.5 bg-yellow-700 hover:bg-yellow-600 text-white rounded">Replace</button>}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Load session */}
      <div className="relative">
        <button onClick={() => { setShowLoad(!showLoad); setShowSave(false); if (!showLoad) refreshFilters(); }}
          className="text-[9px] px-2 py-1 border border-slate-600 rounded text-slate-300 hover:border-slate-400 hover:text-white transition-colors font-medium flex items-center gap-1">
          ▼ <span>Load Session</span>
        </button>
        {showLoad && (
          <div className="absolute top-7 right-0 z-40 bg-slate-900 border border-slate-600 rounded overflow-hidden w-52 shadow-xl">
            {filterNames.length === 0
              ? <p className="text-[9px] text-slate-500 px-2 py-1.5">No saved sessions</p>
              : filterNames.map(name => (
                <div key={name} className="flex items-center justify-between px-2 py-1.5 hover:bg-slate-700 group">
                  <button onClick={() => handleLoadSelect(name)} className="text-[10px] text-slate-200 hover:text-white text-left flex-1 font-medium">{name}</button>
                  <button onClick={() => handleDelete(name)} className="text-[9px] text-slate-600 hover:text-red-400 ml-2 opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Result Card ────────────────────────────────────────────────────────────
function StrikesDisplay({ c }: { c: SpreadCandidate }) {
  const widthTag = (w: number) => <span className="text-slate-400 mx-0.5">·${w}·</span>;
  if (c.strategy === 'IC' && c.shortCallStrike != null && c.longCallStrike != null) {
    return <div className="text-xs shrink-0"><span className="text-slate-300">Strikes </span><span className="text-white">{c.shortStrike}/{c.longStrike}</span>{widthTag(c.spreadWidth)}<span className="text-white">{c.shortCallStrike}/{c.longCallStrike}</span>{widthTag(c.callWidth ?? c.spreadWidth)}</div>;
  }
  return <div className="text-xs shrink-0"><span className="text-slate-300">Strikes </span><span className="text-white">{c.shortStrike}/{c.longStrike}</span>{widthTag(c.spreadWidth)}</div>;
}

function ResultCard({ result }: { result: ScreenResult }) {
  const [expanded, setExpanded] = useState(false);
  const c = result.bestCandidate, t = result.trendResult;
  const stratBg = result.strategy === 'BPS' ? 'bg-emerald-900/40 border-emerald-700 text-emerald-300' : result.strategy === 'BCS' ? 'bg-red-900/40 border-red-700 text-red-300' : 'bg-blue-900/40 border-blue-700 text-blue-300';
  return (
    <div className={`border rounded-lg overflow-hidden cursor-pointer transition-all ${result.qualified ? 'border-slate-600 bg-slate-900/60' : 'border-slate-700 bg-slate-900/30 opacity-60'}`} onClick={() => setExpanded(!expanded)}>
      <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="w-16 shrink-0"><p className="font-bold text-white text-sm">{result.symbol}</p>{result.price && <p className="text-[10px] text-slate-300">${result.price.toFixed(2)}</p>}</div>
        <span className={`text-[10px] px-2 py-0.5 border rounded shrink-0 font-medium ${stratBg}`}>{result.strategy}</span>
        {t && <span className={`text-[10px] shrink-0 font-medium ${trendColor(t.trend)}`}>{trendIcon(t.trend)} {t.trend}</span>}
        <div className="text-xs text-slate-300 shrink-0">IVR <span className={result.ivr != null && result.ivr >= 30 ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>{result.ivr != null ? `${result.ivr.toFixed(1)}%` : 'N/A'}</span></div>
        {c && <>
          <div className="text-xs shrink-0"><span className="text-slate-300">Exp </span><span className="text-white font-medium">{c.expiration}</span><span className="text-slate-300 ml-1">({c.dte}d)</span></div>
          <StrikesDisplay c={c} />
          <div className="text-xs shrink-0"><span className="text-slate-300">Credit </span><span className="text-emerald-400 font-bold">${(c.totalCredit ?? c.credit).toFixed(2)}</span></div>
          <div className="text-xs shrink-0"><span className="text-slate-300">ROC </span><span className="text-white font-medium">{c.roc.toFixed(0)}%</span></div>
          {c.pop != null && <div className="text-xs shrink-0"><span className="text-slate-300">POP </span><span className="text-white font-medium">{c.pop.toFixed(0)}%</span></div>}
          <div className="text-xs shrink-0"><span className="text-slate-300">δ </span><span className="text-white font-medium">{c.shortDelta.toFixed(2)}</span></div>
          <span className="text-[9px] text-slate-400 border border-slate-600 rounded px-1 py-0.5 shrink-0">opt</span>
        </>}
        {!result.qualified && result.failReasons.length > 0 && <div className="text-[10px] text-red-400 ml-auto font-medium">{result.failReasons.slice(0, 2).join(' · ')}</div>}
        <div className="ml-auto text-slate-300 text-xs shrink-0">{expanded ? '▲' : '▼'}</div>
      </div>
      {expanded && (
        <div className="border-t border-slate-700 px-4 py-3 space-y-3">
          {t && <div className="text-[10px] text-slate-300 pb-2 border-b border-slate-700"><span className={`${trendColor(t.trend)} mr-2 font-medium`}>{trendIcon(t.trend)} {t.trend.toUpperCase()}</span>{t.reason}</div>}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {Object.entries(result.checks).map(([key, check]) => (
              <div key={key} className="flex items-start gap-2">
                <span className={`text-xs mt-0.5 font-bold ${statusColor(check.status)}`}>{statusIcon(check.status)}</span>
                <div>
                  <p className="text-[10px] text-slate-400 uppercase tracking-wider">{key}</p>
                  <p className="text-xs text-white font-medium">{check.value}</p>
                  <p className="text-[10px] text-slate-300">{check.reason}</p>
                </div>
              </div>
            ))}
          </div>
          {c && c.strategy === 'IC' && c.callWidth != null && c.callWidth !== c.spreadWidth && <div className="pt-2 border-t border-slate-700"><p className="text-[10px] text-slate-300">Asymmetric widths — Put: ${c.spreadWidth} · Call: ${c.callWidth}</p></div>}
          {result.failReasons.length > 0 && <div className="pt-2 border-t border-slate-700"><p className="text-[10px] text-red-400 font-medium">{result.failReasons.join(' · ')}</p></div>}
        </div>
      )}
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────
export default function Home() {
  const [autoTickers, setAutoTickers] = useState('');
  const [bpsTickers, setBpsTickers] = useState('');
  const [bcsTickers, setBcsTickers] = useState('');
  const [icTickers, setIcTickers] = useState('');
  const [results, setResults] = useState<ScreenResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [loadPrompt, setLoadPrompt] = useState<LoadPromptState>({ show: false, name: '', type: 'strategy' });
  const [runtimeRules, setRuntimeRules] = useState<RulesType>(() => {
    try { const saved = localStorage.getItem('prosper-rules'); return saved ? { ...DEFAULT_RULES, ...JSON.parse(saved) } : { ...DEFAULT_RULES }; }
    catch { return { ...DEFAULT_RULES }; }
  });

  useEffect(() => {
    try { setBpsTickers(localStorage.getItem(LS_BPS) || ''); setBcsTickers(localStorage.getItem(LS_BCS) || ''); setIcTickers(localStorage.getItem(LS_IC) || ''); } catch {}
  }, []);

  const handleBpsChange = (v: string) => { setBpsTickers(v); try { localStorage.setItem(LS_BPS, v); } catch {} };
  const handleBcsChange = (v: string) => { setBcsTickers(v); try { localStorage.setItem(LS_BCS, v); } catch {} };
  const handleIcChange = (v: string) => { setIcTickers(v); try { localStorage.setItem(LS_IC, v); } catch {} };

  const handleGlobalLoad = (newBps: string, newBcs: string, newIc: string) => {
    handleBpsChange(newBps); handleBcsChange(newBcs); handleIcChange(newIc);
  };

  const showLoadPrompt = (state: Omit<LoadPromptState, 'show'>) => {
    setLoadPrompt({ show: true, ...state });
  };

  const parseTickers = (input: string) => input.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  const autoTickerList = parseTickers(autoTickers);
  const autoOverLimit = autoTickerList.length > AUTO_TICKER_LIMIT;

  const downloadCSV = () => {
    const headers = ['Symbol','Strategy','Trend','Qualified','Price','IVR','Expiration','DTE','Short Put Strike','Long Put Strike','Put Width','Short Call Strike','Long Call Strike','Call Width','Short Delta','Credit','ROC%','POP%','Short OI','Long OI','Total Credit','Fail Reasons'];
    const rows = results.map(r => { const c = r.bestCandidate; return [r.symbol,r.strategy,r.trendResult?.trend||'',r.qualified?'YES':'NO',r.price?.toFixed(2)||'',r.ivr?.toFixed(1)||'',c?.expiration||'',c?.dte||'',c?.shortStrike||'',c?.longStrike||'',c?.spreadWidth||'',c?.shortCallStrike||'',c?.longCallStrike||'',c?.callWidth||'',c?.shortDelta?.toFixed(2)||'',c?.credit?.toFixed(2)||'',c?.roc?.toFixed(0)||'',c?.pop?.toFixed(0)||'',c?.shortOI||'',c?.longOI||'',c?.totalCredit?.toFixed(2)||'',r.failReasons.join('; ')].map(v=>`"${v}"`).join(','); });
    const blob = new Blob([[headers.join(','),...rows].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `prosper-screen-${new Date().toISOString().split('T')[0]}.csv`; a.click();
  };

  const runScreen = async (rules: RulesType) => {
    setError(''); setResults([]);
    const autoList = parseTickers(autoTickers).slice(0, AUTO_TICKER_LIMIT);
    const bps = parseTickers(bpsTickers), bcs = parseTickers(bcsTickers), ic = parseTickers(icTickers);
    if (!autoList.length && !bps.length && !bcs.length && !ic.length) { setError('Enter at least one ticker.'); return; }
    if (autoOverLimit) { setError(`AUTO box limited to ${AUTO_TICKER_LIMIT} tickers.`); return; }
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
    <div className="min-h-screen bg-[#080c14] text-slate-100 font-mono">
      {/* Header */}
      <div className="border-b border-slate-700 px-6 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold tracking-widest text-white">PROSPER OPTIONS SCREENER</h1>
          <p className="text-[10px] text-slate-300 mt-0.5 tracking-wider">BPS · BCS · IRON CONDOR</p>
        </div>
        <GlobalSessionBar
          bps={bpsTickers} bcs={bcsTickers} ic={icTickers}
          onLoad={handleGlobalLoad}
          onLoadPrompt={showLoadPrompt}
        />
      </div>

      <div className="flex h-[calc(100vh-57px)]">
        {/* Sidebar */}
        <div className="w-80 border-r border-slate-700 p-4 overflow-auto flex flex-col gap-4 shrink-0">
          {/* AUTO */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[9px] px-1.5 py-0.5 bg-purple-900/40 text-purple-300 border border-purple-700 rounded tracking-wider font-medium">AUTO</span>
                <span className="text-[11px] text-slate-200 tracking-wider font-medium">TREND DETECT</span>
              </div>
              <span className={`text-[9px] font-medium ${autoOverLimit ? 'text-red-400' : 'text-slate-400'}`}>{autoTickerList.length}/{AUTO_TICKER_LIMIT}</span>
            </div>
            <textarea value={autoTickers} onChange={e => setAutoTickers(e.target.value)} placeholder="AAPL, MSFT, XOM&#10;auto-detects BPS/BCS/IC"
              className={`w-full bg-slate-900/80 border rounded p-2 text-xs text-white h-16 resize-none focus:outline-none placeholder-slate-600 leading-relaxed ${autoOverLimit ? 'border-red-700' : 'border-slate-700 focus:border-purple-600'}`} />
            {autoOverLimit && <p className="text-[9px] text-red-400 mt-1 font-medium">Max {AUTO_TICKER_LIMIT} tickers</p>}
            <p className="text-[9px] text-slate-500 mt-1">~{autoTickerList.length * 12}s scan time</p>
          </div>

          <div className="border-t border-slate-700 pt-3 space-y-4">
            <p className="text-[9px] text-slate-400 tracking-widest font-medium">MANUAL OVERRIDE</p>
            <StrategyBox label="BPS" badge="BULLISH" badgeColor="bg-emerald-900/40 text-emerald-300 border-emerald-700" borderFocus="focus:border-emerald-600" value={bpsTickers} onChange={handleBpsChange} strategy="BPS" disabled={loading} onLoadPrompt={showLoadPrompt} />
            <StrategyBox label="BCS" badge="BEARISH" badgeColor="bg-red-900/40 text-red-300 border-red-700" borderFocus="focus:border-red-600" value={bcsTickers} onChange={handleBcsChange} strategy="BCS" disabled={loading} onLoadPrompt={showLoadPrompt} />
            <StrategyBox label="IC" badge="NEUTRAL" badgeColor="bg-blue-900/40 text-blue-300 border-blue-700" borderFocus="focus:border-blue-600" value={icTickers} onChange={handleIcChange} strategy="IC" disabled={loading} onLoadPrompt={showLoadPrompt} />
          </div>

          {/* Active Rules */}
          <div className="text-[9px] space-y-1 border-t border-slate-700 pt-3">
            <p className="text-slate-300 mb-2 tracking-widest font-medium">ACTIVE RULES</p>
            {[['IVR',`≥ ${runtimeRules.IVR_MIN}%`],['DTE',`${runtimeRules.DTE_MIN}–${runtimeRules.DTE_MAX} days`],['BPS/BCS delta',`${runtimeRules.SPREAD_DELTA_MIN}–${runtimeRules.SPREAD_DELTA_MAX}`],['IC delta',`${runtimeRules.IC_DELTA_MIN}–${runtimeRules.IC_DELTA_MAX}`],['Credit ratio',`≥ ${(runtimeRules.CREDIT_RATIO_MIN * 100).toFixed(0)}%`],['OI per leg',`≥ ${runtimeRules.OI_MIN}`],['Bid-Ask',`≤ $${runtimeRules.BID_ASK_MAX}`],['Max width',`$${runtimeRules.MAX_SPREAD_WIDTH} (opt)`],['Min ROC spread',`${runtimeRules.ROC_MIN_SPREAD}%`],['Min ROC IC',`${runtimeRules.ROC_MIN_IC}%`]].map(([k,v]) => (
              <div key={k} className="flex justify-between"><span className="text-slate-400">{k}</span><span className="text-slate-200 font-medium">{v}</span></div>
            ))}
          </div>

          {error && <div className="text-[10px] text-red-300 bg-red-900/20 border border-red-700 rounded p-2 leading-relaxed font-medium">{error}</div>}

          <button onClick={() => setShowRulesModal(true)} disabled={loading || autoOverLimit}
            className="w-full bg-white text-black py-2.5 rounded text-xs font-bold tracking-widest hover:bg-slate-200 transition-colors disabled:opacity-40 mt-auto">
            {loading ? 'SCANNING...' : 'RUN SCREENER'}
          </button>
        </div>

        {/* Main content */}
        <div className="flex-1 overflow-auto p-5">
          {results.length === 0 && !loading && (
            <div className="h-full flex flex-col items-center justify-center text-slate-500">
              <div className="text-4xl mb-3 opacity-30">◈</div>
              <p className="text-[10px] tracking-widest text-slate-400">ADD TICKERS AND RUN SCREENER</p>
              <p className="text-[9px] mt-2 text-slate-500">Save & load sessions · Upload Finviz screenshots</p>
            </div>
          )}
          {loading && <div className="h-full flex flex-col items-center justify-center gap-2"><div className="text-[10px] tracking-widest text-slate-300 animate-pulse font-medium">{status || 'SCANNING...'}</div></div>}
          {results.length > 0 && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div className="flex gap-4 text-[10px] tracking-wider font-medium">
                  <span className="text-emerald-400">{qualified.length} QUALIFIED</span>
                  <span className="text-slate-400">{disqualified.length} DISQUALIFIED</span>
                  <span className="text-slate-400">{results.length} SCANNED</span>
                </div>
                <button onClick={downloadCSV} className="text-[10px] px-3 py-1.5 border border-slate-600 rounded hover:border-slate-400 text-slate-300 hover:text-white transition-colors tracking-wider">↓ CSV</button>
              </div>
              {qualified.length > 0 && <div><p className="text-[9px] text-emerald-500 tracking-widest mb-2 font-medium">QUALIFIED</p><div className="space-y-2">{qualified.map(r => <ResultCard key={`${r.symbol}-${r.strategy}`} result={r} />)}</div></div>}
              {disqualified.length > 0 && <div><p className="text-[9px] text-slate-500 tracking-widest mb-2 font-medium">DISQUALIFIED</p><div className="space-y-2">{disqualified.map(r => <ResultCard key={`${r.symbol}-${r.strategy}`} result={r} />)}</div></div>}
            </div>
          )}
        </div>
      </div>

      {/* Load Prompt Modal */}
      <LoadPromptModal state={loadPrompt} onClose={() => setLoadPrompt(p => ({ ...p, show: false }))} />

      {/* Rules Modal */}
      {showRulesModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-slate-900 border border-slate-600 rounded-lg p-6 w-[500px] max-h-[80vh] overflow-auto">
            <h2 className="text-xs font-bold tracking-widest text-white mb-1">SCREENING RULES</h2>
            <p className="text-[9px] text-slate-300 mb-4 tracking-wider">Width optimizer tries $5 → ${runtimeRules.MAX_SPREAD_WIDTH} in steps and returns best ROC. IC sides optimized independently.</p>
            <div className="grid grid-cols-2 gap-3 mb-6">
              {(['IVR_MIN','IVR_IC_MAX','DTE_MIN','DTE_MAX','SPREAD_DELTA_MIN','SPREAD_DELTA_MAX','IC_DELTA_MIN','IC_DELTA_MAX','OI_MIN','BID_ASK_MAX','CREDIT_RATIO_MIN','MAX_SPREAD_WIDTH','ROC_MIN_SPREAD','ROC_MIN_IC'] as (keyof RulesType)[]).map(key => (
                <div key={key}>
                  <p className="text-[9px] text-slate-300 tracking-wider mb-1">{RULE_LABELS[key] ?? key}{key === 'MAX_SPREAD_WIDTH' && <span className="text-slate-500 ml-1">(optimizer cap)</span>}</p>
                  <input type="number" step="any" value={runtimeRules[key]} onChange={e => setRuntimeRules(prev => ({ ...prev, [key]: parseFloat(e.target.value) || 0 }))}
                    className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-slate-400" />
                </div>
              ))}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setRuntimeRules({ ...DEFAULT_RULES })} className="flex-1 border border-slate-600 text-yellow-400 py-2 rounded text-xs tracking-widest hover:border-yellow-500 font-medium">RESET</button>
              <button onClick={() => setShowRulesModal(false)} className="flex-1 border border-slate-600 text-slate-300 py-2 rounded text-xs tracking-widest hover:border-slate-400">CANCEL</button>
              <button onClick={() => { setShowRulesModal(false); localStorage.setItem('prosper-rules', JSON.stringify(runtimeRules)); runScreen(runtimeRules); }}
                className="flex-1 bg-white text-black py-2 rounded text-xs font-bold tracking-widest hover:bg-slate-200">RUN</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
