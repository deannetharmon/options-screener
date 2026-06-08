// path: app/trade-log/page.tsx

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

const BASE       = 'https://api.tastytrade.com';
const CLIENT_ID  = '4d4c851b-bdaf-4ac9-b39b-811e604739f2';
const LS_DEVICE  = 'hunter-device-id';
const LS_TL_1W   = 'hunter-tradelog-1w';
const LS_TL_2W   = 'hunter-tradelog-2w';
const LS_TL_1M   = 'hunter-tradelog-1m';
const LS_TL_3M   = 'hunter-tradelog-3m';
const LS_TL_6M   = 'hunter-tradelog-6m';
const LS_TL_12M  = 'hunter-tradelog-12m';
const CACHE_VERSION = 'v3'; // bump to invalidate stale caches

type TimeRange = '1w' | '2w' | '1m' | '3m' | '6m' | '12m';
type Outcome  = 'WIN' | 'LOSS' | 'SCRATCH' | 'OPEN';
type ExitType = 'TARGET_HIT' | 'FAST_CUT' | 'TIME_STOP' | 'MAX_LOSS' | 'HELD_TO_EXPIRY' | 'EARLY_WIN' | 'UNKNOWN';
type SortField = 'closeDate' | 'openDate' | 'symbol' | 'strategy' | 'pnl' | 'pnlPct' | 'holdDays';
type SortDir = 'asc' | 'desc';
type GroupBy = 'none' | 'symbol' | 'outcome';

interface ClosedTrade {
  id: string;
  symbol: string;
  strategy: 'BPS' | 'BCS' | 'IC' | 'SPREAD' | 'OTHER';
  openDate: string;
  closeDate: string;
  openTime: string;   // HH:MM local
  openDow: number;    // 0=Sun..6=Sat
  expiry: string;
  holdDays: number;
  strikes: string;
  creditReceived: number;
  closePrice: number;
  pnl: number;
  pnlPct: number;
  outcome: Outcome;
  quantity: number;
  fees: number;
  excluded?: boolean;  // user-toggled: excluded from reporting
  dteAtClose: number;    // days remaining to expiry when closed
  dteAtEntry: number;    // estimated DTE when trade was opened
  exitType: ExitType;
}

interface CacheEntry { trades: ClosedTrade[]; fetchedAt: number; deviceId: string; range: TimeRange; }
interface ChatMessage { role: 'user' | 'assistant'; content: string; }

async function getAccessToken(): Promise<string> {
  const cached = sessionStorage.getItem('tt_access_token');
  if (cached) return cached;
  const refreshToken = localStorage.getItem('tt_refresh_token');
  const clientSecret = localStorage.getItem('tt_client_secret') ?? '';
  if (!refreshToken || !clientSecret) { window.location.href = '/login'; throw new Error('Not authenticated'); }
  const res = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID, client_secret: clientSecret }) });
  if (!res.ok) { sessionStorage.removeItem('tt_access_token'); localStorage.removeItem('tt_refresh_token'); window.location.href = '/login'; throw new Error('Session expired'); }
  const data = await res.json();
  const token = data.access_token;
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
function getDeviceId(): string {
  try { let id = localStorage.getItem(LS_DEVICE); if (!id) { id = crypto.randomUUID(); localStorage.setItem(LS_DEVICE, id); } return id; } catch { return 'unknown'; }
}
const LS_KEY: Record<TimeRange, string> = { '1w': LS_TL_1W, '2w': LS_TL_2W, '1m': LS_TL_1M, '3m': LS_TL_3M, '6m': LS_TL_6M, '12m': LS_TL_12M };
function readCache(range: TimeRange): CacheEntry | null {
  try {
    const raw = localStorage.getItem(LS_KEY[range]);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry & { version?: string };
    if (parsed.version !== CACHE_VERSION) return null; // stale schema
    return parsed;
  } catch { return null; }
}
function writeCache(range: TimeRange, trades: ClosedTrade[]) {
  try { localStorage.setItem(LS_KEY[range], JSON.stringify({ trades, fetchedAt: Date.now(), deviceId: getDeviceId(), range, version: CACHE_VERSION })); } catch {}
}

function parseOccSymbol(occ: string): { symbol: string; expiry: string; optionType: 'P' | 'C' | null; strike: number } {
  const cleaned = occ.replace(/\s+/g, '');
  const m = cleaned.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!m) return { symbol: occ, expiry: '', optionType: null, strike: 0 };
  const y = '20' + m[2].slice(0, 2), mo = m[2].slice(2, 4), d = m[2].slice(4, 6);
  return { symbol: m[1], expiry: `${y}-${mo}-${d}`, optionType: m[3] as 'P' | 'C', strike: parseInt(m[4], 10) / 1000 };
}
function rangeStartDate(range: TimeRange): string {
  const d = new Date();
  if      (range === '1w')  d.setDate(d.getDate() - 7);
  else if (range === '2w')  d.setDate(d.getDate() - 14);
  else if (range === '1m')  d.setMonth(d.getMonth() - 1);
  else if (range === '3m')  d.setMonth(d.getMonth() - 3);
  else if (range === '6m')  d.setMonth(d.getMonth() - 6);
  else                      d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().split('T')[0];
}


// ── Exit classification ───────────────────────────────────────────────────
function classifyExit(
  pnl: number,
  creditReceived: number,
  holdDays: number,
  dteAtClose: number,
  dteAtEntry: number,
): ExitType {
  if (creditReceived === 0) return 'UNKNOWN';
  const pnlPct = (pnl / Math.abs(creditReceived)) * 100;
  const pctOfDteUsed = dteAtEntry > 0 ? holdDays / dteAtEntry : 0;

  if (pnl >= 0) {
    if (holdDays <= 3 && pnlPct < 30) return 'EARLY_WIN';           // very fast, small win
    if (pnlPct >= 30 && pnlPct <= 70) return 'TARGET_HIT';          // clean ~50% target
    if (pnlPct > 70 || pctOfDteUsed >= 0.75) return 'HELD_TO_EXPIRY'; // let it ride
    return 'TARGET_HIT';
  } else {
    if (pnlPct < -100) return 'MAX_LOSS';                            // loss > full credit — held too long
    if (holdDays <= 2) return 'FAST_CUT';                            // quick defensive exit
    if (dteAtClose > 0 && dteAtClose <= 21) return 'TIME_STOP';      // hit 21-DTE rule
    if (holdDays >= 14) return 'MAX_LOSS';                            // held long time with a loss
    return 'FAST_CUT';
  }
}

async function fetchAndReconstructTrades(range: TimeRange): Promise<ClosedTrade[]> {
  const token = await getAccessToken();
  const accountsData = await ttFetch('/customers/me/accounts', token);
  const accountNumber = accountsData?.data?.items?.[0]?.account?.['account-number'];
  if (!accountNumber) throw new Error('No account found');
  const startDate = rangeStartDate(range);
  let allTx: any[] = [];
  let page = 1;
  while (true) {
    const data = await ttFetch(`/accounts/${accountNumber}/transactions?start-date=${startDate}&per-page=250&page-offset=${(page - 1) * 250}`, token);
    const items: any[] = data?.data?.items ?? [];
    allTx = [...allTx, ...items];
    if (!data?.pagination || items.length < 250 || allTx.length >= data.pagination['total-items']) break;
    page++;
  }
  // Log a sample transaction to check field names
  const optionTx = allTx.filter(tx => tx['transaction-type'] === 'Trade' && tx.symbol && parseOccSymbol(tx.symbol).optionType !== null);
  const txTypes = allTx.map(tx => tx['transaction-type']).filter((v, i, a) => a.indexOf(v) === i);
  // Log action-description values present in optionTx
  const byOptionSymbol: Record<string, any[]> = {};
  for (const tx of optionTx) {
    const sym = tx.symbol.replace(/\s+/g, '');
    if (!byOptionSymbol[sym]) byOptionSymbol[sym] = [];
    byOptionSymbol[sym].push(tx);
  }
  const legPairs: any[] = [];
  for (const [sym, txList] of Object.entries(byOptionSymbol)) {
    const parsed = parseOccSymbol(sym);
    if (!parsed.optionType) continue;
    const getTimestamp = (tx: any) => tx['executed-at'] ?? tx['transaction-date'] ?? tx['settled-at'] ?? '';
    const opens  = txList.filter((tx: any) => tx['transaction-sub-type'] === 'Sell to Open' || tx['transaction-sub-type'] === 'Buy to Open');
    const closes = txList.filter((tx: any) => tx['transaction-sub-type'] === 'Buy to Close' || tx['transaction-sub-type'] === 'Sell to Close');
    const openQueue  = [...opens].sort((a, b) => getTimestamp(a).localeCompare(getTimestamp(b)));
    const closeQueue = [...closes].sort((a, b) => getTimestamp(a).localeCompare(getTimestamp(b)));
    for (const openTx of openQueue) {
      const openQty = Math.abs(parseFloat(openTx.quantity ?? '1'));
      const matchIdx = closeQueue.findIndex((c: any) => Math.abs(parseFloat(c.quantity ?? '1')) === openQty && getTimestamp(c) > getTimestamp(openTx));
      if (matchIdx === -1) continue;
      const closeTx = closeQueue.splice(matchIdx, 1)[0];
      const fees = ['regulatory-fees','clearing-fees','commission'].reduce((s: number, k: string) => s + Math.abs(parseFloat(openTx[k] ?? '0')) + Math.abs(parseFloat(closeTx[k] ?? '0')), 0);
      legPairs.push({ sym, underlying: openTx['underlying-symbol'], expiry: parsed.expiry, optionType: parsed.optionType, strike: parsed.strike, openTx, closeTx, qty: openQty, openPrice: Math.abs(parseFloat(openTx.price ?? '0')), closePrice: Math.abs(parseFloat(closeTx.price ?? '0')), fees });
    }
  }
  const spreadMap: Record<string, any[]> = {};
  for (const pair of legPairs) {
    const getTs2 = (tx: any) => tx['executed-at'] ?? tx['transaction-date'] ?? tx['settled-at'] ?? '';
    const openTs = getTs2(pair.openTx);
    const key = `${pair.underlying}::${pair.expiry}::${openTs.slice(0, 10)}`;
    if (!spreadMap[key]) spreadMap[key] = [];
    spreadMap[key].push(pair);
  }
  const trades: ClosedTrade[] = [];
  for (const [key, pairs] of Object.entries(spreadMap)) {
    const [underlying, expiry, openDay] = key.split('::');
    const putPairs  = pairs.filter((p: any) => p.optionType === 'P');
    const callPairs = pairs.filter((p: any) => p.optionType === 'C');
    let strategy: ClosedTrade['strategy'] = 'SPREAD';
    if (putPairs.length >= 2 && callPairs.length === 0) strategy = 'BPS';
    else if (callPairs.length >= 2 && putPairs.length === 0) strategy = 'BCS';
    else if (putPairs.length >= 2 && callPairs.length >= 2) strategy = 'IC';
    else if (pairs.length > 0) strategy = 'OTHER';
    const sortedPuts  = putPairs.map((p: any) => p.strike).sort((a: number, b: number) => b - a);
    const sortedCalls = callPairs.map((p: any) => p.strike).sort((a: number, b: number) => a - b);
    let strikes = '';
    if (strategy === 'BPS' && sortedPuts.length >= 2) strikes = `${sortedPuts[0]}P/${sortedPuts[1]}P`;
    else if (strategy === 'BCS' && sortedCalls.length >= 2) strikes = `${sortedCalls[0]}C/${sortedCalls[1]}C`;
    else if (strategy === 'IC' && sortedPuts.length >= 2 && sortedCalls.length >= 2) strikes = `${sortedPuts[0]}P/${sortedPuts[1]}P · ${sortedCalls[0]}C/${sortedCalls[1]}C`;
    else strikes = pairs.map((p: any) => `${p.strike}${p.optionType}`).join('/');
    let totalOpenValue = 0, totalCloseValue = 0, totalFees = 0;
    for (const p of pairs) {
      const isShort = p.openTx['transaction-sub-type'] === 'Sell to Open';
      totalOpenValue  += p.openPrice  * p.qty * 100 * (isShort ?  1 : -1);
      totalCloseValue += p.closePrice * p.qty * 100 * (isShort ? -1 :  1);
      totalFees += p.fees;
    }
    const creditReceived = totalOpenValue;
    const closePrice     = -totalCloseValue;
    const pnl     = creditReceived + totalCloseValue - totalFees;
    const pnlPct  = creditReceived !== 0 ? (pnl / Math.abs(creditReceived)) * 100 : 0;
    const getTxTs = (tx: any) => tx['executed-at'] ?? tx['transaction-date'] ?? tx['settled-at'] ?? '';
    const closeDate = pairs.map((p: any) => getTxTs(p.closeTx).slice(0, 10)).filter(Boolean).sort().reverse()[0] ?? openDay;
    const holdDays  = Math.round((new Date(closeDate).getTime() - new Date(openDay).getTime()) / 86400000);
    const outcome: Outcome = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'SCRATCH';
    // Entry time metadata — use the earliest open leg timestamp
    // TastyTrade uses 'executed-at'; fall back to other timestamp fields if missing
    const getTs = (tx: any) => tx['executed-at'] ?? tx['transaction-date'] ?? tx['settled-at'] ?? '';
    const earliestOpen = pairs.map((p: any) => getTs(p.openTx)).filter(Boolean).sort()[0] ?? '';
    let openTime = '';
    let openDow  = -1;
    if (earliestOpen) {
      // Parse as ET — market hours are always Eastern regardless of user's local timezone
      try {
        const etStr = new Date(earliestOpen).toLocaleString('en-US', { timeZone: 'America/New_York' });
        const etDt  = new Date(etStr);
        openTime = `${String(etDt.getHours()).padStart(2,'0')}:${String(etDt.getMinutes()).padStart(2,'0')}`;
        openDow  = etDt.getDay();
      } catch {
        const fallback = new Date(earliestOpen);
        openTime = `${String(fallback.getHours()).padStart(2,'0')}:${String(fallback.getMinutes()).padStart(2,'0')}`;
        openDow  = fallback.getDay();
      }
    }
    // DTE calculations
    // Add T12:00:00Z to force UTC noon — prevents timezone day-shift on date-only strings
    const dteAtClose = Math.max(0, Math.round((new Date(expiry + 'T12:00:00Z').getTime() - new Date(closeDate + 'T12:00:00Z').getTime()) / 86400000));
    const dteAtEntry = holdDays + dteAtClose;
    const exitType   = classifyExit(pnl, creditReceived, holdDays, dteAtClose, dteAtEntry);
    trades.push({ id: `${underlying}-${openDay}-${expiry}`, symbol: underlying, strategy, openDate: openDay, closeDate, openTime, openDow, expiry, holdDays, dteAtClose, dteAtEntry, exitType, strikes, creditReceived, closePrice, pnl, pnlPct, outcome, quantity: strategy === 'IC' ? Math.min(putPairs.length, callPairs.length) : Math.max(putPairs.length, callPairs.length, 1), fees: totalFees });
  }
  trades.sort((a, b) => b.closeDate.localeCompare(a.closeDate));
  return trades;
}

// ── AI ────────────────────────────────────────────────────────────────────
const AI_SYSTEM_PROMPT = `You are a brutally honest options trading coach reviewing a trader's actual closed trade history. Your job is to find real patterns, call out mistakes without softening them, and give specific actionable advice.

Do not hedge. Do not add disclaimers. If the data shows a clear problem, say so directly. If a pattern is costing money, name it explicitly. Be direct like a mentor who respects the trader enough to tell them the truth.

Respond in clear conversational prose. No JSON. No markdown headers. Use short paragraphs. When you cite a stat, be specific with numbers.`;

function buildTradeAnalysisPrompt(trades: ClosedTrade[], range: TimeRange): string {
  const total = trades.length;
  if (total === 0) return 'No closed trades found in this period.';

  const wins    = trades.filter(t => t.outcome === 'WIN');
  const losses  = trades.filter(t => t.outcome === 'LOSS');
  const winRate = Math.round((wins.length / total) * 100);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin  = wins.length   > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const avgHold = Math.round(trades.reduce((s, t) => s + t.holdDays, 0) / total);

  // By strategy
  const strategies = ['BPS','BCS','IC','SPREAD','OTHER'] as const;
  const byStrategy = strategies.map(s => {
    const g = trades.filter(t => t.strategy === s);
    if (g.length === 0) return null;
    const w = g.filter(t => t.outcome === 'WIN').length;
    const pnl = g.reduce((sum, t) => sum + t.pnl, 0);
    return { strategy: s, count: g.length, winRate: Math.round((w / g.length) * 100), pnl: pnl.toFixed(0), avgPnlPct: (g.reduce((sum, t) => sum + t.pnlPct, 0) / g.length).toFixed(1) };
  }).filter(Boolean);

  // By symbol
  const symMap: Record<string, { count: number; wins: number; pnl: number }> = {};
  for (const t of trades) {
    if (!symMap[t.symbol]) symMap[t.symbol] = { count: 0, wins: 0, pnl: 0 };
    symMap[t.symbol].count++;
    if (t.outcome === 'WIN') symMap[t.symbol].wins++;
    symMap[t.symbol].pnl += t.pnl;
  }
  const bySymbol = Object.entries(symMap).sort((a, b) => b[1].pnl - a[1].pnl)
    .map(([sym, v]) => `${sym}: ${v.count} trades, ${Math.round(v.wins/v.count*100)}% win, $${v.pnl.toFixed(0)} P&L`);

  // By day of week
  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dowMap: Record<number, { count: number; wins: number; pnl: number }> = {};
  for (const t of trades) {
    if (t.openDow < 0) continue;
    if (!dowMap[t.openDow]) dowMap[t.openDow] = { count: 0, wins: 0, pnl: 0 };
    dowMap[t.openDow].count++;
    if (t.outcome === 'WIN') dowMap[t.openDow].wins++;
    dowMap[t.openDow].pnl += t.pnl;
  }
  const byDow = Object.entries(dowMap).sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([d, v]) => `${DOW[Number(d)]}: ${v.count} trades, ${Math.round(v.wins/v.count*100)}% win, $${v.pnl.toFixed(0)}`);

  // By time of day bucket
  const timeBuckets = [
    { label: 'Open (9:30–10:30)', min: 570, max: 630 },
    { label: 'Morning (10:30–12:00)', min: 630, max: 720 },
    { label: 'Midday (12:00–14:00)', min: 720, max: 840 },
    { label: 'Afternoon (14:00–15:00)', min: 840, max: 900 },
    { label: 'Close (15:00–16:00)', min: 900, max: 960 },
  ];
  const byTime = timeBuckets.map(b => {
    const g = trades.filter(t => {
      if (!t.openTime) return false;
      const [h, m] = t.openTime.split(':').map(Number);
      const mins = h * 60 + m;
      return mins >= b.min && mins < b.max;
    });
    if (g.length === 0) return null;
    const w = g.filter(t => t.outcome === 'WIN').length;
    const pnl = g.reduce((s, t) => s + t.pnl, 0);
    return `${b.label}: ${g.length} trades, ${Math.round(w/g.length*100)}% win, $${pnl.toFixed(0)}`;
  }).filter(Boolean);

  // Hold time analysis
  const holdBuckets = [
    { label: '0–7 days', min: 0, max: 7 },
    { label: '8–14 days', min: 8, max: 14 },
    { label: '15–21 days', min: 15, max: 21 },
    { label: '22–30 days', min: 22, max: 30 },
    { label: '31+ days', min: 31, max: 999 },
  ];
  const byHold = holdBuckets.map(b => {
    const g = trades.filter(t => t.holdDays >= b.min && t.holdDays <= b.max);
    if (g.length === 0) return null;
    const w = g.filter(t => t.outcome === 'WIN').length;
    return `${b.label}: ${g.length} trades, ${Math.round(w/g.length*100)}% win`;
  }).filter(Boolean);

  // Behavioral flags
  const sorted = [...trades].sort((a, b) => a.closeDate.localeCompare(b.closeDate));
  let revengeTrades = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i-1].outcome === 'LOSS' && sorted[i].outcome === 'LOSS') {
      const daysBetween = Math.round((new Date(sorted[i].openDate).getTime() - new Date(sorted[i-1].closeDate).getTime()) / 86400000);
      if (daysBetween <= 2) revengeTrades++;
    }
  }

  return `Analyze this trader's closed options trade history from the last ${range === '3m' ? '3 months' : range === '6m' ? '6 months' : '12 months'} and give brutally honest coaching feedback.

OVERALL (${total} closed trades):
Win rate: ${winRate}%  |  Total P&L: $${totalPnl.toFixed(0)}  |  Avg win: $${avgWin.toFixed(0)}  |  Avg loss: $${avgLoss.toFixed(0)}  |  Avg hold: ${avgHold} days

BY STRATEGY:
${byStrategy.map(s => `${s!.strategy}: ${s!.count} trades, ${s!.winRate}% win, $${s!.pnl} total, avg ${s!.avgPnlPct}%`).join('\n')}

BY SYMBOL (best to worst P&L):
${bySymbol.join('\n')}

ENTRY DAY OF WEEK:
${byDow.join('\n')}

ENTRY TIME OF DAY:
${byTime.length > 0 ? byTime.join('\n') : 'Insufficient time data'}

HOLD TIME vs WIN RATE:
${byHold.join('\n')}

BEHAVIORAL FLAGS:
Potential revenge trades (loss followed by another entry within 2 days that also lost): ${revengeTrades}

EXIT TYPE BREAKDOWN:
${(() => {
  const exitLabels: Record<string, string> = {
    TARGET_HIT:     'Target hit (40–65% profit)',
    FAST_CUT:       'Fast cut (exit ≤2 days, loss)',
    TIME_STOP:      'Time stop (closed at ≤21 DTE)',
    MAX_LOSS:       'Max loss (held too long, >150% loss)',
    HELD_TO_EXPIRY: 'Held to expiry (win but risky)',
    EARLY_WIN:      'Early win (closed fast, small gain)',
  };
  const types = ['TARGET_HIT','FAST_CUT','TIME_STOP','MAX_LOSS','HELD_TO_EXPIRY','EARLY_WIN'];
  return types.map(et => {
    const g = trades.filter(t => t.exitType === et);
    if (g.length === 0) return null;
    const w = g.filter(t => t.outcome === 'WIN').length;
    const pnl = g.reduce((s, t) => s + t.pnl, 0);
    const avgH = Math.round(g.reduce((s, t) => s + t.holdDays, 0) / g.length);
    return `${exitLabels[et]}: ${g.length} trades, ${Math.round(w/g.length*100)}% win, $${pnl.toFixed(0)} total, avg ${avgH}d hold`;
  }).filter(Boolean).join('\n');
})()}

LOSS DETAIL (each losing trade with context):
${trades.filter(t => t.outcome === 'LOSS').map(t =>
  `${t.symbol} ${t.strategy}: held ${t.holdDays}d, ${t.dteAtClose}DTE remaining at close, loss ${t.pnlPct.toFixed(0)}% of credit [${t.exitType}]`
).join('\n') || 'No losses in this period'}

Provide honest coaching. Lead with exit behavior analysis first — for each loss, was the exit disciplined or a mistake? Were the fast cuts the right call or panic? Which losses came from holding too long? Then cover: strategy patterns, entry timing issues, and finish with 3 concrete things to change immediately.`;
}

async function callAIWithHistory(messages: ChatMessage[], system: string): Promise<string> {
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1800, system, messages }),
  });
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err?.error ?? `API error: ${res.status}`); }
  const data = await res.json();
  return data?.content?.find((b: any) => b.type === 'text')?.text ?? '';
}

// ── Formatting ────────────────────────────────────────────────────────────
function fmtDate(d: string) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m,10)-1]} ${parseInt(day,10)}, ${y}`;
}
function fmtAge(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
function exitTypeColor(e: ExitType) {
  if (e === 'TARGET_HIT')     return 'text-emerald-400 border-emerald-700 bg-emerald-500/8';
  if (e === 'FAST_CUT')       return 'text-blue-400 ac-border-faint bg-blue-500/8';
  if (e === 'TIME_STOP')      return 'text-yellow-400 border-yellow-700 bg-yellow-500/8';
  if (e === 'MAX_LOSS')       return 'text-red-400 border-red-700 bg-red-500/8';
  if (e === 'HELD_TO_EXPIRY') return 'text-orange-400 border-orange-700 bg-orange-500/8';
  if (e === 'EARLY_WIN')      return 'text-purple-400 border-purple-700 bg-purple-500/8';
  return 'text-slate-400 border-slate-700';
}
function exitTypeLabel(e: ExitType) {
  if (e === 'TARGET_HIT')     return 'Target Hit';
  if (e === 'FAST_CUT')       return 'Fast Cut';
  if (e === 'TIME_STOP')      return 'Time Stop';
  if (e === 'MAX_LOSS')       return 'Max Loss';
  if (e === 'HELD_TO_EXPIRY') return 'Held to Expiry';
  if (e === 'EARLY_WIN')      return 'Early Win';
  return 'Unknown';
}

function outcomeColor(o: Outcome) {
  if (o === 'WIN')     return 'text-emerald-400 border-emerald-600 bg-emerald-500/10';
  if (o === 'LOSS')    return 'text-red-400 border-red-600 bg-red-500/10';
  if (o === 'SCRATCH') return 'text-yellow-400 border-yellow-600 bg-yellow-500/10';
  return 'text-slate-400 border-slate-600 bg-slate-500/10';
}
function stratColor(s: string) {
  if (s === 'BPS') return 'text-emerald-400 border-emerald-600';
  if (s === 'BCS') return 'text-red-400 border-red-600';
  if (s === 'IC')  return 'text-blue-400 ac-border';
  return 'text-slate-400 border-slate-600';
}

// ── AI Chat Panel ─────────────────────────────────────────────────────────
function AIChatPanel({ trades, range, th, onClose }: {
  trades: ClosedTrade[];
  range: TimeRange;
  th: typeof THEMES[Theme];
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [initializing, setInitializing] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-run initial analysis on open
  useEffect(() => {
    const runInitial = async () => {
      setInitializing(true);
      const prompt = buildTradeAnalysisPrompt(trades, range);
      const initMessages: ChatMessage[] = [{ role: 'user', content: prompt }];
      try {
        const reply = await callAIWithHistory(initMessages, AI_SYSTEM_PROMPT);
        setMessages([{ role: 'assistant', content: reply }]);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setInitializing(false);
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    };
    runInitial();
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    setError('');
    const next: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setLoading(true);
    try {
      const reply = await callAIWithHistory(next, AI_SYSTEM_PROMPT);
      setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const suggestions = [
    'Which symbol should I stop trading?',
    'Is my risk/reward ratio sustainable?',
    'What time of day gives me the best entries?',
    'Am I cutting winners too early?',
    'What should I focus on for the next month?',
  ];

  return (
    <div className={`fixed top-0 right-0 h-full w-[480px] max-w-[95vw] ${th.sidebar} border-l ${th.border} flex flex-col z-50 shadow-2xl`}
         style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      {/* Header */}
      <div className={`flex items-center justify-between px-5 py-4 border-b ${th.border} shrink-0`}>
        <div>
          <p className={`text-sm font-bold ${th.text} tracking-wider`}>◈ AI COACHING</p>
          <p className={`text-[10px] ${th.textFaint} mt-0.5`}>
            {trades.length} trades · {range === '3m' ? '3 months' : range === '6m' ? '6 months' : '12 months'}
          </p>
        </div>
        <button onClick={onClose} className={`${th.textFaint} hover:${th.text} text-xl leading-none`}>✕</button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {initializing && (
          <div className="flex items-center gap-3 py-8 justify-center">
            <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            <p className={`text-xs ${th.textFaint}`}>Analyzing your trade history...</p>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role === 'assistant' && <span className="text-indigo-400 text-[11px] mt-1 shrink-0 font-bold">◈</span>}
            <div className={`rounded-2xl px-4 py-3 text-[12px] leading-relaxed whitespace-pre-wrap max-w-[92%] ${
              m.role === 'user'
                ? 'ac-bg-20 border ac-border/30 text-blue-100 ml-auto'
                : `${th.card} border ${th.border} ${th.textMuted}`
            }`}>
              {m.content}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex gap-3 justify-start">
            <span className="text-indigo-400 text-[11px] mt-1 shrink-0 font-bold">◈</span>
            <div className={`${th.card} border ${th.border} rounded-2xl px-4 py-3`}>
              <div className="flex gap-1 items-center h-4">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}

        {error && <p className="text-[10px] text-red-400 px-1">{error} — <button onClick={send} className="underline">retry</button></p>}
        <div ref={bottomRef} />
      </div>

      {/* Suggestions — shown before user sends first message */}
      {messages.length === 1 && !initializing && (
        <div className="px-5 pb-3 flex flex-wrap gap-1.5 shrink-0">
          {suggestions.map((s, i) => (
            <button key={i} onClick={() => { setInput(s); setTimeout(() => inputRef.current?.focus(), 50); }}
              className={`text-[10px] px-2.5 py-1 rounded-full border ${th.border} ${th.textFaint} hover:border-indigo-500 hover:text-indigo-400 transition-colors`}>
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className={`px-5 py-4 border-t ${th.border} shrink-0`}>
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Ask a follow-up question..."
            rows={2}
            className={`flex-1 resize-none text-xs px-3 py-2.5 border ${th.inputBorder} ${th.input} ${th.text} rounded-xl placeholder:${th.textFaint} focus:outline-none focus:border-indigo-500`}
          />
          <button onClick={send} disabled={loading || !input.trim()}
            className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-xl text-xs font-bold tracking-wider transition-colors shrink-0">
            Send
          </button>
        </div>
        <p className={`text-[9px] ${th.textFaint} mt-1.5`}>Enter to send · Shift+Enter for new line</p>
      </div>
    </div>
  );
}


// ── Multi-Select Filter ───────────────────────────────────────────────────
function MultiSelect({ label, options, selected, onChange, th }: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];  // empty = all selected
  onChange: (vals: string[]) => void;
  th: typeof THEMES[Theme];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const allSelected = selected.length === 0;
  const toggle = (val: string) => {
    if (val === 'ALL') { onChange([]); return; }
    const next = selected.includes(val)
      ? selected.filter(v => v !== val)
      : [...selected, val];
    onChange(next.length === options.length ? [] : next);
  };

  const summaryLabel = allSelected
    ? `All ${label}`
    : selected.length === 1
    ? options.find(o => o.value === selected[0])?.label ?? selected[0]
    : `${selected.length} ${label}`;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        className={`text-[10px] px-2.5 py-1.5 border rounded flex items-center gap-1.5 transition-colors whitespace-nowrap ${
          !allSelected
            ? 'ac-btn bg-blue-500/8'
            : `${th.inputBorder} ${th.textFaint} ac-hover-border hover:ac-text`
        }`}>
        {summaryLabel}
        <span className="text-[8px] opacity-50">▾</span>
      </button>

      {open && (
        <div className={`absolute top-full mt-1 left-0 z-30 ${th.sidebar} border ${th.border} rounded-xl shadow-2xl py-1.5 min-w-[160px]`}
          onClick={e => e.stopPropagation()}>
          {/* All */}
          <button
            onClick={() => { onChange([]); setOpen(false); }}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-[10px] hover:bg-white/5 transition-colors ${allSelected ? th.text : th.textFaint}`}>
            <span className={`w-3 h-3 border rounded-sm flex items-center justify-center shrink-0 ${allSelected ? 'border-blue-500 bg-blue-500' : th.border}`}>
              {allSelected && <span className="text-white text-[8px]">✓</span>}
            </span>
            All {label}
          </button>
          <div className={`my-1 border-t ${th.borderLight}`} />
          {options.map(opt => {
            const checked = !allSelected && selected.includes(opt.value);
            return (
              <button key={opt.value}
                onClick={() => toggle(opt.value)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-[10px] hover:bg-white/5 transition-colors ${checked ? th.text : th.textFaint}`}>
                <span className={`w-3 h-3 border rounded-sm flex items-center justify-center shrink-0 ${checked ? 'border-blue-500 bg-blue-500' : th.border}`}>
                  {checked && <span className="text-white text-[8px]">✓</span>}
                </span>
                {opt.label}
              </button>
            );
          })}
          {!allSelected && (
            <>
              <div className={`my-1 border-t ${th.borderLight}`} />
              <button onClick={() => { onChange([]); setOpen(false); }}
                className={`w-full px-3 py-1.5 text-[9px] ${th.textFaint} hover:text-red-400 transition-colors text-left`}>
                Clear filter
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────
export default function TradeLogPage() {
  const [theme, setTheme]       = useState<Theme>(getSavedTheme);
  const [accent, setAccent] = useState<Accent>(getSavedAccent);
  useEffect(() => { applyAccent(accent); }, [accent]);
  useEffect(() => { injectAccentStyle(); applyAccent(getSavedAccent()); }, []);
  const th = THEMES[theme];
  const [trades, setTrades]     = useState<ClosedTrade[]>([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [status, setStatus]     = useState('');
  const [range, setRange]       = useState<TimeRange>('3m');
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [isNewDevice, setIsNewDevice] = useState(false);
  const [showAI, setShowAI]     = useState(false);

  const [filterStrategy, setFilterStrategy] = useState<string[]>(() => {
    try { const s = localStorage.getItem('hunter-tl-f-strategy'); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [filterOutcome,  setFilterOutcome]  = useState<string[]>(() => {
    try { const s = localStorage.getItem('hunter-tl-f-outcome');  return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [filterExitType, setFilterExitType] = useState<string[]>(() => {
    try { const s = localStorage.getItem('hunter-tl-f-exit');     return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [filterSymbol,   setFilterSymbol]   = useState(() => {
    try { return localStorage.getItem('hunter-tl-f-symbol') ?? ''; } catch { return ''; }
  });
  const saveFilter = (key: string, val: string[] | string) => {
    try { localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val)); } catch {}
  };
  const [showExcluded,   setShowExcluded]   = useState(false);
  const [excludedIds,    setExcludedIds]    = useState<Set<string>>(() => {
    try { const s = localStorage.getItem('hunter-tradelog-excluded'); return s ? new Set<string>(JSON.parse(s)) : new Set<string>(); } catch { return new Set<string>(); }
  });
  const toggleExclude = (id: string) => {
    setExcludedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      try { localStorage.setItem('hunter-tradelog-excluded', JSON.stringify(Array.from(next))); } catch {}
      return next;
    });
  };
  const [sortField, setSortField] = useState<SortField>('closeDate');
  const [sortDir,   setSortDir]   = useState<SortDir>('desc');
  const [groupBy,   setGroupBy]   = useState<GroupBy>('none');

  const loadTrades = useCallback(async (r: TimeRange, forceRefresh = false) => {
    const deviceId = getDeviceId();
    if (!forceRefresh) {
      const cached = readCache(r);
      if (cached) {
        const sameDevice = cached.deviceId === deviceId;
        const fresh = Date.now() - cached.fetchedAt < 4 * 60 * 60 * 1000;
        if (sameDevice && fresh) { setTrades(cached.trades); setCachedAt(cached.fetchedAt); setIsNewDevice(false); return; }
        if (!sameDevice) { setIsNewDevice(true); setStatus('New device detected — loading from TastyTrade...'); }
        else setStatus('Cache stale — refreshing...');
      } else { setStatus('Loading trade history from TastyTrade...'); }
    } else { setStatus('Refreshing from TastyTrade...'); }
    setLoading(true); setError('');
    try {
      const fetched = await fetchAndReconstructTrades(r);
      setTrades(fetched); writeCache(r, fetched); setCachedAt(Date.now()); setIsNewDevice(false);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); setStatus(''); }
  }, []);

  useEffect(() => { loadTrades('3m'); }, [loadTrades]);

  const handleRangeChange = (r: TimeRange) => { setRange(r); loadTrades(r); };

  const filtered = trades.filter(t => {
    if (!showExcluded && excludedIds.has(t.id)) return false;
    if (filterStrategy.length > 0 && !filterStrategy.includes(t.strategy)) return false;
    if (filterOutcome.length  > 0 && !filterOutcome.includes(t.outcome))   return false;
    if (filterExitType.length > 0 && !filterExitType.includes(t.exitType)) return false;
    if (filterSymbol && !t.symbol.toLowerCase().includes(filterSymbol.toLowerCase())) return false;
    return true;
  });
  const reportingTrades = filtered.filter(t => !excludedIds.has(t.id));

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    switch (sortField) {
      case 'closeDate': cmp = a.closeDate.localeCompare(b.closeDate); break;
      case 'openDate':  cmp = a.openDate.localeCompare(b.openDate);   break;
      case 'symbol':    cmp = a.symbol.localeCompare(b.symbol);        break;
      case 'strategy':  cmp = a.strategy.localeCompare(b.strategy);    break;
      case 'pnl':       cmp = a.pnl - b.pnl;                           break;
      case 'pnlPct':    cmp = a.pnlPct - b.pnlPct;                     break;
      case 'holdDays':  cmp = a.holdDays - b.holdDays;                  break;
    }
    return sortDir === 'desc' ? -cmp : cmp;
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('desc'); }
  };
  const sortIcon = (field: SortField) =>
    sortField !== field ? <span className="text-[8px] opacity-30">↕</span>
    : sortDir === 'desc' ? <span className="text-[9px] text-blue-400">↓</span>
    : <span className="text-[9px] text-blue-400">↑</span>;

  const wins      = reportingTrades.filter(t => t.outcome === 'WIN').length;
  const losses    = reportingTrades.filter(t => t.outcome === 'LOSS').length;
  const scratches = reportingTrades.filter(t => t.outcome === 'SCRATCH').length;
  const total     = reportingTrades.length;
  const excluded  = excludedIds.size;
  const winRate   = total > 0 ? Math.round((wins / total) * 100) : 0;
  const totalPnl  = reportingTrades.reduce((s, t) => s + t.pnl, 0);
  const avgPnlPct = total > 0 ? reportingTrades.reduce((s, t) => s + t.pnlPct, 0) / total : 0;

  const thCol = `text-[9px] text-[#808080] uppercase tracking-widest font-medium cursor-pointer hover:text-white select-none whitespace-nowrap`;

  return (
    <div className={`min-h-screen ${th.bg} pb-24 transition-colors duration-200`} style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>

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
              className={`text-[9px] px-2 py-1 border rounded transition-colors ${theme === t ? 'ac-btn' : `${th.border} ${th.textFaint} hover:ac-border-faint`}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Sticky controls bar */}
      <div className={`${th.header} border-b ${th.border} px-6 py-3 sticky top-[85px] z-40 transition-all duration-300 ${showAI ? 'mr-[480px]' : ''}`}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1">
              {([['1w','1 WK'],['2w','2 WK'],['1m','1 MO'],['3m','3 MO'],['6m','6 MO'],['12m','12 MO']] as [TimeRange,string][]).map(([r,label]) => (
                <button key={r} onClick={() => handleRangeChange(r)} disabled={loading}
                  className={`text-[10px] px-2.5 py-1.5 border rounded font-bold tracking-wider transition-colors disabled:opacity-50 ${range === r ? 'ac-btn ac-bg-10' : `${th.border} ${th.textFaint} hover:ac-border-faint ac-hover-text`}`}>
                  {label}
                </button>
              ))}
            </div>
            <MultiSelect
              label="Strategies"
              options={[
                { value: 'BPS', label: 'BPS' },
                { value: 'BCS', label: 'BCS' },
                { value: 'IC',  label: 'IC' },
                { value: 'OTHER', label: 'Other' },
              ]}
              selected={filterStrategy}
              onChange={v => { setFilterStrategy(v); saveFilter('hunter-tl-f-strategy', v); }}
              th={th}
            />
            <MultiSelect
              label="Outcomes"
              options={[
                { value: 'WIN',     label: 'Win' },
                { value: 'LOSS',    label: 'Loss' },
                { value: 'SCRATCH', label: 'Scratch' },
              ]}
              selected={filterOutcome}
              onChange={v => { setFilterOutcome(v); saveFilter('hunter-tl-f-outcome', v); }}
              th={th}
            />
            <MultiSelect
              label="Exit Types"
              options={[
                { value: 'TARGET_HIT',     label: 'Target Hit' },
                { value: 'FAST_CUT',       label: 'Fast Cut' },
                { value: 'TIME_STOP',      label: 'Time Stop' },
                { value: 'MAX_LOSS',       label: 'Max Loss' },
                { value: 'HELD_TO_EXPIRY', label: 'Held to Expiry' },
                { value: 'EARLY_WIN',      label: 'Early Win' },
              ]}
              selected={filterExitType}
              onChange={v => { setFilterExitType(v); saveFilter('hunter-tl-f-exit', v); }}
              th={th}
            />
            <input value={filterSymbol}
              onChange={e => { setFilterSymbol(e.target.value); saveFilter('hunter-tl-f-symbol', e.target.value); }}
              placeholder="Filter symbol..."
              className={`text-[10px] px-2 py-1.5 border ${th.inputBorder} ${th.input} ${th.text} rounded w-28`} />
          </div>
          <div className="flex items-center gap-3">
            {cachedAt && <span className={`text-[9px] ${th.textFaint}`}>Synced {fmtAge(Date.now() - cachedAt)}</span>}
            {excluded > 0 && (
              <button onClick={() => setShowExcluded(v => !v)}
                className={`text-[10px] px-3 py-1.5 border rounded tracking-wider transition-colors ${showExcluded ? 'border-orange-500 text-orange-400 bg-orange-500/10' : `${th.border} ${th.textFaint} hover:border-orange-500 hover:text-orange-300`}`}>
                {showExcluded ? `⊘ Hide ${excluded} excluded` : `⊘ Show ${excluded} excluded`}
              </button>
            )}
            {trades.length > 0 && (
              <button onClick={() => setShowAI(v => !v)}
                className={`text-[10px] px-3 py-1.5 border rounded font-bold tracking-wider transition-colors ${showAI ? 'border-indigo-500 text-indigo-400 bg-indigo-500/10' : 'border-indigo-700 text-indigo-400 hover:border-indigo-500 hover:bg-indigo-500/10'}`}>
                ◈ AI Analysis {excluded > 0 ? `(${total} trades)` : ''}
              </button>
            )}
            {/* Group toggle */}
            <div className="flex items-center gap-1">
              {([['none','Flat'],['symbol','By Ticker'],['outcome','By Outcome']] as [GroupBy,string][]).map(([g,label]) => (
                <button key={g} onClick={() => setGroupBy(g)}
                  className={`text-[10px] px-2.5 py-1.5 border rounded font-bold tracking-wider transition-colors ${groupBy === g ? 'ac-btn ac-bg-10' : `${th.border} ${th.textFaint} hover:ac-border-faint`}`}>
                  {label}
                </button>
              ))}
            </div>
            <button onClick={() => loadTrades(range, true)} disabled={loading}
              className={`text-[10px] px-3 py-1.5 border ${th.border} rounded ${th.textMuted} ac-hover-border ac-hover-text transition-colors disabled:opacity-50 tracking-wider`}>
              {loading ? '↺ Loading...' : '↺ Refresh'}
            </button>
          </div>
        </div>
      </div>{/* end sticky controls */}

      {/* Scrolling content */}
      <div className={`px-6 py-4 max-w-[1600px] mx-auto space-y-4 transition-all duration-300 ${showAI ? 'mr-[480px]' : ''}`}>

        {isNewDevice && !loading && (
          <div className="flex items-center gap-3 p-3 rounded-lg border border-blue-500/30 bg-blue-500/8">
            <span className="text-blue-400">↺</span>
            <p className="text-xs ac-text">Different device detected — trade history loaded fresh from TastyTrade.</p>
          </div>
        )}

        {(loading || status) && (
          <div className="flex items-center gap-3 p-3 rounded-lg border border-blue-500/20 bg-blue-500/5">
            {loading && <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0" />}
            <p className={`text-xs ${loading ? 'text-blue-400' : th.textFaint}`}>{status || 'Loading...'}</p>
          </div>
        )}
        {error && <div className="p-3 rounded-lg border border-red-500/40 bg-red-500/8"><p className="text-xs text-red-400 font-medium">{error}</p></div>}

        {!loading && total > 0 && (
          <div className={`${th.card} border ${th.border} rounded-xl grid grid-cols-2 md:grid-cols-5`}>
            {[
              { label: 'Trades',    value: String(total),                                         color: th.text },
              { label: 'Win Rate',  value: `${winRate}%`,                                         color: winRate >= 60 ? 'text-emerald-400' : winRate >= 45 ? 'text-yellow-400' : 'text-red-400' },
              { label: 'W / L / S', value: `${wins} / ${losses} / ${scratches}`,                  color: th.textMuted },
              { label: 'Total P&L', value: `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(0)}`,  color: totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400' },
              { label: 'Avg P&L %', value: `${avgPnlPct >= 0 ? '+' : ''}${avgPnlPct.toFixed(1)}%`,color: avgPnlPct >= 0 ? 'text-emerald-400' : 'text-red-400' },
              ...(excluded > 0 ? [{ label: 'Excluded', value: String(excluded), color: 'text-orange-400' }] : []),
            ].map((s, i) => (
              <div key={i} className="px-4 py-3 flex flex-col items-center text-center">
                <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-1`}>{s.label}</p>
                <p className={`text-lg font-bold ${s.color}`} style={{ fontFamily: "'DM Mono', monospace" }}>{s.value}</p>
              </div>
            ))}
          </div>
        )}

        {!loading && sorted.length > 0 && (
          <div className={`${th.card} border ${th.border} rounded-xl overflow-hidden`}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className={`border-b ${th.border}`}>
                    {[
                      { label: 'Symbol',     field: 'symbol'    as SortField },
                      { label: 'Strategy',   field: 'strategy'  as SortField },
                      { label: 'Strikes',    field: null },
                      { label: 'Opened',     field: 'openDate'  as SortField },
                      { label: 'Entry Time', field: null },
                      { label: 'Closed',     field: 'closeDate' as SortField },
                      { label: 'Days Held',  field: 'holdDays'  as SortField },
                      { label: 'Credit',     field: null },
                      { label: 'Close Cost', field: null },
                      { label: 'P&L $',      field: 'pnl'       as SortField },
                      { label: 'P&L %',      field: 'pnlPct'    as SortField },
                      { label: 'DTE Left',   field: null },
                      { label: 'Exit Type',  field: null },
                      { label: 'Outcome',    field: null },
                      { label: '',           field: null },  // exclude toggle
                    ].map(col => (
                      <th key={col.label} className={`px-3 py-2.5 text-left ${thCol}`}
                        onClick={() => col.field && handleSort(col.field)}>
                        <span className="flex items-center gap-1">{col.label}{col.field && sortIcon(col.field)}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {groupBy === 'none' ? sorted.map(trade => (
                    <tr key={trade.id} className={`border-b ${th.borderLight} hover:bg-white/5 transition-colors ${excludedIds.has(trade.id) ? 'opacity-40' : ''}`}>
                      <td className={`px-3 py-2.5 font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{trade.symbol}</td>
                      <td className="px-3 py-2.5"><span className={`text-[9px] px-1.5 py-0.5 border rounded font-bold ${stratColor(trade.strategy)}`}>{trade.strategy}</span></td>
                      <td className={`px-3 py-2.5 ${th.textFaint} text-[10px]`} style={{ fontFamily: "'DM Mono', monospace" }}>{trade.strikes}</td>
                      <td className={`px-3 py-2.5 ${th.textMuted}`}>{fmtDate(trade.openDate)}</td>
                      <td className={`px-3 py-2.5 ${th.textFaint} text-[10px]`} style={{ fontFamily: "'DM Mono', monospace" }}>{trade.openTime || '—'}</td>
                      <td className={`px-3 py-2.5 ${th.textMuted}`}>{fmtDate(trade.closeDate)}</td>
                      <td className={`px-3 py-2.5 ${th.textFaint} text-center`}>{trade.holdDays}d</td>
                      <td className="px-3 py-2.5 text-emerald-400 font-medium" style={{ fontFamily: "'DM Mono', monospace" }}>${trade.creditReceived.toFixed(2)}</td>
                      <td className="px-3 py-2.5 text-red-400/80" style={{ fontFamily: "'DM Mono', monospace" }}>${trade.closePrice.toFixed(2)}</td>
                      <td className={`px-3 py-2.5 font-bold ${trade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>{trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}</td>
                      <td className={`px-3 py-2.5 font-bold ${trade.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>{trade.pnlPct >= 0 ? '+' : ''}{trade.pnlPct.toFixed(1)}%</td>
                      <td className={`px-3 py-2.5 text-center ${th.textFaint} text-[10px]`} style={{ fontFamily: "'DM Mono', monospace" }}>{trade.dteAtClose}d</td>
                      <td className="px-3 py-2.5"><span className={`text-[9px] px-1.5 py-0.5 border rounded font-bold ${exitTypeColor(trade.exitType)}`}>{exitTypeLabel(trade.exitType)}</span></td>
                      <td className="px-3 py-2.5"><span className={`text-[9px] px-1.5 py-0.5 border rounded font-bold ${outcomeColor(trade.outcome)}`}>{trade.outcome}</span></td>
                      <td className="px-3 py-2.5">
                        <button
                          onClick={e => { e.stopPropagation(); toggleExclude(trade.id); }}
                          title={excludedIds.has(trade.id) ? 'Include in reporting' : 'Exclude from reporting'}
                          className={`text-[9px] px-1.5 py-0.5 border rounded transition-colors ${
                            excludedIds.has(trade.id)
                              ? 'border-orange-600 text-orange-400 bg-orange-500/10 hover:bg-orange-500/20'
                              : `${th.border} ${th.textFaint} hover:border-orange-500 hover:text-orange-400`
                          }`}>
                          {excludedIds.has(trade.id) ? '⊘ excl.' : '⊘'}
                        </button>
                      </td>
                    </tr>
                  )) : (() => {
                    const groupKeys: string[] = groupBy === 'symbol'
                      ? sorted.map(t => t.symbol).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => {
                          const ap = sorted.filter(t2 => t2.symbol === a).reduce((s, t2) => s + t2.pnl, 0);
                          const bp = sorted.filter(t2 => t2.symbol === b).reduce((s, t2) => s + t2.pnl, 0);
                          return bp - ap;
                        })
                      : ['WIN', 'LOSS', 'SCRATCH'];
                    const rows: React.ReactNode[] = [];
                    for (const key of groupKeys) {
                      const group = sorted.filter(t => groupBy === 'symbol' ? t.symbol === key : t.outcome === key);
                      if (group.length === 0) continue;
                      const groupPnl = group.reduce((s, t) => s + t.pnl, 0);
                      const groupWins = group.filter(t => t.outcome === 'WIN').length;
                      const groupWinRate = Math.round(groupWins / group.length * 100);
                      const hdrColor = groupBy === 'outcome'
                        ? (key === 'WIN' ? 'text-emerald-400' : key === 'LOSS' ? 'text-red-400' : 'text-yellow-400')
                        : th.text;
                      rows.push(
                        <tr key={`hdr-${key}`} style={{ background: 'rgba(255,255,255,0.04)' }}>
                          <td colSpan={15} className={`px-3 py-1.5 border-t border-b ${th.border}`}>
                            <div className="flex items-center gap-3">
                              <span className={`text-[10px] font-bold tracking-widest ${hdrColor}`} style={{ fontFamily: "'DM Mono', monospace" }}>{key}</span>
                              <span className={`text-[9px] ${th.textFaint}`}>{group.length} trade{group.length !== 1 ? 's' : ''}</span>
                              {groupBy === 'symbol' && <span className={`text-[9px] ${groupWinRate >= 60 ? 'text-emerald-400' : groupWinRate >= 40 ? 'text-yellow-400' : 'text-red-400'}`}>{groupWinRate}% win</span>}
                              <span className={`text-[9px] font-bold ${groupPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{groupPnl >= 0 ? '+' : ''}${groupPnl.toFixed(0)}</span>
                            </div>
                          </td>
                        </tr>
                      );
                      for (const trade of group) {
                        rows.push(
                          <tr key={trade.id} className={`border-b ${th.borderLight} hover:bg-white/5 transition-colors ${excludedIds.has(trade.id) ? 'opacity-40' : ''}`}>
                            <td className={`px-3 py-2.5 font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{trade.symbol}</td>
                            <td className="px-3 py-2.5"><span className={`text-[9px] px-1.5 py-0.5 border rounded font-bold ${stratColor(trade.strategy)}`}>{trade.strategy}</span></td>
                            <td className={`px-3 py-2.5 ${th.textFaint} text-[10px]`} style={{ fontFamily: "'DM Mono', monospace" }}>{trade.strikes}</td>
                            <td className={`px-3 py-2.5 ${th.textMuted}`}>{fmtDate(trade.openDate)}</td>
                            <td className={`px-3 py-2.5 ${th.textFaint} text-[10px]`} style={{ fontFamily: "'DM Mono', monospace" }}>{trade.openTime || '—'}</td>
                            <td className={`px-3 py-2.5 ${th.textMuted}`}>{fmtDate(trade.closeDate)}</td>
                            <td className={`px-3 py-2.5 ${th.textFaint} text-center`}>{trade.holdDays}d</td>
                            <td className="px-3 py-2.5 text-emerald-400 font-medium" style={{ fontFamily: "'DM Mono', monospace" }}>${trade.creditReceived.toFixed(2)}</td>
                            <td className="px-3 py-2.5 text-red-400/80" style={{ fontFamily: "'DM Mono', monospace" }}>${trade.closePrice.toFixed(2)}</td>
                            <td className={`px-3 py-2.5 font-bold ${trade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>{trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}</td>
                            <td className={`px-3 py-2.5 font-bold ${trade.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>{trade.pnlPct >= 0 ? '+' : ''}{trade.pnlPct.toFixed(1)}%</td>
                            <td className={`px-3 py-2.5 text-center ${th.textFaint} text-[10px]`} style={{ fontFamily: "'DM Mono', monospace" }}>{trade.dteAtClose}d</td>
                            <td className="px-3 py-2.5"><span className={`text-[9px] px-1.5 py-0.5 border rounded font-bold ${exitTypeColor(trade.exitType)}`}>{exitTypeLabel(trade.exitType)}</span></td>
                            <td className="px-3 py-2.5"><span className={`text-[9px] px-1.5 py-0.5 border rounded font-bold ${outcomeColor(trade.outcome)}`}>{trade.outcome}</span></td>
                            <td className="px-3 py-2.5">
                              <button onClick={e => { e.stopPropagation(); toggleExclude(trade.id); }}
                                title={excludedIds.has(trade.id) ? 'Include in reporting' : 'Exclude from reporting'}
                                className={`text-[9px] px-1.5 py-0.5 border rounded transition-colors ${excludedIds.has(trade.id) ? 'border-orange-600 text-orange-400 bg-orange-500/10 hover:bg-orange-500/20' : `${th.border} ${th.textFaint} hover:border-orange-500 hover:text-orange-400`}`}>
                                {excludedIds.has(trade.id) ? '⊘ excl.' : '⊘'}
                              </button>
                            </td>
                          </tr>
                        );
                      }
                    }
                    return rows;
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!loading && !error && total === 0 && trades.length > 0 && (
          <div className={`text-center py-12 ${th.textFaint}`}><p className="text-sm">No trades match your filters.</p></div>
        )}
        {!loading && !error && trades.length === 0 && (
          <div className={`text-center py-16 ${th.textFaint}`}>
            <div className="text-4xl mb-3 opacity-20">◈</div>
            <p className="text-sm">No closed trades found in this period.</p>
          </div>
        )}
      </div>

      {showAI && (
        <AIChatPanel trades={reportingTrades.length > 0 ? reportingTrades : trades} range={range} th={th} onClose={() => setShowAI(false)} />
      )}
    </div>
  );
}
