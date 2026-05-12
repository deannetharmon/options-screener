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

  // ── Fetch IVR from /market-metrics ──────────────────────────────────────
  // Field: implied-volatility-index-rank (TastyTrade API docs confirmed)
  const ivrMap: Record<string, number | null> = {};
  try {
    const underlyingSymbols = Array.from(new Set(optionPositions.map((p: any) => p['underlying-symbol'] as string)));
    const qs = underlyingSymbols.map((s: string) => `symbols[]=${encodeURIComponent(s)}`).join('&');
    const metricsData = await ttFetch(`/market-metrics?${qs}`, token);
    for (const item of metricsData?.data?.items ?? []) {
      const raw = item['implied-volatility-index-rank'] ?? item['tw-implied-volatility-index-rank'] ?? null;
      const parsed = raw != null ? parseFloat(String(raw)) : NaN;
      if (!isNaN(parsed)) {
        // TastyTrade returns IVR as a decimal (0.422) or percentage (42.2) — normalise to 0–100
        ivrMap[item['symbol']] = parsed <= 1 ? Math.round(parsed * 100) : Math.round(parsed);
      }
    }
  } catch { /* IVR optional */ }

  // ── Fetch working (GTC) orders ────────────────────────────────────────
  const gtcSymbols = new Set<string>();
  try {
    const ordersData = await ttFetch(`/accounts/${accountNumber}/orders/live`, token);
    for (const order of ordersData?.data?.items ?? []) {
      if (order.status === 'Live' || order.status === 'Working') {
        for (const leg of order.legs ?? []) {
          const sym = leg['underlying-symbol'] ?? leg.symbol ?? '';
          if (sym) gtcSymbols.add(sym.split(' ')[0].trim());
        }
      }
    }
  } catch { /* GTC check optional */ }

  // ── Parse OCC option symbol: e.g. APP260618P410 → type=P, strike=410 ──
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
      plOpen: null, // populated below from TastyTrade P/L endpoint
      needsClose: dte <= 21,
      accountNumber,
      ivr: ivrMap[symbol] ?? null,
      hasGtc: gtcSymbols.has(symbol),
    };
  });

  // ── Fetch real P/L Open from TastyTrade positions+marks ─────────────────
  try {
    const plData = await ttFetch(`/accounts/${accountNumber}/positions?include-marks=true`, token);
    const plItems: any[] = plData?.data?.items ?? [];
    const plBySymbol: Record<string, number> = {};
    for (const item of plItems) {
      const sym = item['underlying-symbol'];
      if (!sym) continue;
      const qty = parseFloat(item['quantity'] ?? '1');
      const multiplier = parseFloat(item['multiplier'] ?? '100');
      const avgOpen = parseFloat(item['average-open-price'] ?? '0');
      const mark = parseFloat(item['mark-price'] ?? '0');
      const dir = item['quantity-direction'] === 'Short' ? -1 : 1;
      const pl = dir * (mark - avgOpen) * qty * multiplier;
      plBySymbol[sym] = (plBySymbol[sym] ?? 0) + pl;
    }
    for (const pos of positions) {
      if (plBySymbol[pos.symbol] != null) {
        pos.plOpen = Math.round(plBySymbol[pos.symbol] * 100) / 100;
      }
      if (ivrMap[pos.symbol] != null) {
        pos.ivr = ivrMap[pos.symbol];
      }
    }
  } catch { /* plOpen/ivr stay null */ }

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

type ActionType = 'HOLD' | 'WATCH' | 'MANAGE' | 'TAKE_PROFIT' | 'CUT_LOSSES' | 'CLOSE_ROLL';

interface Recommendation {
  action: ActionType;
  detail: string;
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
  const pnlPct = pos.pnl != null && pos.creditReceived !== 0 ? (pos.pnl / pos.creditReceived) * 100 : 0;
  const trendAgainst = trend && (
    (pos.strategy === 'BPS' && trend.trend === 'downtrend') ||
    (pos.strategy === 'BCS' && trend.trend === 'uptrend')
  );
  const trendAligns = trend && (
    (pos.strategy === 'BPS' && trend.trend === 'uptrend') ||
    (pos.strategy === 'BCS' && trend.trend === 'downtrend') ||
    (pos.strategy === 'IC' && trend.trend === 'sideways')
  );
  if (pos.needsClose && pnlPct >= 0) return { action: 'CLOSE_ROLL', detail: `${pos.dte} DTE — close or roll to next expiry` };
  if (pos.needsClose && pnlPct < 0)  return { action: 'CUT_LOSSES', detail: `${pos.dte} DTE — close to prevent further loss` };
  if (pos.hitTarget)                  return { action: 'TAKE_PROFIT', detail: `50% target reached — lock in $${pos.pnl?.toFixed(2)} profit` };
  if (pnlPct < -15 && trendAgainst)  return { action: 'CUT_LOSSES', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% and trend confirms — exit` };
  if (pnlPct < -15)                  return { action: 'MANAGE', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% — trend not confirmed, manage actively` };
  if (pnlPct >= 35)                  return { action: 'TAKE_PROFIT', detail: `${pnlPct.toFixed(0)}% profit — approaching target` };
  if (pnlPct < 0 && trendAgainst)    return { action: 'MANAGE', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% with adverse trend — watch closely` };
  if (pnlPct < 0)                    return { action: 'WATCH', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% — trend still ok, monitor` };
  if (trendAligns)                   return { action: 'HOLD', detail: `Trend confirms ${pos.strategy} — ${pnlPct.toFixed(0)}% profit` };
  return { action: 'HOLD', detail: `${pnlPct.toFixed(0)}% profit — ${pos.dte} DTE remaining` };
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
  plOpen: number | null;      // TastyTrade real P/L Open
  targetPrice: number;
  hitTarget: boolean;
  needsClose: boolean;
  accountNumber: string;
  ivr: number | null;         // Live IV Rank from TastyTrade
  hasGtc: boolean;            // Whether a GTC working order exists
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
function PositionCard({ pos, th, selectedAction, onToggleSelect }: {
  pos: Position;
  th: typeof THEMES[Theme];
  selectedAction: ActionType | null;
  onToggleSelect: (key: string, action: ActionType) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [trend, setTrend] = useState<TrendResult | null>(null);
  const [trendLoading, setTrendLoading] = useState(false);

  useEffect(() => {
    setTrendLoading(true);
    getTrend(pos.symbol).then(t => { setTrend(t); setTrendLoading(false); }).catch(() => setTrendLoading(false));
  }, [pos.symbol]);

  const rec = getRecommendation(pos, trend);

  const ttLink = `https://trade.tastytrade.com/trade?symbol=${pos.symbol}`;

  const ttActionUrl = (_action: ActionType): string =>
    `https://my.tastytrade.com/app.html#/trading/positions`;

  const ttActionTooltip = (action: ActionType): string => {
    switch (action) {
      case 'TAKE_PROFIT':  return `Open TastyTrade Positions → close ${pos.symbol} at 50% profit`;
      case 'CUT_LOSSES':   return `Open TastyTrade Positions → close ${pos.symbol} to cut losses`;
      case 'CLOSE_ROLL':   return `Open TastyTrade Positions → close or roll ${pos.symbol}`;
      case 'MANAGE':       return `Open TastyTrade Positions → manage ${pos.symbol}`;
      case 'WATCH':        return `Open TastyTrade Positions → monitor ${pos.symbol}`;
      default:             return `Open TastyTrade Positions`;
    }
  };

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

  const borderClass = selectedAction
    ? 'border-blue-500/60'
    : pos.needsClose
    ? 'border-red-500/60'
    : pos.hitTarget
    ? 'border-emerald-500/60'
    : th.border;

  const effectiveAction = selectedAction ?? rec.action;

  const actionConfig: Record<ActionType, { label: string; btnClass: string; pillClass: string; show: boolean }> = {
    HOLD:        { label: '● Hold',         btnClass: '', pillClass: 'border-blue-700 text-blue-400 bg-blue-500/10',      show: false },
    WATCH:       { label: '⚠ Watch',        btnClass: '', pillClass: 'border-yellow-700 text-yellow-400 bg-yellow-500/10', show: false },
    MANAGE:      { label: '⚡ Manage',       btnClass: 'border-orange-600 text-orange-400 hover:bg-orange-600/10',  pillClass: '', show: true },
    TAKE_PROFIT: { label: '✓ Take Profit',  btnClass: 'border-emerald-600 text-emerald-400 hover:bg-emerald-600/10', pillClass: '', show: true },
    CUT_LOSSES:  { label: '✕ Cut Losses',   btnClass: 'border-red-600 text-red-400 hover:bg-red-600/10',           pillClass: '', show: true },
    CLOSE_ROLL:  { label: '↻ Close / Roll', btnClass: 'border-purple-600 text-purple-400 hover:bg-purple-600/10',  pillClass: '', show: true },
  };

  const actionDef = actionConfig[effectiveAction];

  const actions: { key: ActionType; label: string; activeColor: string; ringColor: string; labelColor: string }[] = [
    { key: 'HOLD',        label: 'Hold',         activeColor: 'bg-blue-500 border-blue-500',      ringColor: 'ring-blue-500',    labelColor: 'text-blue-400' },
    { key: 'WATCH',       label: 'Watch',        activeColor: 'bg-yellow-500 border-yellow-500',  ringColor: 'ring-yellow-500',  labelColor: 'text-yellow-400' },
    { key: 'MANAGE',      label: 'Manage',       activeColor: 'bg-orange-500 border-orange-500',  ringColor: 'ring-orange-500',  labelColor: 'text-orange-400' },
    { key: 'TAKE_PROFIT', label: 'Take profit',  activeColor: 'bg-emerald-500 border-emerald-500', ringColor: 'ring-emerald-500', labelColor: 'text-emerald-400' },
    { key: 'CUT_LOSSES',  label: 'Cut losses',   activeColor: 'bg-red-500 border-red-500',        ringColor: 'ring-red-500',     labelColor: 'text-red-400' },
    { key: 'CLOSE_ROLL',  label: 'Close / roll', activeColor: 'bg-purple-500 border-purple-500',  ringColor: 'ring-purple-500',  labelColor: 'text-purple-400' },
  ];

  return (
    <div className={`border ${borderClass} ${th.card} rounded-lg overflow-hidden transition-all`}>
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

      <div className="flex items-stretch">
        {/* Expand toggle — left edge */}
        <button
          onClick={() => setExpanded(!expanded)}
          className={`px-3 flex items-center border-r ${th.borderLight} ${th.textFaint} hover:${th.textMuted} transition-colors shrink-0`}>
          <span className="text-[10px]">{expanded ? '▲' : '▼'}</span>
        </button>

        {/* Data columns — fixed grid for vertical alignment */}
        <div className="grid px-4 py-3 flex-1 min-w-0" style={{ gridTemplateColumns: '72px 120px 110px 80px 80px 90px 80px 70px 55px 60px', gap: '0 12px', alignItems: 'center' }}>
          <div>
            <p className={`font-bold ${th.text} text-sm leading-tight`} style={{ fontFamily: "'DM Mono', monospace" }}>{pos.symbol}</p>
            <span className={`text-[10px] px-1.5 py-0.5 border rounded font-bold ${stratColor(pos.strategy)}`}>{pos.strategy}</span>
          </div>
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>Expiry / DTE</p>
            <p className="text-xs leading-tight" style={{ fontFamily: "'DM Mono', monospace" }}>
              <span className={`block ${th.text}`}>{pos.expDate}</span>
              <span className={`block ${dteColor(pos.dte)}`}>({pos.dte}d)</span>
            </p>
          </div>
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>Strikes</p>
            <p className={`text-xs ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{strikesSummary()}</p>
          </div>
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>Current</p>
            <p className={`text-xs ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>
              {pos.currentValue != null ? `$${pos.currentValue.toFixed(2)}` : '—'}
            </p>
          </div>
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>Credit</p>
            <p className="text-xs font-bold text-emerald-400" style={{ fontFamily: "'DM Mono', monospace" }}>${pos.creditReceived.toFixed(2)}</p>
          </div>
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>P&L</p>
            <p className={`text-xs font-bold ${pnlColor(pos.pnl)}`} style={{ fontFamily: "'DM Mono', monospace" }}>
              {pos.pnl != null ? `${pos.pnl >= 0 ? '+' : ''}$${pos.pnl.toFixed(2)}` : '—'}
              {pos.pnlPct != null && <span className="ml-1 text-[10px] font-normal">({pos.pnlPct.toFixed(0)}%)</span>}
            </p>
          </div>
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>50% Target</p>
            <p className={`text-xs ${pos.hitTarget ? 'text-emerald-400 font-bold' : th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>
              ${pos.targetPrice.toFixed(2)}{pos.hitTarget && ' ✓'}
            </p>
          </div>
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>P/L Open</p>
            <p className={`text-xs font-bold ${pos.plOpen != null ? (pos.plOpen >= 0 ? 'text-emerald-400' : 'text-red-400') : th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>
              {pos.plOpen != null ? `${pos.plOpen >= 0 ? '+' : ''}$${pos.plOpen.toFixed(0)}` : '—'}
            </p>
          </div>
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>IVR</p>
            <p className={`text-xs font-bold ${pos.ivr != null ? (pos.ivr >= 30 ? 'text-emerald-400' : 'text-yellow-400') : th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>
              {pos.ivr != null ? `${pos.ivr}` : '—'}
            </p>
          </div>
          <div>
            <p className={`text-[9px] ${th.textFaint}`}>GTC</p>
            <p className={`text-xs font-bold ${pos.hasGtc ? 'text-emerald-400' : 'text-red-400'}`}>
              {pos.hasGtc ? '✓ Live' : '✕ None'}
            </p>
          </div>
        </div>

        {/* Action columns + button */}
        <div className={`flex items-stretch border-l ${th.border} shrink-0`} onClick={e => e.stopPropagation()}>
          {trendLoading ? (
            <div className="flex items-center px-4">
              <span className={`text-[10px] ${th.textFaint}`}>analyzing...</span>
            </div>
          ) : (
            <>
              {actions.map(a => {
                const isSelected = selectedAction === a.key;
                const isRec = rec.action === a.key && selectedAction === null;
                const labelColor = isSelected || isRec ? a.labelColor : th.textFaint;
                return (
                  <div
                    key={a.key}
                    onClick={() => onToggleSelect(pos.key, a.key)}
                    className={`flex flex-col items-center justify-center px-3 py-2 gap-1.5 border-r ${th.borderLight} w-[70px] cursor-pointer hover:bg-white/5 transition-colors`}
                  >
                    <span className={`text-[9px] text-center leading-tight whitespace-nowrap font-medium ${labelColor}`}>{a.label}</span>
                    <div className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center transition-all
                      ${isSelected ? a.activeColor : isRec ? 'border-slate-500 ring-1 ' + a.ringColor : 'border-slate-700'}`}>
                      {(isSelected || isRec) && <span className="text-[8px] font-bold text-white">✓</span>}
                    </div>
                  </div>
                );
              })}

              {/* Action button */}
              <div className="flex flex-col items-center justify-center gap-1 px-3 min-w-[110px]">
                {actionDef.show ? (
                  <button
                    onClick={() => onToggleSelect(pos.key, effectiveAction)}
                    className={`text-[9px] px-3 py-1.5 border rounded font-bold tracking-wider whitespace-nowrap transition-colors w-full text-center ${actionDef.btnClass}`}>
                    {actionDef.label}
                  </button>
                ) : (
                  <span className={`text-[9px] px-3 py-1.5 border rounded whitespace-nowrap w-full text-center font-medium ${actionDef.pillClass}`}>
                    {actionDef.label}
                  </span>
                )}
                <a
                  href={ttActionUrl(effectiveAction)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[8px] text-white/30 hover:text-white/70 tracking-wider transition-colors whitespace-nowrap"
                  title={ttActionTooltip(effectiveAction)}>
                  → TastyTrade ↗
                </a>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Expanded legs */}
      {expanded && (
        <div className={`border-t ${th.border} px-4 py-3`}>
          <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-2`}>Legs</p>
          <div className="space-y-1.5">
            {pos.legs.map((leg, i) => (
              <div key={i} className="flex items-center gap-4 flex-wrap">
                <span className={`text-[10px] w-10 font-bold ${leg.direction === 'Short' ? 'text-red-400' : 'text-emerald-400'}`}>{leg.direction}</span>
                <span className={`text-[10px] ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>
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
  const capturedPct = totalCredit > 0 ? (totalPnl / totalCredit) * 100 : 0;

  const totalAtRisk = positions.reduce((sum, p) => {
    const shorts = p.legs.filter(l => l.direction === 'Short');
    const longs  = p.legs.filter(l => l.direction === 'Long' && l.optionType === shorts[0]?.optionType);
    if (shorts[0] && longs[0]) {
      const width = Math.abs(shorts[0].strikePrice - longs[0].strikePrice);
      const qty = shorts[0].quantity;
      return sum + Math.max(0, (width * 100 * qty) - p.creditReceived);
    }
    return sum;
  }, 0);

  // Est. theta/day = sum of (current_value / DTE) per position — daily decay working in our favor
  const totalTheta = positions.reduce((sum, p) => {
    if (p.currentValue != null && p.dte > 0) return sum + (p.currentValue / p.dte);
    return sum;
  }, 0);

  return (
    <div className={`grid grid-cols-4 border-b ${th.border}`}>
      <div className={`p-5 border-r ${th.border} flex flex-col items-center text-center`}>
        <p className={`text-[10px] ${th.textFaint} uppercase tracking-widest mb-2`}>Open Positions</p>
        <p className={`text-3xl font-bold ${th.text}`}>{positions.length}</p>
        <p className={`text-[10px] ${th.textFaint} mt-1`}>{positions.length === 1 ? '1 active spread' : `${positions.length} active spreads`}</p>
      </div>

      <div className={`p-5 border-r ${th.border} flex flex-col items-center text-center`}>
        <p className={`text-[10px] ${th.textFaint} uppercase tracking-widest mb-2`}>Captured</p>
        <p className={`text-3xl font-bold ${totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
          {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(0)}
        </p>
        <p className={`text-[10px] mt-1`} style={{ fontFamily: "'DM Mono', monospace" }}>
          <span className={`font-bold ${th.textMuted}`}>of ${totalCredit.toFixed(0)} collected</span>
          <span className={`ml-1 ${totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>· {capturedPct.toFixed(0)}%</span>
        </p>
      </div>

      <div className={`p-5 border-r ${th.border} flex flex-col items-center text-center`}>
        <p className={`text-[10px] ${th.textFaint} uppercase tracking-widest mb-2`}>At Risk</p>
        <p className={`text-3xl font-bold ${th.textMuted}`} style={{ fontFamily: "'DM Mono', monospace" }}>
          ${totalAtRisk.toFixed(0)}
        </p>
        <p className={`text-[10px] ${th.textFaint} mt-1`}>max loss if all expire worthless</p>
      </div>

      <div className="p-5 flex flex-col items-center text-center">
        <p className={`text-[10px] ${th.textFaint} uppercase tracking-widest mb-2`}>Est. Theta / Day</p>
        <p className="text-3xl font-bold text-blue-400" style={{ fontFamily: "'DM Mono', monospace" }}>
          +${totalTheta.toFixed(2)}
        </p>
        <p className={`text-[10px] ${th.textFaint} mt-1`}>est. daily decay across all positions</p>
      </div>
    </div>
  );
}

// ── Close Summary Modal ───────────────────────────────────────────────────
function CloseModal({ positions, selected, onClose, th }: {
  positions: Position[];
  selected: Map<string, ActionType>;
  onClose: () => void;
  th: typeof THEMES[Theme];
}) {
  const selectedPositions = positions.filter(p => selected.has(p.key));
  const totalCredit = selectedPositions.reduce((sum, p) => sum + p.creditReceived, 0);
  const totalPnl = selectedPositions.reduce((sum, p) => sum + (p.pnl ?? 0), 0);

  const actionLabels: Record<ActionType, { label: string; color: string }> = {
    HOLD:        { label: 'Hold',         color: 'text-blue-400 border-blue-600' },
    WATCH:       { label: '⚠ Watch',      color: 'text-yellow-400 border-yellow-600' },
    MANAGE:      { label: '⚡ Manage',     color: 'text-orange-400 border-orange-600' },
    TAKE_PROFIT: { label: '✓ Take profit', color: 'text-emerald-400 border-emerald-600' },
    CUT_LOSSES:  { label: '✕ Cut losses',  color: 'text-red-400 border-red-600' },
    CLOSE_ROLL:  { label: '↻ Close / roll', color: 'text-purple-400 border-purple-600' },
  };

  const grouped = new Map<ActionType, Position[]>();
  for (const pos of selectedPositions) {
    const action = selected.get(pos.key)!;
    if (!grouped.has(action)) grouped.set(action, []);
    grouped.get(action)!.push(pos);
  }

  const openAll = () => {
    selectedPositions.forEach(p => {
      window.open(`https://my.tastytrade.com/trade?symbol=${p.symbol}`, '_blank');
    });
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50 p-4">
      <div className={`${th.sidebar} border ${th.border} rounded-2xl w-full max-w-lg`}>
        <div className={`flex items-center justify-between px-5 py-4 border-b ${th.border}`}>
          <div>
            <h2 className={`text-sm font-bold ${th.text} tracking-wider`}>CLOSE {selectedPositions.length} POSITION{selectedPositions.length !== 1 ? 'S' : ''}</h2>
            <p className={`text-[10px] ${th.textFaint} mt-0.5`}>Buy to close — set limit at mid price in TastyTrade</p>
          </div>
          <button onClick={onClose} className={`text-xl ${th.textFaint} hover:${th.text}`}>✕</button>
        </div>

        <div className="px-5 py-3 space-y-4 max-h-80 overflow-auto">
          {Array.from(grouped.entries()).map(([action, poses]) => (
            <div key={action}>
              <p className={`text-[9px] font-bold tracking-widest mb-2 uppercase ${actionLabels[action].color.split(' ')[0]}`}>
                {actionLabels[action].label}
              </p>
              <div className="space-y-2">
                {poses.map(p => {
                  const closeTarget = (p.currentValue ?? p.creditReceived * 0.5).toFixed(2);
                  return (
                    <div key={p.key} className={`flex items-center justify-between py-2 border-b ${th.borderLight}`}>
                      <div className="flex items-center gap-3">
                        <span className={`text-xs font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{p.symbol}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 border rounded font-bold ${stratColor(p.strategy)}`}>{p.strategy}</span>
                        <span className={`text-[10px] ${th.textFaint}`}>{p.expDate} · {p.dte}d</span>
                      </div>
                      <div className="text-right">
                        {(action === 'TAKE_PROFIT' || action === 'CUT_LOSSES' || action === 'CLOSE_ROLL') && (
                          <p className="text-xs font-bold text-blue-400" style={{ fontFamily: "'DM Mono', monospace" }}>BTC @ ${closeTarget}</p>
                        )}
                        {p.pnl != null && <p className={`text-[10px] ${p.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{p.pnl >= 0 ? '+' : ''}${p.pnl.toFixed(2)}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className={`px-5 py-3 border-t ${th.border} flex items-center justify-between`}>
          <div>
            <p className={`text-[10px] ${th.textFaint}`}>Total credit collected</p>
            <p className="text-sm font-bold text-emerald-400" style={{ fontFamily: "'DM Mono', monospace" }}>${totalCredit.toFixed(2)}</p>
          </div>
          <div className="text-right">
            <p className={`text-[10px] ${th.textFaint}`}>Estimated P&L</p>
            <p className={`text-sm font-bold ${totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
              {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
            </p>
          </div>
        </div>

        <div className="px-5 py-4 flex gap-3">
          <button onClick={openAll}
            className="flex-1 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold tracking-widest transition-colors">
            OPEN ALL IN TASTYTRADE →
          </button>
          <button onClick={onClose}
            className={`px-4 py-3 border ${th.border} ${th.textFaint} rounded-xl text-xs font-medium hover:${th.text} transition-colors`}>
            Cancel
          </button>
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
  const [selected, setSelected] = useState<Map<string, ActionType>>(new Map());
  const [showCloseModal, setShowCloseModal] = useState(false);

  const toggleSelected = (key: string, action: ActionType) => {
    setSelected(prev => {
      const next = new Map(prev);
      if (next.get(key) === action) next.delete(key);
      else next.set(key, action);
      return next;
    });
  };

  const fetchPositions = async () => {
    setLoading(true); setError(''); setSelected(new Map());
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
            <Link href="/" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">HUNTER</Link>
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

          <div className="overflow-x-auto">
          <div className="p-6 space-y-6" style={{ minWidth: '1180px' }}>

            {/* Needs close */}
            {needsClose.length > 0 && (
              <div>
                <p className="text-[10px] text-red-400 tracking-widest mb-3 font-bold uppercase">⚠ Close Now — 21 DTE or Less</p>
                <div className="space-y-2">{needsClose.map(p => <PositionCard key={p.key} pos={p} th={th} selectedAction={selected.get(p.key) ?? null} onToggleSelect={toggleSelected} />)}</div>
              </div>
            )}

            {/* Hit target */}
            {hitTarget.length > 0 && (
              <div>
                <p className="text-[10px] text-emerald-400 tracking-widest mb-3 font-bold uppercase">✓ 50% Profit Target Hit</p>
                <div className="space-y-2">{hitTarget.map(p => <PositionCard key={p.key} pos={p} th={th} selectedAction={selected.get(p.key) ?? null} onToggleSelect={toggleSelected} />)}</div>
              </div>
            )}

            {/* Active positions */}
            {normal.length > 0 && (
              <div>
                <p className={`text-[10px] ${th.textFaint} tracking-widest mb-3 font-bold uppercase`}>Active Positions</p>
                <div className="space-y-2">{normal.map(p => <PositionCard key={p.key} pos={p} th={th} selectedAction={selected.get(p.key) ?? null} onToggleSelect={toggleSelected} />)}</div>
              </div>
            )}

          </div>
          </div>
        </>
      )}

      {/* Floating action bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40">
          <div className="flex items-center gap-3 bg-[#111] border border-[#333] rounded-2xl px-5 py-3 shadow-2xl">
            <span className="text-xs text-white font-medium">{selected.size} position{selected.size !== 1 ? 's' : ''} selected</span>
            <button onClick={() => setShowCloseModal(true)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold tracking-wider transition-colors">
              REVIEW SELECTED →
            </button>
            <button onClick={() => setSelected(new Map())}
              className="text-xs text-slate-400 hover:text-white transition-colors">
              Clear
            </button>
          </div>
        </div>
      )}

      {showCloseModal && (
        <CloseModal
          positions={positions}
          selected={selected}
          onClose={() => setShowCloseModal(false)}
          th={th}
        />
      )}
    </div>
  );
}
