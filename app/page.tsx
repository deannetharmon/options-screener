'use client';
import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { createPortal } from 'react-dom';

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
  dark: { bg: 'bg-[#0a0a0a]', sidebar: 'bg-[#0f0f0f]', card: 'bg-[#171717]', cardQualified: 'bg-[#1c1c1c]', border: 'border-[#2c2c2c]', borderLight: 'border-[#202020]', header: 'bg-[#0f0f0f]', text: 'text-white', textMuted: 'text-[#e0e0e0]', textFaint: 'text-[#808080]', input: 'bg-[#141414]', inputBorder: 'border-[#353535]', tag: 'bg-[#222222]', label: 'text-[#aaaaaa]' },
  medium: { bg: 'bg-[#141414]', sidebar: 'bg-[#1a1a1a]', card: 'bg-[#202020]', cardQualified: 'bg-[#252525]', border: 'border-[#333333]', borderLight: 'border-[#282828]', header: 'bg-[#1a1a1a]', text: 'text-white', textMuted: 'text-[#d8d8d8]', textFaint: 'text-[#777777]', input: 'bg-[#1e1e1e]', inputBorder: 'border-[#3a3a3a]', tag: 'bg-[#2a2a2a]', label: 'text-[#999999]' },
  light: { bg: 'bg-[#f5f5f5]', sidebar: 'bg-white', card: 'bg-white', cardQualified: 'bg-white', border: 'border-[#e0e0e0]', borderLight: 'border-[#ebebeb]', header: 'bg-[#111111]', text: 'text-[#111111]', textMuted: 'text-[#1a1a1a]', textFaint: 'text-[#666666]', input: 'bg-white', inputBorder: 'border-[#cccccc]', tag: 'bg-[#f0f0f0]', label: 'text-[#444444]' },
};

// ── Types ──────────────────────────────────────────────────────────────────
interface CheckResult { status: 'pass' | 'fail' | 'warn' | 'pending'; value: string; reason: string; }
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
  strategy: 'BPS' | 'BCS' | 'IC' | 'NO_TRADE';
  subtype: 'CONTINUATION' | 'REVERSAL' | 'RANGE' | 'CHOP' | 'UNKNOWN';
  confidence: number; // 0-100
  ma20: number;
  ma50: number;
  ma200?: number;
  reason: string;
  scores?: {
    momentum: number;
    maAlignment: number;
    slope: number;
    structure: number;
    chop: number;
    volatility: number;
    total: number;
  };
  metrics?: {
    price: number;
    ma20: number;
    ma50: number;
    ma200: number;
    momentum20: number;
    momentum60: number;
    momentum90: number;
    ma20Slope: number;
    ma50Slope: number;
    range60: number;
    chopRatio: number;
    distFromMa50: number;
    higherHighs: boolean;
    higherLows: boolean;
    lowerHighs: boolean;
    lowerLows: boolean;
  };
}
interface AutoTrendEntry {
  symbol: string;
  result: TrendResult;
}

interface ScreenResult {
  symbol: string; strategy: string; price: number | null; ivr: number | null;
  qualified: boolean; bestCandidate: SpreadCandidate | null;
  failReasons: string[]; earningsDate?: string | null; trendResult?: TrendResult;
  isEtf?: boolean;
  ruleSetApplied?: string;
  checks: { ivr: CheckResult; earnings: CheckResult; oi: CheckResult; delta: CheckResult; credit: CheckResult; roc: CheckResult; pop: CheckResult; };
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

// ── Helper Functions ───────────────────────────────────────────────────────
function daysUntil(dateStr: string): number {
  const target = new Date(dateStr);
  const now = new Date();
  return Math.round((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}


function getSavedTheme(): Theme {
  try { const t = localStorage.getItem(LS_THEME); return (t === 'dark' || t === 'medium' || t === 'light') ? t as Theme : 'dark'; }
  catch { return 'dark'; }
}

function getWidthSteps(maxWidth: number, price: number | null): number[] {
  // Always start at $5 so high-priced ETFs/indexes can find narrow spreads with viable credit ratios.
  // Step size scales with price to keep iteration count reasonable.
  // e.g. SPY $739: steps $5, $10, $15... up to maxWidth
  //      SPX $7412: steps $25, $50... up to maxWidth (price>=2000 uses $25 steps)
  const stepSize = price == null ? 5 : price >= 2000 ? 25 : price >= 500 ? 5 : price >= 200 ? 5 : 5;
  const steps: number[] = [];
  for (let w = stepSize; w <= maxWidth; w += stepSize) steps.push(w);
  return steps;
}

function getBidAskMax(price: number | null): number {
  if (price == null) return 1.50;
  if (price >= 500) return 3.00;
  if (price >= 200) return 1.50;
  if (price >= 100) return 0.50;
  return 0.10;
}

function addBusinessDays(dateStr: string, days: number): Date {
  const date = new Date(dateStr);
  let added = 0;
  while (added < days) {
    date.setDate(date.getDate() + 1);
    const dow = date.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return date;
}

function formatCalDate(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

function buildEarningsCalUrl(symbol: string, strategy: string, earningsDate: string, ivr: number | null): string {
  const followUp = addBusinessDays(earningsDate, 2);
  const end = new Date(followUp); end.setDate(end.getDate() + 1);
  const title = encodeURIComponent(`Re-screen ${symbol}`);
  const details = encodeURIComponent(`Re-screen after earnings`);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${formatCalDate(followUp)}/${formatCalDate(end)}&details=${details}`;
}

function buildEntryCalUrl(result: ScreenResult, businessDays: number, directDate?: Date): string {
  const followUp = directDate ?? addBusinessDays(new Date().toISOString().split('T')[0], businessDays);
  const end = new Date(followUp); end.setDate(end.getDate() + 1);
  const title = encodeURIComponent(`Enter ${result.symbol}`);
  const details = encodeURIComponent(`Re-screen & enter ${result.symbol} — ${result.strategy} ${result.bestCandidate?.shortStrike}/${result.bestCandidate?.longStrike}`);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${formatCalDate(followUp)}/${formatCalDate(end)}&details=${details}`;
}

// OCR + merge helpers
const OCR_TICKER_BLACKLIST = new Set([
  // Common Finviz / UI / financial-label fragments that OCR mistakes for tickers
  'USA','ETF','CEO','IPO','NYSE','NASDAQ','OTC','ADR','INC','LLC','LTD','PLC','THE','AND','FOR','REQ',
  'BPS','BCS','IC','PUT','CALL','OTM','ITM','ATM','IVR','DTE','ROC','POP','GTC','OCO',
  'AI','AN','IS','IT','AT','OR','AS','BY','IN','ON','TO','OF','NO','ANY','ALL',
  'EPS','TTM','EV','LT','TA','SMA','RSI','PEG','PE','PB','PS',
  'BETA','AVG','PRICE','VOLUME','FLOAT','GAP','NEWS','BASIC','CUSTOM','FILTER','SIGNAL','TICKERS',
  // Single characters — never a valid US ticker
  'A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
  // Common 2-char OCR noise from vertical ticker list misreads
  'EL','ME','AL','LE','RE','DE','VE','TE','SE','CE','FE','HE','BE','KE','NE','PE','WE',
  'LI','TI','VI','GI','DI','RI','FI','MI','NI','PI','SI','HI','BI','KI',
  'LO','DO','GO','HO','KO','MO','PO','SO','TO','VO','WO','YO',
  'IL','IM','IP','IR','IX',
  // Other common noise tokens
  'EW','RN','TT','LL','MM','NN','RR','SS','TH','WH','CH','SH','PH',
]);

function normalizeTickerToken(raw: string): string | null {
  const token = raw.trim().toUpperCase().replace(/[–—]/g, '-').replace(/\.$/, '');
  if (!token) return null;

  // Yahoo Finance uses hyphen for Berkshire class B.
  const normalized = token.replace('.', '-');
  if (normalized === 'BRK-B' || normalized === 'BRK/B') return 'BRK-B';

  // Basic US ticker shape: 2–5 letters, optional class suffix e.g. BRK-B, BF-B.
  // Minimum 2 characters — single letters are never valid tickers in this context.
  if (!/^[A-Z]{2,5}(-[A-Z])?$/.test(normalized)) return null;
  if (OCR_TICKER_BLACKLIST.has(normalized)) return null;
  return normalized;
}

function normalizeTickerInput(input: string): string[] {
  const cleaned = input
    .toUpperCase()
    .replace(/[–—]/g, '-')
    .replace(/\bBRK\s*[-.]?\s*B\b/g, 'BRK-B')
    .replace(/\bBF\s*[-.]?\s*B\b/g, 'BF-B');

  return Array.from(new Set(
    cleaned
      .split(/[,\s]+/)
      .map(normalizeTickerToken)
      .filter((t): t is string => Boolean(t))
  ));
}

async function extractTickersFromImage(file: File): Promise<string[]> {
  // Convert file to base64
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });

  const mediaType = file.type || 'image/png';

  const response = await fetch('/api/ocr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64, mediaType }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error ?? `OCR request failed: ${response.status}`);
  }

  const data = await response.json();
  const rawText: string = data?.text ?? '';

  const tickers: string[] = [];
  for (const line of rawText.split('\n')) {
    const ticker = normalizeTickerToken(line.trim());
    if (ticker) tickers.push(ticker);
  }

  return Array.from(new Set(tickers));
}

function mergeTickers(existing: string, newTickers: string[]): string {
  const existingList = normalizeTickerInput(existing);
  const normalizedNew = newTickers.map(normalizeTickerToken).filter((t): t is string => Boolean(t));
  const existingSet = new Set(existingList);
  const toAdd = normalizedNew.filter(t => !existingSet.has(t));
  return [...existingList, ...toAdd].join(', ');
}

function tickersToString(tickers: string[]): string { return tickers.join(', '); }

function generateSuggestions(results: ScreenResult[], rules: RulesType): FilterSuggestion[] {
  const suggestions: FilterSuggestion[] = [];
  const disqualified = results.filter(r => !r.qualified);
  if (disqualified.length === 0) return [];

  // Count how many fail each specific rule (excluding earnings which is a hard gate)
  const failedCredit = disqualified.filter(r => r.failReasons.some(f => f.includes('Credit') || f.includes('credit'))).length;
  const failedOI = disqualified.filter(r => r.failReasons.some(f => f.includes('OI') || f.includes('qualifying strikes'))).length;
  const failedROC = disqualified.filter(r => r.failReasons.some(f => f.includes('ROC') || f.includes('roc'))).length;
  const failedIVR = disqualified.filter(r => r.failReasons.some(f => f.includes('IVR'))).length;

  // Credit ratio suggestion
  if (failedCredit > 0 && rules.CREDIT_RATIO_MIN > 0.20) {
    const relaxed = rules.CREDIT_RATIO_MIN === 0.33 ? 0.25 : 0.20;
    suggestions.push({
      priority: 1,
      rule: 'CREDIT_RATIO_MIN',
      currentValue: rules.CREDIT_RATIO_MIN,
      suggestedValue: relaxed,
      label: `Relax credit ratio to ${(relaxed * 100).toFixed(0)}% of width`,
      rationale: `${failedCredit} stock${failedCredit !== 1 ? 's' : ''} failed credit minimum. Current premium environment is thin — ${(relaxed * 100).toFixed(0)}% is the ${relaxed === 0.25 ? 'professional floor' : 'absolute minimum'}.`,
      tradeoff: relaxed === 0.25 ? 'Slightly less cushion but mathematically sound. Still profitable if POP holds.' : 'Risk/reward becomes marginal. Only use in high IVR environments.',
      wouldQualify: failedCredit,
    });
  }

  // OI suggestion
  if (failedOI > 0 && rules.OI_MIN > 200) {
    const relaxed = rules.OI_MIN === 500 ? 300 : 200;
    suggestions.push({
      priority: 2,
      rule: 'OI_MIN',
      currentValue: rules.OI_MIN,
      suggestedValue: relaxed,
      label: `Relax OI minimum to ${relaxed}`,
      rationale: `${failedOI} stock${failedOI !== 1 ? 's' : ''} failed OI check. Lower OI means wider bid-ask fills — acceptable for smaller position sizes.`,
      tradeoff: 'Wider bid-ask spreads on entry/exit. Keep position size to 1 contract until liquidity improves.',
      wouldQualify: failedOI,
    });
  }

  // ROC suggestion
  if (failedROC > 0 && rules.ROC_MIN_SPREAD > 15) {
    const relaxed = Math.max(15, rules.ROC_MIN_SPREAD - 5);
    suggestions.push({
      priority: 3,
      rule: 'ROC_MIN_SPREAD',
      currentValue: rules.ROC_MIN_SPREAD,
      suggestedValue: relaxed,
      label: `Relax min ROC to ${relaxed}%`,
      rationale: `${failedROC} stock${failedROC !== 1 ? 's' : ''} failed ROC minimum. Current market conditions compress returns.`,
      tradeoff: 'Lower return per dollar at risk. Only worthwhile if POP is high (70%+).',
      wouldQualify: failedROC,
    });
  }

  // IVR suggestion
  if (failedIVR > 0 && rules.IVR_MIN > 20) {
    const relaxed = Math.max(20, rules.IVR_MIN - 5);
    suggestions.push({
      priority: 4,
      rule: 'IVR_MIN',
      currentValue: rules.IVR_MIN,
      suggestedValue: relaxed,
      label: `Relax IVR floor to ${relaxed}%`,
      rationale: `${failedIVR} stock${failedIVR !== 1 ? 's' : ''} failed IVR minimum. Low IV environment — less premium available across the board.`,
      tradeoff: 'Selling premium when IV is low means less cushion and smaller credits. Use smaller position sizes.',
      wouldQualify: failedIVR,
    });
  }

  return suggestions.sort((a, b) => a.priority - b.priority);
}

// ── Persistent Saved Filters (LocalStorage + API fallback) ─────────────────
async function loadFilters(strategy: string): Promise<SavedFilters | GlobalFilters> {
  const lsKey = strategy === 'global' ? LS_GLOBAL_SESSIONS : LS_SAVED_FILTERS;
  try {
    const saved = localStorage.getItem(lsKey);
    if (saved) return JSON.parse(saved);
  } catch {}
  try {
    const res = await fetch(`/api/filters?strategy=${strategy}`);
    const data = await res.json();
    const filters = data.filters ?? {};
    localStorage.setItem(lsKey, JSON.stringify(filters));
    return filters;
  } catch {
    return {};
  }
}

async function saveFilter(
  strategy: string,
  name: string,
  payload: { tickers?: string[]; bps?: string[]; bcs?: string[]; ic?: string[] },
  replace = false
): Promise<{ success?: boolean; conflict?: boolean; message?: string }> {
  const lsKey = strategy === 'global' ? LS_GLOBAL_SESSIONS : LS_SAVED_FILTERS;
  try {
    const res = await fetch('/api/filters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy, name, replace, ...payload })
    });
    const result = await res.json();
    if (result.success) {
      const current = await loadFilters(strategy) as any;
      if (strategy === 'global') {
        current[name] = { bps: payload.bps || [], bcs: payload.bcs || [], ic: payload.ic || [] };
      } else {
        current[name] = payload.tickers || [];
      }
      localStorage.setItem(lsKey, JSON.stringify(current));
    }
    return result;
  } catch {
    try {
      const current = await loadFilters(strategy) as any;
      if (strategy === 'global') {
        current[name] = { bps: payload.bps || [], bcs: payload.bcs || [], ic: payload.ic || [] };
      } else {
        current[name] = payload.tickers || [];
      }
      localStorage.setItem(lsKey, JSON.stringify(current));
      return { success: true };
    } catch (e) {
      return { success: false, message: 'Failed to save' };
    }
  }
}

async function deleteFilter(strategy: string, name: string): Promise<void> {
  const lsKey = strategy === 'global' ? LS_GLOBAL_SESSIONS : LS_SAVED_FILTERS;
  try {
    await fetch('/api/filters', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy, name })
    });
  } catch {}
  try {
    const current = await loadFilters(strategy);
    delete current[name];
    localStorage.setItem(lsKey, JSON.stringify(current));
  } catch {}
}

// ── Index / ETF overrides ──────────────────────────────────────────────────
const INDEX_TICKERS = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'GLD', 'SLV', 'TLT', 'HYG', 'LQD', 'XLF', 'XLK', 'XLE', 'XLV', 'XLI', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'XLY', 'EEM', 'EFA', 'VXX', 'UVXY', 'ARKK', 'SMH', 'SOXX', 'XBI', 'IBB', 'GDX']);
const INDEX_IVR_MIN = 15;

// ── Rules ──────────────────────────────────────────────────────────────────
// CHANGE 1: Added EARNINGS_BUFFER_DAYS and CREDIT_MIN_ABS
const DEFAULT_RULES = {
  IVR_MIN: 30, IVR_IC_MAX: 70, OI_MIN: 500, BID_ASK_MAX: 0.10,
  CREDIT_RATIO_MIN: 0.33, SPREAD_DELTA_MIN: 0.20, SPREAD_DELTA_MAX: 0.30,
  IC_DELTA_MIN: 0.16, IC_DELTA_MAX: 0.20, DTE_MIN: 30, DTE_MAX: 45,
  MAX_SPREAD_WIDTH: 100, ROC_MIN_SPREAD: 20, ROC_MIN_IC: 30, POP_MIN: 65,
};
type RulesType = typeof DEFAULT_RULES;

const RULE_PRESETS = [
  { key: 'course',    label: 'Course',     desc: 'Exact course rules',             color: 'border-blue-600 text-blue-400 bg-blue-600/10',        rules: { IVR_MIN: 30, OI_MIN: 500, BID_ASK_MAX: 0.10, CREDIT_RATIO_MIN: 0.33, ROC_MIN_SPREAD: 20, ROC_MIN_IC: 30 } },
  { key: 'relaxed',   label: 'Relaxed',    desc: 'Wider net, still disciplined',   color: 'border-emerald-600 text-emerald-400 bg-emerald-600/10', rules: { IVR_MIN: 25, OI_MIN: 300, BID_ASK_MAX: 0.15, CREDIT_RATIO_MIN: 0.28, ROC_MIN_SPREAD: 15, ROC_MIN_IC: 25 } },
  { key: 'lowvol',    label: 'Low Vol',    desc: 'Crushed IV environments',        color: 'border-yellow-600 text-yellow-400 bg-yellow-600/10',   rules: { IVR_MIN: 20, OI_MIN: 200, BID_ASK_MAX: 0.20, CREDIT_RATIO_MIN: 0.22, ROC_MIN_SPREAD: 12, ROC_MIN_IC: 20 } },
  { key: 'strict',    label: 'Strict',     desc: 'A+ setups only',                 color: 'border-red-600 text-red-400 bg-red-600/10',            rules: { IVR_MIN: 40, OI_MIN: 500, BID_ASK_MAX: 0.10, CREDIT_RATIO_MIN: 0.35, ROC_MIN_SPREAD: 25, ROC_MIN_IC: 35 } },
  { key: 'shortterm', label: 'Short Term', desc: '14-28 DTE · active management', color: 'border-orange-500 text-orange-400 bg-orange-500/10',   rules: { IVR_MIN: 35, OI_MIN: 500, BID_ASK_MAX: 0.10, CREDIT_RATIO_MIN: 0.30, ROC_MIN_SPREAD: 15, ROC_MIN_IC: 22, DTE_MIN: 14, DTE_MAX: 28 } },
] as const;

const RULE_LABELS: Record<string, string> = {
  IVR_MIN: 'IVR Min % (floor)',
  IVR_IC_MAX: 'IVR Max % (IC only)',
  OI_MIN: 'Open Interest Min (per leg)',
  BID_ASK_MAX: 'Bid-Ask Max $ (per leg)',
  CREDIT_RATIO_MIN: 'Min Credit — % of Width  (0.33 = course · 0.25 = floor · 0.20 = danger)',
  SPREAD_DELTA_MIN: 'Spread Delta Min',
  SPREAD_DELTA_MAX: 'Spread Delta Max',
  IC_DELTA_MIN: 'IC Delta Min',
  IC_DELTA_MAX: 'IC Delta Max',
  DTE_MIN: 'DTE Min (days)',
  DTE_MAX: 'DTE Max (days)',
  MAX_SPREAD_WIDTH: 'Max Spread Width $ (optimizer cap)',
  ROC_MIN_SPREAD: 'Min ROC % (Spread)',
  ROC_MIN_IC: 'Min ROC % (IC)',
  POP_MIN: 'Min POP % (Probability of Profit)',
};

const LS_RULES = 'prosper-rules';
const LS_RULES_ETF = 'prosper-rules-etf';
const LS_RULES_PRESET = 'prosper-rules-preset';
const LS_ACTIVE_PRESET = 'prosper-active-preset';
const LS_ACTIVE_PRESET_ETF = 'prosper-active-preset-etf';
const LS_RULES_VERSION = 'prosper-rules-v3'; // bump this when defaults change

const DEFAULT_ETF_RULES: RulesType = {
  IVR_MIN: 15, IVR_IC_MAX: 70, OI_MIN: 100, BID_ASK_MAX: 0.25,
  CREDIT_RATIO_MIN: 0.20, SPREAD_DELTA_MIN: 0.15, SPREAD_DELTA_MAX: 0.35,
  IC_DELTA_MIN: 0.15, IC_DELTA_MAX: 0.25, DTE_MIN: 30, DTE_MAX: 45,
  MAX_SPREAD_WIDTH: 500, ROC_MIN_SPREAD: 15, ROC_MIN_IC: 20, POP_MIN: 65,
};

function getSavedRules(): RulesType {
  try {
    if (!localStorage.getItem(LS_RULES_VERSION)) {
      localStorage.removeItem(LS_RULES);
      localStorage.removeItem(LS_RULES_ETF);
      localStorage.setItem(LS_RULES_VERSION, '1');
    }
    const saved = localStorage.getItem(LS_RULES);
    return saved ? { ...DEFAULT_RULES, ...JSON.parse(saved) } : { ...DEFAULT_RULES };
  } catch { return { ...DEFAULT_RULES }; }
}

function getSavedEtfRules(): RulesType {
  try {
    const saved = localStorage.getItem(LS_RULES_ETF);
    return saved ? { ...DEFAULT_ETF_RULES, ...JSON.parse(saved) } : { ...DEFAULT_ETF_RULES };
  } catch { return { ...DEFAULT_ETF_RULES }; }
}

function saveRulesToStorage(rules: RulesType) {
  try { localStorage.setItem(LS_RULES, JSON.stringify(rules)); } catch {}
}

function saveEtfRulesToStorage(rules: RulesType) {
  try { localStorage.setItem(LS_RULES_ETF, JSON.stringify(rules)); } catch {}
}
const TREND_DETECTION_CONCURRENCY = 8;
const LS_BPS = 'prosper-tickers-bps';
const LS_BCS = 'prosper-tickers-bcs';
const LS_IC = 'prosper-tickers-ic';
const LS_BROKEN = 'prosper-tickers-broken';
const LS_CAL = 'prosper-cal-scheduled';
const LS_CAL_ENTRY = 'prosper-cal-entry';
const DTE_ALERT_THRESHOLD = 25;
const HUNTER_URL = 'https://options-HUNTER-dun.vercel.app';
const LS_SAVED_FILTERS = 'prosper-saved-filters';
const LS_GLOBAL_SESSIONS = 'prosper-global-sessions';
const LS_SCREEN_MODE = 'prosper-screen-mode';
const LS_RANK_CONFIG = 'prosper-rank-config';
const LS_SESSION_LOADED_AT = 'prosper-session-loaded-at';

// ── Ranking / Scoring ──────────────────────────────────────────────────────
interface RankConfig {
  weightIvr: number;       // 0–40
  weightCredit: number;    // 0–40
  weightRoc: number;       // 0–30
  weightPop: number;       // 0–20
  weightDte: number;       // 0–20
  dteSweetSpot: number;    // DTE center (default 38)
  dteRange: number;        // ± around sweet spot for full score (default 7)
  thresholdGreen: number;  // default 75
  thresholdYellow: number; // default 55
  thresholdOrange: number; // default 35
}

const DEFAULT_RANK_CONFIG: RankConfig = {
  weightIvr: 25, weightCredit: 25, weightRoc: 20, weightPop: 15, weightDte: 15,
  dteSweetSpot: 38, dteRange: 7,
  thresholdGreen: 75, thresholdYellow: 55, thresholdOrange: 35,
};

function getSavedRankConfig(): RankConfig {
  try { const s = localStorage.getItem(LS_RANK_CONFIG); return s ? { ...DEFAULT_RANK_CONFIG, ...JSON.parse(s) } : { ...DEFAULT_RANK_CONFIG }; }
  catch { return { ...DEFAULT_RANK_CONFIG }; }
}

interface DimensionScore {
  ivr: number; credit: number; roc: number; pop: number; dte: number; total: number;
}

function scoreCandidate(result: ScreenResult, cfg: RankConfig): { score: number; dims: DimensionScore } | null {
  const c = result.bestCandidate;
  if (!c) return null;
  const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

  // IVR — curves up, peaks ~65, slightly penalizes >80 (earnings risk territory)
  const ivr = result.ivr ?? 0;
  const ivrRaw = ivr <= 65 ? ivr / 65 : 1 - (ivr - 65) / 100;
  const ivrScore = clamp(ivrRaw) * cfg.weightIvr;

  // Credit ratio — linear from 0.20 (min) to 0.50 (max)
  const creditRaw = (c.creditRatio - 0.20) / 0.30;
  const creditScore = clamp(creditRaw) * cfg.weightCredit;

  // ROC — logarithmic, diminishing returns above 50%
  const rocRaw = Math.log(1 + c.roc / 50) / Math.log(2);
  const rocScore = clamp(rocRaw) * cfg.weightRoc;

  // POP — bell curve, peaks at 72%, drops above 85% (strike too tight)
  const pop = c.pop ?? 70;
  const popRaw = pop <= 72 ? (pop - 55) / 17 : 1 - (pop - 72) / 30;
  const popScore = clamp(popRaw) * cfg.weightPop;

  // DTE — bell curve centered on sweet spot
  const dteDiff = Math.abs(c.dte - cfg.dteSweetSpot);
  const dteRaw = dteDiff <= cfg.dteRange ? 1 : 1 - (dteDiff - cfg.dteRange) / 15;
  const dteScore = clamp(dteRaw) * cfg.weightDte;

  const total = Math.round(ivrScore + creditScore + rocScore + popScore + dteScore);
  return {
    score: total,
    dims: {
      ivr: Math.round(ivrScore),
      credit: Math.round(creditScore),
      roc: Math.round(rocScore),
      pop: Math.round(popScore),
      dte: Math.round(dteScore),
      total,
    },
  };
}

function trafficLight(score: number, cfg: RankConfig): { emoji: string; label: string; color: string; border: string; bg: string } {
  if (score >= cfg.thresholdGreen)  return { emoji: '🟢', label: 'Strong',     color: 'text-emerald-400', border: 'border-emerald-600', bg: 'bg-emerald-500/10' };
  if (score >= cfg.thresholdYellow) return { emoji: '🟡', label: 'Acceptable', color: 'text-yellow-400',  border: 'border-yellow-600',  bg: 'bg-yellow-500/10'  };
  if (score >= cfg.thresholdOrange) return { emoji: '🟠', label: 'Marginal',   color: 'text-orange-400',  border: 'border-orange-600',  bg: 'bg-orange-500/10'  };
  return                                    { emoji: '🔴', label: 'Avoid',      color: 'text-red-400',     border: 'border-red-700',     bg: 'bg-red-500/5'      };
}

// ── TastyTrade API ─────────────────────────────────────────────────────────
const BASE = 'https://api.tastytrade.com';
const CLIENT_ID = '4d4c851b-bdaf-4ac9-b39b-811e604739f2';

async function getAccessToken(): Promise<string> {
  const cached = sessionStorage.getItem('tt_access_token');
  if (cached) return cached;
  const refreshToken = localStorage.getItem('tt_refresh_token');
  const clientSecret =
    process.env.NEXT_PUBLIC_TASTYTRADE_CLIENT_SECRET ||
    localStorage.getItem('tt_client_secret') ||
    '';
  if (!refreshToken || !clientSecret) { window.location.href = '/login'; throw new Error('Not authenticated'); }
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID, client_secret: clientSecret }),
  });
  if (!res.ok) {
    sessionStorage.removeItem('tt_access_token');
    localStorage.removeItem('tt_refresh_token');
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  const data = await res.json();
  const token = data.access_token;
  if (!token) { window.location.href = '/login'; throw new Error('No token'); }
  sessionStorage.setItem('tt_access_token', token);
  return token;
}

async function ttFetch(path: string, token: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    // Token expired mid-session — clear it, get a fresh one, retry once
    sessionStorage.removeItem('tt_access_token');
    const freshToken = await getAccessToken();
    const retry = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${freshToken}` } });
    if (!retry.ok) { const text = await retry.text(); throw new Error(`${path} failed (${retry.status}): ${text.slice(0, 200)}`); }
    return retry.json();
  }
  if (!res.ok) { const text = await res.text(); throw new Error(`${path} failed (${res.status}): ${text.slice(0, 200)}`); }
  return res.json();
}
async function loadPortfolioTickers(): Promise<{ current: string[]; historical: string[] }> {
  const token = await getAccessToken();

  // ── Current positions ─────────────────────────────────────────────────
  const current: string[] = [];
  try {
    const accountsData = await ttFetch('/customers/me/accounts', token);
    const accountNumber = accountsData?.data?.items?.[0]?.account?.['account-number'];
    if (accountNumber) {
      const posData = await ttFetch(`/accounts/${accountNumber}/positions`, token);
      for (const p of posData?.data?.items ?? []) {
        const sym = p['underlying-symbol'];
        if (sym && !current.includes(sym)) current.push(sym);
      }
    }
  } catch { /* current positions optional */ }

  // ── Historical positions (transactions) ───────────────────────────────
  const historical: string[] = [];
  try {
    const accountsData = await ttFetch('/customers/me/accounts', token);
    const accountNumber = accountsData?.data?.items?.[0]?.account?.['account-number'];
    if (accountNumber) {
      // Fetch last 2 years of transactions
      const startDate = new Date();
      startDate.setFullYear(startDate.getFullYear() - 2);
      const startStr = startDate.toISOString().split('T')[0];
      const txData = await ttFetch(`/accounts/${accountNumber}/transactions?start-date=${startStr}&per-page=500`, token);
      for (const tx of txData?.data?.items ?? []) {
        const sym = tx['underlying-symbol'] ?? tx['symbol'];
        if (sym && !historical.includes(sym) && !current.includes(sym)) {
          historical.push(sym);
        }
      }
    }
  } catch { /* historical optional */ }

  return { current, historical };
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
async function getChain(symbol: string, token: string, RULES: RulesType): Promise<{ expirations: string[]; chains: Record<string, any[]>; isEtfOrIndex: boolean }> {
  const nested = await ttFetch(`/option-chains/${symbol}/nested`, token);
  // Detect ETF/Index from TastyTrade instrument-type — no hardcoded list needed
  const instrumentType: string = nested?.data?.items?.[0]?.['instrument-type'] ?? '';
  const isEtfOrIndex = ['ETF', 'Index', 'Future'].some(t => instrumentType.toLowerCase().includes(t.toLowerCase()))
    || INDEX_TICKERS.has(symbol.toUpperCase()); // fallback for known tickers
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
      chains[meta.expDate].push({ strikePrice: meta.strike, expirationDate: meta.expDate, optionType: meta.optionType, delta, openInterest: oi, bid, ask, mid: (bid + ask) / 2 });
    }
  }
  expirations.sort(); return { expirations, chains, isEtfOrIndex };
}

// ── HUNTER Logic ─────────────────────────────────────────────────────────
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
    const maxLoss = width - credit; const roc = maxLoss > 0 ? (credit / maxLoss) * 100 : 0; if (roc < RULES.ROC_MIN_SPREAD) continue;
    const pop = (1 - absDelta) * 100; if (pop < RULES.POP_MIN) continue;
    candidates.push({ strategy, expiration: expDate, dte: daysUntil(expDate), shortStrike: shortLeg.strikePrice, longStrike, shortDelta: absDelta, shortOI: shortLeg.openInterest, longOI: longLeg.openInterest, credit, spreadWidth: width, creditRatio, roc, pop, optimized: true });
  }
  if (candidates.length === 0) return null;
  // Pick best POP; use ROC as tiebreaker when POP difference is < 5%
  return candidates.sort((a, b) => {
    const popDiff = (b.pop ?? 0) - (a.pop ?? 0);
    if (Math.abs(popDiff) >= 5) return popDiff;
    return b.roc - a.roc;
  })[0];
}
function findBestSpread(chain: any[], strategy: 'BPS' | 'BCS', expDate: string, price: number | null, RULES: RulesType): SpreadCandidate | null {
  const legs = chain.filter(o => o.expirationDate === expDate && o.optionType === (strategy === 'BPS' ? 'P' : 'C'));
  const allCandidates: SpreadCandidate[] = [];
  for (const width of getWidthSteps(RULES.MAX_SPREAD_WIDTH, price)) {
    const c = trySpreadAtWidth(legs, strategy, expDate, width, price, RULES);
    if (c) allCandidates.push(c);
  }
  if (allCandidates.length === 0) return null;
  // Pick best POP across all widths; ROC tiebreaker when POP difference is < 5%
  return allCandidates.sort((a, b) => {
    const popDiff = (b.pop ?? 0) - (a.pop ?? 0);
    if (Math.abs(popDiff) >= 5) return popDiff;
    return b.roc - a.roc;
  })[0];
}
function tryICSideAtWidth(legs: any[], side: 'put' | 'call', width: number, price: number | null, RULES: RulesType, minCallStrike?: number): { shortStrike: number; longStrike: number; shortDelta: number; credit: number; creditRatio: number; roc: number; shortOI: number; longOI: number; pop: number } | null {
  const bidAskMax = getBidAskMax(price);
  const candidates: { shortStrike: number; longStrike: number; shortDelta: number; credit: number; creditRatio: number; roc: number; shortOI: number; longOI: number; pop: number }[] = [];
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
    candidates.push({ shortStrike: shortLeg.strikePrice, longStrike, shortDelta: absDelta, credit, creditRatio, roc, shortOI: shortLeg.openInterest, longOI: longLeg.openInterest, pop });
  }
  if (candidates.length === 0) return null;
  // Pick best POP; ROC tiebreaker within 5%
  return candidates.sort((a, b) => {
    const popDiff = b.pop - a.pop;
    if (Math.abs(popDiff) >= 5) return popDiff;
    return b.roc - a.roc;
  })[0];
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

function runChecklist(symbol: string, strategy: 'BPS' | 'BCS' | 'IC', metrics: any, chainData: { expirations: string[]; chains: Record<string, any[]>; isEtfOrIndex?: boolean }, price: number | null, STOCK_RULES: RulesType, trendResult?: TrendResult, stockPresetLabel?: string, ETF_RULES_PARAM?: RulesType, etfPresetLabel?: string): ScreenResult {
  const failReasons: string[] = [], ivrValue = metrics.ivRank, earningsDate = metrics.earningsExpectedDate;
  const isIndex = chainData.isEtfOrIndex ?? INDEX_TICKERS.has(symbol.toUpperCase());
  // Auto-select the right rule set based on ticker type
  const RULES = isIndex ? (ETF_RULES_PARAM ?? { ...DEFAULT_ETF_RULES }) : STOCK_RULES;
  const appliedLabel = isIndex
    ? (etfPresetLabel ? `ETF — ${etfPresetLabel}` : 'ETF rules')
    : (stockPresetLabel ?? 'Custom');
  const effectiveRules: RulesType = RULES;
  const effectiveIvrMin = isIndex ? INDEX_IVR_MIN : effectiveRules.IVR_MIN;
  const ivrCheck: CheckResult = ivrValue == null ? { status: 'warn', value: 'N/A', reason: 'Not available' } : ivrValue < effectiveIvrMin ? (() => { failReasons.push(`IVR ${ivrValue.toFixed(1)}% < ${effectiveIvrMin}%`); return { status: 'fail' as const, value: `${ivrValue.toFixed(1)}%`, reason: `Below ${effectiveIvrMin}% minimum${isIndex ? ' (index)' : ''}` }; })() : { status: 'pass', value: `${ivrValue.toFixed(1)}%`, reason: isIndex ? `Above ${effectiveIvrMin}% (index floor)` : 'Above minimum' };

  // Earnings buffer auto-derived: DTE_MAX + 5 days cushion
  const earningsBuffer = RULES.DTE_MAX + 5;
  let earningsCheck: CheckResult;
  if (isIndex) {
    earningsCheck = { status: 'pass', value: 'N/A (index/ETF)', reason: 'No earnings events' };
  } else if (!earningsDate) {
    earningsCheck = { status: 'pass', value: 'None found', reason: 'Safe to trade' };
  } else {
    const d = daysUntil(earningsDate);
    if (d < 0) {
      earningsCheck = { status: 'pass', value: `${earningsDate} (past)`, reason: 'Already reported' };
    } else if (d < earningsBuffer) {
      failReasons.push(`Earnings in ${d}d`);
      earningsCheck = { status: 'fail', value: `${d}d (${earningsDate})`, reason: `Within ${earningsBuffer}d buffer (DTE Max + 5)` };
    } else {
      earningsCheck = { status: 'pass', value: `${d}d (${earningsDate})`, reason: `Outside ${earningsBuffer}d buffer` };
    }
  }

  const validExpirations = chainData.expirations.filter(exp => { const dte = daysUntil(exp); if (dte < effectiveRules.DTE_MIN || dte > effectiveRules.DTE_MAX) return false; if (!isIndex && earningsDate) { const ed = daysUntil(earningsDate); if (ed >= 0 && ed <= dte) return false; } return true; });
  let bestCandidate: SpreadCandidate | null = null;
  if (ivrCheck.status !== 'fail' && earningsCheck.status !== 'fail' && validExpirations.length > 0) { for (const exp of validExpirations) { const chainItems = chainData.chains[exp] || []; bestCandidate = strategy === 'IC' ? findBestIC(chainItems, exp, price, effectiveRules) : findBestSpread(chainItems, strategy, exp, price, effectiveRules); if (bestCandidate) break; } }
  if (!bestCandidate && validExpirations.length === 0 && !failReasons.some(r => r.includes('IVR') || r.includes('Earnings'))) failReasons.push('No 30-45 DTE expirations');
  else if (!bestCandidate && validExpirations.length > 0 && !failReasons.length) failReasons.push('No qualifying strikes found');
  const oiCheck: CheckResult = bestCandidate ? { status: 'pass', value: `${bestCandidate.shortOI}/${bestCandidate.longOI}`, reason: `Both legs ≥ ${effectiveRules.OI_MIN}` } : { status: 'fail', value: 'None', reason: failReasons[failReasons.length - 1] || 'No candidate' };
  const deltaCheck: CheckResult = bestCandidate ? { status: 'pass', value: bestCandidate.shortDelta.toFixed(2), reason: 'Within target range' } : { status: 'pending', value: '—', reason: 'No candidate' };

  const rawCredit = bestCandidate ? (bestCandidate.totalCredit ?? bestCandidate.credit) : 0;
  const creditCheck: CheckResult = bestCandidate
    ? { status: 'pass', value: `$${rawCredit.toFixed(2)}`, reason: `${(bestCandidate.creditRatio * 100).toFixed(0)}% of width` }
    : { status: 'pending', value: '—', reason: 'No candidate' };

  const rocMin = strategy === 'IC' ? effectiveRules.ROC_MIN_IC : effectiveRules.ROC_MIN_SPREAD;
  const rocCheck: CheckResult = bestCandidate ? { status: bestCandidate.roc >= rocMin ? 'pass' : 'fail', value: `${bestCandidate.roc.toFixed(0)}%`, reason: `Min ${rocMin}%` } : { status: 'pending', value: '—', reason: 'No candidate' };
  const candidatePop = bestCandidate ? (bestCandidate.pop ?? 0) : 0;
  const popMin = effectiveRules.POP_MIN;
  const popCheck: CheckResult = bestCandidate
    ? { status: candidatePop >= popMin ? 'pass' : 'fail', value: `${candidatePop.toFixed(0)}%`, reason: `Min ${popMin}%` }
    : { status: 'pending', value: '—', reason: 'No candidate' };
  if (bestCandidate && candidatePop < popMin) { failReasons.push(`POP ${candidatePop.toFixed(0)}% < ${popMin}%`); }
  const qualified = ivrCheck.status === 'pass' && earningsCheck.status === 'pass' && oiCheck.status === 'pass' && deltaCheck.status === 'pass' && creditCheck.status === 'pass' && rocCheck.status === 'pass' && popCheck.status === 'pass' && bestCandidate !== null;
  return { symbol, strategy, price, ivr: ivrValue, qualified, bestCandidate, failReasons, earningsDate, trendResult, isEtf: isIndex, ruleSetApplied: appliedLabel, checks: { ivr: ivrCheck, earnings: earningsCheck, oi: oiCheck, delta: deltaCheck, credit: creditCheck, roc: rocCheck, pop: popCheck } };
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
function EntryCalendarButton({ result, th }: { result: ScreenResult; th: typeof THEMES[Theme]; rules: RulesType; }) {
  const key = `entry-${result.symbol}-${result.bestCandidate?.expiration}`;
  const [scheduled, setScheduled] = useState<string | null>(() => {
    try { const s = localStorage.getItem(LS_CAL_ENTRY); const all = s ? JSON.parse(s) : {}; return all[key] || null; } catch { return null; }
  });
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});
  const [selectedDate, setSelectedDate] = useState<string>(() => {
    const d = addBusinessDays(new Date().toISOString().split('T')[0], 2);
    return d.toISOString().split('T')[0];
  });

  const presets: { label: string; days: number; hint: string }[] = [
    { label: '+2d',  days: 2,  hint: 'Revisit soon' },
    { label: '+1wk', days: 5,  hint: 'Post-spike settle' },
    { label: '+2wk', days: 10, hint: 'Post-earnings' },
  ];

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPopoverStyle({
        position: 'fixed',
        top: rect.bottom + 6,
        left: rect.left,
        zIndex: 9999,
      });
    }
    setOpen(!open);
  };

  const handleSchedule = (days: number, label: string) => {
    const url = buildEntryCalUrl(result, days);
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    document.body.appendChild(a); a.click(); setTimeout(() => document.body.removeChild(a), 100);
    try { const s = localStorage.getItem(LS_CAL_ENTRY); const all = s ? JSON.parse(s) : {}; all[key] = label; localStorage.setItem(LS_CAL_ENTRY, JSON.stringify(all)); } catch {}
    setScheduled(label);
    setTimeout(() => setOpen(false), 150);
  };

  const handleDatePick = (dateStr: string) => {
    if (!dateStr) return;
    setSelectedDate(dateStr);
    const d = new Date(dateStr + 'T12:00:00');
    const url = buildEntryCalUrl(result, 0, d);
    // Create anchor, append, click, then defer removal so the tab opens before DOM cleanup
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    document.body.appendChild(a); a.click(); setTimeout(() => document.body.removeChild(a), 100);
    try { const s = localStorage.getItem(LS_CAL_ENTRY); const all = s ? JSON.parse(s) : {}; all[key] = dateStr; localStorage.setItem(LS_CAL_ENTRY, JSON.stringify(all)); } catch {}
    setScheduled(dateStr);
    setTimeout(() => setOpen(false), 150);
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (btnRef.current && btnRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  if (scheduled) return (
    <span
      className="text-[9px] text-emerald-500 border border-emerald-600 rounded px-1.5 py-0.5 font-medium cursor-pointer hover:border-emerald-400"
      onClick={(e) => { e.stopPropagation(); setScheduled(null); }}
      title="Click to reset"
    >
      ✓ re-screen {scheduled}
    </span>
  );

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleOpen}
        className={`text-[9px] px-1.5 py-0.5 border ${th.inputBorder} rounded ${th.textMuted} hover:border-emerald-500 hover:text-emerald-400 transition-colors font-medium`}
      >
        📅 re-screen
      </button>
      {open && (
        <div
          onClick={e => e.stopPropagation()}
          style={popoverStyle}
          className={`${th.sidebar} border ${th.border} rounded-lg shadow-2xl p-3 w-52`}
        >
          <p className={`text-[8px] ${th.textFaint} tracking-widest mb-2 uppercase`}>Re-screen in:</p>
          {presets.map(p => (
            <button
              key={p.label}
              onClick={() => handleSchedule(p.days, p.label)}
              className={`w-full text-left px-2 py-2 rounded hover:bg-emerald-500/10 border border-transparent hover:border-emerald-700 transition-colors mb-1`}
            >
              <span className="text-emerald-400 font-bold text-xs">{p.label}</span>
              <span className={`text-[9px] ${th.textFaint} ml-2`}>{p.hint}</span>
            </button>
          ))}
          <div className={`mt-2 pt-2 border-t ${th.border}`}>
            <p className={`text-[8px] ${th.textFaint} tracking-widest mb-1.5 uppercase`}>Pick a date:</p>
            <div className="flex gap-1 items-center">
              <input
                ref={dateInputRef}
                type="date"
                min={new Date().toISOString().split('T')[0]}
                value={selectedDate}
                onChange={e => handleDatePick(e.target.value)}
                className={`flex-1 ${th.input} border ${th.inputBorder} rounded px-2 py-1.5 text-xs ${th.text} focus:outline-none focus:border-emerald-500 cursor-pointer`}
              />
              <button
                onClick={e => { e.stopPropagation(); try { dateInputRef.current?.showPicker(); } catch { dateInputRef.current?.focus(); } }}
                className={`px-1.5 py-1.5 border ${th.inputBorder} rounded ${th.textFaint} hover:text-emerald-400 hover:border-emerald-600 transition-colors text-xs`}
                title="Open calendar"
              >📅</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── DTE Alert Banner ───────────────────────────────────────────────────────
function DTEAlertBanner({ results, rules }: { results: ScreenResult[], rules: RulesType }) {
  const isShortTerm = rules.DTE_MAX <= 28;
  const alertThreshold = isShortTerm ? rules.DTE_MIN - 1 : 25;
  const closeTarget = isShortTerm ? Math.floor(rules.DTE_MIN / 2) : 21;
  const approaching = results.filter(r => r.qualified && r.bestCandidate && r.bestCandidate.dte <= alertThreshold);
  if (approaching.length === 0) return null;
  return (
    <div className="border border-yellow-500/50 bg-yellow-500/10 rounded-lg px-4 py-3 flex items-start gap-3">
      <span className="text-yellow-400 text-base mt-0.5">⚠</span>
      <div className="flex-1">
        <p className="text-xs text-yellow-400 font-bold tracking-wider mb-1">
          {isShortTerm ? `APPROACHING ${rules.DTE_MIN} DTE — ACTIVE MANAGEMENT REQUIRED` : 'APPROACHING 21 DTE — ACTION REQUIRED'}
        </p>
        <p className="text-[10px] text-yellow-300 mb-2">
          {isShortTerm
            ? `Short term rules active (${rules.DTE_MIN}–${rules.DTE_MAX} DTE). Monitor closely — consider closing at 50% profit or ${closeTarget} DTE.`
            : 'Close these positions regardless of profit/loss when they hit 21 DTE.'}
        </p>
        <div className="flex flex-wrap gap-2">
          {approaching.map(r => (
            <span key={r.symbol} className="text-[10px] bg-yellow-500/10 border border-yellow-600 rounded px-2 py-0.5 text-yellow-300 font-medium">
              {r.symbol} {r.bestCandidate?.expiration} — <span className={r.bestCandidate!.dte <= closeTarget ? 'text-red-400 font-bold' : 'text-yellow-400'}>{r.bestCandidate?.dte}d</span>
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
function SessionsPanel({ bps, bcs, ic, broken, onLoadAll, onLoadPrompt, onReclassify, th }: {
  bps: string; bcs: string; ic: string; broken: string;
  onLoadAll: (bps: string, bcs: string, ic: string, broken: string) => void;
  onLoadPrompt: (state: Omit<LoadPromptState, 'show'>) => void;
  onReclassify: () => void;
  th: typeof THEMES[Theme];
}) {
  const [globalFilters, setGlobalFilters] = useState<GlobalFilters>({});
  const [showSave, setShowSave] = useState(false);
  const [showLoad, setShowLoad] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveError, setSaveError] = useState('');
  const [loadingPortfolio, setLoadingPortfolio] = useState(false);
  const [portfolioStatus, setPortfolioStatus] = useState('');
  const [lastLoadedName, setLastLoadedName] = useState<string | null>(null);

  const markSessionLoaded = (name: string) => {
    setLastLoadedName(name);
    try { localStorage.setItem(LS_SESSION_LOADED_AT, JSON.stringify({ name, at: Date.now() })); } catch {}
  };

  const handleLoadFromPortfolio = async () => {
    setLoadingPortfolio(true);
    setPortfolioStatus('Fetching positions...');
    try {
      const { current, historical } = await loadPortfolioTickers();
      const all = [...current, ...historical];
      if (all.length === 0) { setPortfolioStatus('No positions found'); setTimeout(() => setPortfolioStatus(''), 3000); return; }
      const allStr = all.join(', ');
      setPortfolioStatus(`Found ${current.length} current · ${historical.length} historical`);
      setTimeout(() => setPortfolioStatus(''), 4000);
      // Check if boxes already have tickers
      const hasExisting = [bps, bcs, ic].some(v => normalizeTickerInput(v).length > 0);
      if (hasExisting) {
        onLoadPrompt({
          name: `${all.length} tickers from portfolio`,
          type: 'strategy',
          onLoad: (doMerge: boolean) => {
            if (doMerge) {
              // Merge all into BPS box (user can redistribute)
              onLoadAll(mergeTickers(bps, all), bcs, ic, broken);
            } else {
              onLoadAll(allStr, '', '', '');
            }
          },
        });
      } else {
        onLoadAll(allStr, '', '', '');
      }
    } catch (e: any) {
      setPortfolioStatus(`Error: ${e.message}`);
      setTimeout(() => setPortfolioStatus(''), 4000);
    }
    setLoadingPortfolio(false);
  };
  const parseTickers = normalizeTickerInput;
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
    const allEmpty = !parseTickers(bps).length && !parseTickers(bcs).length && !parseTickers(ic).length;
    if (allEmpty) {
      onLoadAll(tickersToString(session.bps), tickersToString(session.bcs), tickersToString(session.ic), '');
      markSessionLoaded(name);
      return;
    }
    onLoadPrompt({ name, type: 'global', onLoad: (doMerge: boolean) => {
      if (doMerge) onLoadAll(mergeTickers(bps, session.bps), mergeTickers(bcs, session.bcs), mergeTickers(ic, session.ic), broken);
      else onLoadAll(tickersToString(session.bps), tickersToString(session.bcs), tickersToString(session.ic), '');
      markSessionLoaded(name);
    }});
  };
  const handleDelete = async (name: string) => { await deleteFilter('global', name); await refreshFilters(); };
  const filterNames = Object.keys(globalFilters);
  return (
    <div className={`border-t ${th.border} pt-3`}>
      <p className={`text-[9px] ${th.textMuted} tracking-widest font-medium mb-2`}>SESSIONS</p>

      {/* Loaded session indicator + re-classify */}
      {lastLoadedName && (
        <div className={`mb-2 px-2 py-1.5 rounded border border-yellow-700/50 bg-yellow-500/5 flex items-center justify-between gap-2`}>
          <div>
            <p className="text-[8px] text-yellow-400/80 leading-tight">Loaded: <span className="font-bold text-yellow-400">{lastLoadedName}</span></p>
            <p className="text-[8px] text-yellow-400/50 leading-tight">Trends may have shifted</p>
          </div>
          <button
            onClick={onReclassify}
            className="text-[8px] px-2 py-1 border border-yellow-600 text-yellow-400 rounded hover:bg-yellow-500/10 transition-colors font-bold shrink-0 whitespace-nowrap">
            ↻ Re-classify
          </button>
        </div>
      )}
      <div className="flex gap-2 mb-2">
        <button
          onClick={handleLoadFromPortfolio}
          disabled={loadingPortfolio}
          className={`w-full text-[9px] px-2 py-1.5 border border-purple-700 rounded-lg text-purple-400 hover:border-purple-500 hover:text-purple-300 transition-colors font-medium flex items-center justify-center gap-1 disabled:opacity-40`}>
          {loadingPortfolio ? '⟳ Loading...' : '📊 Load from Portfolio'}
        </button>
      </div>
      {portfolioStatus && <p className={`text-[9px] ${portfolioStatus.startsWith('Error') ? 'text-red-400' : 'text-emerald-400'} mb-2`}>{portfolioStatus}</p>}
      <div className="flex gap-2">
        <button onClick={() => onLoadAll('', '', '', '')} className={`text-[9px] px-2 py-1.5 border border-red-800 rounded-lg text-red-500 hover:border-red-500 hover:text-red-400 transition-colors font-medium flex items-center justify-center gap-1 shrink-0`}>✕ Clear</button>
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
  strategy: 'BPS' | 'BCS' | 'IC' | 'broken';
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
  const parseTickers = normalizeTickerInput;
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
      } else {
        onChange('⚠ No tickers found in image');
        setTimeout(() => onChange(''), 2500);
      }
    } catch (err: any) {
      console.error(err);
      onChange(`⚠ OCR error: ${err?.message ?? 'unknown'}`);
      setTimeout(() => onChange(''), 3500);
    }
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
    if (!hasValue) { onChange(tickersToString(tickers)); return; }
    onLoadPrompt({ name, type: 'strategy', onLoad: (doMerge: boolean) => { if (doMerge) onChange(mergeTickers(value, tickers)); else onChange(tickersToString(tickers)); } });
  };
  const handleDelete = async (name: string) => { await deleteFilter(strategy, name); await refreshFilters(); };
  const filterNames = Object.keys(savedFilters);
  const hasValue = parseTickers(value).length > 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <span className={`text-[9px] px-1.5 py-0.5 border rounded-md tracking-wider font-bold ${badgeColor}`}>{badge}</span>
          <span className={`text-[10px] ${th.textMuted} font-medium tracking-wider`}>{label}</span>
        </div>
        <div className="flex items-center gap-1">
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleOCR} />
          <button onClick={handleImgClick} disabled={disabled || scanning} className={`text-[9px] px-1.5 py-0.5 border ${th.inputBorder} rounded ${th.textMuted} hover:border-blue-500 hover:text-blue-400 transition-colors disabled:opacity-40`}>{scanning ? '⟳' : '↑ img'}</button>
          <div className="relative">
            <button onClick={() => { setShowSaveInput(!showSaveInput); setShowLoad(false); setSaveError(''); }} disabled={disabled || !hasValue} className={`text-[9px] px-1.5 py-0.5 border ${th.inputBorder} rounded ${th.textMuted} hover:border-blue-500 hover:text-blue-400 transition-colors disabled:opacity-40`}>💾</button>
            {showSaveInput && (
              <div className={`absolute top-6 right-0 z-40 ${th.sidebar} border ${th.border} rounded-lg p-2 w-44 shadow-xl`}>
                <div className="flex gap-1 mb-1">
                  <input type="text" value={saveName} onChange={e => { setSaveName(e.target.value); setSaveError(''); }} placeholder="Filter name..." onKeyDown={e => e.key === 'Enter' && handleSave()}
                    className={`flex-1 ${th.input} border ${th.inputBorder} rounded px-2 py-1 text-[10px] ${th.text} focus:outline-none focus:border-blue-500 placeholder-slate-500`} />
                  <button onClick={() => handleSave()} className="text-[9px] px-1.5 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium">Save</button>
                </div>
                {saveError && (<div className="flex gap-1 items-center"><span className="text-[9px] text-yellow-400">{saveError}</span>{saveError.includes('exists') && <button onClick={() => handleSave(true)} className="text-[9px] px-1 py-0.5 bg-yellow-600 text-white rounded">Replace</button>}</div>)}
              </div>
            )}
          </div>
          <div className="relative">
            <button onClick={() => { setShowLoad(!showLoad); setShowSaveInput(false); if (!showLoad) refreshFilters(); }} disabled={disabled} className={`text-[9px] px-1.5 py-0.5 border ${th.inputBorder} rounded ${th.textMuted} hover:border-blue-500 hover:text-blue-400 transition-colors disabled:opacity-40`}>▼</button>
            {showLoad && (
              <div className={`absolute top-6 right-0 z-40 ${th.sidebar} border ${th.border} rounded-lg overflow-hidden w-44 shadow-xl`}>
                {loadingFilters ? <p className={`text-[9px] ${th.textFaint} px-3 py-2`}>Loading...</p>
                  : filterNames.length === 0 ? <p className={`text-[9px] ${th.textFaint} px-3 py-2`}>No saved filters yet</p>
                  : filterNames.map(name => (
                    <div key={name} className={`flex items-center justify-between px-3 py-2 hover:bg-blue-500/10 group cursor-pointer`}>
                      <button onClick={() => handleLoadSelect(name)} className={`text-[10px] ${th.textMuted} text-left flex-1 font-medium`}>{name}</button>
                      <button onClick={() => handleDelete(name)} className="text-[9px] text-slate-500 hover:text-red-500 ml-2 opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        placeholder={`${label} tickers...`}
        className={`w-full ${th.input} border ${th.inputBorder} rounded-lg p-2 text-xs ${th.text} h-14 resize-none focus:outline-none ${borderFocus} placeholder-slate-500 leading-relaxed disabled:opacity-40`}
      />
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

function ResultCard({ result, th, rules, screenMode, rankConfig }: {
  result: ScreenResult;
  th: typeof THEMES[Theme];
  rules: RulesType;
  screenMode?: 'filter' | 'rank';
  rankConfig?: RankConfig;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showBestFinder, setShowBestFinder] = useState(false);

  const c = result.bestCandidate;
  const t = result.trendResult;

  // Ranking
  const scored = rankConfig && c ? scoreCandidate(result, rankConfig) : null;
  const light = scored ? trafficLight(scored.score, rankConfig!) : null;
  const isRankMode = screenMode === 'rank';
  const stratBadge = result.strategy === 'BPS'
    ? 'bg-emerald-500/15 border-emerald-500 text-emerald-500'
    : result.strategy === 'BCS'
    ? 'bg-red-500/15 border-red-500 text-red-500'
    : 'bg-blue-500/15 border-blue-500 text-blue-500';

  const isShortTerm = rules.DTE_MAX <= 28;
  const dteAlertThreshold = isShortTerm ? rules.DTE_MIN - 1 : DTE_ALERT_THRESHOLD;
  const dteCloseTarget = isShortTerm ? Math.floor(rules.DTE_MIN / 2) : 21;
  const isApproaching = c && c.dte <= dteAlertThreshold;
  const hasEarningsBlock = result.failReasons.some(f => f.includes('Earnings'))
    && result.earningsDate
    && daysUntil(result.earningsDate) >= 0;

  const cardBorder = result.qualified
    ? (isApproaching ? 'border-yellow-500/50' : th.border)
    : th.borderLight;

  return (
    <div className={`border ${cardBorder} ${result.qualified ? `${th.cardQualified} ${strategyAccent(result.strategy)}` : `${th.card} opacity-60`} rounded-lg cursor-pointer transition-all hover:shadow-md`}
         onClick={() => setExpanded(!expanded)}>

      {/* Header Row */}
      <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="w-16 shrink-0">
          <p className={`font-bold ${th.text} text-sm`}>{result.symbol}</p>
          {result.price && <p className={`text-[10px] ${th.textFaint}`}>${result.price.toFixed(2)}</p>}
          {result.isEtf && (
            <p className="text-[8px] text-blue-400/70 tracking-wider leading-tight">
              {result.symbol === 'SPX' || result.symbol === 'XSP' || result.symbol === 'NDX' || result.symbol === 'RUT' ? 'index' : 'etf'}
            </p>
          )}
        </div>
        {/* Rule set badge */}
        {result.ruleSetApplied && (
          <span className={`text-[8px] px-1.5 py-0.5 border rounded shrink-0 font-medium tracking-wider
            ${result.ruleSetApplied.includes('ETF')
              ? 'border-blue-800 text-blue-400/80 bg-blue-500/5'
              : result.ruleSetApplied === 'Strict'
              ? 'border-red-900 text-red-400/70 bg-red-500/5'
              : result.ruleSetApplied === 'Course'
              ? 'border-slate-700 text-slate-400/70'
              : result.ruleSetApplied === 'Relaxed'
              ? 'border-emerald-900 text-emerald-400/70 bg-emerald-500/5'
              : result.ruleSetApplied === 'Low Vol'
              ? 'border-yellow-900 text-yellow-400/70 bg-yellow-500/5'
              : result.ruleSetApplied === 'Short Term'
              ? 'border-orange-900 text-orange-400/70 bg-orange-500/5'
              : 'border-slate-700 text-slate-500'
            }`}>
            {result.ruleSetApplied}
          </span>
        )}
        {/* Rank score badge */}
        {isRankMode && scored && light && (
          <span className={`text-[9px] px-2 py-0.5 border rounded shrink-0 font-bold ${light.color} ${light.border} ${light.bg}`}>
            {light.emoji} {scored.score} — {light.label}
          </span>
        )}
        <span className={`text-[10px] px-2 py-0.5 border rounded-md shrink-0 font-bold ${stratBadge}`}>{result.strategy}</span>
        {t && <span className={`text-[10px] shrink-0 font-medium ${trendColor(t.trend)}`}>{trendIcon(t.trend)} {t.trend}</span>}
        <div className={`text-xs ${th.label} shrink-0`}>IVR <span className={result.ivr != null && result.ivr >= 30 ? 'text-emerald-500 font-bold' : 'text-red-500 font-bold'}>{result.ivr != null ? `${result.ivr.toFixed(1)}%` : 'N/A'}</span></div>

        {c && <>
          <div className="text-xs shrink-0"><span className={th.label}>Exp </span><span className={`${th.text} font-medium`}>{c.expiration}</span><span className={`ml-1 font-medium ${c.dte <= dteCloseTarget ? 'text-red-500' : c.dte <= dteAlertThreshold ? 'text-yellow-500' : th.textFaint}`}>({c.dte}d)</span></div>
          <StrikesDisplay c={c} th={th} />
          <div className="text-xs shrink-0"><span className={th.label}>Credit </span><span className="text-emerald-500 font-bold">${(c.totalCredit ?? c.credit).toFixed(2)}</span></div>
          <div className="text-xs shrink-0"><span className={th.label}>ROC </span><span className={`${th.text} font-medium`}>{c.roc.toFixed(0)}%</span></div>
          {c.pop != null && <div className="text-xs shrink-0"><span className={th.label}>POP </span><span className={`${th.text} font-medium`}>{c.pop.toFixed(0)}%</span></div>}
          <div className="text-xs shrink-0"><span className={th.label}>δ </span><span className={`${th.text} font-medium`}>{c.shortDelta.toFixed(2)}</span></div>
          <span className={`text-[9px] ${th.textFaint} border ${th.borderLight} rounded px-1 py-0.5 shrink-0`}>opt</span>
          {result.qualified && <span onClick={e => e.stopPropagation()} className="shrink-0"><EntryCalendarButton result={result} th={th} rules={rules} /></span>}
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

      {/* Expanded Content */}
      {expanded && (
        <div className={`border-t ${th.border} px-4 py-3 space-y-3`}>
          {t && <div className={`text-[10px] ${th.textMuted} pb-2 border-b ${th.border}`}><span className={`${trendColor(t.trend)} mr-2 font-medium`}>{trendIcon(t.trend)} {t.trend.toUpperCase()}</span>{t.reason}</div>}

          {/* Score breakdown in rank mode */}
          {isRankMode && scored && light && (
            <div className={`border ${light.border} ${light.bg} rounded-lg p-3`}>
              <div className="flex items-center justify-between mb-2">
                <p className={`text-[10px] font-bold ${light.color}`}>{light.emoji} Score {scored.score}/100 — {light.label}</p>
              </div>
              <div className="grid grid-cols-5 gap-2">
                {[
                  { label: 'IVR', val: scored.dims.ivr, max: rankConfig!.weightIvr },
                  { label: 'Credit', val: scored.dims.credit, max: rankConfig!.weightCredit },
                  { label: 'ROC', val: scored.dims.roc, max: rankConfig!.weightRoc },
                  { label: 'POP', val: scored.dims.pop, max: rankConfig!.weightPop },
                  { label: 'DTE', val: scored.dims.dte, max: rankConfig!.weightDte },
                ].map(d => (
                  <div key={d.label} className="text-center">
                    <p className={`text-[8px] ${th.textFaint} mb-1`}>{d.label}</p>
                    <div className={`h-1 rounded-full bg-slate-700 mb-1`}>
                      <div className={`h-full rounded-full ${light!.color.replace('text-', 'bg-')}`}
                        style={{ width: `${d.max > 0 ? (d.val / d.max) * 100 : 0}%` }} />
                    </div>
                    <p className={`text-[9px] font-bold ${th.text}`}>{d.val}<span className={`${th.textFaint} font-normal`}>/{d.max}</span></p>
                  </div>
                ))}
              </div>
            </div>
          )}

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

          {c && c.strategy === 'IC' && c.callWidth != null && c.callWidth !== c.spreadWidth && (
            <div className={`pt-2 border-t ${th.border}`}>
              <p className={`text-[10px] ${th.textMuted}`}>Asymmetric widths — Put: ${c.spreadWidth} · Call: ${c.callWidth}</p>
            </div>
          )}

          {result.failReasons.length > 0 && (
            <div className={`pt-2 border-t ${th.border}`}>
              <p className="text-[10px] text-red-500 font-medium">{result.failReasons.join(' · ')}</p>
            </div>
          )}

          {/* Best Opportunity Button */}
          <button
            onClick={(e) => { e.stopPropagation(); setShowBestFinder(true); }}
            className="w-full py-2.5 border border-emerald-600 hover:bg-emerald-500/10 text-emerald-400 rounded-xl text-sm font-medium tracking-wider transition-colors mt-2"
          >
            🔍 FIND BEST OPPORTUNITY FOR {result.symbol}
          </button>
        </div>
      )}

      {/* Best Opportunity Modal — rendered via portal to escape card click handler */}
      {showBestFinder && typeof document !== 'undefined' && createPortal(
        <BestOpportunityFinder
          symbol={result.symbol}
          onClose={() => setShowBestFinder(false)}
          th={th}
          rules={rules}
          preferredStrategy={result.strategy as 'BPS' | 'BCS' | 'IC'}
        />,
        document.body
      )}
    </div>
  );
}

// ── Auto Trend Debug Panel ─────────────────────────────────────────────────
function AutoTrendDebugPanel({ entries, th }: { entries: AutoTrendEntry[]; th: typeof THEMES[Theme] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (entries.length === 0) return null;

  const stratColor = (s: string) =>
    s === 'BPS' ? 'text-emerald-400 border-emerald-600 bg-emerald-500/10'
    : s === 'BCS' ? 'text-red-400 border-red-600 bg-red-500/10'
    : s === 'IC' ? 'text-blue-400 border-blue-600 bg-blue-500/10'
    : 'text-amber-400 border-amber-600 bg-amber-500/10';

  const barColor = (val: number) =>
    val > 0 ? 'bg-emerald-500' : val < 0 ? 'bg-red-500' : 'bg-slate-600';

  const ScoreBar = ({ label, value, max = 50 }: { label: string; value: number; max?: number }) => {
    const pct = Math.min(100, (Math.abs(value) / max) * 50); // 50% = center
    const isPos = value >= 0;
    return (
      <div className="flex items-center gap-2">
        <span className={`text-[9px] w-16 shrink-0 ${th.textFaint}`}>{label}</span>
        <div className="flex-1 h-1.5 bg-slate-700 rounded-full relative overflow-hidden">
          <div
            className={`absolute h-full rounded-full ${barColor(value)}`}
            style={{ width: `${pct}%`, left: isPos ? '50%' : `${50 - pct}%` }}
          />
          <div className="absolute left-1/2 top-0 w-px h-full bg-slate-500 opacity-50" />
        </div>
        <span className={`text-[9px] w-8 text-right font-mono shrink-0 ${value > 0 ? 'text-emerald-400' : value < 0 ? 'text-red-400' : th.textFaint}`}>
          {value > 0 ? '+' : ''}{value}
        </span>
      </div>
    );
  };

  return (
    <div className={`border ${th.border} rounded-xl overflow-hidden`}>
      <div className={`px-4 py-2.5 border-b ${th.border} flex items-center justify-between`}>
        <p className={`text-[10px] font-bold tracking-widest ${th.textMuted}`}>TREND DETECT RESULTS</p>
        <span className={`text-[9px] ${th.textFaint}`}>{entries.length} tickers</span>
      </div>
      <div className="divide-y divide-slate-800">
        {entries.map(({ symbol, result }) => {
          const s = result.scores;
          const isOpen = expanded === symbol;
          const label = result.strategy === 'NO_TRADE' ? 'REVIEW' : result.strategy;
          return (
            <div key={symbol}>
              <button
                className={`w-full px-4 py-2.5 flex items-center gap-3 hover:bg-slate-800/40 transition-colors text-left`}
                onClick={() => setExpanded(isOpen ? null : symbol)}
              >
                <span className={`text-[9px] px-1.5 py-0.5 border rounded font-bold shrink-0 ${stratColor(label)}`}>{label}</span>
                <span className={`text-xs font-bold ${th.text} w-16 shrink-0`}>{symbol}</span>
                <span className={`text-[9px] ${th.textFaint} flex-1 truncate`}>{result.reason}</span>
                {s && (
                  <span className={`text-[9px] font-mono shrink-0 ${s.total > 0 ? 'text-emerald-400' : s.total < 0 ? 'text-red-400' : th.textFaint}`}>
                    {s.total > 0 ? '+' : ''}{s.total}
                  </span>
                )}
                <span className={`text-[9px] ${th.textFaint} shrink-0`}>{isOpen ? '▲' : '▼'}</span>
              </button>

              {isOpen && s && (
                <div className={`px-4 pb-3 pt-1 ${th.card} space-y-2`}>
                  <p className={`text-[9px] ${th.textFaint} font-mono leading-relaxed mb-2`}>{result.reason}</p>
                  <div className="space-y-1.5">
                    <ScoreBar label="Momentum" value={s.momentum} max={50} />
                    <ScoreBar label="MA Align" value={s.maAlignment} max={40} />
                    <ScoreBar label="Slope" value={s.slope} max={25} />
                    <ScoreBar label="Structure" value={s.structure} max={60} />
                    <ScoreBar label="Chop ✗" value={-s.chop} max={25} />
                    <ScoreBar label="Vol/Mat ✗" value={-s.volatility} max={40} />
                  </div>
                  <div className={`flex items-center justify-between pt-1.5 border-t ${th.border} mt-1`}>
                    <span className={`text-[9px] font-bold ${th.textMuted}`}>TOTAL</span>
                    <span className={`text-[10px] font-black font-mono ${s.total > 0 ? 'text-emerald-400' : s.total < 0 ? 'text-red-400' : th.textFaint}`}>
                      {s.total > 0 ? '+' : ''}{s.total}
                    </span>
                  </div>
                  {result.metrics && (
                    <div className={`grid grid-cols-2 gap-x-4 gap-y-0.5 pt-1.5 border-t ${th.border}`}>
                      {[
                        ['Mom 20d', `${(result.metrics.momentum20 * 100).toFixed(1)}%`],
                        ['Mom 60d', `${(result.metrics.momentum60 * 100).toFixed(1)}%`],
                        ['Mom 90d', `${(result.metrics.momentum90 * 100).toFixed(1)}%`],
                        ['Range 60d', `${(result.metrics.range60 * 100).toFixed(1)}%`],
                        ['Chop ratio', result.metrics.chopRatio.toFixed(1)],
                        ['Dist MA50', `${(result.metrics.distFromMa50 * 100).toFixed(1)}%`],
                        ['↑Hi/↑Lo', `${result.metrics.higherHighs ? '✓' : '✗'}/${result.metrics.higherLows ? '✓' : '✗'}`],
                        ['↓Hi/↓Lo', `${result.metrics.lowerHighs ? '✓' : '✗'}/${result.metrics.lowerLows ? '✓' : '✗'}`],
                      ].map(([k, v]) => (
                        <div key={k} className="flex justify-between">
                          <span className={`text-[9px] ${th.textFaint}`}>{k}</span>
                          <span className={`text-[9px] font-mono ${th.textMuted}`}>{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Range Indicator ────────────────────────────────────────────────────────
function RangeIndicator({ value, strict, course, relaxed, lowvol, fmt }: {
  value: number; strict?: number; course?: number; relaxed?: number; lowvol?: number;
  fmt?: (v: number) => string;
}) {
  const f = fmt ?? ((v: number) => String(v));
  const points = [
    strict  != null ? { v: strict,  label: 'Strict',  color: 'bg-red-500' }    : null,
    course  != null ? { v: course,  label: 'Course',  color: 'bg-blue-500' }   : null,
    relaxed != null ? { v: relaxed, label: 'Relaxed', color: 'bg-emerald-500' }: null,
    lowvol  != null ? { v: lowvol,  label: 'Low Vol', color: 'bg-yellow-500' } : null,
  ].filter(Boolean) as { v: number; label: string; color: string }[];
  if (!points.length) return null;
  const allVals = points.map(p => p.v);
  const min = Math.min(...allVals, value) * 0.9;
  const max = Math.max(...allVals, value) * 1.1;
  const pct = (v: number) => Math.round(((v - min) / (max - min)) * 100);
  return (
    <div className="mt-1 relative h-3">
      <div className="absolute inset-x-0 top-1.5 h-px bg-slate-700 rounded" />
      {points.map(p => (
        <div key={p.label} className={`absolute w-1.5 h-1.5 rounded-full ${p.color} top-1 -translate-x-1/2`}
          style={{ left: `${pct(p.v)}%` }} title={`${p.label}: ${f(p.v)}`} />
      ))}
      <div className="absolute w-2 h-2 rounded-full bg-white border-2 border-slate-900 top-0.5 -translate-x-1/2 z-10"
        style={{ left: `${pct(value)}%` }} title={`Current: ${f(value)}`} />
    </div>
  );
}

// ── Slider ─────────────────────────────────────────────────────────────────
function Slider({ label, hint, value, min, max, step = 1, fmt, onChange, th }: {
  label: string; hint?: string; value: number; min: number; max: number; step?: number;
  fmt?: (v: number) => string; onChange: (v: number) => void; th: typeof THEMES[Theme];
}) {
  const f = fmt ?? ((v: number) => String(v));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <p className={`text-[9px] ${th.textFaint} tracking-wider uppercase font-medium leading-tight`}>{label}</p>
        <span className={`text-[10px] font-bold ${th.text}`}>{f(value)}</span>
      </div>
      {hint && <p className={`text-[8px] ${th.textFaint} opacity-60`}>{hint}</p>}
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-blue-500"
        style={{ background: `linear-gradient(to right, #3b82f6 ${((value - min) / (max - min)) * 100}%, #374151 0%)` }}
      />
      <div className="flex justify-between">
        <span className={`text-[8px] ${th.textFaint}`}>{f(min)}</span>
        <span className={`text-[8px] ${th.textFaint}`}>{f(max)}</span>
      </div>
    </div>
  );
}

// ── Rules Modal Subcomponents ──────────────────────────────────────────────
function RuleInput({ ruleKey, rawValues, editedRules, onRawChange, onBlur, th, label, hint }: {
  ruleKey: keyof RulesType;
  rawValues: Record<string, string>;
  editedRules: RulesType;
  onRawChange: (key: string, raw: string) => void;
  onBlur: (key: keyof RulesType, raw: string) => void;
  th: typeof THEMES[Theme];
  label?: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col">
      <p className={`text-[9px] ${th.textFaint} tracking-wider uppercase font-medium leading-tight`}>
        {label ?? RULE_LABELS[ruleKey]}
      </p>
      <p className={`text-[8px] ${th.textFaint} opacity-60 mb-1 leading-tight min-h-[12px]`}>
        {hint ?? ''}
      </p>
      <input
        type="text"
        inputMode="decimal"
        value={rawValues[ruleKey] ?? String(editedRules[ruleKey])}
        onChange={e => onRawChange(ruleKey, e.target.value)}
        onBlur={e => onBlur(ruleKey, e.target.value)}
        onFocus={e => e.target.select()}
        className={`w-full ${th.input} border ${th.inputBorder} rounded-lg px-3 py-1.5 text-xs ${th.text} focus:outline-none focus:border-blue-500 font-medium`}
      />
    </div>
  );
}

function SectionHeader({ label, th }: { label: string; th: typeof THEMES[Theme] }) {
  return (
    <div className={`col-span-full pt-3 pb-1 border-b ${th.border}`}>
      <p className={`text-[9px] ${th.textFaint} tracking-widest uppercase font-bold`}>{label}</p>
    </div>
  );
}

// ── Rules Modal ────────────────────────────────────────────────────────────
function RulesModal({ stockRules, etfRules, rankConfig, onClose, onRun, th }: {
  stockRules: RulesType;
  etfRules: RulesType;
  rankConfig: RankConfig;
  onClose: () => void;
  onRun: (stockRules: RulesType, etfRules: RulesType, stockLabel: string, etfLabel: string, rankConfig: RankConfig) => void;
  th: typeof THEMES[Theme];
}) {
  const [stockEdited, setStockEdited] = useState<RulesType>({ ...stockRules });
  const [stockRaw, setStockRaw] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(stockRules).map(([k, v]) => [k, String(v)])));
  const [stockPreset, setStockPreset] = useState<string | null>(() => { try { return localStorage.getItem(LS_ACTIVE_PRESET); } catch { return null; } });
  const [etfEdited, setEtfEdited] = useState<RulesType>({ ...etfRules });
  const [etfRaw, setEtfRaw] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(etfRules).map(([k, v]) => [k, String(v)])));
  const [etfPreset, setEtfPreset] = useState<string | null>(() => { try { return localStorage.getItem(LS_ACTIVE_PRESET_ETF); } catch { return null; } });
  const [rankEdited, setRankEdited] = useState<RankConfig>({ ...rankConfig });

  const makeHandlers = (
    edited: RulesType,
    setEdited: React.Dispatch<React.SetStateAction<RulesType>>,
    setRaw: React.Dispatch<React.SetStateAction<Record<string, string>>>
  ) => ({
    onChange: (key: string, raw: string) => setRaw(prev => ({ ...prev, [key]: raw })),
    onBlur: (key: keyof RulesType, raw: string) => {
      const val = parseFloat(raw);
      if (!isNaN(val)) { setEdited(prev => ({ ...prev, [key]: val })); setRaw(prev => ({ ...prev, [key]: String(val) })); }
      else setRaw(prev => ({ ...prev, [key]: String(edited[key]) }));
    },
  });

  const stockHandlers = makeHandlers(stockEdited, setStockEdited, setStockRaw);
  const etfHandlers = makeHandlers(etfEdited, setEtfEdited, setEtfRaw);

  const applyPresetToStock = (p: typeof RULE_PRESETS[number]) => {
    const merged = { ...DEFAULT_RULES, ...p.rules };
    setStockEdited(merged); setStockRaw(Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, String(v)])));
    setStockPreset(p.key); try { localStorage.setItem(LS_ACTIVE_PRESET, p.key); } catch {}
  };
  const applyPresetToEtf = (p: typeof RULE_PRESETS[number]) => {
    const merged = { ...DEFAULT_ETF_RULES, ...p.rules };
    setEtfEdited(merged); setEtfRaw(Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, String(v)])));
    setEtfPreset(p.key); try { localStorage.setItem(LS_ACTIVE_PRESET_ETF, p.key); } catch {}
  };
  const handleResetStock = () => {
    setStockEdited({ ...DEFAULT_RULES }); setStockRaw(Object.fromEntries(Object.entries(DEFAULT_RULES).map(([k, v]) => [k, String(v)])));
    setStockPreset(null); try { localStorage.removeItem(LS_RULES); localStorage.removeItem(LS_ACTIVE_PRESET); } catch {}
  };
  const handleResetEtf = () => {
    setEtfEdited({ ...DEFAULT_ETF_RULES }); setEtfRaw(Object.fromEntries(Object.entries(DEFAULT_ETF_RULES).map(([k, v]) => [k, String(v)])));
    setEtfPreset(null); try { localStorage.removeItem(LS_RULES_ETF); localStorage.removeItem(LS_ACTIVE_PRESET_ETF); } catch {}
  };
  const handleResetRank = () => setRankEdited({ ...DEFAULT_RANK_CONFIG });

  const handleRun = () => {
    saveRulesToStorage(stockEdited); saveEtfRulesToStorage(etfEdited);
    try { localStorage.setItem(LS_RANK_CONFIG, JSON.stringify(rankEdited)); } catch {}
    const sLabel = stockPreset ? (RULE_PRESETS.find(p => p.key === stockPreset)?.label ?? 'Custom') : 'Custom';
    const eLabel = etfPreset ? (RULE_PRESETS.find(p => p.key === etfPreset)?.label ?? 'ETF Custom') : 'ETF Custom';
    onRun(stockEdited, etfEdited, sLabel, eLabel, rankEdited);
  };

  const RuleCol = ({ edited, raw, handlers, presetKey, onApplyPreset, onReset, isEtf }: {
    edited: RulesType; raw: Record<string, string>;
    handlers: { onChange: (k: string, v: string) => void; onBlur: (k: keyof RulesType, v: string) => void };
    presetKey: string | null; onApplyPreset: (p: typeof RULE_PRESETS[number]) => void; onReset: () => void; isEtf: boolean;
  }) => {
    const ri = (key: keyof RulesType, lbl?: string, hint?: string) => (
      <div>
        <RuleInput ruleKey={key} rawValues={raw} editedRules={edited} onRawChange={handlers.onChange} onBlur={handlers.onBlur} th={th} label={lbl} hint={hint} />
        <RangeIndicator
          value={edited[key] as number}
          strict={(RULE_PRESETS.find(p => p.key === 'strict')?.rules as any)?.[key]}
          course={(RULE_PRESETS.find(p => p.key === 'course')?.rules as any)?.[key]}
          relaxed={(RULE_PRESETS.find(p => p.key === 'relaxed')?.rules as any)?.[key]}
          lowvol={(RULE_PRESETS.find(p => p.key === 'lowvol')?.rules as any)?.[key]}
          fmt={(v) => String(v)}
        />
      </div>
    );
    return (
      <div className="flex-1 min-w-0">
        <div className={`px-4 py-2.5 border-b ${th.border} flex items-center justify-between ${isEtf ? 'bg-blue-500/5' : ''}`}>
          <div>
            <p className={`text-[10px] font-bold tracking-widest ${isEtf ? 'text-blue-400' : th.text}`}>{isEtf ? '🏦 ETF / INDEX' : '📈 STOCK'}</p>
            <p className={`text-[8px] ${th.textFaint} mt-0.5`}>{isEtf ? 'Auto-applied to ETFs & Indexes' : 'Auto-applied to individual stocks'}</p>
          </div>
          <button onClick={onReset} className="text-[8px] border border-yellow-700 text-yellow-600 px-2 py-0.5 rounded hover:bg-yellow-500/10 transition-colors">RESET</button>
        </div>
        <div className="px-4 py-2 border-b border-dashed border-slate-800">
          <p className="text-[8px] tracking-widest uppercase mb-1.5 opacity-40">Quick presets:</p>
          <div className="flex gap-1 flex-wrap">
            {RULE_PRESETS.map(p => (
              <button key={p.key} onClick={() => onApplyPreset(p)} title={p.desc}
                className={'px-2 py-1 rounded text-[8px] font-bold border transition-colors ' + (presetKey === p.key ? p.color : 'border-slate-700 text-slate-500 hover:border-slate-500')}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="px-4 py-3 space-y-3">
          <div>
            <p className={`text-[8px] ${th.textFaint} tracking-widest uppercase font-bold mb-2`}>① Volatility & Timing</p>
            <div className="grid grid-cols-2 gap-3">
              {ri('IVR_MIN','IVR Min %','Floor')}
              {ri('IVR_IC_MAX','IVR Max % (IC)','IC only')}
              {ri('DTE_MIN','DTE Min')}
              {ri('DTE_MAX','DTE Max')}
            </div>
          </div>
          <div>
            <p className={`text-[8px] ${th.textFaint} tracking-widest uppercase font-bold mb-2`}>② Delta</p>
            <div className="grid grid-cols-2 gap-3">
              {ri('SPREAD_DELTA_MIN','Spread δ Min')}
              {ri('SPREAD_DELTA_MAX','Spread δ Max')}
              {ri('IC_DELTA_MIN','IC δ Min')}
              {ri('IC_DELTA_MAX','IC δ Max')}
            </div>
          </div>
          <div>
            <p className={`text-[8px] ${th.textFaint} tracking-widest uppercase font-bold mb-2`}>③ Liquidity · Credit · Return</p>
            <div className="grid grid-cols-2 gap-3">
              {ri('OI_MIN','Min OI','Per leg')}
              {ri('BID_ASK_MAX','Max Bid-Ask','Per leg')}
              {ri('MAX_SPREAD_WIDTH','Max Width $','Optimizer cap')}
              {ri('CREDIT_RATIO_MIN','Min Credit Ratio','0.33=course')}
              {ri('ROC_MIN_SPREAD','Min ROC Spread')}
              {ri('ROC_MIN_IC','Min ROC IC')}
              {ri('POP_MIN','Min POP %')}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const sl = (key: keyof RankConfig, label: string, hint: string, min: number, max: number, step = 1, fmt?: (v: number) => string) => (
    <Slider label={label} hint={hint} value={rankEdited[key] as number} min={min} max={max} step={step}
      fmt={fmt} onChange={v => setRankEdited(prev => ({ ...prev, [key]: v }))} th={th} />
  );

  const totalWeight = rankEdited.weightIvr + rankEdited.weightCredit + rankEdited.weightRoc + rankEdited.weightPop + rankEdited.weightDte;


  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className={`${th.sidebar} border ${th.border} rounded-xl shadow-2xl w-full max-w-6xl max-h-[92vh] overflow-auto`}>
        <div className={`flex items-center justify-between px-6 py-4 border-b ${th.border}`}>
          <div>
            <h2 className="text-sm font-bold tracking-widest text-red-500">SCREENING RULES</h2>
            <p className={`text-[9px] ${th.textFaint} mt-0.5`}>Stock and ETF/Index rules apply automatically per ticker. Ranking config drives the score in Rank mode. Dots on inputs show preset positions.</p>
          </div>
          <button onClick={onClose} className={`${th.textFaint} hover:${th.text} text-lg`}>✕</button>
        </div>
        <div className="flex divide-x divide-slate-800">
          <RuleCol edited={stockEdited} raw={stockRaw} handlers={stockHandlers} presetKey={stockPreset} onApplyPreset={applyPresetToStock} onReset={handleResetStock} isEtf={false} />
          <RuleCol edited={etfEdited} raw={etfRaw} handlers={etfHandlers} presetKey={etfPreset} onApplyPreset={applyPresetToEtf} onReset={handleResetEtf} isEtf={true} />

          {/* Ranking config column */}
          <div className="w-72 shrink-0">
            <div className={`px-4 py-2.5 border-b ${th.border} flex items-center justify-between bg-purple-500/5`}>
              <div>
                <p className="text-[10px] font-bold tracking-widest text-purple-400">⬡ RANKING</p>
                <p className={`text-[8px] ${th.textFaint} mt-0.5`}>Scoring weights and thresholds</p>
              </div>
              <button onClick={handleResetRank} className="text-[8px] border border-yellow-700 text-yellow-600 px-2 py-0.5 rounded hover:bg-yellow-500/10 transition-colors">RESET</button>
            </div>
            <div className="px-4 py-3 space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className={`text-[8px] ${th.textFaint} tracking-widest uppercase font-bold`}>Scoring Weights</p>
                  <span className={`text-[8px] font-bold ${totalWeight === 100 ? 'text-emerald-400' : 'text-yellow-400'}`}>{totalWeight}/100 pts</span>
                </div>
                <div className="space-y-3">
                  {sl('weightIvr',    'IVR Quality',   'Peaks ~65, slight penalty >80', 0, 40)}
                  {sl('weightCredit', 'Credit Ratio',  'Linear 0.20→0.50',             0, 40)}
                  {sl('weightRoc',    'ROC',           'Log scale, dims >50%',          0, 30)}
                  {sl('weightPop',    'POP',           'Bell curve, peaks at 72%',      0, 20)}
                  {sl('weightDte',    'DTE Quality',   'Bell curve around sweet spot',  0, 20)}
                </div>
              </div>
              <div>
                <p className={`text-[8px] ${th.textFaint} tracking-widest uppercase font-bold mb-3`}>DTE Sweet Spot</p>
                <div className="space-y-3">
                  {sl('dteSweetSpot', 'Center DTE',  'Full score at this DTE',         14, 45)}
                  {sl('dteRange',     '± Range',     'Days either side for full score', 1, 14)}
                </div>
              </div>
              <div>
                <p className={`text-[8px] ${th.textFaint} tracking-widest uppercase font-bold mb-3`}>Traffic Light Thresholds</p>
                <div className="space-y-3">
                  {sl('thresholdGreen',  '🟢 Green floor',  'Strong — take the trade',       40, 100)}
                  {sl('thresholdYellow', '🟡 Yellow floor', 'Acceptable — proceed with care', 20, 80)}
                  {sl('thresholdOrange', '🟠 Orange floor', 'Marginal — paper trade only',    10, 60)}
                </div>
                <p className={`text-[8px] ${th.textFaint} mt-2 leading-relaxed`}>🔴 Red = below orange floor. Earnings always blocks regardless of score.</p>
              </div>
            </div>
          </div>
        </div>
        <div className={`flex gap-3 px-6 py-4 border-t ${th.border}`}>
          <p className={`text-[9px] ${th.textFaint} flex-1 self-center`}>Stocks and ETFs/Indexes auto-apply their own rules. Ranking scores apply in Rank mode only. Dots on inputs show where each preset sits.</p>
          <button onClick={onClose} className={`border ${th.border} ${th.textMuted} py-2 px-4 rounded-lg text-xs tracking-widest hover:border-blue-500`}>CANCEL</button>
          <button onClick={handleRun} className="bg-blue-600 hover:bg-blue-500 text-white py-2 px-6 rounded-lg text-xs font-bold tracking-widest transition-colors">RUN</button>
        </div>
      </div>
    </div>
  );
}

// ── Trend Detection with Yahoo Finance ──────────────────────────────────────
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
  setAutoTickers: (v: string) => void,
  setError: (e: string) => void,
  setStatus: (s: string) => void,
  setLoading: (l: boolean) => void,
  parseTickers: (s: string) => string[],
  setAutoTrendEntries: (entries: AutoTrendEntry[]) => void,
  showLoadPrompt: (state: Omit<LoadPromptState, 'show'>) => void
) {
  const autoList = Array.from(new Set(parseTickers(autoTickers)));
  if (autoList.length === 0) {
    setError('Enter at least one ticker for trend detection.');
    return;
  }

  setError('');
  setLoading(true);
  setAutoTrendEntries([]);

  try {
    setStatus(`Analyzing ${autoList.length} ticker${autoList.length === 1 ? '' : 's'} with Yahoo Finance...`);
    const distributions: { bps: string[]; bcs: string[]; ic: string[]; broken: string[] } = { bps: [], bcs: [], ic: [], broken: [] };
    const entries: AutoTrendEntry[] = [];
    let completed = 0;

    const analyzeSymbol = async (symbol: string) => {
      try {
        const trendResult = await getTrend(symbol);
        entries.push({ symbol, result: trendResult });
        if (trendResult.strategy === 'BPS') {
          distributions.bps.push(symbol);
        } else if (trendResult.strategy === 'BCS') {
          distributions.bcs.push(symbol);
        } else if (trendResult.strategy === 'IC') {
          distributions.ic.push(symbol);
        } else {
          distributions.broken.push(symbol);
        }
      } catch (e: any) {
        console.warn(e?.message ?? e);
        distributions.broken.push(symbol);
      } finally {
        completed += 1;
        setStatus(`Analyzed ${completed}/${autoList.length} tickers...`);
      }
    };

    for (let i = 0; i < autoList.length; i += TREND_DETECTION_CONCURRENCY) {
      const chunk = autoList.slice(i, i + TREND_DETECTION_CONCURRENCY);
      await Promise.all(chunk.map(analyzeSymbol));
    }

    // Sort entries to match strategy grouping order: BPS, BCS, IC, Review
    const order = ['BPS', 'BCS', 'IC', 'NO_TRADE'];
    entries.sort((a, b) => order.indexOf(a.result.strategy) - order.indexOf(b.result.strategy));
    setAutoTrendEntries(entries);

    const statusMsg = `✅ Trend detection complete: ${distributions.bps.length} BPS, ${distributions.bcs.length} BCS, ${distributions.ic.length} IC, ${distributions.broken.length} broken/unknown.`;

    const applyDistributions = (doMerge: boolean) => {
      if (doMerge) {
        if (distributions.bps.length > 0) handleBpsChange(mergeTickers(bpsTickers, distributions.bps));
        if (distributions.bcs.length > 0) handleBcsChange(mergeTickers(bcsTickers, distributions.bcs));
        if (distributions.ic.length > 0) handleIcChange(mergeTickers(icTickers, distributions.ic));
        if (distributions.broken.length > 0) handleBrokenChange(mergeTickers(brokenTickers, distributions.broken));
      } else {
        handleBpsChange(tickersToString(distributions.bps));
        handleBcsChange(tickersToString(distributions.bcs));
        handleIcChange(tickersToString(distributions.ic));
        handleBrokenChange(tickersToString(distributions.broken));
      }
    };

    // Check if any box already has tickers — if so, prompt replace vs merge
    const hasExisting =
      parseTickers(bpsTickers).length > 0 ||
      parseTickers(bcsTickers).length > 0 ||
      parseTickers(icTickers).length > 0 ||
      parseTickers(brokenTickers).length > 0;

    setAutoTickers('');
    setStatus(statusMsg);

    if (hasExisting) {
      const total = distributions.bps.length + distributions.bcs.length + distributions.ic.length + distributions.broken.length;
      showLoadPrompt({
        name: `${total} ticker${total !== 1 ? 's' : ''} from trend detection`,
        type: 'strategy',
        onLoad: applyDistributions,
      });
    } else {
      applyDistributions(false);
    }
  } catch (e: any) {
    setError(e.message);
  } finally {
    setLoading(false);
  }
}

// ── Yahoo Finance getTrend vNext ────────────────────────────────────────────
async function getTrend(symbol: string): Promise<TrendResult> {
  const cleanSymbol = normalizeTickerToken(symbol) ?? symbol.toUpperCase();
  const res = await fetch(`/api/chart?symbol=${encodeURIComponent(cleanSymbol)}`, { cache: 'no-store' });

  if (!res.ok) throw new Error(`Yahoo chart fetch failed for ${cleanSymbol} (${res.status})`);

  const data = await res.json();
  const bars: { c: number }[] = data?.bars ?? [];
  const closes = bars.map(b => b.c).filter((c): c is number => Number.isFinite(c));

  const unknownResult = (reason: string): TrendResult => ({
    trend: 'unknown',
    strategy: 'NO_TRADE',
    subtype: 'UNKNOWN',
    confidence: 0,
    ma20: 0,
    ma50: 0,
    ma200: 0,
    reason,
  });

  if (closes.length < 90) {
    return unknownResult('Not enough valid Yahoo daily closing prices for vNext trend detection');
  }

  const avg = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const pct = (current: number, prior: number) => prior === 0 ? 0 : (current - prior) / prior;
  const max = (values: number[]) => Math.max(...values);
  const min = (values: number[]) => Math.min(...values);
  const clamp = (value: number, low = 0, high = 100) => Math.max(low, Math.min(high, value));
  const signedScale = (value: number, fullAt: number, maxPoints: number) => {
    const sign = value >= 0 ? 1 : -1;
    return sign * Math.min(1, Math.abs(value) / fullAt) * maxPoints;
  };

  const currentPrice = closes[closes.length - 1];
  const ma20 = avg(closes.slice(-20));
  const ma50 = avg(closes.slice(-50));
  const ma200 = closes.length >= 200 ? avg(closes.slice(-200)) : avg(closes);
  const ma20Prev = avg(closes.slice(-40, -20));
  const ma50Prev = closes.length >= 100 ? avg(closes.slice(-100, -50)) : avg(closes.slice(-90, -40));

  const ma20Slope = pct(ma20, ma20Prev);
  const ma50Slope = pct(ma50, ma50Prev);
  const momentum10 = pct(currentPrice, closes[closes.length - 11]);
  const momentum20 = pct(currentPrice, closes[closes.length - 21]);
  const momentum40 = pct(currentPrice, closes[closes.length - 41]);
  const momentum60 = pct(currentPrice, closes[closes.length - 61]);
  const momentum90 = pct(currentPrice, closes[closes.length - 91]);

  const last10 = closes.slice(-10);
  const last20 = closes.slice(-20);
  const prior20 = closes.slice(-40, -20);
  const last40 = closes.slice(-40);
  const prior40 = closes.slice(-80, -40);
  const last60 = closes.slice(-60);
  const prior60 = closes.slice(-120, -60);
  const last90 = closes.slice(-90);

  const high20 = max(last20), low20 = min(last20);
  const high40 = max(last40), low40 = min(last40);
  const high60 = max(last60), low60 = min(last60);
  const high90 = max(last90), low90 = min(last90);
  const priorHigh20 = max(prior20), priorLow20 = min(prior20);
  const priorHigh40 = max(prior40), priorLow40 = min(prior40);
  const priorHigh60 = prior60.length ? max(prior60) : priorHigh40;
  const priorLow60 = prior60.length ? min(prior60) : priorLow40;

  const range60 = pct(high60, low60);
  const net60 = Math.abs(momentum60);
  const chopRatio = net60 < 0.01 ? 99 : range60 / net60;
  const distFromMa20 = pct(currentPrice, ma20);
  const distFromMa50 = pct(currentPrice, ma50);
  const drawdownFrom60High = pct(currentPrice, high60); // negative number
  const drawdownFrom90High = pct(currentPrice, high90); // negative number
  const reboundFrom60Low = pct(currentPrice, low60);
  const reboundFrom90Low = pct(currentPrice, low90);
  const near60High = currentPrice >= high60 * 0.96;
  const near60Low = currentPrice <= low60 * 1.04;

  const higherLows = low20 > priorLow20 * 0.985;
  const higherHighs = high20 > priorHigh20 * 1.005;
  const lowerHighs = high20 < priorHigh20 * 1.015;
  const lowerLows = low20 < priorLow20 * 0.995;
  const regimeHigherLows = low40 > priorLow40 * 0.985;
  const regimeHigherHighs = high40 > priorHigh40 * 1.005;
  const regimeLowerHighs = high40 < priorHigh40 * 1.015;
  const regimeLowerLows = low40 < priorLow40 * 0.995;
  const brokePriorSupport = currentPrice < priorLow60 * 0.985 || currentPrice < priorLow40 * 0.985;
  const brokePriorResistance = currentPrice > priorHigh60 * 1.015 || currentPrice > priorHigh40 * 1.015;

  const isIdx = INDEX_TICKERS.has(cleanSymbol.toUpperCase());
  const highVolName = Math.abs(momentum60) > 0.18 || range60 > 0.34 || Math.abs(momentum90) > 0.30;
  const maxHealthyRange60 = isIdx ? 0.22 : highVolName ? 0.48 : 0.34;
  const maxChaoticRange60 = isIdx ? 0.30 : highVolName ? 0.72 : 0.52;

  let momentumScore = 0;
  momentumScore += signedScale(momentum20, 0.10, 18);
  momentumScore += signedScale(momentum60, 0.22, 22);
  // A small 90-day memory prevents a few right-edge candles from fully reversing the regime.
  momentumScore += signedScale(momentum90, 0.35, 8);

  let maAlignmentScore = 0;
  if (currentPrice > ma20) maAlignmentScore += 8; else maAlignmentScore -= 8;
  if (currentPrice > ma50) maAlignmentScore += 10; else maAlignmentScore -= 10;
  if (ma20 > ma50) maAlignmentScore += 10; else maAlignmentScore -= 10;
  // Distance from the 50MA matters, but too much distance is handled by maturity/exhaustion below.
  maAlignmentScore += signedScale(distFromMa50, 0.12, 6);

  let slopeScore = 0;
  slopeScore += signedScale(ma20Slope, 0.035, 13);
  slopeScore += signedScale(ma50Slope, 0.025, 9);

  let structureScore = 0;
  if (higherHighs) structureScore += 7;
  if (higherLows) structureScore += 9;
  if (regimeHigherHighs) structureScore += 8;
  if (regimeHigherLows) structureScore += 10;
  if (lowerHighs) structureScore -= 9;
  if (lowerLows) structureScore -= 7;
  if (regimeLowerHighs) structureScore -= 10;
  if (regimeLowerLows) structureScore -= 8;

  let regimeScore = 0;
  if (brokePriorResistance && momentum40 > 0) regimeScore += 12;
  if (brokePriorSupport && momentum40 < 0) regimeScore -= 12;
  if (currentPrice > high90 * 0.98 && momentum60 > 0.08) regimeScore += 8;
  if (currentPrice < low90 * 1.04 && momentum60 < -0.08) regimeScore -= 8;
  // Failed trend behavior: prior strength followed by a decisive break is bearish even if the long chart was once bullish.
  if (momentum90 > 0.10 && momentum20 < -0.07 && currentPrice < ma20 && drawdownFrom60High < -0.12) regimeScore -= 16;
  // Recovery behavior: prior weakness followed by reclaiming averages can be a bullish reversal.
  if (momentum90 < -0.10 && momentum20 > 0.07 && currentPrice > ma20 && reboundFrom60Low > 0.12) regimeScore += 14;

  const rawDirectionalScore = momentumScore + maAlignmentScore + slopeScore + structureScore + regimeScore;

  let volatilityPenalty = 0;
  if (range60 > maxHealthyRange60) volatilityPenalty += range60 > maxChaoticRange60 ? 22 : 9;

  let chopPenalty = 0;
  if (chopRatio > 6.0) chopPenalty += 18;
  else if (chopRatio > 4.0) chopPenalty += 10;
  else if (chopRatio > 3.0) chopPenalty += 5;

  // Trend maturity / exhaustion: direction may be right, but trade quality is poor when the move is vertical.
  let maturityPenalty = 0;
  const upsideExhausted =
    (momentum10 > 0.18 && momentum20 > 0.28) ||
    (distFromMa50 > 0.28 && reboundFrom60Low > 0.55) ||
    (near60High && reboundFrom60Low > 0.75 && range60 > 0.55);
  const downsideExhausted =
    (momentum10 < -0.18 && momentum20 < -0.28) ||
    (distFromMa50 < -0.25 && Math.abs(drawdownFrom60High) > 0.45) ||
    (near60Low && Math.abs(drawdownFrom60High) > 0.55 && range60 > 0.55);

  if (upsideExhausted || downsideExhausted) maturityPenalty += highVolName ? 16 : 24;
  if (Math.abs(momentum20) > 0.40) maturityPenalty += 12;

  const penalty = volatilityPenalty + chopPenalty + maturityPenalty;
  const directionalScore = rawDirectionalScore > 0
    ? rawDirectionalScore - penalty
    : rawDirectionalScore + penalty;

  const scores = {
    momentum: Math.round(momentumScore),
    maAlignment: Math.round(maAlignmentScore),
    slope: Math.round(slopeScore),
    structure: Math.round(structureScore + regimeScore),
    chop: Math.round(chopPenalty),
    volatility: Math.round(volatilityPenalty + maturityPenalty),
    total: Math.round(directionalScore),
  };

  const metrics = {
    price: currentPrice,
    ma20,
    ma50,
    ma200,
    momentum10,
    momentum20,
    momentum40,
    momentum60,
    momentum90,
    ma20Slope,
    ma50Slope,
    range60,
    chopRatio,
    distFromMa20,
    distFromMa50,
    drawdownFrom60High,
    drawdownFrom90High,
    reboundFrom60Low,
    reboundFrom90Low,
    higherHighs,
    higherLows,
    lowerHighs,
    lowerLows,
    regimeHigherHighs,
    regimeHigherLows,
    regimeLowerHighs,
    regimeLowerLows,
    brokePriorSupport,
    brokePriorResistance,
    upsideExhausted,
    downsideExhausted,
  };



  const absScore = Math.abs(directionalScore);
  const conflictPenalty = Math.abs(momentumScore) > 12 && Math.abs(maAlignmentScore) > 12 && Math.sign(momentumScore) !== Math.sign(maAlignmentScore) ? 12 : 0;
  const confidence = Math.round(clamp(absScore - conflictPenalty - penalty * 0.35, 0, 100));

  // ── CDW fix: catastrophic recent drop = event-driven, not a tradeable setup ──
  // If price crashed >25% in the last 10 bars, the chart is broken regardless of direction.
  const recentCatastrophicDrop = pct(currentPrice, max(closes.slice(-11, -1))) < -0.25;
  // TMDX fix: exempt stocks already in a confirmed sustained downtrend.
  // A stock dropping 25%+ as the final leg of a 6-month downtrend is BCS, not event-driven chaos.
  const preCatastrophicDowntrend =
    (lowerHighs || regimeLowerHighs) &&
    (lowerLows || regimeLowerLows) &&
    drawdownFrom60High < -0.30 &&
    momentum60 < -0.10;
  if (recentCatastrophicDrop && !preCatastrophicDowntrend) {
    return {
      trend: 'unknown',
      strategy: 'NO_TRADE',
      subtype: 'CHOP',
      confidence: 20,
      ma20, ma50, ma200, scores, metrics,
      reason: `REVIEW: catastrophic drop >25% in last 10 bars — event-driven, chart not yet tradeable. Wait for structure to form.`,
    };
  }

  // ── GDDY fix: post-crash stabilization → IC ──────────────────────────────
  // Wide 60-day range due to a prior crash, BUT recent 20-bar range is tight = stabilized.
  // This is a valid IC candidate even though the 60d stats look chaotic.
  const recentRange20Pct = high20 > 0 ? (high20 - low20) / low20 : 1;
  const postCrashStabilized =
    range60 > maxHealthyRange60 &&           // wide 60d range (crash visible)
    recentRange20Pct < 0.10 &&               // but last 20 bars are tight (<10%)
    Math.abs(momentum20) < 0.05 &&           // recent price going nowhere
    Math.abs(momentum40) < 0.12 &&           // medium-term also contained
    drawdownFrom60High < -0.15;              // confirms there was a real drop

  // ── ADP/GDDY fix: chop ratio explodes to 99 when net60 ≈ 0 ──────────────
  // A stock can have a very high chop ratio AND clear directional structure
  // (ADP: staircase down but net displacement ≈ 0 over 60d due to bounces).
  // Don't let infinite chop override a clear bearish/bullish score.
  // Also: GDDY-type post-crash flat ranges have high chop ratio but are valid IC.
  // Pre-compute bearish/bullish structure here so isChaotic can respect it.
  const clearBearishStructure =
    (lowerHighs || regimeLowerHighs) &&
    (lowerLows || regimeLowerLows || brokePriorSupport ||
      (ma20Slope < -0.008 && drawdownFrom60High < -0.12)) &&
    // Use ma50Slope as fallback — catches ADP-type bounces where ma20 is temporarily positive
    // but the slower MA50 still points down, confirming the broader downtrend
    (ma20Slope < -0.005 || momentum40 < -0.03 || ma50Slope < -0.008) &&
    drawdownFrom60High < -0.06 &&
    !(momentum90 > 0.25 && drawdownFrom60High < -0.20 && range60 > 0.35); // ANET-type: strongly bullish then event crash — not a clean downtrend

  const clearBullishStructure =
    (higherLows || regimeHigherLows) &&
    currentPrice > ma50 &&
    (ma20Slope > 0.005 || momentum40 > 0.03) &&
    directionalScore >= 8 &&
    drawdownFrom60High > -0.25;  // exclude post-crash bounces — if dropped >25% from 60d high, not a clean uptrend

  // isChaotic: only fires when there's no clear directional structure
  const isChaotic = !postCrashStabilized &&
    !clearBearishStructure &&
    !clearBullishStructure &&
    (range60 > maxChaoticRange60 || (chopRatio > 6.0 && absScore < 50));

  if (isChaotic) {
    return {
      trend: 'sideways',
      strategy: 'NO_TRADE',
      subtype: 'CHOP',
      confidence: Math.max(25, Math.min(48, confidence)),
      ma20, ma50, ma200, scores, metrics,
      reason: `NO_TRADE CHOP: 60-day range ${(range60 * 100).toFixed(1)}%, chop ratio ${chopRatio.toFixed(1)}, directional score ${scores.total}.`,
    };
  }

  // If the move is directional but very mature/vertical, keep it out of automatic spread assignment.
  if ((upsideExhausted && directionalScore > 45) || (downsideExhausted && directionalScore < -45)) {
    return {
      trend: directionalScore > 0 ? 'uptrend' : 'downtrend',
      strategy: 'NO_TRADE',
      subtype: 'UNKNOWN',
      confidence: Math.max(42, Math.min(58, confidence)),
      ma20, ma50, ma200, scores, metrics,
      reason: `REVIEW EXTENDED: ${directionalScore > 0 ? 'bullish' : 'bearish'} direction, but move is mature/vertical. 20-day momentum ${(momentum20 * 100).toFixed(1)}%, distance from 50MA ${(distFromMa50 * 100).toFixed(1)}%, 60-day range ${(range60 * 100).toFixed(1)}%.`,
    };
  }

  const bullishContinuation =
    directionalScore >= 68 &&
    ma20 > ma50 &&
    currentPrice > ma20 &&
    momentum60 > 0.07 &&
    (higherLows || regimeHigherLows) &&
    !upsideExhausted;

  const bearishContinuation =
    directionalScore <= -62 &&
    currentPrice < ma20 &&
    (ma20 < ma50 || ma20Slope < -0.015) &&
    (momentum60 < -0.06 || momentum20 < -0.08) &&
    (lowerHighs || lowerLows || brokePriorSupport);

  const bullishReversal =
    directionalScore >= 48 &&
    currentPrice > ma20 &&
    momentum20 > 0.035 &&
    momentum60 > 0.07 &&           // raised from 0.045 — filters out flat/ranging stocks with marginal 60d momentum
    (higherLows || regimeHigherLows) &&
    regimeHigherLows &&            // require regime-level higher lows, not just 20-bar — rules out UBER-type ranges
    momentum90 > -0.35 &&
    !upsideExhausted;

  const bearishReversal =
    directionalScore <= -48 &&
    currentPrice < ma20 &&
    momentum20 < -0.035 &&
    (momentum60 < -0.035 || ma20Slope < -0.012 || brokePriorSupport) &&
    (lowerHighs || lowerLows || regimeLowerHighs || regimeLowerLows) &&
    !downsideExhausted;

  if (bullishContinuation) {
    return {
      trend: 'uptrend',
      strategy: 'BPS',
      subtype: 'CONTINUATION',
      confidence,
      ma20,
      ma50,
      ma200,
      scores,
      metrics,
      reason: `BPS CONTINUATION: score ${scores.total}, momentum ${scores.momentum}, MA ${scores.maAlignment}, slope ${scores.slope}, structure/regime ${scores.structure}.`,
    };
  }

  if (bearishContinuation) {
    return {
      trend: 'downtrend',
      strategy: 'BCS',
      subtype: 'CONTINUATION',
      confidence,
      ma20,
      ma50,
      ma200,
      scores,
      metrics,
      reason: `BCS CONTINUATION: score ${scores.total}, momentum ${scores.momentum}, MA ${scores.maAlignment}, slope ${scores.slope}, structure/regime ${scores.structure}.`,
    };
  }

  if (bullishReversal) {
    return {
      trend: 'uptrend',
      strategy: 'BPS',
      subtype: 'REVERSAL',
      confidence: Math.max(55, Math.min(74, confidence)),
      ma20,
      ma50,
      ma200,
      scores,
      metrics,
      reason: `BPS REVERSAL: recovery with improving structure. Score ${scores.total}, 20-day momentum ${(momentum20 * 100).toFixed(1)}%, 60-day momentum ${(momentum60 * 100).toFixed(1)}%.`,
    };
  }

  if (bearishReversal) {
    return {
      trend: 'downtrend',
      strategy: 'BCS',
      subtype: 'REVERSAL',
      confidence: Math.max(55, Math.min(74, confidence)),
      ma20,
      ma50,
      ma200,
      scores,
      metrics,
      reason: `BCS REVERSAL: deterioration/failure after prior strength or failed rebound. Score ${scores.total}, 20-day momentum ${(momentum20 * 100).toFixed(1)}%, 60-day momentum ${(momentum60 * 100).toFixed(1)}%.`,
    };
  }

  // ── Trend Memory Arbitration ──────────────────────────────────────────────

  // ── GDDY: post-crash stabilized → IC ─────────────────────────────────────
  if (postCrashStabilized) {
    return {
      trend: 'sideways',
      strategy: 'IC',
      subtype: 'RANGE',
      confidence: Math.max(52, Math.min(72, confidence)),
      ma20, ma50, ma200, scores, metrics,
      reason: `IC RANGE (post-crash stabilization): 60-day range elevated from prior crash, but last 20 bars tight at ${(recentRange20Pct * 100).toFixed(1)}%, recent momentum flat. Range-bound structure supports IC.`,
    };
  }

  // ── ERX fix: high-vol name with strong recent recovery ───────────────────
  const recentBullishRecovery =
    highVolName &&
    momentum20 > 0.08 &&
    momentum10 > 0.03 &&
    currentPrice > ma20 &&
    currentPrice > ma50 &&
    (higherLows || regimeHigherLows) &&
    reboundFrom60Low > 0.30 &&
    !upsideExhausted;

  if (recentBullishRecovery) {
    return {
      trend: 'uptrend',
      strategy: 'BPS',
      subtype: 'REVERSAL',
      confidence: Math.max(52, Math.min(70, confidence)),
      ma20, ma50, ma200, scores, metrics,
      reason: `BPS (volatile recovery): high-vol name with strong recent bounce (+${(momentum20 * 100).toFixed(1)}% 20d), price above both MAs, higher-low structure. 60d momentum distorted by prior crash — recent signal trusted.`,
    };
  }

  // ── Bearish memory: catches ADSK (-22), and now also SPGI/VMC via clearBearishStructure ──
  // Two tiers:
  // Strong (-15 and below): full gate including MA50 check
  // Weak (clearBearishStructure, any score): lower highs + slope confirmed = BCS override
  const bearishMemoryStrong =
    directionalScore <= -15 &&
    (lowerHighs || regimeLowerHighs) &&
    (lowerLows || regimeLowerLows || brokePriorSupport) &&
    (currentPrice < ma50 || (lowerHighs && regimeLowerHighs && ma20Slope < -0.005)) &&
    (ma20Slope < -0.005 || momentum40 < -0.03 || momentum60 < -0.05) &&
    !(momentum20 > 0.08 && currentPrice > ma20 && reboundFrom60Low > 0.20);

  // Weak bearish: covers SPGI (+3) and VMC (-7) — low score but clear lower-high structure
  // with price rolling over and negative slope. Use clearBearishStructure computed above.
  const bearishMemoryWeak =
    !bearishMemoryStrong &&
    clearBearishStructure &&
    (lowerHighs || regimeLowerHighs) &&
    drawdownFrom60High < -0.06 &&
    !(momentum20 > 0.06 && currentPrice > ma20) &&
    !(momentum60 > 0.12 && currentPrice > ma50);  // block strong 60d recoveries — HOOD-type V-bounces back above MA50

  const bullishMemoryStrong =
    directionalScore >= 22 &&
    (higherLows || regimeHigherLows) &&
    currentPrice > ma50 &&
    (ma20Slope > 0.008 || momentum40 > 0.05) &&
    !(momentum20 < -0.06 && currentPrice < ma20);

  // ── Diagnostic strings for IC/Review reason text ──────────────────────────
  const _diagLH = lowerHighs || regimeLowerHighs;
  const _diagLL = lowerLows || regimeLowerLows || brokePriorSupport || (ma20Slope < -0.008 && drawdownFrom60High < -0.12);
  const _diagSlope = ma20Slope < -0.005 || momentum40 < -0.03 || ma50Slope < -0.008;
  const _diagDD = drawdownFrom60High < -0.06;
  const _diagNoBnc = !(momentum20 > 0.06 && currentPrice > ma20);
  const _diagCBS = `CBS[↓Hi=${_diagLH?'✓':'✗'} ↓Lo=${_diagLL?'✓':'✗'} slope=${_diagSlope?'✓':'✗'} dd=${_diagDD?'✓':'✗'}]=${clearBearishStructure?'✓':'✗'}`;
  const _diagBMSLL = lowerLows || regimeLowerLows || brokePriorSupport;
  const _diagBMSMA50 = currentPrice < ma50 || (lowerHighs && regimeLowerHighs && ma20Slope < -0.005);
  const _diagBMSSlope = ma20Slope < -0.005 || momentum40 < -0.03 || momentum60 < -0.05;
  const _diagBMSNoBnc = !(momentum20 > 0.08 && currentPrice > ma20 && reboundFrom60Low > 0.20);
  const _diagBMS = `BMS[s≤-15=${directionalScore<=-15?'✓':'✗'} ↓Hi=${_diagLH?'✓':'✗'} ↓Lo=${_diagBMSLL?'✓':'✗'} MA50=${_diagBMSMA50?'✓':'✗'} sl=${_diagBMSSlope?'✓':'✗'} noBnc=${_diagBMSNoBnc?'✓':'✗'}]=${bearishMemoryStrong?'✓':'✗'}`;
  const _diagBMW = `BMW[CBS=${clearBearishStructure?'✓':'✗'} dd=${_diagDD?'✓':'✗'} noBnc=${_diagNoBnc?'✓':'✗'}]=${bearishMemoryWeak?'✓':'✗'}`;
  const _diag = `| ${_diagCBS} | ${_diagBMS} | ${_diagBMW}`;

  // True IC range: only if no directional memory gate fires.
  const rangeLike = absScore <= 28 || chopRatio > 3.0 || (range60 > 0.22 && Math.abs(momentum60) < 0.06);

  if (rangeLike && bearishMemoryStrong) {
    return {
      trend: 'downtrend',
      strategy: 'BCS',
      subtype: 'CONTINUATION',
      confidence: Math.max(52, Math.min(70, confidence)),
      ma20,
      ma50,
      ma200,
      scores,
      metrics,
      reason: `BCS (trend memory override): score ${scores.total} — bearish structure persists despite consolidation. Lower highs/lows, price below MA50, slope/momentum confirm direction. Range ${(range60 * 100).toFixed(1)}%, chop ${chopRatio.toFixed(1)}.`,
    };
  }

  if (rangeLike && bullishMemoryStrong) {
    return {
      trend: 'uptrend',
      strategy: 'BPS',
      subtype: 'CONTINUATION',
      confidence: Math.max(52, Math.min(70, confidence)),
      ma20,
      ma50,
      ma200,
      scores,
      metrics,
      reason: `BPS (trend memory override): score ${scores.total} — bullish structure persists despite consolidation. Higher lows, price above MA50, slope/momentum confirm direction. Range ${(range60 * 100).toFixed(1)}%, chop ${chopRatio.toFixed(1)}.`,
    };
  }

  // ── SPGI/VMC/ADP: weak score but confirmed bearish structure ─────────────
  // Must fire before rangeLike IC check, otherwise these fall through to IC.
  if (bearishMemoryWeak) {
    return {
      trend: 'downtrend',
      strategy: 'BCS',
      subtype: 'REVERSAL',
      confidence: Math.max(45, Math.min(62, confidence)),
      ma20, ma50, ma200, scores, metrics,
      reason: `BCS (weak bearish memory): score ${scores.total} — lower highs confirmed, price rolling over, negative slope. Structure supports BCS despite low directional score. Range ${(range60 * 100).toFixed(1)}%.`,
    };
  }

  if (rangeLike) {
    return {
      trend: 'sideways',
      strategy: 'IC',
      subtype: 'RANGE',
      confidence: Math.max(55, Math.min(78, 100 - absScore - Math.round(penalty * 0.35))),
      ma20,
      ma50,
      ma200,
      scores,
      metrics,
      reason: `IC RANGE: overlapping/mixed structure; score ${scores.total}, 60-day range ${(range60 * 100).toFixed(1)}%, chop ratio ${chopRatio.toFixed(1)}. ${_diag}`,
    };
  }

  // ── Final fallback: only truly ambiguous signals reach here ──────────────
  // If we have a weak directional lean but no clean pattern, try one more time
  // to assign BCS/BPS before sending to Review.
  if (directionalScore <= -18 && currentPrice < ma50 && (lowerHighs || brokePriorSupport)) {
    return {
      trend: 'downtrend',
      strategy: 'BCS',
      subtype: 'REVERSAL',
      confidence: Math.max(40, Math.min(55, confidence)),
      ma20,
      ma50,
      ma200,
      scores,
      metrics,
      reason: `BCS (weak lean): score ${scores.total} — below MA50 with lower-high or support break structure, but signal is not clean. Monitor carefully.`,
    };
  }

  if (directionalScore >= 18 && currentPrice > ma50 && (higherLows || regimeHigherLows) && momentum60 > 0.05 && !rangeLike) {
    return {
      trend: 'uptrend',
      strategy: 'BPS',
      subtype: 'REVERSAL',
      confidence: Math.max(40, Math.min(55, confidence)),
      ma20,
      ma50,
      ma200,
      scores,
      metrics,
      reason: `BPS (weak lean): score ${scores.total} — above MA50 with higher-low structure, but signal is not clean. Monitor carefully.`,
    };
  }

  // Second pass: strong score above MA50 even without confirmed higher lows — catches RY-type
  // stocks with strong directional scores that just pulled back far enough to disrupt the lows structure
  if (directionalScore >= 45 && currentPrice > ma50 && momentum60 > 0.04 && ma20Slope > 0 && !rangeLike) {
    return {
      trend: 'uptrend',
      strategy: 'BPS',
      subtype: 'REVERSAL',
      confidence: Math.max(42, Math.min(58, confidence)),
      ma20,
      ma50,
      ma200,
      scores,
      metrics,
      reason: `BPS (strong score, recovering): score ${scores.total} — above MA50 with positive slope and momentum. Higher-low structure not yet confirmed but directional lean is clear.`,
    };
  }

  return {
    trend: 'unknown',
    strategy: 'NO_TRADE',
    subtype: 'UNKNOWN',
    confidence: Math.max(35, Math.min(54, confidence)),
    ma20,
    ma50,
    ma200,
    scores,
    metrics,
    reason: `REVIEW: genuinely conflicting signals; score ${scores.total}, momentum ${scores.momentum}, MA ${scores.maAlignment}, slope ${scores.slope}, structure/regime ${scores.structure}. No clear directional or range pattern. ${_diag}`,
  };
}

// ── Best Opportunity Finder ────────────────────────────────────────────────
interface BestSetup {
  strategy: string;
  grade: 'A+' | 'A' | 'B' | 'C';
  setup: SpreadCandidate;
  score: number;
  notes: string[];
  result: ScreenResult;
}

interface LevelResult {
  presetKey: string;
  presetLabel: string;
  presetColor: string;
  rulesUsed: RulesType;
  ruleDiffs: string[];
  ranked: BestSetup[];
  failures: { strategy: string; reasons: string[] }[];
}

function getRuleDiffs(base: RulesType, relaxed: Partial<RulesType>): string[] {
  const labels: Record<string, string> = {
    IVR_MIN: 'IVR floor', OI_MIN: 'Min OI', BID_ASK_MAX: 'Max bid-ask',
    CREDIT_RATIO_MIN: 'Credit ratio', ROC_MIN_SPREAD: 'ROC spread', ROC_MIN_IC: 'ROC IC',
  };
  return Object.entries(relaxed)
    .filter(([k, v]) => base[k as keyof RulesType] !== v)
    .map(([k, v]) => {
      const label = labels[k] || k;
      const from = base[k as keyof RulesType];
      return `${label}: ${from} → ${v}`;
    });
}

function BestOpportunityFinder({
  symbol, onClose, th, rules, preferredStrategy,
}: {
  symbol: string; onClose: () => void; th: typeof THEMES[Theme];
  rules: RulesType; preferredStrategy?: 'BPS' | 'BCS' | 'IC';
}) {
  const [loading, setLoading] = useState(false);
  const [levelResults, setLevelResults] = useState<LevelResult[]>([]);
  const [error, setError] = useState('');

  const COURSE_RULES = { IVR_MIN: 30, OI_MIN: 500, BID_ASK_MAX: 0.10, CREDIT_RATIO_MIN: 0.33, ROC_MIN_SPREAD: 20, ROC_MIN_IC: 30 };
  const levels = [
    { presetKey: 'strict',    presetLabel: 'Strict',     presetColor: 'border-red-500 text-red-400',         rules: { IVR_MIN: 40, OI_MIN: 500, BID_ASK_MAX: 0.10, CREDIT_RATIO_MIN: 0.35, ROC_MIN_SPREAD: 25, ROC_MIN_IC: 35 } },
    { presetKey: 'course',    presetLabel: 'Course',     presetColor: 'border-blue-500 text-blue-400',       rules: COURSE_RULES },
    { presetKey: 'relaxed',   presetLabel: 'Relaxed',    presetColor: 'border-emerald-500 text-emerald-400', rules: { IVR_MIN: 25, OI_MIN: 300, BID_ASK_MAX: 0.15, CREDIT_RATIO_MIN: 0.28, ROC_MIN_SPREAD: 15, ROC_MIN_IC: 25 } },
    { presetKey: 'lowvol',    presetLabel: 'Low Vol',    presetColor: 'border-yellow-500 text-yellow-400',   rules: { IVR_MIN: 20, OI_MIN: 200, BID_ASK_MAX: 0.20, CREDIT_RATIO_MIN: 0.22, ROC_MIN_SPREAD: 12, ROC_MIN_IC: 20 } },
    { presetKey: 'shortterm', presetLabel: 'Short Term', presetColor: 'border-orange-500 text-orange-400',   rules: { IVR_MIN: 35, OI_MIN: 500, BID_ASK_MAX: 0.10, CREDIT_RATIO_MIN: 0.30, ROC_MIN_SPREAD: 15, ROC_MIN_IC: 22, DTE_MIN: 14, DTE_MAX: 28 } },
  ];

  const scoreCandidate = (result: ScreenResult, strat: string): BestSetup | null => {
    if (!result.qualified || !result.bestCandidate) return null;
    const c = result.bestCandidate;
    const score = (c.roc || 0) * 0.45 + ((c.pop || 70) * 0.35) + (c.creditRatio * 100 * 0.2);
    let grade: BestSetup['grade'] = 'C';
    if (score > 88) grade = 'A+'; else if (score > 75) grade = 'A'; else if (score > 60) grade = 'B';
    const notes: string[] = [];
    if (c.dte < 35) notes.push(`DTE is ${c.dte} — shorter side, watch 21 DTE closely`);
    if (c.dte < 29) notes.push(`⚠ Short term setup — active daily management required, gamma risk elevated`);
    if (result.ivr && result.ivr > 60) notes.push(`IVR ${result.ivr.toFixed(0)}% elevated — verify no binary event`);
    if (c.creditRatio > 0.45) notes.push(`Excellent credit ratio at ${(c.creditRatio * 100).toFixed(0)}% of width`);
    if (notes.length === 0) notes.push('Clean setup — all rules pass');
    return { strategy: strat, grade, setup: c, score, notes, result };
  };

  const findBest = async () => {
    setLoading(true); setError(''); setLevelResults([]);
    try {
      const token = await getAccessToken();
      const [metricsArray, price] = await Promise.all([getMarketMetrics([symbol], token), getQuote(symbol, token)]);
      const metrics = metricsArray[0] || { symbol, ivRank: null, earningsExpectedDate: null };
      const strategies: ('BPS' | 'BCS' | 'IC')[] = preferredStrategy
        ? [preferredStrategy, ...(['BPS', 'BCS', 'IC'] as const).filter(s => s !== preferredStrategy)]
        : ['BPS', 'BCS', 'IC'];
      const results: LevelResult[] = [];
      for (const level of levels) {
        const mergedRules = { ...rules, ...level.rules };
        const chainData = await getChain(symbol, token, mergedRules);
        const ruleDiffs = getRuleDiffs({ ...DEFAULT_RULES, ...COURSE_RULES }, level.rules);
        const candidates: BestSetup[] = [];
        const failures: { strategy: string; reasons: string[] }[] = [];
        for (const strat of strategies) {
          const result = runChecklist(symbol, strat, metrics, chainData, price, mergedRules);
          const setup = scoreCandidate(result, strat);
          if (setup) candidates.push(setup);
          else failures.push({ strategy: strat, reasons: result.failReasons.length > 0 ? result.failReasons : ['No qualifying strikes found'] });
        }
        results.push({ presetKey: level.presetKey, presetLabel: level.presetLabel, presetColor: level.presetColor, rulesUsed: mergedRules, ruleDiffs, ranked: candidates.sort((a, b) => b.score - a.score), failures });
      }
      setLevelResults(results);
    } catch (e: any) {
      setError(e.message || 'Failed to analyze chain');
    } finally {
      setLoading(false);
    }
  };

  const gradeColor = (g: string) => g === 'A+' ? 'text-emerald-400' : g === 'A' ? 'text-emerald-500' : g === 'B' ? 'text-yellow-400' : 'text-orange-400';

  return (
    <div className="fixed inset-0 bg-black flex items-center justify-center z-[60] p-4">
      <div className={`${th.sidebar} border ${th.border} rounded-2xl p-6 w-full max-w-2xl max-h-[92vh] overflow-auto`}>
        <div className="flex justify-between items-start mb-4">
          <div>
            <h2 className={`text-lg font-bold ${th.text}`}>Best Opportunity — {symbol}</h2>
            <p className={`text-[9px] ${th.textFaint} mt-0.5`}>
              Scans all 4 rule levels. Each level shows the best setup found and what changed vs Course.
              {preferredStrategy && <span> Preferred: <span className="text-blue-400 font-bold">{preferredStrategy}</span></span>}
            </p>
          </div>
          <button onClick={onClose} className="text-2xl text-slate-400 hover:text-white">✕</button>
        </div>

        <button onClick={findBest} disabled={loading}
          className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 rounded-xl font-bold text-sm tracking-widest transition-colors mb-4">
          {loading ? 'SCANNING ALL RULE LEVELS...' : 'SCAN ALL RULE LEVELS'}
        </button>

        {error && <div className="p-4 bg-red-500/10 border border-red-500 rounded-xl text-red-400 text-sm mb-4">{error}</div>}

        <div className="space-y-4">
          {levelResults.map(level => (
            <div key={level.presetKey} className={`border ${th.border} rounded-xl overflow-hidden`}>
              <div className={`flex items-center justify-between px-4 py-2.5 border-b ${th.border} ${th.card}`}>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-bold tracking-widest px-2 py-0.5 border rounded ${level.presetColor}`}>{level.presetLabel.toUpperCase()}</span>
                  {level.ruleDiffs.length === 0 ? (
                    <span className={`text-[9px] ${th.textFaint}`}>Course baseline — no changes</span>
                  ) : level.presetKey === 'strict' ? (
                    <span className="text-[9px] text-red-400">Tighter: {level.ruleDiffs.join(' · ')}</span>
                  ) : level.presetKey === 'shortterm' ? (
                    <span className="text-[9px] text-orange-400">14–28 DTE · requires active daily management</span>
                  ) : (
                    <span className="text-[9px] text-yellow-400">Relaxed vs Course: {level.ruleDiffs.join(' · ')}</span>
                  )}
                </div>
                {level.ranked.length > 0
                  ? <span className={`text-[10px] ${th.textFaint}`}>{level.ranked.length} setup{level.ranked.length !== 1 ? 's' : ''} found</span>
                  : <span className="text-[10px] text-slate-500">No setup found</span>}
              </div>

              {level.ranked.length > 0 ? (
                <div className="divide-y divide-[inherit]" style={{ borderColor: 'inherit' }}>
                  {level.ranked.map((setup, idx) => (
                    <div key={setup.strategy} className={`p-4 ${idx === 0 ? '' : 'opacity-80'}`}>
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center border ${idx === 0 ? 'border-emerald-500 text-emerald-400' : idx === 1 ? 'border-slate-500 text-slate-400' : 'border-slate-700 text-slate-500'}`}>{idx + 1}</span>
                          <span className={`text-xs font-bold px-2 py-0.5 border rounded ${setup.strategy === 'BPS' ? 'text-emerald-400 border-emerald-700' : setup.strategy === 'BCS' ? 'text-red-400 border-red-700' : 'text-blue-400 border-blue-700'}`}>{setup.strategy}</span>
                          <span className={`text-xs font-bold ${gradeColor(setup.grade)}`}>Grade {setup.grade}</span>
                          <span className={`text-[9px] ${th.textFaint}`}>score {setup.score.toFixed(1)}</span>
                        </div>
                        <button
                          onClick={() => { alert(`${setup.strategy} ${symbol} [${level.presetLabel} rules]\nExp: ${setup.setup.expiration} (${setup.setup.dte}d)\nStrikes: ${setup.setup.shortStrike}/${setup.setup.longStrike}\nCredit: $${(setup.setup.totalCredit ?? setup.setup.credit).toFixed(2)}\n50% target: $${((setup.setup.totalCredit ?? setup.setup.credit) * 0.5).toFixed(2)}`); }}
                          className="text-[9px] px-2 py-1 border border-emerald-600 text-emerald-400 rounded hover:bg-emerald-600/10 transition-colors font-medium tracking-wider"
                        >TRADE →</button>
                      </div>
                      <div className="grid grid-cols-4 gap-3 mb-2">
                        <div><p className={`text-[9px] ${th.textFaint} uppercase tracking-wider`}>Expiry</p><p className={`text-xs font-bold ${th.text}`}>{setup.setup.expiration} <span className="text-slate-500">({setup.setup.dte}d)</span></p></div>
                        <div><p className={`text-[9px] ${th.textFaint} uppercase tracking-wider`}>Strikes</p><p className={`text-xs font-bold ${th.text}`}>{setup.setup.shortStrike}/{setup.setup.longStrike}</p></div>
                        <div><p className={`text-[9px] ${th.textFaint} uppercase tracking-wider`}>Credit</p><p className="text-xs font-bold text-emerald-400">${(setup.setup.totalCredit ?? setup.setup.credit).toFixed(2)}</p></div>
                        <div><p className={`text-[9px] ${th.textFaint} uppercase tracking-wider`}>ROC / POP</p><p className={`text-xs font-bold ${th.text}`}>{setup.setup.roc.toFixed(0)}% / {setup.setup.pop?.toFixed(0) ?? '—'}%</p></div>
                      </div>
                      <div className="grid grid-cols-3 gap-3 mb-2">
                        <div><p className={`text-[9px] ${th.textFaint} uppercase tracking-wider`}>50% Target</p><p className="text-xs font-bold text-emerald-400">${((setup.setup.totalCredit ?? setup.setup.credit) * 0.5).toFixed(2)}</p></div>
                        <div><p className={`text-[9px] ${th.textFaint} uppercase tracking-wider`}>Credit Ratio</p><p className={`text-xs font-bold ${th.text}`}>{(setup.setup.creditRatio * 100).toFixed(0)}% of width</p></div>
                        <div><p className={`text-[9px] ${th.textFaint} uppercase tracking-wider`}>OI Short/Long</p><p className={`text-xs font-bold ${th.text}`}>{setup.setup.shortOI} / {setup.setup.longOI}</p></div>
                      </div>
                      <p className={`text-[9px] ${th.textFaint}`}>{setup.notes[0]}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-3 space-y-1.5">
                  {level.failures.map(f => (
                    <div key={f.strategy} className="flex items-start gap-2">
                      <span className={`text-[9px] px-1.5 py-0.5 border rounded font-bold shrink-0 ${f.strategy === 'BPS' ? 'text-emerald-400 border-emerald-800' : f.strategy === 'BCS' ? 'text-red-400 border-red-800' : 'text-blue-400 border-blue-800'}`}>{f.strategy}</span>
                      <p className={`text-[9px] ${th.textFaint}`}>{f.reasons.join(' · ')}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────
export default function Home() {
  const [theme, setTheme] = useState<Theme>(getSavedTheme);
  const th = THEMES[theme];

  const [autoTickers, setAutoTickers] = useState('');
  const autoFileRef = useRef<HTMLInputElement>(null);
  const [autoScanning, setAutoScanning] = useState(false);
  const autoPendingTickersRef = useRef<string[]>([]);
  const [bpsTickers, setBpsTickers] = useState('');
  const [bcsTickers, setBcsTickers] = useState('');
  const [icTickers, setIcTickers] = useState('');
  const [brokenTickers, setBrokenTickers] = useState('');
  const [results, setResults] = useState<ScreenResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [loadPrompt, setLoadPrompt] = useState<LoadPromptState>({ show: false, name: '', type: 'strategy' });
  const [runtimeStockRules, setRuntimeStockRules] = useState<RulesType>(getSavedRules);
  const [runtimeEtfRules, setRuntimeEtfRules] = useState<RulesType>(getSavedEtfRules);
  const [rankConfig, setRankConfig] = useState<RankConfig>(getSavedRankConfig);
  const [screenMode, setScreenMode] = useState<'filter' | 'rank'>(() => {
    try { return (localStorage.getItem(LS_SCREEN_MODE) as 'filter' | 'rank') ?? 'filter'; } catch { return 'filter'; }
  });
  const [sessionLoadedAt, setSessionLoadedAt] = useState<{ name: string; at: number } | null>(() => {
    try { const s = localStorage.getItem(LS_SESSION_LOADED_AT); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [stockPresetLabel, setStockPresetLabel] = useState<string>(() => {
    try { const k = localStorage.getItem(LS_ACTIVE_PRESET); return RULE_PRESETS.find(p => p.key === k)?.label ?? 'Custom'; } catch { return 'Custom'; }
  });
  const [etfPresetLabel, setEtfPresetLabel] = useState<string>(() => {
    try { const k = localStorage.getItem(LS_ACTIVE_PRESET_ETF); return RULE_PRESETS.find(p => p.key === k)?.label ?? 'ETF Custom'; } catch { return 'ETF Custom'; }
  });
  const [autoTrendEntries, setAutoTrendEntries] = useState<AutoTrendEntry[]>([]);

  useEffect(() => {
    try {
      setBpsTickers(localStorage.getItem(LS_BPS) || '');
      setBcsTickers(localStorage.getItem(LS_BCS) || '');
      setIcTickers(localStorage.getItem(LS_IC) || '');
      setBrokenTickers(localStorage.getItem(LS_BROKEN) || '');
    } catch {}
  }, []);

  const handleBpsChange = (v: string) => { setBpsTickers(v); try { localStorage.setItem(LS_BPS, v); } catch {} };
  const handleBcsChange = (v: string) => { setBcsTickers(v); try { localStorage.setItem(LS_BCS, v); } catch {} };
  const handleIcChange = (v: string) => { setIcTickers(v); try { localStorage.setItem(LS_IC, v); } catch {} };
  const handleBrokenChange = (v: string) => { setBrokenTickers(v); try { localStorage.setItem(LS_BROKEN, v); } catch {} };
  const handleGlobalLoad = (newBps: string, newBcs: string, newIc: string, newBroken: string) => { handleBpsChange(newBps); handleBcsChange(newBcs); handleIcChange(newIc); handleBrokenChange(newBroken); if (!newBps && !newBcs && !newIc && !newBroken) { setResults([]); setAutoTrendEntries([]); } };
  const showLoadPrompt = (state: Omit<LoadPromptState, 'show'>) => { setLoadPrompt({ show: true, ...state }); };

  const parseTickers = normalizeTickerInput;
  const autoTickerList = parseTickers(autoTickers);

  const downloadCSV = () => {
    const headers = ['Symbol','Strategy','Trend','Trend Subtype','Trend Confidence','Qualified','Price','IVR','Expiration','DTE','Short Put Strike','Long Put Strike','Put Width','Short Call Strike','Long Call Strike','Call Width','Short Delta','Credit','ROC%','POP%','Short OI','Long OI','Total Credit','Earnings Date','Fail Reasons'];
    const rows = results.map(r => { const c = r.bestCandidate; return [r.symbol,r.strategy,r.trendResult?.trend||'',r.trendResult?.subtype||'',r.trendResult?.confidence!=null?r.trendResult.confidence.toFixed(0)+'%':'',r.qualified?'YES':'NO',r.price?.toFixed(2)||'',r.ivr?.toFixed(1)||'',c?.expiration||'',c?.dte||'',c?.shortStrike||'',c?.longStrike||'',c?.spreadWidth||'',c?.shortCallStrike||'',c?.longCallStrike||'',c?.callWidth||'',c?.shortDelta?.toFixed(2)||'',c?.credit?.toFixed(2)||'',c?.roc?.toFixed(0)||'',c?.pop?.toFixed(0)||'',c?.shortOI||'',c?.longOI||'',c?.totalCredit?.toFixed(2)||'',r.earningsDate||'',r.failReasons.join('; ')].map(v=>`"${v}"`).join(','); });
    const blob = new Blob([[headers.join(','),...rows].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `prosper-screen-${new Date().toISOString().split('T')[0]}.csv`; a.click();
  };

  const runTrendDetectionWrapper = () => {
    runTrendDetection(
      autoTickers, bpsTickers, bcsTickers, icTickers, brokenTickers,
      handleBpsChange, handleBcsChange, handleIcChange, handleBrokenChange,
      setAutoTickers, setError, setStatus, setLoading, parseTickers,
      setAutoTrendEntries, showLoadPrompt
    );
  };

  const runScreen = async (sRules: RulesType, eRules: RulesType, sLabel?: string, eLabel?: string) => {
    setError('');
    setResults([]);
    setAutoTrendEntries([]);

    const autoList = parseTickers(autoTickers);
    const bps = parseTickers(bpsTickers);
    const bcs = parseTickers(bcsTickers);
    const ic = parseTickers(icTickers);

    if (!autoList.length && !bps.length && !bcs.length && !ic.length) {
      setError('Enter at least one ticker.');
      return;
    }

    setRuntimeStockRules(sRules);
    setRuntimeEtfRules(eRules);
    setLoading(true);

    try {
      setStatus('Getting access token...');
      const token = await getAccessToken();

      const allSymbols = Array.from(new Set([...autoList, ...bps, ...bcs, ...ic]));
      setStatus('Fetching market metrics...');
      const metricsArray = await getMarketMetrics(allSymbols, token);
      const metricsMap = Object.fromEntries(metricsArray.map((m: any) => [m.symbol, m]));

      const screenResults: ScreenResult[] = [];

      const errResult = (symbol: string, strategy: string, msg: string, trendResult?: TrendResult): ScreenResult => ({
        symbol, strategy, price: null, ivr: null, qualified: false, bestCandidate: null,
        failReasons: [msg], trendResult,
        checks: { ivr: { status: 'fail', value: 'Error', reason: msg }, earnings: { status: 'pending', value: '—', reason: '—' }, oi: { status: 'pending', value: '—', reason: '—' }, delta: { status: 'pending', value: '—', reason: '—' }, credit: { status: 'pending', value: '—', reason: '—' }, roc: { status: 'pending', value: '—', reason: '—' }, pop: { status: 'pending', value: '—', reason: '—' } }
      });

      // getChain uses the appropriate rule set for DTE filtering — pass stock rules as base,
      // runChecklist will auto-select ETF rules internally per ticker
      const getChainRules = (isEtfTicker: boolean) => isEtfTicker ? eRules : sRules;

      // Scan AUTO tickers (with trend detection)
      for (let i = 0; i < autoList.length; i++) {
        const symbol = autoList[i];
        setStatus(`Scanning ${symbol} (${i+1}/${autoList.length})...`);
        let trendResult: TrendResult | undefined;
        try { trendResult = await getTrend(symbol); } catch (e) { console.warn(e); }
        const strategy: 'BPS' | 'BCS' | 'IC' =
          trendResult?.strategy === 'BPS' || trendResult?.strategy === 'BCS' || trendResult?.strategy === 'IC'
            ? trendResult.strategy : 'IC';
        try {
          const metrics = metricsMap[symbol] || { symbol, ivRank: null, earningsExpectedDate: null };
          const isEtfTicker = INDEX_TICKERS.has(symbol.toUpperCase());
          const [chainData, price] = await Promise.all([getChain(symbol, token, getChainRules(isEtfTicker)), getQuote(symbol, token)]);
          screenResults.push(runChecklist(symbol, strategy, metrics, chainData, price, sRules, trendResult, sLabel, eRules, eLabel));
        } catch (e: any) {
          screenResults.push(errResult(symbol, strategy, e.message, trendResult));
        }
      }

      // Scan manual boxes
      for (const { symbols, strategy } of [
        { symbols: bps, strategy: 'BPS' as const },
        { symbols: bcs, strategy: 'BCS' as const },
        { symbols: ic, strategy: 'IC' as const }
      ]) {
        for (const symbol of symbols) {
          setStatus(`Scanning ${symbol}...`);
          try {
            const metrics = metricsMap[symbol] || { symbol, ivRank: null, earningsExpectedDate: null };
            const isEtfTicker = INDEX_TICKERS.has(symbol.toUpperCase());
            const [chainData, price] = await Promise.all([getChain(symbol, token, getChainRules(isEtfTicker)), getQuote(symbol, token)]);
            screenResults.push(runChecklist(symbol, strategy, metrics, chainData, price, sRules, undefined, sLabel, eRules, eLabel));
          } catch (e: any) {
            screenResults.push(errResult(symbol, strategy, e.message));
          }
        }
      }

      // Remove duplicates and sort
      const uniqueResults = screenResults.filter((r, index, self) =>
        index === self.findIndex(t => t.symbol === r.symbol && t.strategy === r.strategy)
      );

      if (screenMode === 'rank') {
        // Sort by score descending; no-candidate results go to the bottom
        uniqueResults.sort((a, b) => {
          const sA = a.bestCandidate ? (scoreCandidate(a, rankConfig)?.score ?? 0) : -1;
          const sB = b.bestCandidate ? (scoreCandidate(b, rankConfig)?.score ?? 0) : -1;
          return sB - sA;
        });
      } else {
        uniqueResults.sort((a, b) => {
          if (a.qualified && !b.qualified) return -1;
          if (!a.qualified && b.qualified) return 1;
          return (b.ivr ?? 0) - (a.ivr ?? 0);
        });
      }

      setResults(uniqueResults);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setStatus('');
      setLoading(false);
    }
  };

  const qualified = results.filter(r => r.qualified);
  const disqualified = results.filter(r => !r.qualified);

  return (
    <div className={`min-h-screen ${th.bg} text-slate-100 transition-colors duration-200`} style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      {/* Header */}
      <div className={`${th.header} border-b ${th.border} px-6 py-4 flex items-center justify-between`}>
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-base font-bold tracking-widest text-white" style={{ fontFamily: "'DM Mono', monospace" }}>OPTIONS HUNTER</h1>
            <p className="text-[10px] text-white/50 mt-0.5 tracking-wider" style={{ fontFamily: "'DM Mono', monospace" }}>BPS · BCS · IRON CONDOR</p>
          </div>
          <nav className="flex items-center gap-1 bg-black/20 rounded-lg p-1">
            <span className="text-xs px-3 py-1.5 rounded bg-white/20 text-white tracking-wider">HUNTER</span>
            <Link href="/portfolio" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">PORTFOLIO</Link>
          </nav>
          {/* Mode toggle in header */}
          <div className="flex items-center gap-1 bg-black/20 rounded-lg p-1">
            {(['filter', 'rank'] as const).map(mode => (
              <button key={mode} onClick={() => { setScreenMode(mode); try { localStorage.setItem(LS_SCREEN_MODE, mode); } catch {} }}
                className={`text-xs px-3 py-1.5 rounded transition-colors tracking-wider font-medium ${screenMode === mode ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white/80'}`}>
                {mode === 'filter' ? '⊘ Filter' : '⬡ Rank'}
              </button>
            ))}
          </div>
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
              <div className="flex items-center gap-1">
                <input ref={autoFileRef} type="file" accept="image/*" className="hidden" onChange={async (e) => {
                  const file = e.target.files?.[0]; if (!file) return; setAutoScanning(true);
                  try {
                    const tickers = await extractTickersFromImage(file);
                    if (tickers.length > 0) {
                      const hasExisting = autoTickers.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean).length > 0;
                      if (hasExisting) {
                        autoPendingTickersRef.current = tickers;
                        showLoadPrompt({
                          name: `${tickers.length} ticker${tickers.length !== 1 ? 's' : ''} from image`,
                          type: 'strategy',
                          onLoad: (doMerge: boolean) => {
                            if (doMerge) setAutoTickers(mergeTickers(autoTickers, autoPendingTickersRef.current));
                            else setAutoTickers(tickersToString(autoPendingTickersRef.current));
                          },
                        });
                      } else {
                        setAutoTickers(tickersToString(tickers));
                      }
                    } else {
                      setError('No tickers found in image');
                    }
                  } catch (err: any) {
                    console.error(err);
                    setError(`OCR error: ${err?.message ?? 'unknown'}`);
                  }
                  setAutoScanning(false);
                }} />
                <button onClick={() => { if (autoFileRef.current) autoFileRef.current.value = ''; autoFileRef.current?.click(); }} disabled={loading || autoScanning}
                  className={`text-[9px] px-1.5 py-0.5 border ${th.inputBorder} rounded ${th.textMuted} hover:border-blue-500 hover:text-blue-400 transition-colors disabled:opacity-40`}>
                  {autoScanning ? '⟳' : '↑ img'}
                </button>
                <span className={`text-[9px] font-medium ${th.textFaint}`}>{autoTickerList.length}</span>
              </div>
            </div>
            <textarea value={autoTickers} onChange={e => setAutoTickers(e.target.value)} placeholder="AAPL, MSFT, XOM&#10;auto-detects BPS/BCS/IC → assigns to boxes below"
              className={`w-full ${th.input} border ${th.inputBorder} rounded-lg p-2 text-xs ${th.text} h-16 resize-none focus:outline-none focus:border-purple-500 placeholder-slate-500 leading-relaxed`} />
            <div className="flex items-center justify-between mt-1">
              <p className={`text-[9px] ${th.textFaint}`}>Yahoo trend detection</p>
              <div className="flex items-center gap-1">
                {autoTickerList.length > 0 && (
                  <button
                    onClick={() => setAutoTickers('')}
                    disabled={loading}
                    className="text-[9px] px-2 py-1 border border-red-800 rounded text-red-500 hover:border-red-500 hover:text-red-400 transition-colors disabled:opacity-40 font-bold"
                  >
                    ✕
                  </button>
                )}
                <button
                  onClick={runTrendDetectionWrapper}
                  disabled={loading || autoTickerList.length === 0}
                  className="text-[9px] px-2 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded font-bold tracking-wider transition-colors disabled:opacity-40"
                >
                  {loading ? '...' : 'ANALYZE TRENDS'}
                </button>
              </div>
            </div>
          </div>

          <SessionsPanel bps={bpsTickers} bcs={bcsTickers} ic={icTickers} broken={brokenTickers} onLoadAll={handleGlobalLoad} onLoadPrompt={showLoadPrompt} onReclassify={runTrendDetectionWrapper} th={th} />

          <div className={`border-t ${th.border} pt-3 space-y-4`}>
            <p className={`text-[9px] ${th.textMuted} tracking-widest font-medium`}>SCAN LISTS</p>
            <StrategyBox label="BPS" badge="BULLISH" badgeColor="bg-emerald-500/15 text-emerald-500 border-emerald-500" borderFocus="focus:border-emerald-500" value={bpsTickers} onChange={handleBpsChange} strategy="BPS" disabled={loading} onLoadPrompt={showLoadPrompt} th={th} />
            <StrategyBox label="BCS" badge="BEARISH" badgeColor="bg-red-500/15 text-red-500 border-red-500" borderFocus="focus:border-red-500" value={bcsTickers} onChange={handleBcsChange} strategy="BCS" disabled={loading} onLoadPrompt={showLoadPrompt} th={th} />
            <StrategyBox label="IC" badge="NEUTRAL" badgeColor="bg-blue-500/15 text-blue-500 border-blue-500" borderFocus="focus:border-blue-500" value={icTickers} onChange={handleIcChange} strategy="IC" disabled={loading} onLoadPrompt={showLoadPrompt} th={th} />
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

          <button onClick={() => setShowRulesModal(true)} disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white py-2.5 rounded-lg text-xs font-bold tracking-widest transition-colors disabled:opacity-40 shadow-lg border border-blue-400/30">
            {loading ? 'SCANNING...' : 'RUN HUNTER'}
          </button>

          {/* Last Rules Used */}
          <div className={`text-[9px] space-y-1 border-t ${th.border} pt-3`}>
            <p className={`${th.textMuted} mb-2 tracking-widest font-medium`}>ACTIVE RULES</p>
            <div className="space-y-3">
              {[
                { label: '📈 Stock', rules: runtimeStockRules, preset: stockPresetLabel },
                { label: '🏦 ETF/Index', rules: runtimeEtfRules, preset: etfPresetLabel },
              ].map(({ label, rules, preset }) => (
                <div key={label}>
                  <p className={`${th.textFaint} font-bold mb-1`}>{label} <span className="font-normal opacity-60">({preset})</span></p>
                  {[
                    ['IVR', `≥ ${rules.IVR_MIN}%`],
                    ['DTE', `${rules.DTE_MIN}–${rules.DTE_MAX}d`],
                    ['Credit ratio', `≥ ${(rules.CREDIT_RATIO_MIN * 100).toFixed(0)}%`],
                    ['OI per leg', `≥ ${rules.OI_MIN}`],
                    ['Bid-Ask', `≤ $${rules.BID_ASK_MAX}`],
                    ['Max width', `$${rules.MAX_SPREAD_WIDTH}`],
                    ['Min ROC spread', `${rules.ROC_MIN_SPREAD}%`],
                    ['Min ROC IC', `${rules.ROC_MIN_IC}%`],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <span className={th.textFaint}>{k}</span>
                      <span className={`${th.textMuted} font-medium`}>{v}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Main content */}
        <div className="flex-1 overflow-auto p-5">

          {/* Stale session warning */}
          {sessionLoadedAt && (() => {
            const daysSince = (Date.now() - sessionLoadedAt.at) / (1000 * 60 * 60 * 24);
            if (daysSince < 2) return null;
            return (
              <div className="mb-4 px-4 py-3 border border-yellow-600/50 bg-yellow-500/8 rounded-lg flex items-start gap-3">
                <span className="text-yellow-400 text-sm mt-0.5">⚠</span>
                <div className="flex-1">
                  <p className="text-xs text-yellow-400 font-bold tracking-wider">STALE SESSION — "{sessionLoadedAt.name}"</p>
                  <p className="text-[10px] text-yellow-400/70 mt-0.5">
                    Loaded {Math.floor(daysSince)} day{Math.floor(daysSince) !== 1 ? 's' : ''} ago. Market conditions may have shifted — tickers could belong in different boxes now.
                  </p>
                </div>
                <button
                  onClick={() => { runTrendDetectionWrapper(); setSessionLoadedAt(null); try { localStorage.removeItem(LS_SESSION_LOADED_AT); } catch {} }}
                  className="text-[9px] px-3 py-1.5 border border-yellow-600 text-yellow-400 rounded hover:bg-yellow-500/10 transition-colors font-bold shrink-0 whitespace-nowrap">
                  ↻ Re-classify now
                </button>
                <button
                  onClick={() => { setSessionLoadedAt(null); try { localStorage.removeItem(LS_SESSION_LOADED_AT); } catch {} }}
                  className="text-yellow-600 hover:text-yellow-400 text-sm shrink-0">✕</button>
              </div>
            );
          })()}

          {results.length === 0 && !loading && autoTrendEntries.length === 0 && (
            <div className={`h-full flex flex-col items-center justify-center ${th.textFaint}`}>
              <div className="text-4xl mb-3 opacity-20">◈</div>
              <p className={`text-[10px] tracking-widest ${th.textMuted}`}>ADD TICKERS AND RUN HUNTER</p>
              <p className={`text-[9px] mt-2 ${th.textFaint}`}>Save sessions · Load scan lists · Upload Finviz screenshots</p>
            </div>
          )}
          {loading && <div className="h-full flex flex-col items-center justify-center gap-2"><div className={`text-[10px] tracking-widest ${th.textMuted} animate-pulse font-medium`}>{status || 'SCANNING...'}</div></div>}

          {/* Trend detect debug panel — shown after ANALYZE TRENDS, cleared when RUN HUNTER fires */}
          {!loading && autoTrendEntries.length > 0 && results.length === 0 && (
            <div className="space-y-4">
              <AutoTrendDebugPanel entries={autoTrendEntries} th={th} />
            </div>
          )}
          {results.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex gap-4 text-[10px] tracking-wider font-medium">
                  {screenMode === 'filter' ? (
                    <>
                      <span className="text-emerald-500">{qualified.length} QUALIFIED</span>
                      <span className={th.textFaint}>{disqualified.length} DISQUALIFIED</span>
                    </>
                  ) : (
                    <>
                      <span className="text-emerald-400">{results.filter(r => { const s = r.bestCandidate ? scoreCandidate(r, rankConfig)?.score ?? 0 : 0; return s >= rankConfig.thresholdGreen; }).length} 🟢</span>
                      <span className="text-yellow-400">{results.filter(r => { const s = r.bestCandidate ? scoreCandidate(r, rankConfig)?.score ?? 0 : 0; return s >= rankConfig.thresholdYellow && s < rankConfig.thresholdGreen; }).length} 🟡</span>
                      <span className="text-orange-400">{results.filter(r => { const s = r.bestCandidate ? scoreCandidate(r, rankConfig)?.score ?? 0 : 0; return s >= rankConfig.thresholdOrange && s < rankConfig.thresholdYellow; }).length} 🟠</span>
                      <span className="text-red-400">{results.filter(r => { const s = r.bestCandidate ? scoreCandidate(r, rankConfig)?.score ?? 0 : 0; return s < rankConfig.thresholdOrange; }).length} 🔴</span>
                    </>
                  )}
                  <span className={th.textFaint}>{results.length} SCANNED</span>
                </div>
                <div className="flex items-center gap-2">
                  {results.some(r => !r.qualified && r.earningsDate && daysUntil(r.earningsDate) >= 0 && r.failReasons.some(f => f.includes('Earnings'))) && (
                    <button onClick={() => {
                      const toSchedule = results.filter(r => !r.qualified && r.earningsDate && daysUntil(r.earningsDate) >= 0 && r.failReasons.some(f => f.includes('Earnings')));
                      const stored = (() => { try { const s = localStorage.getItem(LS_CAL); return s ? JSON.parse(s) : {}; } catch { return {}; } })();
                      toSchedule.forEach((r, i) => {
                        const key = `${r.symbol}-${r.earningsDate}`;
                        if (!stored[key]) {
                          setTimeout(() => window.open(buildEarningsCalUrl(r.symbol, r.strategy, r.earningsDate!, r.ivr), '_blank'), i * 300);
                          stored[key] = true;
                        }
                      });
                      try { localStorage.setItem(LS_CAL, JSON.stringify(stored)); } catch {}
                    }}
                    className={`text-[10px] px-3 py-1.5 border border-blue-700 rounded-lg text-blue-400 hover:border-blue-500 hover:text-blue-300 transition-colors tracking-wider`}>
                      📅 Schedule All Earnings Follow-ups
                    </button>
                  )}
                  <button onClick={downloadCSV} className={`text-[10px] px-3 py-1.5 border ${th.border} rounded-lg ${th.textMuted} hover:border-blue-500 hover:text-blue-400 transition-colors tracking-wider`}>↓ CSV</button>
                </div>
              </div>

              {screenMode === 'filter' && (
                <SmartSuggestionsPanel results={results} rules={runtimeStockRules} th={th} onApplyAndRerun={(r) => runScreen(r, runtimeEtfRules, stockPresetLabel, etfPresetLabel)} />
              )}

              {screenMode === 'filter' ? (
                <>
                  {qualified.length > 0 && (
                    <div>
                      <p className="text-[9px] text-emerald-500 tracking-widest mb-2 font-medium">QUALIFIED</p>
                      <div className="space-y-2">{qualified.map(r => <ResultCard key={`${r.symbol}-${r.strategy}`} result={r} th={th} rules={r.isEtf ? runtimeEtfRules : runtimeStockRules} screenMode={screenMode} rankConfig={rankConfig} />)}</div>
                    </div>
                  )}
                  {disqualified.length > 0 && (
                    <div>
                      <p className={`text-[9px] ${th.textFaint} tracking-widest mb-2 font-medium`}>DISQUALIFIED</p>
                      <div className="space-y-2">{disqualified.map(r => <ResultCard key={`${r.symbol}-${r.strategy}`} result={r} th={th} rules={r.isEtf ? runtimeEtfRules : runtimeStockRules} screenMode={screenMode} rankConfig={rankConfig} />)}</div>
                    </div>
                  )}
                </>
              ) : (
                <div>
                  <p className="text-[9px] text-purple-400 tracking-widest mb-2 font-medium">⬡ RANKED — ALL OPPORTUNITIES</p>
                  <div className="space-y-2">{results.map((r, i) => (
                    <div key={`${r.symbol}-${r.strategy}`} className="flex items-start gap-2">
                      <span className={`text-[9px] ${th.textFaint} w-5 text-right shrink-0 mt-4`}>{i + 1}</span>
                      <div className="flex-1"><ResultCard result={r} th={th} rules={r.isEtf ? runtimeEtfRules : runtimeStockRules} screenMode={screenMode} rankConfig={rankConfig} /></div>
                    </div>
                  ))}</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <LoadPromptModal state={loadPrompt} onClose={() => setLoadPrompt(p => ({ ...p, show: false }))} th={th} />
      {showRulesModal && <RulesModal stockRules={runtimeStockRules} etfRules={runtimeEtfRules} rankConfig={rankConfig} onClose={() => setShowRulesModal(false)} onRun={(sRules, eRules, sLabel, eLabel, rCfg) => { setShowRulesModal(false); setRuntimeStockRules(sRules); setRuntimeEtfRules(eRules); setStockPresetLabel(sLabel); setEtfPresetLabel(eLabel); setRankConfig(rCfg); runScreen(sRules, eRules, sLabel, eLabel); }} th={th} />}
    </div>
  );
}
