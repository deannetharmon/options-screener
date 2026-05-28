// path: app/performance/page.tsx

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
const LS_DEVICE  = 'hunter-device-id';
const LS_TL_3M   = 'hunter-tradelog-3m';
const LS_TL_6M   = 'hunter-tradelog-6m';
const LS_TL_12M  = 'hunter-tradelog-12m';
const LS_PERF_WIDGETS = 'hunter-perf-widgets';
const SCRATCH_PCT = 5;

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

// ── Types (shared with trade-log) ─────────────────────────────────────────
type TimeRange = '3m' | '6m' | '12m';
type Outcome = 'WIN' | 'LOSS' | 'SCRATCH' | 'OPEN';

interface ClosedTrade {
  id: string;
  symbol: string;
  strategy: 'BPS' | 'BCS' | 'IC' | 'SPREAD' | 'OTHER';
  openDate: string;
  closeDate: string;
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
  openTime?: string;
  openDow?: number;
}

interface ChatMessage { role: 'user' | 'assistant'; content: string; }

interface CacheEntry {
  trades: ClosedTrade[];
  fetchedAt: number;
  deviceId: string;
  range: TimeRange;
}

// ── Widget config ─────────────────────────────────────────────────────────
type WidgetId =
  | 'overview'
  | 'monthly_pnl'
  | 'by_strategy'
  | 'by_symbol'
  | 'hold_time'
  | 'best_worst'
  | 'streak'
  | 'dte_analysis';

interface WidgetConfig {
  id: WidgetId;
  label: string;
  enabled: boolean;
  order: number;
}

const DEFAULT_WIDGETS: WidgetConfig[] = [
  { id: 'overview',    label: 'Overview Stats',      enabled: true,  order: 0 },
  { id: 'monthly_pnl', label: 'Monthly P&L',         enabled: true,  order: 1 },
  { id: 'by_strategy', label: 'P&L by Strategy',     enabled: true,  order: 2 },
  { id: 'by_symbol',   label: 'P&L by Symbol',       enabled: true,  order: 3 },
  { id: 'hold_time',   label: 'Hold Time Analysis',  enabled: true,  order: 4 },
  { id: 'best_worst',  label: 'Best & Worst Trades', enabled: true,  order: 5 },
  { id: 'streak',      label: 'Win/Loss Streak',     enabled: false, order: 6 },
  { id: 'dte_analysis',label: 'DTE at Entry',        enabled: false, order: 7 },
];

function getSavedWidgets(): WidgetConfig[] {
  try {
    const saved = localStorage.getItem(LS_PERF_WIDGETS);
    if (!saved) return DEFAULT_WIDGETS;
    const parsed: WidgetConfig[] = JSON.parse(saved);
    // Merge — keep any new defaults not yet in saved config
    const savedIds = new Set(parsed.map(w => w.id));
    const merged = [...parsed, ...DEFAULT_WIDGETS.filter(w => !savedIds.has(w.id))];
    return merged.sort((a, b) => a.order - b.order);
  } catch { return DEFAULT_WIDGETS; }
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
  try { const raw = localStorage.getItem(LS_KEY[range]); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeCache(range: TimeRange, trades: ClosedTrade[]) {
  try {
    const entry: CacheEntry = { trades, fetchedAt: Date.now(), deviceId: getDeviceId(), range };
    localStorage.setItem(LS_KEY[range], JSON.stringify(entry));
  } catch {}
}


// ── AI ────────────────────────────────────────────────────────────────────
const AI_SYSTEM_PROMPT = `You are a brutally honest options trading coach reviewing a trader's actual closed trade history. Your job is to find real patterns, call out mistakes without softening them, and give specific actionable advice.

Do not hedge. Do not add disclaimers. If the data shows a clear problem, say so directly. If a pattern is costing money, name it explicitly. Be direct like a mentor who respects the trader enough to tell them the truth.

Respond in clear conversational prose. No JSON. No markdown headers. Use short paragraphs. When you cite a stat, be specific with numbers.`;

function buildPerformanceAnalysisPrompt(trades: ClosedTrade[], range: TimeRange): string {
  const total = trades.length;
  if (total === 0) return 'No closed trades found in this period.';
  const wins    = trades.filter(t => t.outcome === 'WIN');
  const losses  = trades.filter(t => t.outcome === 'LOSS');
  const winRate = Math.round((wins.length / total) * 100);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin  = wins.length   > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const avgHold = Math.round(trades.reduce((s, t) => s + t.holdDays, 0) / total);
  const strategies = ['BPS','BCS','IC','SPREAD','OTHER'] as const;
  const byStrategy = strategies.map(s => {
    const g = trades.filter(t => t.strategy === s);
    if (g.length === 0) return null;
    const w = g.filter(t => t.outcome === 'WIN').length;
    const pnl = g.reduce((sum, t) => sum + t.pnl, 0);
    return `${s}: ${g.length} trades, ${Math.round(w/g.length*100)}% win, $${pnl.toFixed(0)} total, avg ${(g.reduce((sum, t) => sum + t.pnlPct, 0)/g.length).toFixed(1)}%`;
  }).filter(Boolean);
  const symMap: Record<string, { count: number; wins: number; pnl: number }> = {};
  for (const t of trades) {
    if (!symMap[t.symbol]) symMap[t.symbol] = { count: 0, wins: 0, pnl: 0 };
    symMap[t.symbol].count++; if (t.outcome === 'WIN') symMap[t.symbol].wins++; symMap[t.symbol].pnl += t.pnl;
  }
  const bySymbol = Object.entries(symMap).sort((a, b) => b[1].pnl - a[1].pnl)
    .map(([sym, v]) => `${sym}: ${v.count} trades, ${Math.round(v.wins/v.count*100)}% win, $${v.pnl.toFixed(0)}`);
  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dowMap: Record<number, { count: number; wins: number; pnl: number }> = {};
  for (const t of trades) {
    if (t.openDow == null || t.openDow < 0) continue;
    if (!dowMap[t.openDow]) dowMap[t.openDow] = { count: 0, wins: 0, pnl: 0 };
    dowMap[t.openDow].count++; if (t.outcome === 'WIN') dowMap[t.openDow].wins++; dowMap[t.openDow].pnl += t.pnl;
  }
  const byDow = Object.entries(dowMap).sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([d, v]) => `${DOW[Number(d)]}: ${v.count} trades, ${Math.round(v.wins/v.count*100)}% win, $${v.pnl.toFixed(0)}`);
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
      const [h, m] = t.openTime.split(':').map(Number); const mins = h * 60 + m;
      return mins >= b.min && mins < b.max;
    });
    if (g.length === 0) return null;
    const w = g.filter(t => t.outcome === 'WIN').length;
    return `${b.label}: ${g.length} trades, ${Math.round(w/g.length*100)}% win, $${g.reduce((s,t) => s+t.pnl, 0).toFixed(0)}`;
  }).filter(Boolean);
  const sorted = [...trades].sort((a, b) => a.closeDate.localeCompare(b.closeDate));
  let revengeTrades = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i-1].outcome === 'LOSS' && sorted[i].outcome === 'LOSS') {
      const days = Math.round((new Date(sorted[i].openDate).getTime() - new Date(sorted[i-1].closeDate).getTime()) / 86400000);
      if (days <= 2) revengeTrades++;
    }
  }
  return `Analyze this trader's performance data from the last ${range === '3m' ? '3 months' : range === '6m' ? '6 months' : '12 months'} and give brutally honest coaching feedback.

OVERALL (${total} closed trades):
Win rate: ${winRate}% | Total P&L: $${totalPnl.toFixed(0)} | Avg win: $${avgWin.toFixed(0)} | Avg loss: $${avgLoss.toFixed(0)} | Avg hold: ${avgHold} days

BY STRATEGY:
${byStrategy.join('\n')}

BY SYMBOL (best to worst P&L):
${bySymbol.join('\n')}

ENTRY DAY OF WEEK:
${byDow.length > 0 ? byDow.join('\n') : 'No day data available'}

ENTRY TIME OF DAY:
${byTime.length > 0 ? byTime.join('\n') : 'No time data available'}

BEHAVIORAL FLAGS:
Potential revenge trades: ${revengeTrades}

Cover: what is genuinely working, what is clearly not working, the single most damaging pattern, specific execution mistakes visible in the data, and 3 concrete changes to make immediately. Be direct. Start with the most important finding.`;
}

async function callAIWithHistory(messages: ChatMessage[], system: string): Promise<string> {
  const res = await fetch('/api/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1800, system, messages }),
  });
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err?.error ?? `API error: ${res.status}`); }
  const data = await res.json();
  return data?.content?.find((b: any) => b.type === 'text')?.text ?? '';
}

// ── AI Chat Panel ─────────────────────────────────────────────────────────
function AIChatPanel({ trades, range, th, onClose }: {
  trades: ClosedTrade[]; range: TimeRange; th: typeof THEMES[Theme]; onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [initializing, setInitializing] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  useEffect(() => {
    const runInitial = async () => {
      setInitializing(true);
      const prompt = buildPerformanceAnalysisPrompt(trades, range);
      try {
        const reply = await callAIWithHistory([{ role: 'user', content: prompt }], AI_SYSTEM_PROMPT);
        setMessages([{ role: 'assistant', content: reply }]);
      } catch (e: any) { setError(e.message); }
      finally { setInitializing(false); setTimeout(() => inputRef.current?.focus(), 100); }
    };
    runInitial();
  }, []);

  const send = async () => {
    const text = input.trim(); if (!text || loading) return;
    setInput(''); setError('');
    const next: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next); setLoading(true);
    try {
      const reply = await callAIWithHistory(next, AI_SYSTEM_PROMPT);
      setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); setTimeout(() => inputRef.current?.focus(), 50); }
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const suggestions = [
    'Which strategy should I drop entirely?',
    'What does my win/loss ratio say about my edge?',
    'Am I entering at the wrong time of day?',
    'What is my biggest execution mistake?',
    'What should I focus on to improve most?',
  ];

  return (
    <div className={`fixed top-0 right-0 h-full w-[480px] max-w-[95vw] ${th.sidebar} border-l ${th.border} flex flex-col z-50 shadow-2xl`}
         style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div className={`flex items-center justify-between px-5 py-4 border-b ${th.border} shrink-0`}>
        <div>
          <p className={`text-sm font-bold ${th.text} tracking-wider`}>◈ AI COACHING</p>
          <p className={`text-[10px] ${th.textFaint} mt-0.5`}>{trades.length} trades · {range === '3m' ? '3 months' : range === '6m' ? '6 months' : '12 months'}</p>
        </div>
        <button onClick={onClose} className={`${th.textFaint} hover:${th.text} text-xl leading-none`}>✕</button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {initializing && (
          <div className="flex items-center gap-3 py-8 justify-center">
            <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            <p className={`text-xs ${th.textFaint}`}>Analyzing your performance data...</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role === 'assistant' && <span className="text-indigo-400 text-[11px] mt-1 shrink-0 font-bold">◈</span>}
            <div className={`rounded-2xl px-4 py-3 text-[12px] leading-relaxed whitespace-pre-wrap max-w-[92%] ${
              m.role === 'user' ? 'bg-blue-600/20 border border-blue-600/30 text-blue-100 ml-auto' : `${th.card} border ${th.border} ${th.textMuted}`
            }`}>{m.content}</div>
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
      <div className={`px-5 py-4 border-t ${th.border} shrink-0`}>
        <div className="flex items-end gap-2">
          <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey}
            placeholder="Ask a follow-up question..." rows={2}
            className={`flex-1 resize-none text-xs px-3 py-2.5 border ${th.inputBorder} ${th.input} ${th.text} rounded-xl focus:outline-none focus:border-indigo-500`} />
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

// ── Transaction reconstruction (same logic as trade-log) ─────────────────
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
  const optionTx = allTx.filter(tx => tx['transaction-type'] === 'Trade' && tx.symbol && parseOccSymbol(tx.symbol).optionType !== null);
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
    const opens  = txList.filter((tx: any) => tx.action === 'Sell to Open' || tx.action === 'Buy to Open');
    const closes = txList.filter((tx: any) => tx.action === 'Buy to Close' || tx.action === 'Sell to Close');
    const openQueue  = [...opens].sort((a, b) => a['executed-at'].localeCompare(b['executed-at']));
    const closeQueue = [...closes].sort((a, b) => a['executed-at'].localeCompare(b['executed-at']));
    for (const openTx of openQueue) {
      const openQty = Math.abs(parseFloat(openTx.quantity ?? '1'));
      const matchIdx = closeQueue.findIndex((c: any) => Math.abs(parseFloat(c.quantity ?? '1')) === openQty && c['executed-at'] > openTx['executed-at']);
      if (matchIdx === -1) continue;
      const closeTx = closeQueue.splice(matchIdx, 1)[0];
      const fees = ['regulatory-fees','clearing-fees','commission'].reduce((s, k) => s + Math.abs(parseFloat(openTx[k] ?? '0')) + Math.abs(parseFloat(closeTx[k] ?? '0')), 0);
      legPairs.push({ sym, underlying: openTx['underlying-symbol'], expiry: parsed.expiry, optionType: parsed.optionType, strike: parsed.strike, openTx, closeTx, qty: openQty, openPrice: Math.abs(parseFloat(openTx.price ?? '0')), closePrice: Math.abs(parseFloat(closeTx.price ?? '0')), fees });
    }
  }
  const spreadMap: Record<string, any[]> = {};
  for (const pair of legPairs) {
    const key = `${pair.underlying}::${pair.expiry}::${pair.openTx['executed-at'].slice(0, 10)}`;
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
      const isShort = p.openTx.action === 'Sell to Open';
      totalOpenValue  += p.openPrice  * p.qty * 100 * (isShort ?  1 : -1);
      totalCloseValue += p.closePrice * p.qty * 100 * (isShort ? -1 :  1);
      totalFees += p.fees;
    }
    const creditReceived = totalOpenValue;
    const closePrice     = -totalCloseValue;
    const pnl     = creditReceived + totalCloseValue - totalFees;
    const pnlPct  = creditReceived !== 0 ? (pnl / Math.abs(creditReceived)) * 100 : 0;
    const closeDate = pairs.map((p: any) => p.closeTx['executed-at'].slice(0, 10)).sort().reverse()[0];
    const holdDays  = Math.round((new Date(closeDate).getTime() - new Date(openDay).getTime()) / 86400000);
    const outcome: Outcome = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'SCRATCH';
    trades.push({ id: `${underlying}-${openDay}-${expiry}`, symbol: underlying, strategy, openDate: openDay, closeDate, expiry, holdDays, strikes, creditReceived, closePrice, pnl, pnlPct, outcome, quantity: strategy === 'IC' ? Math.min(putPairs.length, callPairs.length) : Math.max(putPairs.length, callPairs.length, 1), fees: totalFees });
  }
  trades.sort((a, b) => b.closeDate.localeCompare(a.closeDate));
  return trades;
}

// ── Formatting ────────────────────────────────────────────────────────────
function fmtAge(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// ── Chart helpers ─────────────────────────────────────────────────────────
function MonthlyPnlChart({ trades, th }: { trades: ClosedTrade[]; th: typeof THEMES[Theme] }) {
  const monthMap: Record<string, number> = {};
  for (const t of trades) {
    const key = t.closeDate.slice(0, 7); // YYYY-MM
    monthMap[key] = (monthMap[key] ?? 0) + t.pnl;
  }
  const entries = Object.entries(monthMap).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return <p className={`text-xs ${th.textFaint} text-center py-4`}>No data</p>;

  const max = Math.max(...entries.map(([, v]) => Math.abs(v)), 1);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  return (
    <div className="flex items-end gap-1 h-36 w-full">
      {entries.map(([key, val]) => {
        const [, m] = key.split('-');
        const pct = (Math.abs(val) / max) * 100;
        const isPos = val >= 0;
        return (
          <div key={key} className="flex-1 flex flex-col items-center gap-1 group relative">
            {/* Tooltip */}
            <div className={`absolute bottom-full mb-1 left-1/2 -translate-x-1/2 hidden group-hover:block z-10 ${th.sidebar} border ${th.border} rounded px-2 py-1 whitespace-nowrap text-[9px] ${th.textMuted} shadow-lg`}>
              <span className="font-bold">{months[parseInt(m,10)-1]} {key.slice(0,4)}</span>
              <span className={`ml-2 font-bold ${isPos ? 'text-emerald-400' : 'text-red-400'}`}>
                {isPos ? '+' : ''}${val.toFixed(0)}
              </span>
            </div>
            <div className="w-full flex flex-col justify-end h-28">
              <div
                className={`w-full rounded-t-sm transition-all ${isPos ? 'bg-emerald-500/70' : 'bg-red-500/60'}`}
                style={{ height: `${Math.max(pct, 2)}%` }}
              />
            </div>
            <span className={`text-[8px] ${th.textFaint}`}>{months[parseInt(m,10)-1].slice(0,1)}</span>
          </div>
        );
      })}
    </div>
  );
}

function HorizBar({ label, value, max, color, suffix = '' }: { label: string; value: number; max: number; color: string; suffix?: string }) {
  const pct = max > 0 ? Math.min((Math.abs(value) / max) * 100, 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-[10px] w-16 shrink-0 truncate" title={label}>{label}</span>
      <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-[10px] font-bold w-16 text-right ${value >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
        {value >= 0 ? '+' : ''}{suffix === '%' ? value.toFixed(1) + '%' : '$' + value.toFixed(0)}
      </span>
    </div>
  );
}

// ── Widget components ─────────────────────────────────────────────────────
function OverviewWidget({ trades, th }: { trades: ClosedTrade[]; th: typeof THEMES[Theme] }) {
  const total    = trades.length;
  const wins     = trades.filter(t => t.outcome === 'WIN').length;
  const losses   = trades.filter(t => t.outcome === 'LOSS').length;
  const scratches = trades.filter(t => t.outcome === 'SCRATCH').length;
  const winRate  = total > 0 ? wins / total : 0;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgPnlPct = total > 0 ? trades.reduce((s, t) => s + t.pnlPct, 0) / total : 0;
  const avgHold  = total > 0 ? Math.round(trades.reduce((s, t) => s + t.holdDays, 0) / total) : 0;
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);

  const stats = [
    { label: 'Total Trades',  value: String(total),                                   color: th.text },
    { label: 'Win Rate',      value: `${Math.round(winRate * 100)}%`,                 color: winRate >= 0.6 ? 'text-emerald-400' : winRate >= 0.45 ? 'text-yellow-400' : 'text-red-400' },
    { label: 'W / L / S',     value: `${wins} / ${losses} / ${scratches}`,            color: th.textMuted },
    { label: 'Total P&L',     value: `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(0)}`, color: totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400' },
    { label: 'Avg P&L %',     value: `${avgPnlPct >= 0 ? '+' : ''}${avgPnlPct.toFixed(1)}%`, color: avgPnlPct >= 0 ? 'text-emerald-400' : 'text-red-400' },
    { label: 'Avg Hold',      value: `${avgHold}d`,                                   color: th.textMuted },
    { label: 'Total Fees',    value: `-$${totalFees.toFixed(0)}`,                     color: 'text-orange-400/80' },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-0 divide-x divide-y">
      {stats.map(s => (
        <div key={s.label} className={`px-4 py-3 flex flex-col items-center text-center ${th.borderLight}`}>
          <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-1`}>{s.label}</p>
          <p className={`text-xl font-bold ${s.color}`} style={{ fontFamily: "'DM Mono', monospace" }}>{s.value}</p>
        </div>
      ))}
    </div>
  );
}

function ByStrategyWidget({ trades, th }: { trades: ClosedTrade[]; th: typeof THEMES[Theme] }) {
  const strategies = ['BPS', 'BCS', 'IC', 'SPREAD', 'OTHER'] as const;
  const rows = strategies.map(s => {
    const group = trades.filter(t => t.strategy === s);
    const wins = group.filter(t => t.outcome === 'WIN').length;
    const total = group.length;
    const pnl = group.reduce((sum, t) => sum + t.pnl, 0);
    const avgPct = total > 0 ? group.reduce((sum, t) => sum + t.pnlPct, 0) / total : 0;
    return { strategy: s, total, wins, winRate: total > 0 ? wins / total : 0, pnl, avgPct };
  }).filter(r => r.total > 0);

  if (rows.length === 0) return <p className={`text-xs ${th.textFaint} text-center py-4`}>No data</p>;
  const maxPnl = Math.max(...rows.map(r => Math.abs(r.pnl)), 1);

  return (
    <div className="space-y-3">
      {rows.map(r => (
        <div key={r.strategy} className="space-y-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`text-[9px] font-bold px-1.5 py-0.5 border rounded ${
                r.strategy === 'BPS' ? 'border-emerald-600 text-emerald-400'
                : r.strategy === 'BCS' ? 'border-red-600 text-red-400'
                : r.strategy === 'IC' ? 'border-blue-600 text-blue-400'
                : 'border-slate-600 text-slate-400'
              }`}>{r.strategy}</span>
              <span className={`text-[10px] ${th.textFaint}`}>{r.total} trades · {Math.round(r.winRate * 100)}% win rate</span>
            </div>
            <span className={`text-[10px] font-bold ${r.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
              {r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(0)} avg {r.avgPct >= 0 ? '+' : ''}{r.avgPct.toFixed(1)}%
            </span>
          </div>
          <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
            <div className={`h-full rounded-full ${r.pnl >= 0 ? 'bg-emerald-500/60' : 'bg-red-500/60'}`}
              style={{ width: `${(Math.abs(r.pnl) / maxPnl) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function BySymbolWidget({ trades, th }: { trades: ClosedTrade[]; th: typeof THEMES[Theme] }) {
  const symbolMap: Record<string, { pnl: number; count: number; winRate: number; wins: number }> = {};
  for (const t of trades) {
    if (!symbolMap[t.symbol]) symbolMap[t.symbol] = { pnl: 0, count: 0, winRate: 0, wins: 0 };
    symbolMap[t.symbol].pnl += t.pnl;
    symbolMap[t.symbol].count++;
    if (t.outcome === 'WIN') symbolMap[t.symbol].wins++;
  }
  const rows = Object.entries(symbolMap)
    .map(([sym, v]) => ({ sym, ...v, winRate: v.count > 0 ? v.wins / v.count : 0 }))
    .sort((a, b) => b.pnl - a.pnl);

  if (rows.length === 0) return <p className={`text-xs ${th.textFaint} text-center py-4`}>No data</p>;
  const maxPnl = Math.max(...rows.map(r => Math.abs(r.pnl)), 1);

  return (
    <div className="space-y-2">
      {rows.map(r => (
        <HorizBar
          key={r.sym}
          label={r.sym}
          value={r.pnl}
          max={maxPnl}
          color={r.pnl >= 0 ? 'bg-emerald-500/60' : 'bg-red-500/60'}
        />
      ))}
    </div>
  );
}

function HoldTimeWidget({ trades, th }: { trades: ClosedTrade[]; th: typeof THEMES[Theme] }) {
  const buckets = [
    { label: '0–7d',  min: 0,  max: 7  },
    { label: '8–14d', min: 8,  max: 14 },
    { label: '15–21d',min: 15, max: 21 },
    { label: '22–30d',min: 22, max: 30 },
    { label: '31d+',  min: 31, max: Infinity },
  ];
  const rows = buckets.map(b => {
    const group = trades.filter(t => t.holdDays >= b.min && t.holdDays <= b.max);
    const wins  = group.filter(t => t.outcome === 'WIN').length;
    const pnl   = group.reduce((s, t) => s + t.pnl, 0);
    return { ...b, count: group.length, wins, winRate: group.length > 0 ? wins / group.length : 0, pnl };
  }).filter(r => r.count > 0);

  if (rows.length === 0) return <p className={`text-xs ${th.textFaint} text-center py-4`}>No data</p>;

  return (
    <div className="space-y-2">
      {rows.map(r => (
        <div key={r.label} className="flex items-center gap-3 text-[10px]">
          <span className={`w-14 shrink-0 ${th.textFaint}`}>{r.label}</span>
          <span className={`w-16 shrink-0 ${th.textMuted}`}>{r.count} trades</span>
          <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
            <div className={`h-full rounded-full ${r.winRate >= 0.6 ? 'bg-emerald-500/60' : r.winRate >= 0.45 ? 'bg-yellow-500/60' : 'bg-red-500/60'}`}
              style={{ width: `${r.winRate * 100}%` }} />
          </div>
          <span className={`w-10 text-right font-bold ${r.winRate >= 0.6 ? 'text-emerald-400' : r.winRate >= 0.45 ? 'text-yellow-400' : 'text-red-400'}`}>
            {Math.round(r.winRate * 100)}%
          </span>
          <span className={`w-16 text-right font-bold ${r.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
            {r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(0)}
          </span>
        </div>
      ))}
    </div>
  );
}

function BestWorstWidget({ trades, th }: { trades: ClosedTrade[]; th: typeof THEMES[Theme] }) {
  const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
  const best  = sorted.slice(0, 3);
  const worst = sorted.slice(-3).reverse();

  const TradeRow = ({ t, label }: { t: ClosedTrade; label: string }) => (
    <div className={`flex items-center justify-between p-2 rounded-lg border ${t.pnl >= 0 ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-red-500/20 bg-red-500/5'}`}>
      <div>
        <span className={`text-xs font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{t.symbol}</span>
        <span className={`ml-2 text-[9px] ${th.textFaint}`}>{t.strategy} · {t.closeDate}</span>
      </div>
      <span className={`text-xs font-bold ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
        {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)} ({t.pnlPct >= 0 ? '+' : ''}{t.pnlPct.toFixed(1)}%)
      </span>
    </div>
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="space-y-2">
        <p className="text-[9px] text-emerald-400 uppercase tracking-widest font-bold mb-2">Best Trades</p>
        {best.map(t => <TradeRow key={t.id} t={t} label="best" />)}
      </div>
      <div className="space-y-2">
        <p className="text-[9px] text-red-400 uppercase tracking-widest font-bold mb-2">Worst Trades</p>
        {worst.map(t => <TradeRow key={t.id} t={t} label="worst" />)}
      </div>
    </div>
  );
}

function StreakWidget({ trades, th }: { trades: ClosedTrade[]; th: typeof THEMES[Theme] }) {
  // Chronological order for streak calculation
  const chrono = [...trades].sort((a, b) => a.closeDate.localeCompare(b.closeDate));
  let curStreak = 0, maxWin = 0, maxLoss = 0;
  let curType: 'WIN' | 'LOSS' | null = null;
  for (const t of chrono) {
    if (t.outcome === 'SCRATCH') continue;
    if (t.outcome === curType) { curStreak++; }
    else { curStreak = 1; curType = t.outcome as 'WIN' | 'LOSS'; }
    if (curType === 'WIN')  maxWin  = Math.max(maxWin,  curStreak);
    if (curType === 'LOSS') maxLoss = Math.max(maxLoss, curStreak);
  }
  const lastType = curType;
  const lastStreak = curStreak;

  return (
    <div className="grid grid-cols-3 gap-4 text-center">
      {[
        { label: 'Current Streak', value: `${lastStreak} ${lastType ?? '—'}`, color: lastType === 'WIN' ? 'text-emerald-400' : lastType === 'LOSS' ? 'text-red-400' : 'text-slate-400' },
        { label: 'Best Win Streak',  value: `${maxWin}W`,  color: 'text-emerald-400' },
        { label: 'Worst Loss Streak',value: `${maxLoss}L`, color: 'text-red-400' },
      ].map(s => (
        <div key={s.label} className={`p-4 rounded-xl border ${th.border}`}>
          <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-2`}>{s.label}</p>
          <p className={`text-2xl font-bold ${s.color}`} style={{ fontFamily: "'DM Mono', monospace" }}>{s.value}</p>
        </div>
      ))}
    </div>
  );
}

function DteAnalysisWidget({ trades, th }: { trades: ClosedTrade[]; th: typeof THEMES[Theme] }) {
  // We approximate entry DTE as holdDays + (expiry - closeDate) days
  // Since we don't store entry DTE directly, bucket by hold days as proxy
  const buckets = [
    { label: '< 21 DTE', min: 0,  max: 20  },
    { label: '21–30 DTE',min: 21, max: 30  },
    { label: '31–45 DTE',min: 31, max: 45  },
    { label: '45+ DTE',  min: 46, max: Infinity },
  ];
  // Estimate entry DTE from holdDays + remaining DTE at close
  const rows = buckets.map(b => {
    const group = trades.filter(t => {
      const daysToExpiry = Math.max(0, Math.round((new Date(t.expiry).getTime() - new Date(t.closeDate).getTime()) / 86400000));
      const entryDte = t.holdDays + daysToExpiry;
      return entryDte >= b.min && entryDte <= b.max;
    });
    const wins   = group.filter(t => t.outcome === 'WIN').length;
    const avgPct = group.length > 0 ? group.reduce((s, t) => s + t.pnlPct, 0) / group.length : 0;
    return { ...b, count: group.length, winRate: group.length > 0 ? wins / group.length : 0, avgPct };
  }).filter(r => r.count > 0);

  if (rows.length === 0) return <p className={`text-xs ${th.textFaint} text-center py-4`}>No data</p>;

  return (
    <div className="space-y-2">
      {rows.map(r => (
        <div key={r.label} className="flex items-center gap-3 text-[10px]">
          <span className={`w-20 shrink-0 ${th.textFaint}`}>{r.label}</span>
          <span className={`w-16 shrink-0 ${th.textMuted}`}>{r.count} trades</span>
          <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
            <div className={`h-full rounded-full ${r.winRate >= 0.6 ? 'bg-emerald-500/60' : r.winRate >= 0.45 ? 'bg-yellow-500/60' : 'bg-red-500/60'}`}
              style={{ width: `${r.winRate * 100}%` }} />
          </div>
          <span className={`w-10 text-right font-bold ${r.winRate >= 0.6 ? 'text-emerald-400' : r.winRate >= 0.45 ? 'text-yellow-400' : 'text-red-400'}`}>
            {Math.round(r.winRate * 100)}%
          </span>
          <span className={`w-16 text-right font-bold ${r.avgPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            avg {r.avgPct >= 0 ? '+' : ''}{r.avgPct.toFixed(1)}%
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Widget shell ──────────────────────────────────────────────────────────
function Widget({ config, trades, th, onToggle, onMoveUp, onMoveDown, isFirst, isLast }: {
  config: WidgetConfig;
  trades: ClosedTrade[];
  th: typeof THEMES[Theme];
  onToggle: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const WIDGET_CONTENT: Record<WidgetId, React.ReactNode> = {
    overview:     <OverviewWidget   trades={trades} th={th} />,
    monthly_pnl:  <MonthlyPnlChart  trades={trades} th={th} />,
    by_strategy:  <ByStrategyWidget trades={trades} th={th} />,
    by_symbol:    <BySymbolWidget   trades={trades} th={th} />,
    hold_time:    <HoldTimeWidget   trades={trades} th={th} />,
    best_worst:   <BestWorstWidget  trades={trades} th={th} />,
    streak:       <StreakWidget     trades={trades} th={th} />,
    dte_analysis: <DteAnalysisWidget trades={trades} th={th} />,
  };

  return (
    <div className={`${th.card} border ${th.border} rounded-xl overflow-hidden`}>
      <div className={`flex items-center justify-between px-4 py-2.5 border-b ${th.borderLight}`}>
        <p className={`text-[10px] font-bold ${th.textMuted} uppercase tracking-widest`}>{config.label}</p>
        <div className="flex items-center gap-1">
          <button onClick={onMoveUp} disabled={isFirst} className={`text-[10px] px-1.5 py-0.5 ${th.textFaint} hover:${th.text} disabled:opacity-20 transition-opacity`}>↑</button>
          <button onClick={onMoveDown} disabled={isLast} className={`text-[10px] px-1.5 py-0.5 ${th.textFaint} hover:${th.text} disabled:opacity-20 transition-opacity`}>↓</button>
          <button onClick={onToggle} className={`text-[9px] px-2 py-0.5 border rounded ml-1 ${th.border} ${th.textFaint} hover:border-red-600 hover:text-red-400 transition-colors`}>Hide</button>
        </div>
      </div>
      <div className="p-4">{WIDGET_CONTENT[config.id]}</div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────
export default function PerformancePage() {
  const [theme, setTheme] = useState<Theme>(getSavedTheme);
  const th = THEMES[theme];

  const [trades, setTrades]       = useState<ClosedTrade[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [status, setStatus]       = useState('');
  const [range, setRange]         = useState<TimeRange>('3m');
  const [cachedAt, setCachedAt]   = useState<number | null>(null);
  const [widgets, setWidgets]     = useState<WidgetConfig[]>(DEFAULT_WIDGETS);
  const [showConfig, setShowConfig] = useState(false);
  const [showAI, setShowAI] = useState(false);

  // Load widget config from localStorage on mount
  useEffect(() => { setWidgets(getSavedWidgets()); }, []);

  const saveWidgets = (w: WidgetConfig[]) => {
    setWidgets(w);
    try { localStorage.setItem(LS_PERF_WIDGETS, JSON.stringify(w)); } catch {}
  };

  const loadTrades = useCallback(async (r: TimeRange, forceRefresh = false) => {
    const deviceId = getDeviceId();
    if (!forceRefresh) {
      const cached = readCache(r);
      if (cached) {
        const sameDevice = cached.deviceId === deviceId;
        const fresh = Date.now() - cached.fetchedAt < 4 * 60 * 60 * 1000;
        if (sameDevice && fresh) { setTrades(cached.trades); setCachedAt(cached.fetchedAt); return; }
        setStatus(sameDevice ? 'Refreshing from TastyTrade...' : 'New device — loading from TastyTrade...');
      } else {
        setStatus('Loading trade history from TastyTrade...');
      }
    } else {
      setStatus('Refreshing from TastyTrade...');
    }
    setLoading(true); setError('');
    try {
      const fetched = await fetchAndReconstructTrades(r);
      setTrades(fetched); writeCache(r, fetched); setCachedAt(Date.now());
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); setStatus(''); }
  }, []);

  useEffect(() => { loadTrades('3m'); }, [loadTrades]);

  const handleRangeChange = (r: TimeRange) => { setRange(r); loadTrades(r); };

  const enabledWidgets = widgets.filter(w => w.enabled).sort((a, b) => a.order - b.order);
  const disabledWidgets = widgets.filter(w => !w.enabled);

  const toggleWidget = (id: WidgetId) => {
    saveWidgets(widgets.map(w => w.id === id ? { ...w, enabled: !w.enabled } : w));
  };
  const moveWidget = (id: WidgetId, dir: 'up' | 'down') => {
    const enabled = [...enabledWidgets];
    const idx = enabled.findIndex(w => w.id === id);
    if (dir === 'up' && idx === 0) return;
    if (dir === 'down' && idx === enabled.length - 1) return;
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
    [enabled[idx], enabled[swapIdx]] = [enabled[swapIdx], enabled[idx]];
    const reordered = enabled.map((w, i) => ({ ...w, order: i }));
    saveWidgets([...reordered, ...disabledWidgets.map((w, i) => ({ ...w, order: reordered.length + i }))]);
  };

  return (
    <div className={`min-h-screen ${th.bg} pb-24 transition-colors duration-200`} style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>

      {/* Header */}
      <div className={`${th.header} border-b ${th.border} px-6 py-4 flex items-center justify-between`}>
        <div className="flex items-center gap-6">
          <div>
            <h1 className="text-base font-bold tracking-widest text-white" style={{ fontFamily: "'DM Mono', monospace" }}>OPTIONS HUNTER</h1>
            <p className="text-[10px] text-white/50 mt-0.5 tracking-wider" style={{ fontFamily: "'DM Mono', monospace" }}>PERFORMANCE</p>
          </div>
          <nav className="flex items-center gap-1 bg-black/20 rounded-lg p-1">
            <Link href="/"            className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">HUNTER</Link>
            <Link href="/portfolio"   className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">PORTFOLIO</Link>
            <Link href="/trade-log"   className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">TRADE LOG</Link>
            <span                     className="text-xs px-3 py-1.5 rounded bg-white/20 text-white tracking-wider">PERFORMANCE</span>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {(['dark','medium','light'] as Theme[]).map(t => (
            <button key={t} onClick={() => { setTheme(t); try { localStorage.setItem(LS_THEME, t); } catch {} }}
              className={`text-[9px] px-2 py-1 border rounded transition-colors ${theme === t ? 'border-blue-500 text-blue-400' : `${th.border} ${th.textFaint} hover:border-blue-700`}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 py-6 max-w-[1400px] mx-auto space-y-4">

        {/* Controls */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            {(['3m','6m','12m'] as TimeRange[]).map(r => (
              <button key={r} onClick={() => handleRangeChange(r)} disabled={loading}
                className={`text-[10px] px-3 py-1.5 border rounded font-bold tracking-wider transition-colors disabled:opacity-50 ${
                  range === r ? 'border-blue-500 text-blue-400 bg-blue-500/10' : `${th.border} ${th.textFaint} hover:border-blue-700 hover:text-blue-400`
                }`}>
                {r === '3m' ? '3 MO' : r === '6m' ? '6 MO' : '12 MO'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            {cachedAt && <span className={`text-[9px] ${th.textFaint}`}>Last synced {fmtAge(Date.now() - cachedAt)}</span>}
            {trades.length > 0 && (
              <button onClick={() => setShowAI(v => !v)}
                className={`text-[10px] px-3 py-1.5 border rounded font-bold tracking-wider transition-colors ${showAI ? 'border-indigo-500 text-indigo-400 bg-indigo-500/10' : 'border-indigo-700 text-indigo-400 hover:border-indigo-500 hover:bg-indigo-500/10'}`}>
                ◈ AI Analysis
              </button>
            )}
            <button onClick={() => setShowConfig(v => !v)}
              className={`text-[10px] px-3 py-1.5 border rounded tracking-wider transition-colors ${showConfig ? 'border-purple-500 text-purple-400 bg-purple-500/10' : `${th.border} ${th.textFaint} hover:border-purple-500 hover:text-purple-400`}`}>
              ⊞ Configure
            </button>
            <button onClick={() => loadTrades(range, true)} disabled={loading}
              className={`text-[10px] px-3 py-1.5 border ${th.border} rounded ${th.textMuted} hover:border-blue-500 hover:text-blue-400 transition-colors disabled:opacity-50 tracking-wider`}>
              {loading ? '↺ Loading...' : '↺ Refresh'}
            </button>
          </div>
        </div>

        {/* Widget configurator panel */}
        {showConfig && (
          <div className={`${th.card} border ${th.border} rounded-xl p-4`}>
            <p className={`text-[10px] font-bold ${th.textMuted} uppercase tracking-widest mb-3`}>Widget Configuration</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {widgets.sort((a, b) => a.order - b.order).map(w => (
                <button key={w.id} onClick={() => toggleWidget(w.id)}
                  className={`text-[10px] px-3 py-2 border rounded text-left transition-colors ${
                    w.enabled
                      ? 'border-blue-500 text-blue-400 bg-blue-500/10'
                      : `${th.border} ${th.textFaint} hover:border-blue-700 hover:text-blue-300`
                  }`}>
                  {w.enabled ? '✓ ' : '+ '}{w.label}
                </button>
              ))}
            </div>
            <p className={`text-[9px] ${th.textFaint} mt-3`}>Use ↑↓ buttons on widgets to reorder. Config is saved automatically.</p>
          </div>
        )}

        {/* Status */}
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

        {/* Widgets */}
        {!loading && trades.length > 0 && (
          <div className="space-y-4">
            {enabledWidgets.map((w, i) => (
              <Widget
                key={w.id}
                config={w}
                trades={trades}
                th={th}
                onToggle={() => toggleWidget(w.id)}
                onMoveUp={() => moveWidget(w.id, 'up')}
                onMoveDown={() => moveWidget(w.id, 'down')}
                isFirst={i === 0}
                isLast={i === enabledWidgets.length - 1}
              />
            ))}
          </div>
        )}

        {!loading && !error && trades.length === 0 && (
          <div className={`text-center py-16 ${th.textFaint}`}>
            <div className="text-4xl mb-3 opacity-20">◈</div>
            <p className="text-sm">No closed trades found in this period.</p>
            <p className="text-[10px] mt-2 opacity-60">Try extending the time range or check your TastyTrade authentication.</p>
          </div>
        )}
      </div>

      {showAI && (
        <AIChatPanel trades={trades} range={range} th={th} onClose={() => setShowAI(false)} />
      )}
    </div>
  );
}
