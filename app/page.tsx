// path: app/page.tsx

'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';

if (typeof document !== 'undefined') {
  if (!document.getElementById('hunter-accent-style')) {
    const style = document.createElement('style');
    style.id = 'hunter-accent-style';
    style.textContent = `
      :root { --accent: #3b82f6; --accent-r: 59; --accent-g: 130; --accent-b: 246; }
      .accent-border { border-color: var(--accent) !important; }
      .accent-text { color: var(--accent) !important; }
      .accent-bg { background-color: rgba(var(--accent-r), var(--accent-g), var(--accent-b), 0.1) !important; }
      .accent-ring { box-shadow: 0 0 0 1px var(--accent) !important; }
    `;
    document.head.appendChild(style);
  }
}
if (typeof document !== 'undefined') {
  if (!document.getElementById('hunter-font')) {
    const link = document.createElement('link');
    link.id = 'hunter-font';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=DM+Mono:wght@400;500&display=swap';
    document.head.appendChild(link);
  }
}

type Theme = 'dark' | 'medium' | 'light';
const LS_THEME = 'hunter-theme';
const LS_ACCENT = 'hunter-accent';

const ACCENTS = {
  electric: { hex: '#3b82f6', label: 'Electric' },
  emerald:  { hex: '#10b981', label: 'Emerald' },
  amber:    { hex: '#f59e0b', label: 'Amber' },
  violet:   { hex: '#8b5cf6', label: 'Violet' },
  rose:     { hex: '#f43f5e', label: 'Rose' },
  slate:    { hex: '#64748b', label: 'Slate' },
} as const;
type Accent = keyof typeof ACCENTS;

function getSavedTheme(): Theme {
  try { const t = localStorage.getItem(LS_THEME); return (t === 'dark' || t === 'medium' || t === 'light') ? t : 'dark'; }
  catch { return 'dark'; }
}
function getSavedAccent(): Accent {
  try { const a = localStorage.getItem(LS_ACCENT); return (a && a in ACCENTS) ? a as Accent : 'electric'; }
  catch { return 'electric'; }
}
function applyAccent(accent: Accent) {
  const hex = ACCENTS[accent].hex;
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--accent', hex);
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    document.documentElement.style.setProperty('--accent-r', String(r));
    document.documentElement.style.setProperty('--accent-g', String(g));
    document.documentElement.style.setProperty('--accent-b', String(b));
  }
}

const THEMES: Record<Theme, {
  bg: string; card: string; border: string; header: string;
  text: string; textMuted: string; textFaint: string; sidebar: string;
}> = {
  dark:   { bg: 'bg-[#0a0a0a]', card: 'bg-[#171717]', border: 'border-[#2c2c2c]', header: 'bg-[#0f0f0f]', text: 'text-white',        textMuted: 'text-[#e0e0e0]', textFaint: 'text-[#808080]', sidebar: 'bg-[#0f0f0f]' },
  medium: { bg: 'bg-[#141414]', card: 'bg-[#202020]', border: 'border-[#333333]', header: 'bg-[#1a1a1a]', text: 'text-white',        textMuted: 'text-[#d8d8d8]', textFaint: 'text-[#777777]', sidebar: 'bg-[#1a1a1a]' },
  light:  { bg: 'bg-[#f5f5f5]', card: 'bg-white',     border: 'border-[#e0e0e0]', header: 'bg-[#111111]', text: 'text-[#111111]',   textMuted: 'text-[#1a1a1a]', textFaint: 'text-[#666666]', sidebar: 'bg-white'     },
};

interface ConditionFlag { label: string; value: string; status: 'good' | 'warn' | 'bad'; detail: string; }

interface EsFutures {
  price: number; overnightChangePct: number; overnightHigh: number; overnightLow: number;
  bias: 'bullish' | 'bearish' | 'neutral'; biasLabel: string; strikeAnchorNote: string; settling: boolean;
}

interface TrendContext {
  sma10: number; currentVsSma: 'above' | 'below' | 'just_crossed_above' | 'just_crossed_below';
  consecutiveDays: number; primeSetup: boolean; recoverySetup: boolean;
  reversalAnchorPrice: number | null; trendLabel: string;
}

interface MarketConditions {
  score: number;
  signal: 'PRIME SETUP' | 'TRADE TODAY' | 'MANAGE ONLY' | 'CAUTION' | 'WAIT TODAY';
  signalDetail: string;
  flags: {
    dayOfWeek: ConditionFlag; timeOfDay: ConditionFlag; esFutures: ConditionFlag;
    vix: ConditionFlag; termStructure: ConditionFlag; spxMove: ConditionFlag;
    fomc: ConditionFlag; expirationWeek: ConditionFlag; earnings: ConditionFlag;
  };
  esFutures: EsFutures | null;
  trendContext: TrendContext | null;
  fiftyPctPositions: string[];
}

const FOMC_DATES_2026 = ['2026-01-29','2026-03-19','2026-05-07','2026-06-18','2026-07-30','2026-09-17','2026-11-05','2026-12-17'];

async function loadMarketConditions(): Promise<MarketConditions> {
  const now = new Date();
  const etParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
  const etHour = parseInt(etParts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const etMinutes = parseInt(etParts.find(p => p.type === 'minute')?.value ?? '0', 10);
  const etTimeDecimal = etHour + etMinutes / 60;
  const dayOfWeek = now.getDay();
  const todayStr = now.toISOString().slice(0, 10);

  let score = 100;
  const flags: MarketConditions['flags'] = {} as any;

  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const dayName = dayNames[dayOfWeek];
  if (dayOfWeek === 1) { score -= 15; flags.dayOfWeek = { label: 'Day of week', value: dayName, status: 'warn', detail: 'Monday gap risk — weekend news can gap fills' }; }
  else if (dayOfWeek === 5) { score -= 12; flags.dayOfWeek = { label: 'Day of week', value: dayName, status: 'warn', detail: 'Friday theta distortion — avoid new entries near close' }; }
  else if (dayOfWeek === 0 || dayOfWeek === 6) { score -= 100; flags.dayOfWeek = { label: 'Day of week', value: dayName, status: 'bad', detail: 'Market closed' }; }
  else { flags.dayOfWeek = { label: 'Day of week', value: dayName, status: 'good', detail: 'Optimal trading day' }; }

  const etTimeStr = `${String(etHour).padStart(2,'0')}:${String(etMinutes).padStart(2,'0')} ET`;
  if (etTimeDecimal < 9.5 || etTimeDecimal > 16.0) { score -= 100; flags.timeOfDay = { label: 'Market time', value: etTimeStr, status: 'bad', detail: 'Market closed' }; }
  else if (etTimeDecimal < 10.0) { score -= 18; flags.timeOfDay = { label: 'Market time', value: etTimeStr, status: 'warn', detail: 'Opening 30 min — wide bid-ask, erratic pricing' }; }
  else if (etTimeDecimal > 15.5) { score -= 15; flags.timeOfDay = { label: 'Market time', value: etTimeStr, status: 'warn', detail: 'Closing 30 min — liquidity thin, avoid new fills' }; }
  else { flags.timeOfDay = { label: 'Market time', value: etTimeStr, status: 'good', detail: 'Clean trading window (10am–3:30pm ET)' }; }

  let vixValue = 18, vix3mValue = 20, spxChange = 0;
  let esFutures: EsFutures | null = null;
  let trendContext: TrendContext | null = null;

  try {
    const [vixRes, vix3mRes, spxRes, esRes, esTrendRes] = await Promise.allSettled([
      fetch('/api/market?symbol=%5EVIX&range=2d&interval=1d',                     { cache: 'no-store' }),
      fetch('/api/market?symbol=%5EVIX3M&range=2d&interval=1d',                   { cache: 'no-store' }),
      fetch('/api/market?symbol=%5EGSPC&range=2d&interval=1d',                    { cache: 'no-store' }),
      fetch('/api/market?symbol=ES%3DF&range=2d&interval=1d&includePrePost=true', { cache: 'no-store' }),
      fetch('/api/market?symbol=ES%3DF&range=1mo&interval=1d',                    { cache: 'no-store' }),
    ]);
    if (vixRes.status === 'fulfilled' && vixRes.value.ok) { const d = await vixRes.value.json(); vixValue = d?.chart?.result?.[0]?.meta?.regularMarketPrice ?? d?.chart?.result?.[0]?.meta?.previousClose ?? 18; }
    if (vix3mRes.status === 'fulfilled' && vix3mRes.value.ok) { const d = await vix3mRes.value.json(); vix3mValue = d?.chart?.result?.[0]?.meta?.regularMarketPrice ?? d?.chart?.result?.[0]?.meta?.previousClose ?? 20; }
    if (spxRes.status === 'fulfilled' && spxRes.value.ok) {
      const d = await spxRes.value.json(); const meta = d?.chart?.result?.[0]?.meta;
      const prev = meta?.chartPreviousClose ?? meta?.previousClose ?? 0; const curr = meta?.regularMarketPrice ?? prev;
      spxChange = prev > 0 ? ((curr - prev) / prev) * 100 : 0;
    }
    if (esRes.status === 'fulfilled' && esRes.value.ok) {
      const d = await esRes.value.json(); const result = d?.chart?.result?.[0]; const meta = result?.meta; const quotes = result?.indicators?.quote?.[0];
      const esPrice = meta?.regularMarketPrice ?? meta?.previousClose ?? 0;
      const esPrevClose = meta?.chartPreviousClose ?? meta?.previousClose ?? esPrice;
      const highs: number[] = quotes?.high ?? []; const lows: number[] = quotes?.low ?? [];
      const overnightHigh = highs.length > 0 ? Math.max(...highs.filter((h: number) => h > 0)) : esPrice * 1.005;
      const overnightLow = lows.length > 0 ? Math.min(...lows.filter((l: number) => l > 0)) : esPrice * 0.995;
      const overnightChangePct = esPrevClose > 0 ? ((esPrice - esPrevClose) / esPrevClose) * 100 : 0;
      let bias: EsFutures['bias'] = 'neutral'; let biasLabel = 'BPS';
      if (overnightChangePct > 0.5) { bias = 'bullish'; biasLabel = 'BPS'; } else if (overnightChangePct < -0.5) { bias = 'bearish'; biasLabel = 'BCS'; }
      const strikeAnchorNote = bias === 'bullish'
        ? `Overnight low ~${overnightLow.toFixed(0)} — short put strike should clear this by 0.5% (≥${(overnightLow * 0.995).toFixed(0)})`
        : bias === 'bearish'
        ? `Overnight high ~${overnightHigh.toFixed(0)} — short call strike should clear this by 0.5% (≤${(overnightHigh * 1.005).toFixed(0)})`
        : `ES=F flat — BPS conditions · puts below ${overnightLow.toFixed(0)} for best buffer`;
      const etPN = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date());
      const etDec = parseInt(etPN.find(p => p.type === 'hour')?.value ?? '0') + parseInt(etPN.find(p => p.type === 'minute')?.value ?? '0') / 60;
      const settling = etDec >= 9.5 && etDec < 9.75 && Math.abs(overnightChangePct) > 0.3;
      esFutures = { price: esPrice, overnightChangePct, overnightHigh, overnightLow, bias, biasLabel, strikeAnchorNote, settling };
    }
    if (esTrendRes.status === 'fulfilled' && esTrendRes.value.ok) {
      const td = await esTrendRes.value.json();
      const closes: number[] = td?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
      const lows: number[] = td?.chart?.result?.[0]?.indicators?.quote?.[0]?.low ?? [];
      const validCloses = closes.filter((c: number) => c != null && c > 0);
      if (validCloses.length >= 11) {
        const yesterday = validCloses[validCloses.length - 2] ?? validCloses[validCloses.length - 1];
        const today = validCloses[validCloses.length - 1];
        const sma10 = validCloses.slice(-11, -1).reduce((a: number, b: number) => a + b, 0) / 10;
        const todayAbove = today > sma10; const yesterdayAbove = yesterday > sma10;
        let currentVsSma: TrendContext['currentVsSma'];
        if (!yesterdayAbove && todayAbove) currentVsSma = 'just_crossed_above';
        else if (yesterdayAbove && !todayAbove) currentVsSma = 'just_crossed_below';
        else if (todayAbove) currentVsSma = 'above';
        else currentVsSma = 'below';
        let consecutiveDays = 0;
        const compareAbove = currentVsSma === 'just_crossed_above' ? false : todayAbove;
        for (let i = validCloses.length - 2; i >= 0 && validCloses.length - 11 <= i; i--) {
          const smaSlice = validCloses.slice(Math.max(0, i - 10), i);
          if (smaSlice.length < 5) break;
          if ((validCloses[i] > smaSlice.reduce((a: number, b: number) => a + b, 0) / smaSlice.length) !== compareAbove) break;
          consecutiveDays++;
        }
        const isReversal = currentVsSma === 'just_crossed_above' && consecutiveDays >= 5;
        const reversalAnchorPrice = isReversal ? Math.min(...lows.filter((l: number) => l != null && l > 0).slice(-3)) : null;
        const trendLabel = currentVsSma === 'just_crossed_above' ? `Reversal — crossed above SMA10 after ${consecutiveDays}d downtrend`
          : currentVsSma === 'just_crossed_below' ? `Breakdown — crossed below SMA10 after ${consecutiveDays}d uptrend`
          : currentVsSma === 'above' ? `Uptrend — above SMA10 for ${consecutiveDays}d`
          : `Downtrend — below SMA10 for ${consecutiveDays}d`;
        trendContext = { sma10, currentVsSma, consecutiveDays, primeSetup: isReversal && vixValue >= 20, recoverySetup: isReversal && vixValue < 20, reversalAnchorPrice, trendLabel };
      }
    }
  } catch {}

  if (esFutures) {
    const chg = esFutures.overnightChangePct;
    const chgStr = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% overnight · ${esFutures.biasLabel} bias`;
    if (esFutures.settling) { score -= 15; flags.esFutures = { label: 'ES=F Futures', value: chgStr, status: 'warn', detail: `Open settling — wait until 9:45am ET. ${esFutures.strikeAnchorNote}` }; }
    else if (Math.abs(chg) > 2.0) { score -= 20; flags.esFutures = { label: 'ES=F Futures', value: chgStr, status: 'bad', detail: `Large overnight move >2% — elevated gap risk. ${esFutures.strikeAnchorNote}` }; }
    else if (Math.abs(chg) > 0.5) { flags.esFutures = { label: 'ES=F Futures', value: chgStr, status: 'good', detail: `Directional bias clear — ${esFutures.biasLabel} favored. ${esFutures.strikeAnchorNote}` }; }
    else { flags.esFutures = { label: 'ES=F Futures', value: chgStr, status: 'good', detail: `ES flat — IC conditions. ${esFutures.strikeAnchorNote}` }; }
  } else { flags.esFutures = { label: 'ES=F Futures', value: 'Unavailable', status: 'warn', detail: 'Could not fetch ES=F data — use SPX day move as proxy' }; }

  const vixStr = vixValue.toFixed(1);
  if (vixValue > 35) { score -= 30; flags.vix = { label: 'VIX', value: vixStr, status: 'bad', detail: 'Extreme fear — wide spreads, avoid new entries' }; }
  else if (vixValue > 28) { score -= 18; flags.vix = { label: 'VIX', value: vixStr, status: 'warn', detail: 'Elevated fear — fills will be wide, size down' }; }
  else if (vixValue < 13) { score -= 15; flags.vix = { label: 'VIX', value: vixStr, status: 'warn', detail: 'Crushed IV — premium too thin to sell efficiently' }; }
  else if (vixValue < 16) { score -= 8; flags.vix = { label: 'VIX', value: vixStr, status: 'warn', detail: 'Low IV — thin premium, prefer managing existing positions' }; }
  else { flags.vix = { label: 'VIX', value: vixStr, status: 'good', detail: `Normal range (${vixStr}) — good premium environment` }; }

  if (vixValue > vix3mValue) { score -= 20; flags.termStructure = { label: 'VIX term structure', value: `Inverted (${vixValue.toFixed(1)} > ${vix3mValue.toFixed(1)})`, status: 'bad', detail: 'Backwardation — market in panic, IV may spike further' }; }
  else { flags.termStructure = { label: 'VIX term structure', value: `Normal (+${(vix3mValue - vixValue).toFixed(1)} spread)`, status: 'good', detail: `Contango — VIX3M ${vix3mValue.toFixed(1)} > VIX ${vixValue.toFixed(1)}, favorable for selling premium` }; }

  const spxStr = `${spxChange >= 0 ? '+' : ''}${spxChange.toFixed(2)}%`;
  if (spxChange < -2.0) { score -= 25; flags.spxMove = { label: 'SPX today', value: spxStr, status: 'bad', detail: 'Sharp drop >2% — avoid BPS entries' }; }
  else if (spxChange < -1.0) { score -= 12; flags.spxMove = { label: 'SPX today', value: spxStr, status: 'warn', detail: 'Moderate drop — wait for stabilization' }; }
  else if (spxChange > 2.0) { score -= 5; flags.spxMove = { label: 'SPX today', value: spxStr, status: 'good', detail: 'Strong up day — BPS entries favorable' }; }
  else { flags.spxMove = { label: 'SPX today', value: spxStr, status: 'good', detail: 'Stable — normal conditions for new entries' }; }

  const isFomcDay = FOMC_DATES_2026.includes(todayStr);
  const nextFomc = FOMC_DATES_2026.find(d => d >= todayStr);
  const daysToFomc = nextFomc ? Math.round((new Date(Date.UTC(...(nextFomc.split('-').map(Number)) as [number,number,number])).getTime() - now.getTime()) / 86400000) : 999;
  if (isFomcDay) { score -= 25; flags.fomc = { label: 'FOMC', value: 'Today · 2:00 PM ET', status: 'bad', detail: 'FOMC announcement day — no new positions' }; }
  else if (daysToFomc <= 3) { score -= 12; flags.fomc = { label: 'FOMC', value: `In ${daysToFomc}d (${nextFomc})`, status: 'warn', detail: 'FOMC this week — defer new entries until after announcement' }; }
  else { flags.fomc = { label: 'FOMC', value: nextFomc ? `Next: ${nextFomc}` : 'None scheduled', status: 'good', detail: 'No FOMC risk this week' }; }

  const month = now.getMonth(), year = now.getFullYear();
  const thirdFriday = new Date(year, month, 1 + ((5 - new Date(year, month, 1).getDay() + 7) % 7) + 14);
  const daysToExp = Math.round((thirdFriday.getTime() - now.getTime()) / 86400000);
  if (daysToExp === 0) { score -= 20; flags.expirationWeek = { label: 'Expiration', value: 'Today (monthly)', status: 'bad', detail: 'Monthly expiration day — extreme gamma, avoid all new positions' }; }
  else if (daysToExp >= 0 && daysToExp <= 5) { score -= 10; flags.expirationWeek = { label: 'Expiration', value: `Monthly exp in ${daysToExp}d`, status: 'warn', detail: 'Expiration week — gamma elevated, prefer closing over opening' }; }
  else { flags.expirationWeek = { label: 'Expiration', value: `Next monthly: ${daysToExp}d`, status: 'good', detail: 'Not expiration week — normal conditions' }; }

  flags.earnings = { label: 'Watchlist earnings', value: 'Check manually', status: 'good', detail: 'Verify no earnings within your DTE window on open positions' };

  score = Math.max(0, Math.min(100, Math.round(score)));
  if (trendContext?.primeSetup) score = Math.min(100, score + 15);

  let signal: MarketConditions['signal']; let signalDetail: string;
  if (trendContext?.primeSetup && score >= 70) { signal = 'PRIME SETUP'; signalDetail = `${trendContext.trendLabel} · VIX ${vixValue.toFixed(1)} elevated · maximum BPS entry conditions`; }
  else if (score >= 75) { signal = 'TRADE TODAY'; signalDetail = `All systems green · optimal window for new entries${esFutures ? ` · ${esFutures.biasLabel} bias` : ''}${trendContext?.recoverySetup ? ' · Recovery setup' : ''}`; }
  else if (score >= 55) { signal = 'MANAGE ONLY'; signalDetail = vixValue < 16 ? 'Low IV — close winners, wait for better premium' : 'Manage existing positions, cautious on new entries'; }
  else if (score >= 35) { signal = 'CAUTION'; signalDetail = `${Object.values(flags).filter(f => f.status !== 'good').length} flags active · manage urgent positions only`; }
  else { signal = 'WAIT TODAY'; signalDetail = 'High-risk environment · no new positions, only stop-loss closes if needed'; }

  return { score, signal, signalDetail, flags, esFutures, trendContext, fiftyPctPositions: [] };
}

function MarketConditionsPanel({ mc, th, loading }: { mc: MarketConditions | null; th: typeof THEMES[Theme]; loading: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const signalStyles = {
    'PRIME SETUP': { bg: 'bg-yellow-500/10',  border: 'border-yellow-500/60',  text: 'text-yellow-300',  ring: 'border-yellow-400',  score: 'text-yellow-300',  detail: 'text-yellow-300/70' },
    'TRADE TODAY': { bg: 'bg-emerald-500/10', border: 'border-emerald-600/50', text: 'text-emerald-400', ring: 'border-emerald-500', score: 'text-emerald-400', detail: 'text-emerald-400/70' },
    'MANAGE ONLY': { bg: 'bg-blue-500/10',    border: 'border-blue-600/50',    text: 'text-blue-400',    ring: 'border-blue-500',    score: 'text-blue-400',    detail: 'text-blue-400/70' },
    'CAUTION':     { bg: 'bg-amber-500/10',   border: 'border-amber-600/50',   text: 'text-amber-400',   ring: 'border-amber-500',   score: 'text-amber-400',   detail: 'text-amber-400/70' },
    'WAIT TODAY':  { bg: 'bg-red-500/10',     border: 'border-red-600/50',     text: 'text-red-400',     ring: 'border-red-500',     score: 'text-red-400',     detail: 'text-red-400/70' },
  };
  const flagColors = {
    good: { pill: 'bg-emerald-500/15 text-emerald-400 border-emerald-700', dot: 'bg-emerald-500' },
    warn: { pill: 'bg-amber-500/15 text-amber-400 border-amber-700',       dot: 'bg-amber-500'   },
    bad:  { pill: 'bg-red-500/15 text-red-400 border-red-700',             dot: 'bg-red-500'     },
  };
  const signal = mc?.signal ?? 'TRADE TODAY';
  const ss = signalStyles[signal];
  const flagGroups = mc ? [
    { section: 'TIME & SESSION',       items: [mc.flags.dayOfWeek, mc.flags.timeOfDay] },
    { section: 'FUTURES & VOLATILITY', items: [mc.flags.esFutures, mc.flags.vix, mc.flags.termStructure, mc.flags.spxMove] },
    { section: 'CALENDAR RISK',        items: [mc.flags.fomc, mc.flags.expirationWeek, mc.flags.earnings] },
  ] : [];
  const flagCount = mc ? Object.values(mc.flags).filter(f => f.status !== 'good').length : 0;

  return (
    <div className={`border ${ss.border} ${ss.bg} rounded-xl overflow-hidden`}>
      <button onClick={() => setExpanded(!expanded)} className="w-full text-left">
        <div className="flex items-center gap-4 px-4 py-3">
          {loading ? (
            <div className="w-12 h-12 rounded-full border-2 border-slate-600 flex items-center justify-center shrink-0">
              <div className="w-4 h-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : mc ? (
            <div className={`w-12 h-12 rounded-full border-2 ${ss.ring} flex flex-col items-center justify-center shrink-0`}>
              <span className={`text-base font-bold leading-none ${ss.score}`}>{mc.score}</span>
              <span className={`text-[8px] ${ss.detail}`}>/100</span>
            </div>
          ) : null}
          <div className="flex-1 min-w-0">
            {loading ? <p className={`text-xs font-bold ${th.textFaint} tracking-widest`}>ANALYZING MARKET CONDITIONS...</p>
              : mc ? (<><p className={`text-sm font-bold tracking-widest ${ss.text}`}>{mc.signal}</p><p className={`text-[10px] ${ss.detail} mt-0.5`}>{mc.signalDetail}</p></>) : null}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {mc && flagCount > 0 && (
              <span className={`text-[9px] px-2 py-0.5 border rounded font-medium ${signal === 'WAIT TODAY' ? 'border-red-700 text-red-400 bg-red-500/10' : signal === 'CAUTION' ? 'border-amber-700 text-amber-400 bg-amber-500/10' : 'border-blue-700 text-blue-400 bg-blue-500/10'}`}>
                {flagCount} flag{flagCount !== 1 ? 's' : ''}
              </span>
            )}
            {mc && <span className={`text-[10px] ${th.textFaint}`}>{expanded ? '▲' : '▼'}</span>}
          </div>
        </div>
      </button>

      {expanded && mc && (
        <div className={`border-t ${th.border}`}>
          {mc.signal === 'PRIME SETUP' && mc.trendContext && (
            <div className="flex items-center gap-3 px-4 py-3 bg-yellow-500/10 border-b border-yellow-500/30">
              <span className="text-yellow-300 text-base shrink-0">★</span>
              <div className="flex-1">
                <p className="text-xs font-bold text-yellow-300 tracking-wider">PRIME SETUP DETECTED</p>
                <p className="text-[10px] text-yellow-300/70 mt-0.5">{mc.trendContext.trendLabel} · VIX elevated · fat premium + bullish reversal = maximum BPS entry conditions</p>
                {mc.trendContext.reversalAnchorPrice && <p className="text-[9px] text-yellow-300/60 mt-0.5">Reversal anchor: ~{mc.trendContext.reversalAnchorPrice.toFixed(0)} — BPS short put strike should be below this level</p>}
              </div>
            </div>
          )}
          {mc.trendContext && mc.signal !== 'PRIME SETUP' && (
            <div className={`flex items-center gap-4 px-4 py-2 border-b ${th.border} ${th.sidebar}`}>
              <span className={`text-[9px] font-bold tracking-widest shrink-0 ${mc.trendContext.currentVsSma === 'just_crossed_above' ? 'text-emerald-400' : mc.trendContext.currentVsSma === 'just_crossed_below' ? 'text-red-400' : mc.trendContext.currentVsSma === 'above' ? 'text-emerald-400/70' : 'text-red-400/70'}`}>ES=F TREND</span>
              <span className={`text-[9px] ${th.textFaint} flex-1`}>{mc.trendContext.trendLabel}</span>
              {mc.trendContext.recoverySetup && <span className="text-[9px] font-bold text-emerald-400 border border-emerald-700 bg-emerald-500/10 px-2 py-0.5 rounded shrink-0">↑ RECOVERY SETUP</span>}
            </div>
          )}
          <div className="grid grid-cols-3 divide-x divide-inherit">
            {flagGroups.map(group => (
              <div key={group.section} className={`divide-y ${th.border}`}>
                <p className={`text-[8px] ${th.textFaint} tracking-widest px-3 py-1.5 font-bold uppercase ${th.sidebar}`}>{group.section}</p>
                {group.items.map((flag, i) => (
                  <div key={i} className="flex items-start gap-2 px-3 py-2">
                    <div className={`w-1.5 h-1.5 rounded-full mt-1 shrink-0 ${flagColors[flag.status].dot}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1 mb-0.5">
                        <p className={`text-[9px] ${th.textFaint} truncate`}>{flag.label}</p>
                        <span className={`text-[8px] px-1.5 py-0.5 border rounded shrink-0 font-medium ${flagColors[flag.status].pill}`}>{flag.status === 'good' ? '✓' : flag.status === 'warn' ? '⚠' : '✗'}</span>
                      </div>
                      <p className={`text-[10px] font-medium ${th.textMuted} truncate`}>{flag.value}</p>
                      <p className={`text-[9px] ${th.textFaint} leading-tight mt-0.5`}>{flag.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {mc.esFutures && (
            <div className={`border-t ${th.border} px-4 py-2.5 flex items-center gap-4 ${th.sidebar}`}>
              <span className={`text-[9px] font-bold tracking-widest shrink-0 ${mc.esFutures.bias === 'bullish' ? 'text-emerald-400' : mc.esFutures.bias === 'bearish' ? 'text-red-400' : 'text-blue-400'}`}>
                {mc.esFutures.bias === 'bullish' ? '↑ BULLISH BIAS' : mc.esFutures.bias === 'bearish' ? '↓ BEARISH BIAS' : '↔ NEUTRAL BIAS'}
              </span>
              <span className={`text-[9px] px-2 py-0.5 border rounded font-bold shrink-0 ${mc.esFutures.bias === 'bullish' ? 'border-emerald-700 text-emerald-400 bg-emerald-500/10' : mc.esFutures.bias === 'bearish' ? 'border-red-700 text-red-400 bg-red-500/10' : 'border-blue-700 text-blue-400 bg-blue-500/10'}`}>{mc.esFutures.biasLabel}</span>
              <span className={`text-[9px] ${th.textFaint} flex-1`}>{mc.esFutures.strikeAnchorNote}</span>
              {mc.esFutures.settling && <span className="text-[9px] font-bold text-amber-400 border border-amber-700 bg-amber-500/10 px-2 py-0.5 rounded shrink-0">⏳ WAIT FOR SETTLE</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NavCard({ href, label, icon, desc, th }: { href: string; label: string; icon: string; desc: string; th: typeof THEMES[Theme] }) {
  return (
    <Link href={href} className={`block border ${th.border} ${th.card} rounded-xl px-4 py-3 hover:border-[var(--accent)] transition-colors group`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-base">{icon}</span>
        <span className={`text-xs font-bold tracking-widest ${th.text} group-hover:text-[var(--accent)] transition-colors`}>{label}</span>
      </div>
      <p className={`text-[10px] ${th.textFaint}`}>{desc}</p>
    </Link>
  );
}

export default function HomePage() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [accent, setAccent] = useState<Accent>('electric');
  const [mc, setMc] = useState<MarketConditions | null>(null);
  const [mcLoading, setMcLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const th = THEMES[theme];

  useEffect(() => {
    const t = getSavedTheme(); setTheme(t);
    const a = getSavedAccent(); setAccent(a); applyAccent(a);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setMcLoading(true);
      try {
        const result = await loadMarketConditions();
        if (!cancelled) {
          setMc(result);
          setLastUpdated(new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' ET');
        }
      } catch { if (!cancelled) setMc(null); }
      finally { if (!cancelled) setMcLoading(false); }
    }
    load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  return (
    <div className={`min-h-screen ${th.bg} transition-colors duration-200`} style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div className={`${th.header} border-b ${th.border} px-6 pb-0 pt-4 flex flex-col sticky top-0 z-50`}>
        <div className="flex items-center justify-between w-full pb-3">
          <div className="flex items-center gap-3">
            <svg width="36" height="36" viewBox="-26 -26 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
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
            {lastUpdated && <span className={`text-[9px] ${th.textFaint}`}>Updated {lastUpdated}</span>}
            <div className="flex items-center gap-1 mr-1">
              {(Object.entries(ACCENTS) as [Accent, typeof ACCENTS[Accent]][]).map(([key, val]) => (
                <button key={key} onClick={() => { setAccent(key); applyAccent(key); try { localStorage.setItem(LS_ACCENT, key); } catch {} }}
                  title={val.label}
                  className={`w-3.5 h-3.5 rounded-full transition-all ${accent === key ? 'ring-2 ring-white/60 ring-offset-1 ring-offset-black scale-125' : 'opacity-60 hover:opacity-100'}`}
                  style={{ backgroundColor: val.hex }} />
              ))}
            </div>
            <div className="w-px h-4 bg-white/20" />
            {(['dark','medium','light'] as Theme[]).map(t => (
              <button key={t} onClick={() => { setTheme(t); try { localStorage.setItem(LS_THEME, t); } catch {} }}
                className={`text-[9px] px-2 py-1 border rounded transition-colors ${theme === t ? 'border-[var(--accent)] text-[var(--accent)] bg-[rgba(var(--accent-r),var(--accent-g),var(--accent-b),0.1)]' : `${th.border} ${th.textFaint}`}`}>
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-0 w-full border-t border-white/10">
          <span className="text-[10px] font-bold px-3 py-2 tracking-wider" style={{ color: '#00d4aa', borderBottom: '2px solid #00d4aa' }}>HOME</span>
          <Link href="/portfolio"    className={`text-[10px] font-bold px-3 py-2 text-white/55 hover:text-white/80 transition-colors tracking-wider`}>PORTFOLIO</Link>
          <Link href="/screener"     className={`text-[10px] font-bold px-3 py-2 text-white/55 hover:text-white/80 transition-colors tracking-wider`}>SCREENER</Link>
          <Link href="/engine"       className={`text-[10px] font-bold px-3 py-2 text-white/55 hover:text-white/80 transition-colors tracking-wider`}>INCOME ENGINE</Link>
          <Link href="/rinse-repeat" className={`text-[10px] font-bold px-3 py-2 text-white/55 hover:text-white/80 transition-colors tracking-wider`}>REPEAT STRATEGIES</Link>
          <Link href="/trade-log"    className={`text-[10px] font-bold px-3 py-2 text-white/55 hover:text-white/80 transition-colors tracking-wider`}>TRADE LOG</Link>
          <Link href="/performance"  className={`text-[10px] font-bold px-3 py-2 text-white/55 hover:text-white/80 transition-colors tracking-wider`}>PERFORMANCE</Link>
          <Link href="/help"         className={`text-[10px] font-bold px-3 py-2 text-white/55 hover:text-white/80 transition-colors tracking-wider`}>HELP</Link>
        </div>
      </div>

      <div className="px-6 py-6 max-w-5xl mx-auto space-y-6">
        <MarketConditionsPanel mc={mc} th={th} loading={mcLoading} />
        <div>
          <p className={`text-[9px] font-bold tracking-widest ${th.textFaint} uppercase mb-3`}>Quick Access</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <NavCard href="/portfolio"    label="PORTFOLIO"         icon="📊" desc="Live positions, Greeks, action buttons"          th={th} />
            <NavCard href="/screener"     label="SCREENER"          icon="🔍" desc="Scan tickers for BPS, BCS, IC setups"            th={th} />
            <NavCard href="/engine"       label="INCOME ENGINE"     icon="⚡" desc="SPX spread suggestions and capital allocation"   th={th} />
            <NavCard href="/rinse-repeat" label="REPEAT STRATEGIES" icon="🔄" desc="Re-screen past winners and track cycles"         th={th} />
            <NavCard href="/trade-log"    label="TRADE LOG"         icon="📋" desc="Closed trade history and P&L analysis"           th={th} />
            <NavCard href="/performance"  label="PERFORMANCE"       icon="📈" desc="Monthly P&L charts and win rate stats"           th={th} />
          </div>
        </div>
      </div>
    </div>
  );
}
