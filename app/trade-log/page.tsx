// path: app/trade-log/page.tsx
'use client';
import { useState, useEffect, useCallback } from 'react';
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
const BASE        = 'https://api.tastytrade.com';
const CLIENT_ID   = '4d4c851b-bdaf-4ac9-b39b-811e604739f2';
const LS_THEME    = 'hunter-theme';
const LS_DEVICE   = 'hunter-device-id';
const LS_TL_3M    = 'hunter-tradelog-3m';
const LS_TL_6M    = 'hunter-tradelog-6m';
const LS_TL_12M   = 'hunter-tradelog-12m';
const SCRATCH_PCT = 5; // ±5% of credit = scratch

// ── Theme ─────────────────────────────────────────────────────────────────
type Theme = 'dark' | 'medium' | 'light';
const THEMES = {
  dark:   { bg: 'bg-[#0a0a0a]', sidebar: 'bg-[#0f0f0f]', card: 'bg-[#171717]', border: 'border-[#2c2c2c]', borderLight: 'border-[#202020]', header: 'bg-[#0f0f0f]', text: 'text-white', textMuted: 'text-[#e0e0e0]', textFaint: 'text-[#808080]', input: 'bg-[#141414]', inputBorder: 'border-[#353535]', tag: 'bg-[#222222]', label: 'text-[#aaaaaa]' },
  medium: { bg: 'bg-[#141414]', sidebar: 'bg-[#1a1a1a]', card: 'bg-[#202020]', border: 'border-[#333333]', borderLight: 'border-[#282828]', header: 'bg-[#1a1a1a]', text: 'text-white', textMuted: 'text-[#d8d8d8]', textFaint: 'text-[#777777]', input: 'bg-[#1e1e1e]', inputBorder: 'border-[#3a3a3a]', tag: 'bg-[#2a2a2a]', label: 'text-[#999999]' },
  light:  { bg: 'bg-[#f5f5f5]', sidebar: 'bg-white', card: 'bg-white', border: 'border-[#e0e0e0]', borderLight: 'border-[#ebebeb]', header: 'bg-[#111111]', text: 'text-[#111111]', textMuted: 'text-[#1a1a1a]', textFaint: 'text-[#666666]', input: 'bg-white', inputBorder: 'border-[#cccccc]', tag: 'bg-[#f0f0f0]', label: 'text-[#444444]' },
};
function getSavedTheme(): Theme {
  try { const t = localStorage.getItem(LS_THEME); return (t === 'dark' || t === 'medium' || t === 'light') ? t : 'dark'; } catch { return 'dark'; }
}

// ── Types ─────────────────────────────────────────────────────────────────
type TimeRange = '3m' | '6m' | '12m';
type Outcome = 'WIN' | 'LOSS' | 'SCRATCH' | 'OPEN';
type SortField = 'closeDate' | 'openDate' | 'symbol' | 'strategy' | 'pnl' | 'pnlPct' | 'holdDays';
type SortDir = 'asc' | 'desc';

interface ClosedTrade {
  id: string;           // synthetic: symbol+openDate+expiry
  symbol: string;
  strategy: 'BPS' | 'BCS' | 'IC' | 'SPREAD' | 'OTHER';
  openDate: string;
  closeDate: string;
  expiry: string;
  holdDays: number;
  strikes: string;
  creditReceived: number;   // per spread (not per contract)
  closePrice: number;       // what we paid to close
  pnl: number;              // creditReceived - closePrice (positive = profit)
  pnlPct: number;           // pnl / creditReceived * 100
  outcome: Outcome;
  quantity: number;
  fees: number;
}

interface CacheEntry {
  trades: ClosedTrade[];
  fetchedAt: number;
  deviceId: string;
  range: TimeRange;
}

// ── Auth ──────────────────────────────────────────────────────────────────
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
  if (!res.ok) { sessionStorage.removeItem('tt_access_token'); localStorage.removeItem('tt_refresh_token'); window.location.href = '/login'; throw new Error('Session expired'); }
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

// ── Device ID ─────────────────────────────────────────────────────────────
function getDeviceId(): string {
  try {
    let id = localStorage.getItem(LS_DEVICE);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(LS_DEVICE, id); }
    return id;
  } catch { return 'unknown'; }
}

// ── Cache helpers ─────────────────────────────────────────────────────────
const LS_KEY: Record<TimeRange, string> = { '3m': LS_TL_3M, '6m': LS_TL_6M, '12m': LS_TL_12M };

function readCache(range: TimeRange): CacheEntry | null {
  try {
    const raw = localStorage.getItem(LS_KEY[range]);
    if (!raw) return null;
    return JSON.parse(raw) as CacheEntry;
  } catch { return null; }
}

function writeCache(range: TimeRange, trades: ClosedTrade[]) {
  try {
    const entry: CacheEntry = { trades, fetchedAt: Date.now(), deviceId: getDeviceId(), range };
    localStorage.setItem(LS_KEY[range], JSON.stringify(entry));
  } catch {}
}

// ── Transaction parsing ───────────────────────────────────────────────────
function parseOccSymbol(occ: string): { symbol: string; expiry: string; optionType: 'P' | 'C' | null; strike: number } {
  const cleaned = occ.replace(/\s+/g, '');
  const m = cleaned.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!m) return { symbol: occ, expiry: '', optionType: null, strike: 0 };
  const y = '20' + m[2].slice(0, 2), mo = m[2].slice(2, 4), d = m[2].slice(4, 6);
  return { symbol: m[1], expiry: `${y}-${mo}-${d}`, optionType: m[3] as 'P' | 'C', strike: parseInt(m[4], 10) / 1000 };
}

function rangeStartDate(range: TimeRange): string {
  const d = new Date();
  if (range === '3m') d.setMonth(d.getMonth() - 3);
  else if (range === '6m') d.setMonth(d.getMonth() - 6);
  else d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().split('T')[0];
}

interface RawTx {
  id: string;
  'transaction-type': string;
  'transaction-sub-type': string;
  'action': string;
  'symbol': string;
  'underlying-symbol': string;
  'executed-at': string;
  'quantity': string;
  'price': string;
  'value': string;
  'regulatory-fees': string;
  'clearing-fees': string;
  'commission': string;
  'net-value': string;
}

async function fetchAndReconstructTrades(range: TimeRange): Promise<ClosedTrade[]> {
  const token = await getAccessToken();
  const accountsData = await ttFetch('/customers/me/accounts', token);
  const accountNumber = accountsData?.data?.items?.[0]?.account?.['account-number'];
  if (!accountNumber) throw new Error('No account found');

  const startDate = rangeStartDate(range);

  // Paginate transactions — TastyTrade returns max 250 per page
  let allTx: RawTx[] = [];
  let page = 1;
  while (true) {
    const data = await ttFetch(
      `/accounts/${accountNumber}/transactions?start-date=${startDate}&per-page=250&page-offset=${(page - 1) * 250}`,
      token
    );
    const items: RawTx[] = data?.data?.items ?? [];
    allTx = [...allTx, ...items];
    const pagination = data?.pagination;
    if (!pagination || items.length < 250) break;
    if (allTx.length >= pagination['total-items']) break;
    page++;
  }

  // Filter to option trades only
  const optionTx = allTx.filter(tx =>
    tx['transaction-type'] === 'Trade' &&
    tx.symbol &&
    parseOccSymbol(tx.symbol).optionType !== null
  );

  // Group by underlying + expiry to reconstruct spreads
  // Key: underlyingSymbol::expiry::openDate(YYYY-MM-DD)
  // We match opening legs (Sell to Open / Buy to Open) with
  // closing legs (Buy to Close / Sell to Close) by symbol

  // Build a map of symbol → list of transactions
  const byOptionSymbol: Record<string, RawTx[]> = {};
  for (const tx of optionTx) {
    const sym = tx.symbol.replace(/\s+/g, '');
    if (!byOptionSymbol[sym]) byOptionSymbol[sym] = [];
    byOptionSymbol[sym].push(tx);
  }

  // For each option symbol, pair opens with closes
  interface LegPair {
    symbol: string;
    underlying: string;
    expiry: string;
    optionType: 'P' | 'C';
    strike: number;
    openTx: RawTx;
    closeTx: RawTx;
    qty: number;
    openPrice: number;   // per share
    closePrice: number;  // per share
    fees: number;
  }

  const legPairs: LegPair[] = [];

  for (const [sym, txList] of Object.entries(byOptionSymbol)) {
    const parsed = parseOccSymbol(sym);
    if (!parsed.optionType) continue;

    const opens  = txList.filter(tx => tx.action === 'Sell to Open' || tx.action === 'Buy to Open');
    const closes = txList.filter(tx => tx.action === 'Buy to Close' || tx.action === 'Sell to Close');

    // Simple FIFO matching: match each open with a close
    const openQueue = [...opens].sort((a, b) => a['executed-at'].localeCompare(b['executed-at']));
    const closeQueue = [...closes].sort((a, b) => a['executed-at'].localeCompare(b['executed-at']));

    for (const openTx of openQueue) {
      const openQty = Math.abs(parseFloat(openTx.quantity ?? '1'));
      const matchIdx = closeQueue.findIndex(c => {
        const closeQty = Math.abs(parseFloat(c.quantity ?? '1'));
        return closeQty === openQty && c['executed-at'] > openTx['executed-at'];
      });
      if (matchIdx === -1) continue; // still open
      const closeTx = closeQueue.splice(matchIdx, 1)[0];
      const openPrice  = Math.abs(parseFloat(openTx.price ?? '0'));
      const closePrice = Math.abs(parseFloat(closeTx.price ?? '0'));
      const fees = Math.abs(parseFloat(openTx['regulatory-fees'] ?? '0'))
                 + Math.abs(parseFloat(openTx['clearing-fees'] ?? '0'))
                 + Math.abs(parseFloat(openTx.commission ?? '0'))
                 + Math.abs(parseFloat(closeTx['regulatory-fees'] ?? '0'))
                 + Math.abs(parseFloat(closeTx['clearing-fees'] ?? '0'))
                 + Math.abs(parseFloat(closeTx.commission ?? '0'));

      legPairs.push({
        symbol: sym,
        underlying: openTx['underlying-symbol'],
        expiry: parsed.expiry,
        optionType: parsed.optionType,
        strike: parsed.strike,
        openTx,
        closeTx,
        qty: openQty,
        openPrice,
        closePrice,
        fees,
      });
    }
  }

  // Group leg pairs into spreads by: underlying + expiry + same open date (within same day)
  const spreadMap: Record<string, LegPair[]> = {};
  for (const pair of legPairs) {
    const openDay = pair.openTx['executed-at'].slice(0, 10);
    const key = `${pair.underlying}::${pair.expiry}::${openDay}`;
    if (!spreadMap[key]) spreadMap[key] = [];
    spreadMap[key].push(pair);
  }

  const trades: ClosedTrade[] = [];

  for (const [key, pairs] of Object.entries(spreadMap)) {
    const [underlying, expiry, openDay] = key.split('::');
    const putPairs  = pairs.filter(p => p.optionType === 'P');
    const callPairs = pairs.filter(p => p.optionType === 'C');

    let strategy: ClosedTrade['strategy'] = 'SPREAD';
    if (putPairs.length >= 2 && callPairs.length === 0) strategy = 'BPS';
    else if (callPairs.length >= 2 && putPairs.length === 0) strategy = 'BCS';
    else if (putPairs.length >= 2 && callPairs.length >= 2) strategy = 'IC';
    else if (pairs.length > 0) strategy = 'OTHER';

    // Strikes string
    const sortedPuts  = putPairs.map(p => p.strike).sort((a, b) => b - a);
    const sortedCalls = callPairs.map(p => p.strike).sort((a, b) => a - b);
    let strikes = '';
    if (strategy === 'BPS' && sortedPuts.length >= 2)
      strikes = `${sortedPuts[0]}P / ${sortedPuts[1]}P`;
    else if (strategy === 'BCS' && sortedCalls.length >= 2)
      strikes = `${sortedCalls[0]}C / ${sortedCalls[1]}C`;
    else if (strategy === 'IC' && sortedPuts.length >= 2 && sortedCalls.length >= 2)
      strikes = `${sortedPuts[0]}P/${sortedPuts[1]}P · ${sortedCalls[0]}C/${sortedCalls[1]}C`;
    else
      strikes = pairs.map(p => `${p.strike}${p.optionType}`).join(' / ');

    // Quantity = number of spreads (pairs of legs / 2 for IC)
    const qty = strategy === 'IC'
      ? Math.min(putPairs.length, callPairs.length)
      : Math.max(putPairs.length, callPairs.length, 1);

    // P&L: for short spreads (BPS/BCS/IC), we sold to open and bought to close
    // credit = sum of STO prices * 100 * qty
    // debit  = sum of BTC prices * 100 * qty
    // pnl    = (credit - debit) per spread * qty * 100 - fees
    let totalOpenValue = 0;
    let totalCloseValue = 0;
    let totalFees = 0;

    for (const p of pairs) {
      const multiplier = 100;
      const isShortLeg = p.openTx.action === 'Sell to Open';
      const openVal  = p.openPrice  * p.qty * multiplier * (isShortLeg ?  1 : -1);
      const closeVal = p.closePrice * p.qty * multiplier * (isShortLeg ? -1 :  1);
      totalOpenValue  += openVal;
      totalCloseValue += closeVal;
      totalFees += p.fees;
    }

    const creditReceived = totalOpenValue;   // net credit when spread was opened
    const closePrice     = -totalCloseValue; // net debit to close (positive cost)
    const pnl = creditReceived + totalCloseValue - totalFees;
    const pnlPct = creditReceived !== 0 ? (pnl / Math.abs(creditReceived)) * 100 : 0;

    // Close date = latest close transaction date across all legs
    const closeDate = pairs
      .map(p => p.closeTx['executed-at'].slice(0, 10))
      .sort()
      .reverse()[0];

    const openDate = openDay;
    const holdDays = Math.round(
      (new Date(closeDate).getTime() - new Date(openDate).getTime()) / 86400000
    );

    // Outcome
    const pnlPctAbs = Math.abs(pnlPct);
    let outcome: Outcome;
    if (pnlPctAbs <= SCRATCH_PCT) outcome = 'SCRATCH';
    else if (pnl > 0) outcome = 'WIN';
    else outcome = 'LOSS';

    trades.push({
      id: `${underlying}-${openDate}-${expiry}`,
      symbol: underlying,
      strategy,
      openDate,
      closeDate,
      expiry,
      holdDays,
      strikes,
      creditReceived,
      closePrice,
      pnl,
      pnlPct,
      outcome,
      quantity: qty,
      fees: totalFees,
    });
  }

  // Sort by close date descending
  trades.sort((a, b) => b.closeDate.localeCompare(a.closeDate));
  return trades;
}

// ── Formatting helpers ────────────────────────────────────────────────────
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
function outcomeColor(o: Outcome) {
  if (o === 'WIN')    return 'text-emerald-400 border-emerald-600 bg-emerald-500/10';
  if (o === 'LOSS')   return 'text-red-400 border-red-600 bg-red-500/10';
  if (o === 'SCRATCH') return 'text-yellow-400 border-yellow-600 bg-yellow-500/10';
  return 'text-slate-400 border-slate-600 bg-slate-500/10';
}
function stratColor(s: string) {
  if (s === 'BPS') return 'text-emerald-400 border-emerald-600';
  if (s === 'BCS') return 'text-red-400 border-red-600';
  if (s === 'IC')  return 'text-blue-400 border-blue-600';
  return 'text-slate-400 border-slate-600';
}

// ── Main Component ────────────────────────────────────────────────────────
export default function TradeLogPage() {
  const [theme, setTheme] = useState<Theme>(getSavedTheme);
  const th = THEMES[theme];

  const [trades, setTrades]       = useState<ClosedTrade[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [status, setStatus]       = useState('');
  const [range, setRange]         = useState<TimeRange>('3m');
  const [cachedAt, setCachedAt]   = useState<number | null>(null);
  const [isNewDevice, setIsNewDevice] = useState(false);

  // Filter state
  const [filterStrategy, setFilterStrategy] = useState<string>('ALL');
  const [filterOutcome,  setFilterOutcome]  = useState<string>('ALL');
  const [filterSymbol,   setFilterSymbol]   = useState('');

  // Sort state
  const [sortField, setSortField] = useState<SortField>('closeDate');
  const [sortDir,   setSortDir]   = useState<SortDir>('desc');

  const loadTrades = useCallback(async (r: TimeRange, forceRefresh = false) => {
    const deviceId = getDeviceId();

    // Check cache first
    if (!forceRefresh) {
      const cached = readCache(r);
      if (cached) {
        const sameDevice = cached.deviceId === deviceId;
        const fresh = Date.now() - cached.fetchedAt < 4 * 60 * 60 * 1000; // 4h
        if (sameDevice && fresh) {
          setTrades(cached.trades);
          setCachedAt(cached.fetchedAt);
          setIsNewDevice(false);
          return;
        }
        if (!sameDevice) {
          setIsNewDevice(true);
          setStatus('New device detected — loading full history from TastyTrade...');
        } else {
          setStatus('Cache stale — refreshing from TastyTrade...');
        }
      } else {
        setStatus('Loading trade history from TastyTrade...');
      }
    } else {
      setStatus('Refreshing from TastyTrade...');
    }

    setLoading(true);
    setError('');
    try {
      const fetched = await fetchAndReconstructTrades(r);
      setTrades(fetched);
      writeCache(r, fetched);
      setCachedAt(Date.now());
      setIsNewDevice(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      setStatus('');
    }
  }, []);

  // On mount: load 3m from cache or TastyTrade
  useEffect(() => { loadTrades('3m'); }, [loadTrades]);

  const handleRangeChange = (r: TimeRange) => {
    setRange(r);
    loadTrades(r);
  };

  // ── Filtering + sorting ──────────────────────────────────────────────────
  const filtered = trades.filter(t => {
    if (filterStrategy !== 'ALL' && t.strategy !== filterStrategy) return false;
    if (filterOutcome  !== 'ALL' && t.outcome   !== filterOutcome)  return false;
    if (filterSymbol && !t.symbol.toLowerCase().includes(filterSymbol.toLowerCase())) return false;
    return true;
  });

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
    :                      <span className="text-[9px] text-blue-400">↑</span>;

  // ── Summary strip ────────────────────────────────────────────────────────
  const wins     = filtered.filter(t => t.outcome === 'WIN').length;
  const losses   = filtered.filter(t => t.outcome === 'LOSS').length;
  const scratches = filtered.filter(t => t.outcome === 'SCRATCH').length;
  const total    = filtered.length;
  const winRate  = total > 0 ? Math.round((wins / total) * 100) : 0;
  const totalPnl = filtered.reduce((s, t) => s + t.pnl, 0);
  const avgPnlPct = total > 0 ? filtered.reduce((s, t) => s + t.pnlPct, 0) / total : 0;

  const thCol = `text-[9px] ${th.textFaint} uppercase tracking-widest font-medium cursor-pointer hover:${th.text} select-none whitespace-nowrap`;

  return (
    <div className={`min-h-screen ${th.bg} pb-24 transition-colors duration-200`} style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>

      {/* Header */}
      <div className={`${th.header} border-b ${th.border} px-6 py-4 flex items-center justify-between`}>
        <div className="flex items-center gap-6">
          <div>
            <h1 className="text-base font-bold tracking-widest text-white" style={{ fontFamily: "'DM Mono', monospace" }}>OPTIONS HUNTER</h1>
            <p className="text-[10px] text-white/50 mt-0.5 tracking-wider" style={{ fontFamily: "'DM Mono', monospace" }}>TRADE LOG</p>
          </div>
          <nav className="flex items-center gap-1 bg-black/20 rounded-lg p-1">
            <Link href="/"            className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">HUNTER</Link>
            <Link href="/portfolio"   className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">PORTFOLIO</Link>
            <span                     className="text-xs px-3 py-1.5 rounded bg-white/20 text-white tracking-wider">TRADE LOG</span>
            <Link href="/performance" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">PERFORMANCE</Link>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {/* Theme toggle */}
          {(['dark','medium','light'] as Theme[]).map(t => (
            <button key={t} onClick={() => { setTheme(t); try { localStorage.setItem(LS_THEME, t); } catch {} }}
              className={`text-[9px] px-2 py-1 border rounded transition-colors ${theme === t ? 'border-blue-500 text-blue-400' : `${th.border} ${th.textFaint} hover:border-blue-700`}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 py-6 max-w-[1600px] mx-auto space-y-4">

        {/* New device / stale notice */}
        {isNewDevice && !loading && (
          <div className="flex items-center gap-3 p-3 rounded-lg border border-blue-500/30 bg-blue-500/8">
            <span className="text-blue-400 text-sm">↺</span>
            <p className="text-xs text-blue-300">Different device detected — trade history was loaded fresh from TastyTrade and cached for next time.</p>
          </div>
        )}

        {/* Controls row */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            {/* Range selector */}
            <div className="flex items-center gap-1">
              {(['3m','6m','12m'] as TimeRange[]).map(r => (
                <button key={r} onClick={() => handleRangeChange(r)}
                  disabled={loading}
                  className={`text-[10px] px-3 py-1.5 border rounded font-bold tracking-wider transition-colors disabled:opacity-50 ${
                    range === r ? 'border-blue-500 text-blue-400 bg-blue-500/10' : `${th.border} ${th.textFaint} hover:border-blue-700 hover:text-blue-400`
                  }`}>
                  {r === '3m' ? '3 MO' : r === '6m' ? '6 MO' : '12 MO'}
                </button>
              ))}
            </div>

            {/* Filters */}
            <select value={filterStrategy} onChange={e => setFilterStrategy(e.target.value)}
              className={`text-[10px] px-2 py-1.5 border ${th.inputBorder} ${th.input} ${th.text} rounded`}>
              <option value="ALL">All Strategies</option>
              <option value="BPS">BPS</option>
              <option value="BCS">BCS</option>
              <option value="IC">IC</option>
              <option value="OTHER">Other</option>
            </select>

            <select value={filterOutcome} onChange={e => setFilterOutcome(e.target.value)}
              className={`text-[10px] px-2 py-1.5 border ${th.inputBorder} ${th.input} ${th.text} rounded`}>
              <option value="ALL">All Outcomes</option>
              <option value="WIN">Wins</option>
              <option value="LOSS">Losses</option>
              <option value="SCRATCH">Scratches</option>
            </select>

            <input value={filterSymbol} onChange={e => setFilterSymbol(e.target.value)}
              placeholder="Filter symbol..."
              className={`text-[10px] px-2 py-1.5 border ${th.inputBorder} ${th.input} ${th.text} rounded w-28 placeholder:${th.textFaint}`} />
          </div>

          <div className="flex items-center gap-3">
            {cachedAt && (
              <span className={`text-[9px] ${th.textFaint}`}>
                Last synced {fmtAge(Date.now() - cachedAt)}
              </span>
            )}
            <button onClick={() => loadTrades(range, true)} disabled={loading}
              className={`text-[10px] px-3 py-1.5 border ${th.border} rounded ${th.textMuted} hover:border-blue-500 hover:text-blue-400 transition-colors disabled:opacity-50 tracking-wider`}>
              {loading ? '↺ Loading...' : '↺ Refresh'}
            </button>
          </div>
        </div>

        {/* Status / loading message */}
        {(loading || status) && (
          <div className="flex items-center gap-3 p-3 rounded-lg border border-blue-500/20 bg-blue-500/5">
            {loading && <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0" />}
            <p className={`text-xs ${loading ? 'text-blue-400' : th.textFaint}`}>{status || 'Loading...'}</p>
          </div>
        )}

        {error && (
          <div className="p-3 rounded-lg border border-red-500/40 bg-red-500/8">
            <p className="text-xs text-red-400 font-medium">{error}</p>
          </div>
        )}

        {/* Summary strip */}
        {!loading && total > 0 && (
          <div className={`${th.card} border ${th.border} rounded-xl grid grid-cols-2 md:grid-cols-5 divide-x ${th.border}`}>
            {[
              { label: 'Trades', value: String(total), color: th.text },
              { label: 'Win Rate', value: `${winRate}%`, color: winRate >= 60 ? 'text-emerald-400' : winRate >= 45 ? 'text-yellow-400' : 'text-red-400' },
              { label: 'W / L / S', value: `${wins} / ${losses} / ${scratches}`, color: th.textMuted },
              { label: 'Total P&L', value: `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(0)}`, color: totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400' },
              { label: 'Avg P&L %', value: `${avgPnlPct >= 0 ? '+' : ''}${avgPnlPct.toFixed(1)}%`, color: avgPnlPct >= 0 ? 'text-emerald-400' : 'text-red-400' },
            ].map((s, i) => (
              <div key={i} className="px-4 py-3 flex flex-col items-center text-center">
                <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-1`}>{s.label}</p>
                <p className={`text-lg font-bold ${s.color}`} style={{ fontFamily: "'DM Mono', monospace" }}>{s.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Trade table */}
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
                      { label: 'Closed',     field: 'closeDate' as SortField },
                      { label: 'Days Held',  field: 'holdDays'  as SortField },
                      { label: 'Credit',     field: null },
                      { label: 'Close Cost', field: null },
                      { label: 'P&L $',      field: 'pnl'       as SortField },
                      { label: 'P&L %',      field: 'pnlPct'    as SortField },
                      { label: 'Outcome',    field: null },
                    ].map(col => (
                      <th key={col.label}
                        className={`px-3 py-2.5 text-left ${thCol} ${col.field ? 'hover:opacity-80' : ''}`}
                        onClick={() => col.field && handleSort(col.field)}>
                        <span className="flex items-center gap-1">{col.label}{col.field && sortIcon(col.field)}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((trade, i) => (
                    <tr key={trade.id}
                      className={`border-b ${th.borderLight} hover:${th.card === 'bg-white' ? 'bg-gray-50' : 'bg-white/5'} transition-colors`}>
                      <td className={`px-3 py-2.5 font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{trade.symbol}</td>
                      <td className="px-3 py-2.5">
                        <span className={`text-[9px] px-1.5 py-0.5 border rounded font-bold ${stratColor(trade.strategy)}`}>{trade.strategy}</span>
                      </td>
                      <td className={`px-3 py-2.5 ${th.textFaint} text-[10px]`} style={{ fontFamily: "'DM Mono', monospace" }}>{trade.strikes}</td>
                      <td className={`px-3 py-2.5 ${th.textMuted}`}>{fmtDate(trade.openDate)}</td>
                      <td className={`px-3 py-2.5 ${th.textMuted}`}>{fmtDate(trade.closeDate)}</td>
                      <td className={`px-3 py-2.5 ${th.textFaint} text-center`}>{trade.holdDays}d</td>
                      <td className={`px-3 py-2.5 text-emerald-400 font-medium`} style={{ fontFamily: "'DM Mono', monospace" }}>
                        ${trade.creditReceived.toFixed(2)}
                      </td>
                      <td className={`px-3 py-2.5 text-red-400/80`} style={{ fontFamily: "'DM Mono', monospace" }}>
                        ${trade.closePrice.toFixed(2)}
                      </td>
                      <td className={`px-3 py-2.5 font-bold ${trade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                        {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
                      </td>
                      <td className={`px-3 py-2.5 font-bold ${trade.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                        {trade.pnlPct >= 0 ? '+' : ''}{trade.pnlPct.toFixed(1)}%
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`text-[9px] px-1.5 py-0.5 border rounded font-bold ${outcomeColor(trade.outcome)}`}>
                          {trade.outcome}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!loading && !error && total === 0 && trades.length > 0 && (
          <div className={`text-center py-12 ${th.textFaint}`}>
            <p className="text-sm">No trades match your filters.</p>
          </div>
        )}

        {!loading && !error && trades.length === 0 && (
          <div className={`text-center py-16 ${th.textFaint}`}>
            <div className="text-4xl mb-3 opacity-20">◈</div>
            <p className="text-sm">No closed trades found in this period.</p>
            <p className="text-[10px] mt-2 opacity-60">Try extending the time range or check that you are authenticated with TastyTrade.</p>
          </div>
        )}
      </div>
    </div>
  );
}
