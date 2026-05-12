'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';

// Inject DM Sans font
if (typeof document !== 'undefined') {
  if (!document.getElementById('prosper-font')) {
    const link = document.createElement('link');
    link.id = 'prosper-font';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=DM+Mono:wght@400;500&display=swap';
    document.head.appendChild(link);
  }
}

// ── TastyTrade (client-side, mirrors screener) ────────────────────────────
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

async function loadPositions(): Promise<Position[]> {
  const token = await getAccessToken();
  const accountsData = await ttFetch('/customers/me/accounts', token);
  const accounts = accountsData?.data?.items ?? [];
  if (accounts.length === 0) throw new Error('No accounts found');
  const accountNumber = accounts[0]?.account?.['account-number'];
  if (!accountNumber) throw new Error('Could not read account number');

  const positionsData = await ttFetch(`/accounts/${accountNumber}/positions`, token);
  const rawPositions = positionsData?.data?.items ?? [];
  const optionPositions = rawPositions.filter((p: any) =>
    p['instrument-type'] === 'Equity Option' || p['instrument-type'] === 'Index Option'
  );

  const groups: Record<string, any[]> = {};
  for (const pos of optionPositions) {
    const symbol = pos['underlying-symbol'];
    const expDate = pos['expires-at']?.slice(0, 10) ?? 'unknown';
    const key = `${symbol}::${expDate}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(pos);
  }

  const allOptionSymbols = optionPositions.map((p: any) => p.symbol).filter(Boolean);
  const currentPrices: Record<string, number> = {};
  if (allOptionSymbols.length > 0) {
    try {
      for (let i = 0; i < allOptionSymbols.length; i += 50) {
        const chunk = allOptionSymbols.slice(i, i + 50);
        const qs = chunk.map((s: string) => `equity-option=${encodeURIComponent(s)}`).join('&');
        const priceData = await ttFetch(`/market-data/by-type?${qs}`, token);
        for (const item of priceData?.data?.items ?? []) {
          const bid = parseFloat(item.bid ?? '0');
          const ask = parseFloat(item.ask ?? '0');
          currentPrices[item.symbol] = (bid + ask) / 2;
        }
      }
    } catch { /* prices optional */ }
  }

  // Parse OCC option symbol: e.g. APP260618P410 → type=P, strike=410
  function parseOptionSymbol(sym: string): { optionType: 'P' | 'C'; strikePrice: number } {
    // TastyTrade format: "APP  260618P00410000" — ticker + spaces + YYMMDD + C/P + 8-digit strike
    const match = sym.trim().replace(/\s+/g, '').match(/^([A-Z/]+)(\d{6})([CP])(\d{8})$/);
    if (!match) return { optionType: 'C', strikePrice: 0 };
    // 00410000 = $410.00, 00045000 = $45.00
    const strikePrice = parseInt(match[4], 10) / 1000;
    return { optionType: match[3] as 'P' | 'C', strikePrice };
  }

  const today = new Date();
  const positions: Position[] = Object.entries(groups).map(([key, legs]) => {
    const [symbol, expDate] = key.split('::');
    const dte = Math.round((new Date(expDate).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    const putLegs  = legs.filter((l: any) => parseOptionSymbol(l.symbol).optionType === 'P');
    const callLegs = legs.filter((l: any) => parseOptionSymbol(l.symbol).optionType === 'C');
    let strategy = 'UNKNOWN';
    if      (putLegs.length >= 2 && callLegs.length === 0) strategy = 'BPS';
    else if (callLegs.length >= 2 && putLegs.length === 0) strategy = 'BCS';
    else if (putLegs.length >= 2 && callLegs.length >= 2)  strategy = 'IC';
    else if (putLegs.length === 1 && callLegs.length === 0) strategy = 'PUT';
    else if (callLegs.length === 1 && putLegs.length === 0) strategy = 'CALL';

    let creditReceived = 0;
    for (const leg of legs) {
      const qty = parseInt(leg['quantity'] ?? '1', 10);
      const avgPrice = parseFloat(leg['average-open-price'] ?? '0');
      creditReceived += leg['quantity-direction'] === 'Short' ? avgPrice * qty : -(avgPrice * qty);
    }
    creditReceived = creditReceived * 100;

    let currentValue = 0;
    let hasCurrentPrices = true;
    for (const leg of legs) {
      const qty = parseInt(leg['quantity'] ?? '1', 10);
      const price = currentPrices[leg.symbol];
      if (price == null) { hasCurrentPrices = false; break; }
      currentValue += leg['quantity-direction'] === 'Short' ? price * qty : -(price * qty);
    }
    currentValue = currentValue * 100;

    const pnl = hasCurrentPrices ? Math.abs(creditReceived) - Math.abs(currentValue) : null;
    const pnlPct = creditReceived !== 0 && pnl != null ? (pnl / Math.abs(creditReceived)) * 100 : null;
    const targetPrice = Math.abs(creditReceived) * 0.5;
    const hitTarget = hasCurrentPrices && pnl != null && pnl >= Math.abs(creditReceived) * 0.5;

    return {
      key, symbol, expDate, dte, strategy,
      legs: legs.map((l: any) => {
        const parsed = parseOptionSymbol(l.symbol);
        return {
          symbol: l.symbol,
          optionType: parsed.optionType,
          strikePrice: parsed.strikePrice,
          direction: l['quantity-direction'] as 'Short' | 'Long',
          quantity: parseInt(l['quantity'] ?? '1', 10),
          avgOpenPrice: parseFloat(l['average-open-price'] ?? '0'),
          currentPrice: currentPrices[l.symbol] ?? null,
        };
      }),
      creditReceived: Math.abs(creditReceived),
      currentValue: hasCurrentPrices ? Math.abs(currentValue) : null,
      pnl, pnlPct, targetPrice, hitTarget,
      needsClose: dte <= 21,
      accountNumber,
    };
  });

  positions.sort((a, b) => {
    if (a.needsClose && !b.needsClose) return -1;
    if (!a.needsClose && b.needsClose) return 1;
    return a.dte - b.dte;
  });
  return positions;
}
type Theme = 'dark' | 'medium' | 'light';
const LS_THEME = 'prosper-theme';

const THEMES = {
  dark:   { bg: 'bg-[#0a0a0a]', sidebar: 'bg-[#0f0f0f]', card: 'bg-[#171717]', cardQualified: 'bg-[#1c1c1c]', border: 'border-[#2c2c2c]', borderLight: 'border-[#202020]', header: 'bg-[#0f0f0f]', text: 'text-white', textMuted: 'text-[#e0e0e0]', textFaint: 'text-[#808080]', input: 'bg-[#141414]', inputBorder: 'border-[#353535]', tag: 'bg-[#222222]', label: 'text-[#aaaaaa]' },
  medium: { bg: 'bg-[#141414]', sidebar: 'bg-[#1a1a1a]', card: 'bg-[#202020]', cardQualified: 'bg-[#252525]', border: 'border-[#333333]', borderLight: 'border-[#282828]', header: 'bg-[#1a1a1a]', text: 'text-white', textMuted: 'text-[#d8d8d8]', textFaint: 'text-[#777777]', input: 'bg-[#1e1e1e]', inputBorder: 'border-[#3a3a3a]', tag: 'bg-[#2a2a2a]', label: 'text-[#999999]' },
  light:  { bg: 'bg-[#f5f5f5]', sidebar: 'bg-white', card: 'bg-white', cardQualified: 'bg-white', border: 'border-[#e0e0e0]', borderLight: 'border-[#ebebeb]', header: 'bg-[#111111]', text: 'text-[#111111]', textMuted: 'text-[#1a1a1a]', textFaint: 'text-[#666666]', input: 'bg-white', inputBorder: 'border-[#cccccc]', tag: 'bg-[#f0f0f0]', label: 'text-[#444444]' },
};

interface TrendResult {
  trend: 'uptrend' | 'downtrend' | 'sideways' | 'unknown';
  strategy: 'BPS' | 'BCS' | 'IC' | 'NO_TRADE';
  confidence: number;
  reason: string;
}

interface Recommendation {
  action: 'HOLD' | 'WATCH' | 'CLOSE_PROFIT' | 'MANAGE' | 'CLOSE_NOW' | 'ROLL';
  label: string;
  detail: string;
  color: string;
}

async function getTrend(symbol: string): Promise<TrendResult> {
  const res = await fetch(`/api/chart?symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' });
  if (!res.ok) return { trend: 'unknown', strategy: 'NO_TRADE', confidence: 0, reason: 'Chart data unavailable' };
  const data = await res.json();
  const bars: { c: number }[] = data?.bars ?? [];
  const closes = bars.map((b: any) => b.c).filter((c: any): c is number => Number.isFinite(c));
  if (closes.length < 50) return { trend: 'unknown', strategy: 'NO_TRADE', confidence: 0, reason: 'Not enough data' };

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const price = closes[closes.length - 1];
  const ma20 = avg(closes.slice(-20));
  const ma50 = avg(closes.slice(-50));
  const mom20 = (price - closes[closes.length - 21]) / closes[closes.length - 21];
  const low20 = Math.min(...closes.slice(-20));
  const high20 = Math.max(...closes.slice(-20));
  const low40 = Math.min(...closes.slice(-40));
  const high40 = Math.max(...closes.slice(-40));
  const higherLows = low20 > Math.min(...closes.slice(-40, -20)) * 0.985;
  const lowerHighs = high20 < Math.max(...closes.slice(-40, -20)) * 1.015;

  let score = 0;
  if (price > ma20) score += 2; else score -= 2;
  if (price > ma50) score += 2; else score -= 2;
  if (ma20 > ma50) score += 2; else score -= 2;
  if (mom20 > 0.03) score += 2; else if (mom20 < -0.03) score -= 2;
  if (higherLows) score += 2; else if (lowerHighs) score -= 2;

  const confidence = Math.min(100, Math.abs(score) * 10);
  if (score >= 4) return { trend: 'uptrend', strategy: 'BPS', confidence, reason: `Price above MA20/MA50, positive momentum` };
  if (score <= -4) return { trend: 'downtrend', strategy: 'BCS', confidence, reason: `Price below MA20/MA50, negative momentum` };
  return { trend: 'sideways', strategy: 'IC', confidence, reason: `Mixed signals, range-bound` };
}

function getRecommendation(pos: Position, trend: TrendResult | null): Recommendation {
  // Close now — DTE urgency
  if (pos.needsClose) return {
    action: 'CLOSE_NOW', label: '✕ CLOSE NOW', color: 'text-red-400 border-red-600 bg-red-500/10',
    detail: `${pos.dte} DTE — mandatory close regardless of P&L`,
  };

  if (pos.hitTarget) return {
    action: 'CLOSE_PROFIT', label: '✓ TAKE PROFIT', color: 'text-emerald-400 border-emerald-600 bg-emerald-500/10',
    detail: '50% profit target reached — lock in gains',
  };

  const pnlPct = pos.pnl != null && pos.creditReceived !== 0 ? (pos.pnl / pos.creditReceived) * 100 : 0;

  if (pnlPct < -15) {
    const trendAgainst = trend && (
      (pos.strategy === 'BPS' && trend.trend === 'downtrend') ||
      (pos.strategy === 'BCS' && trend.trend === 'uptrend')
    );
    return {
      action: trendAgainst ? 'CLOSE_NOW' : 'MANAGE',
      label: trendAgainst ? '✕ CLOSE / ROLL' : '⚡ MANAGE',
      color: trendAgainst ? 'text-red-400 border-red-600 bg-red-500/10' : 'text-orange-400 border-orange-600 bg-orange-500/10',
      detail: trendAgainst
        ? `Down ${Math.abs(pnlPct).toFixed(0)}% and trend confirms — consider closing or rolling`
        : `Down ${Math.abs(pnlPct).toFixed(0)}% but trend not confirmed — watch closely`,
    };
  }

  if (pnlPct >= 35) return {
    action: 'WATCH', label: '◎ NEAR TARGET', color: 'text-yellow-400 border-yellow-600 bg-yellow-500/10',
    detail: `${pnlPct.toFixed(0)}% profit — approaching 50% target, watch for close`,
  };

  const trendAligns = trend && (
    (pos.strategy === 'BPS' && trend.trend === 'uptrend') ||
    (pos.strategy === 'BCS' && trend.trend === 'downtrend') ||
    (pos.strategy === 'IC' && trend.trend === 'sideways')
  );

  if (trendAligns) return {
    action: pnlPct < 0 ? 'WATCH' : 'HOLD',
    label: pnlPct < 0 ? '⚠ WATCH' : '● HOLD',
    color: pnlPct < 0 ? 'text-yellow-400 border-yellow-600 bg-yellow-500/10' : 'text-blue-400 border-blue-600 bg-blue-500/10',
    detail: pnlPct < 0
      ? `Trend still confirms ${pos.strategy} but position is down ${Math.abs(pnlPct).toFixed(0)}% — monitor`
      : `Trend confirms ${pos.strategy} — ${trend!.trend}, ${pnlPct.toFixed(0)}% profit so far`,
  };

  const trendAgainst = trend && (
    (pos.strategy === 'BPS' && trend.trend === 'downtrend') ||
    (pos.strategy === 'BCS' && trend.trend === 'uptrend')
  );

  if (trendAgainst) return {
    action: 'WATCH', label: '⚠ WATCH', color: 'text-yellow-400 border-yellow-600 bg-yellow-500/10',
    detail: `Trend shifted to ${trend!.trend} — monitor ${pos.symbol} closely`,
  };

  return {
    action: pnlPct < 0 ? 'WATCH' : 'HOLD',
    label: pnlPct < 0 ? '⚠ WATCH' : '● HOLD',
    color: pnlPct < 0 ? 'text-yellow-400 border-yellow-600 bg-yellow-500/10' : 'text-blue-400 border-blue-600 bg-blue-500/10',
    detail: pnlPct < 0
      ? `Down ${Math.abs(pnlPct).toFixed(0)}% — monitor, ${pos.dte} DTE remaining`
      : `${pnlPct.toFixed(0)}% profit — ${pos.dte} DTE remaining, on track`,
  };
}

function getSavedTheme(): Theme {
  try { const t = localStorage.getItem(LS_THEME); return (t === 'dark' || t === 'medium' || t === 'light') ? t : 'dark'; } catch { return 'dark'; }
}

interface PositionLeg {
  symbol: string;
  optionType: 'P' | 'C';
  strikePrice: number;
  direction: 'Short' | 'Long';
  quantity: number;
  avgOpenPrice: number;
  currentPrice: number | null;
}

interface Position {
  key: string;
  symbol: string;
  expDate: string;
  dte: number;
  strategy: string;
  legs: PositionLeg[];
  creditReceived: number;
  currentValue: number | null;
  pnl: number | null;
  pnlPct: number | null;
  targetPrice: number;
  hitTarget: boolean;
  needsClose: boolean;
  accountNumber: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function stratColor(strategy: string) {
  if (strategy === 'BPS') return 'text-emerald-400 border-emerald-700';
  if (strategy === 'BCS') return 'text-red-400 border-red-700';
  if (strategy === 'IC')  return 'text-blue-400 border-blue-700';
  return 'text-slate-400 border-slate-700';
}

function pnlColor(pnl: number | null) {
  if (pnl == null) return 'text-slate-400';
  return pnl >= 0 ? 'text-emerald-400' : 'text-red-400';
}

function dteColor(dte: number) {
  if (dte <= 7)  return 'text-red-500 font-bold';
  if (dte <= 21) return 'text-yellow-400 font-bold';
  return 'text-slate-400';
}

function ThemeToggle({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const options: { value: Theme; icon: string; label: string }[] = [
    { value: 'light', icon: '☀', label: 'Light' },
    { value: 'medium', icon: '◐', label: 'Dim' },
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

// ── Position Card ──────────────────────────────────────────────────────────
function PositionCard({ pos, th }: { pos: Position; th: typeof THEMES[Theme] }) {
  const [expanded, setExpanded] = useState(false);
  const [trend, setTrend] = useState<TrendResult | null>(null);
  const [trendLoading, setTrendLoading] = useState(false);

  useEffect(() => {
    setTrendLoading(true);
    getTrend(pos.symbol).then(t => { setTrend(t); setTrendLoading(false); }).catch(() => setTrendLoading(false));
  }, [pos.symbol]);

  const rec = getRecommendation(pos, trend);

  const ttLink = `https://trade.tastytrade.com/trade?symbol=${pos.symbol}`;

  const shortPuts  = pos.legs.filter(l => l.optionType === 'P' && l.direction === 'Short');
  const longPuts   = pos.legs.filter(l => l.optionType === 'P' && l.direction === 'Long');
  const shortCalls = pos.legs.filter(l => l.optionType === 'C' && l.direction === 'Short');
  const longCalls  = pos.legs.filter(l => l.optionType === 'C' && l.direction === 'Long');

  const strikesSummary = () => {
    if (pos.strategy === 'BPS' && shortPuts[0] && longPuts[0])
      return `${shortPuts[0].strikePrice}P / ${longPuts[0].strikePrice}P`;
    if (pos.strategy === 'BCS' && shortCalls[0] && longCalls[0])
      return `${shortCalls[0].strikePrice}C / ${longCalls[0].strikePrice}C`;
    if (pos.strategy === 'IC' && shortPuts[0] && longPuts[0] && shortCalls[0] && longCalls[0])
      return `${shortPuts[0].strikePrice}P/${longPuts[0].strikePrice}P · ${shortCalls[0].strikePrice}C/${longCalls[0].strikePrice}C`;
    return pos.legs.map(l => `${l.strikePrice}${l.optionType}`).join(' / ');
  };

  const borderClass = pos.needsClose
    ? 'border-red-500/60'
    : pos.hitTarget
    ? 'border-emerald-500/60'
    : th.border;

  return (
    <div className={`border ${borderClass} ${th.card} rounded-lg overflow-hidden transition-all`}>
      {/* Alert banner */}
      {pos.needsClose && (
        <div className="bg-red-500/10 border-b border-red-500/40 px-4 py-1.5 flex items-center gap-2">
          <span className="text-red-400 text-xs">⚠</span>
          <span className="text-xs text-red-400 font-bold tracking-wider">CLOSE NOW — {pos.dte} DTE REMAINING</span>
        </div>
      )}
      {pos.hitTarget && !pos.needsClose && (
        <div className="bg-emerald-500/10 border-b border-emerald-500/40 px-4 py-1.5 flex items-center gap-2">
          <span className="text-emerald-400 text-xs">✓</span>
          <span className="text-xs text-emerald-400 font-bold tracking-wider">50% PROFIT TARGET HIT — CLOSE FOR PROFIT</span>
        </div>
      )}

      {/* Main row */}
      <div className="px-4 py-3 flex items-center gap-4 flex-wrap cursor-pointer" onClick={() => setExpanded(!expanded)}>
        {/* Symbol + strategy */}
        <div className="w-20 shrink-0">
          <p className={`font-bold ${th.text} text-sm`} style={{ fontFamily: "'DM Mono', monospace" }}>{pos.symbol}</p>
          <span className={`text-[10px] px-1.5 py-0.5 border rounded font-bold ${stratColor(pos.strategy)}`}>{pos.strategy}</span>
        </div>

        {/* Expiry + DTE */}
        <div className="shrink-0">
          <p className={`text-[10px] ${th.textFaint}`}>Expiry</p>
          <p className="text-xs font-medium" style={{ fontFamily: "'DM Mono', monospace" }}>
            <span className={th.text}>{pos.expDate}</span>
            <span className={`ml-1.5 ${dteColor(pos.dte)}`}>({pos.dte}d)</span>
          </p>
        </div>

        {/* Strikes */}
        <div className="shrink-0">
          <p className={`text-[10px] ${th.textFaint}`}>Strikes</p>
          <p className={`text-xs font-medium ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{strikesSummary()}</p>
        </div>

        {/* Credit received */}
        <div className="shrink-0">
          <p className={`text-[10px] ${th.textFaint}`}>Credit</p>
          <p className="text-xs font-bold text-emerald-400" style={{ fontFamily: "'DM Mono', monospace" }}>${pos.creditReceived.toFixed(2)}</p>
        </div>

        {/* Current value */}
        <div className="shrink-0">
          <p className={`text-[10px] ${th.textFaint}`}>Current</p>
          <p className={`text-xs font-medium ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>
            {pos.currentValue != null ? `$${pos.currentValue.toFixed(2)}` : '—'}
          </p>
        </div>

        {/* P&L */}
        <div className="shrink-0">
          <p className={`text-[10px] ${th.textFaint}`}>P&L</p>
          <p className={`text-xs font-bold ${pnlColor(pos.pnl)}`} style={{ fontFamily: "'DM Mono', monospace" }}>
            {pos.pnl != null ? `${pos.pnl >= 0 ? '+' : ''}$${pos.pnl.toFixed(2)}` : '—'}
            {pos.pnlPct != null && <span className="ml-1 text-[10px]">({pos.pnlPct.toFixed(0)}%)</span>}
          </p>
        </div>

        {/* 50% target */}
        <div className="shrink-0">
          <p className={`text-[10px] ${th.textFaint}`}>50% Target</p>
          <p className={`text-xs font-medium ${pos.hitTarget ? 'text-emerald-400' : th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>
            ${pos.targetPrice.toFixed(2)}
            {pos.hitTarget && <span className="ml-1 text-emerald-400">✓</span>}
          </p>
        </div>

        {/* Recommendation */}
        <div className="shrink-0">
          <p className={`text-[10px] ${th.textFaint}`}>Recommendation</p>
          {trendLoading ? (
            <p className={`text-[10px] ${th.textFaint}`}>analyzing...</p>
          ) : (
            <div>
              <span className={`text-[10px] font-bold px-1.5 py-0.5 border rounded ${rec.color}`}>{rec.label}</span>
              <p className={`text-[9px] ${th.textFaint} mt-0.5 max-w-[180px]`}>{rec.detail}</p>
            </div>
          )}
        </div>

        {/* Spacer + expand + TT link */}
        <div className="ml-auto flex items-center gap-2">
          <a href={ttLink} target="_blank" rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-[9px] px-2 py-1 border border-blue-600 text-blue-400 rounded hover:bg-blue-600/10 transition-colors font-medium tracking-wider">
            TRADE →
          </a>
          <span className={`text-xs ${th.textFaint}`}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Expanded legs detail */}
      {expanded && (
        <div className={`border-t ${th.border} px-4 py-3`}>
          <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-2`}>Legs</p>
          <div className="space-y-1.5">
            {pos.legs.map((leg, i) => (
              <div key={i} className="flex items-center gap-4 flex-wrap">
                <span className={`text-[10px] w-10 font-bold ${leg.direction === 'Short' ? 'text-red-400' : 'text-emerald-400'}`}>{leg.direction}</span>
                <span className={`text-[10px] font-medium ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                  {leg.quantity}x {leg.strikePrice} {leg.optionType === 'P' ? 'Put' : 'Call'}
                </span>
                <span className={`text-[10px] ${th.textFaint}`}>Avg open: <span className={th.text}>${leg.avgOpenPrice.toFixed(2)}</span></span>
                {leg.currentPrice != null && (
                  <span className={`text-[10px] ${th.textFaint}`}>Current: <span className={th.text}>${leg.currentPrice.toFixed(2)}</span></span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Summary Bar ────────────────────────────────────────────────────────────
function SummaryBar({ positions, th }: { positions: Position[]; th: typeof THEMES[Theme] }) {
  const totalCredit = positions.reduce((sum, p) => sum + p.creditReceived, 0);
  const totalPnl = positions.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
  const needsClose = positions.filter(p => p.needsClose).length;
  const hitTarget = positions.filter(p => p.hitTarget && !p.needsClose).length;

  return (
    <div className={`grid grid-cols-2 sm:grid-cols-4 gap-4 p-4 border-b ${th.border}`}>
      <div>
        <p className={`text-[10px] ${th.textFaint} uppercase tracking-widest mb-1`}>Open Positions</p>
        <p className={`text-2xl font-bold ${th.text}`}>{positions.length}</p>
      </div>
      <div>
        <p className={`text-[10px] ${th.textFaint} uppercase tracking-widest mb-1`}>Total Credit</p>
        <p className="text-2xl font-bold text-emerald-400" style={{ fontFamily: "'DM Mono', monospace" }}>${totalCredit.toFixed(2)}</p>
      </div>
      <div>
        <p className={`text-[10px] ${th.textFaint} uppercase tracking-widest mb-1`}>Unrealized P&L</p>
        <p className={`text-2xl font-bold ${pnlColor(totalPnl)}`} style={{ fontFamily: "'DM Mono', monospace" }}>
          {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
        </p>
      </div>
      <div>
        <p className={`text-[10px] ${th.textFaint} uppercase tracking-widest mb-1`}>Action Needed</p>
        <div className="flex items-center gap-3">
          {needsClose > 0 && <span className="text-lg font-bold text-red-400">⚠ {needsClose} close</span>}
          {hitTarget > 0 && <span className="text-lg font-bold text-emerald-400">✓ {hitTarget} target</span>}
          {needsClose === 0 && hitTarget === 0 && <span className={`text-lg font-bold ${th.textFaint}`}>—</span>}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────
export default function PortfolioPage() {
  const [theme, setTheme] = useState<Theme>(getSavedTheme);
  const th = THEMES[theme];

  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchPositions = async () => {
    setLoading(true); setError('');
    try {
      const data = await loadPositions();
      setPositions(data);
      setLastRefresh(new Date());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchPositions(); }, []);

  const needsClose = positions.filter(p => p.needsClose);
  const hitTarget  = positions.filter(p => p.hitTarget && !p.needsClose);
  const normal     = positions.filter(p => !p.needsClose && !p.hitTarget);

  return (
    <div className={`min-h-screen ${th.bg} transition-colors duration-200`} style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>

      {/* Header */}
      <div className={`${th.header} border-b ${th.border} px-6 py-4 flex items-center justify-between`}>
        <div className="flex items-center gap-6">
          <div>
            <h1 className="text-base font-bold tracking-widest text-white" style={{ fontFamily: "'DM Mono', monospace" }}>OPTIONS HUNTER</h1>
            <p className="text-[10px] text-white/50 mt-0.5 tracking-wider" style={{ fontFamily: "'DM Mono', monospace" }}>PORTFOLIO MANAGEMENT</p>
          </div>
          <nav className="flex items-center gap-1 bg-black/20 rounded-lg p-1">
            <Link href="/" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">SCREENER</Link>
            <span className="text-xs px-3 py-1.5 rounded bg-white/20 text-white tracking-wider">PORTFOLIO</span>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && <span className="text-[10px] text-white/30">Updated {lastRefresh.toLocaleTimeString()}</span>}
          <button onClick={fetchPositions} disabled={loading}
            className="text-[10px] px-3 py-1.5 border border-white/20 text-white/60 rounded hover:border-white/40 hover:text-white/80 transition-colors tracking-wider disabled:opacity-40">
            {loading ? 'LOADING...' : '↻ REFRESH'}
          </button>
          <ThemeToggle theme={theme} setTheme={setTheme} />
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-6 mt-4 p-4 bg-red-500/10 border border-red-500 rounded-lg text-red-400 text-sm">{error}</div>
      )}

      {/* Loading state */}
      {loading && positions.length === 0 && (
        <div className="flex items-center justify-center h-64">
          <div className={`text-sm ${th.textFaint} tracking-widest`}>FETCHING POSITIONS...</div>
        </div>
      )}

      {/* No positions */}
      {!loading && !error && positions.length === 0 && (
        <div className="flex flex-col items-center justify-center h-64 gap-2">
          <p className={`text-sm ${th.textFaint} tracking-widest`}>NO OPEN POSITIONS FOUND</p>
          <p className={`text-xs ${th.textFaint}`}>Options positions from your TastyTrade account will appear here</p>
        </div>
      )}

      {/* Content */}
      {positions.length > 0 && (
        <>
          <SummaryBar positions={positions} th={th} />

          <div className="p-6 space-y-6">

            {/* Needs close */}
            {needsClose.length > 0 && (
              <div>
                <p className="text-[9px] text-red-400 tracking-widest mb-2 font-medium uppercase">⚠ Close Now — 21 DTE or Less</p>
                <div className="space-y-2">{needsClose.map(p => <PositionCard key={p.key} pos={p} th={th} />)}</div>
              </div>
            )}

            {/* Hit target */}
            {hitTarget.length > 0 && (
              <div>
                <p className="text-[9px] text-emerald-400 tracking-widest mb-2 font-medium uppercase">✓ 50% Profit Target Hit</p>
                <div className="space-y-2">{hitTarget.map(p => <PositionCard key={p.key} pos={p} th={th} />)}</div>
              </div>
            )}

            {/* Active positions */}
            {normal.length > 0 && (
              <div>
                <p className={`text-[9px] ${th.textFaint} tracking-widest mb-2 font-medium uppercase`}>Active Positions</p>
                <div className="space-y-2">{normal.map(p => <PositionCard key={p.key} pos={p} th={th} />)}</div>
              </div>
            )}

          </div>
        </>
      )}
    </div>
  );
}
