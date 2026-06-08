// app/portfolio/page.tsx

'use client';
import { THEMES, ACCENTS, Theme, Accent, LS_THEME, LS_ACCENT, getSavedTheme, getSavedAccent, applyAccent, injectAccentStyle } from '@/lib/theme';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';

// Inject accent CSS variable style
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
      nav a.active-nav, nav span.active-nav { background: rgba(var(--accent-r), var(--accent-g), var(--accent-b), 0.2); color: var(--accent); }
    `;
    document.head.appendChild(style);
  }
}

// Inject DM Sans font
if (typeof document !== 'undefined') {
  if (!document.getElementById('hunter-font')) {
    const link = document.createElement('link');
    link.id = 'hunter-font';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=DM+Mono:wght@400;500&display=swap';
    document.head.appendChild(link);
  }
}

const BASE = 'https://api.tastytrade.com';
const CLIENT_ID = '4d4c851b-bdaf-4ac9-b39b-811e604739f2';
const LS_PROFIT_TARGETS = 'hunter-profit-targets';
const LS_AUDIT_LOG = 'hunter-audit-log';
const LS_MEMORY = 'hunter-trading-memory';
const LS_DRY_RUN = 'hunter-dry-run';
const LS_WHEEL_CYCLES = 'hunter-wheel-cycles';

// ── Wheel Cycle Types ──────────────────────────────────────────────────────
interface WheelCC {
  id: string;
  entryDate: string;
  strike: number;
  expiry: string;
  premium: number;
  closedAt: number | null;
  status: 'open' | 'expired' | 'called_away' | 'closed';
}

interface WheelCycle {
  id: string;
  symbol: string;
  status: 'csp_open' | 'assigned' | 'cc_open' | 'called_away' | 'closed';
  cspEntryDate: string;
  cspStrike: number;
  cspExpiry: string;
  cspPremium: number;
  cspClosedAt: number | null;
  assignmentDate: string | null;
  assignmentPrice: number | null;
  sharesHeld: number | null;
  coveredCalls: WheelCC[];
  totalPremiumCollected: number;
  effectiveCostBasis: number | null;
  exitDate: string | null;
  exitPrice: number | null;
  totalPnl: number | null;
  dismissedBanner: boolean;
}

function readWheelCycles(): WheelCycle[] {
  try { return JSON.parse(localStorage.getItem(LS_WHEEL_CYCLES) ?? '[]'); } catch { return []; }
}
function writeWheelCycles(cycles: WheelCycle[]) {
  try { localStorage.setItem(LS_WHEEL_CYCLES, JSON.stringify(cycles)); } catch {}
}
function getWheelCycleForPos(pos: Position): WheelCycle | null {
  const cycles = readWheelCycles();
  return cycles.find(c =>
    c.symbol === pos.symbol &&
    c.cspExpiry === pos.expDate &&
    ['csp_open', 'assigned', 'cc_open'].includes(c.status)
  ) ?? null;
}
function startWheelCycle(pos: Position): WheelCycle {
  const cycles = readWheelCycles();
  const shortLeg = pos.legs.find(l => l.direction === 'Short');
  const creditPerContract = pos.creditReceived / 100;
  const cycle: WheelCycle = {
    id: crypto.randomUUID(),
    symbol: pos.symbol,
    status: 'csp_open',
    cspEntryDate: pos.entryDate ?? new Date().toISOString().slice(0, 10),
    cspStrike: shortLeg?.strikePrice ?? 0,
    cspExpiry: pos.expDate,
    cspPremium: creditPerContract,
    cspClosedAt: null,
    assignmentDate: null,
    assignmentPrice: null,
    sharesHeld: null,
    coveredCalls: [],
    totalPremiumCollected: creditPerContract,
    effectiveCostBasis: shortLeg ? shortLeg.strikePrice - creditPerContract : null,
    exitDate: null,
    exitPrice: null,
    totalPnl: null,
    dismissedBanner: false,
  };
  cycles.push(cycle);
  writeWheelCycles(cycles);
  return cycle;
}
function dismissWheelBanner(pos: Position) {
  const cycles = readWheelCycles();
  const idx = cycles.findIndex(c =>
    c.symbol === pos.symbol && c.cspExpiry === pos.expDate
  );
  if (idx >= 0) { cycles[idx].dismissedBanner = true; writeWheelCycles(cycles); }
}
const MEMORY_RAW_TRADES_PER_SYMBOL = 5;   // keep this many raw; summarize older
const MEMORY_RAW_ACTIONS = 20;            // ring buffer size for action history
const MEMORY_SUMMARIZE_INTERVAL_DAYS = 7; // re-summarize behavior weekly
const STALE_PRICE_THRESHOLD = 0.15; // 15% move triggers warning
const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MIN = 30;
const MARKET_CLOSE_HOUR = 16;

function isDryRun(): boolean {
  try { return localStorage.getItem(LS_DRY_RUN) === 'true'; } catch { return false; }
}
function setDryRun(val: boolean) {
  try { val ? localStorage.setItem(LS_DRY_RUN, 'true') : localStorage.removeItem(LS_DRY_RUN); } catch {}
}

// ── Types ──────────────────────────────────────────────────────────────────
type ActionType = 'HOLD' | 'WATCH' | 'MANAGE' | 'TAKE_PROFIT' | 'CUT_LOSSES' | 'CLOSE_ROLL' | 'PLACE_GTC';

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
  plOpen: number | null;
  targetPrice: number;
  profitTarget: number;
  maxRisk: number;
  hitTarget: boolean;
  needsClose: boolean;
  entryDte: number;
  entryDate: string | null;  // date position was opened (YYYY-MM-DD)
  accountNumber: string;
  // Greeks
  ivr: number | null;
  iv: number | null;          // current implied volatility %
  hv30: number | null;        // 30-day historical volatility %
  beta: number | null;        // beta to SPY
  netDelta: number | null;    // net position delta
  netVega: number | null;     // net position vega
  hasGtc: boolean;
  gtcOrderId: string | null;       // ID of the working profit-target GTC order
  gtcOrderPrice: number | null;    // current limit price on that GTC order
  stopLossStatus: StopStatus;
  stopLossPrice: number | null;
  stockPrice: number | null;
  buffer: number | null;
  theta: number | null;
  gamma: number | null;
  earningsDate: string | null; // next earnings only if on/before option expiration
}

interface PositionAnalysis {
  positionKey: string;
  symbol: string;
  loading: boolean;
  error: string | null;
  recommendation: 'HOLD' | 'CLOSE' | 'ROLL' | 'TAKE_PROFIT' | 'CUT_LOSSES' | 'WATCH' | 'MANAGE';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  summary: string;       // 1-2 sentence TL;DR
  reasoning: string;     // full reasoning paragraph
  risks: string[];       // 2-4 bullet risks
  catalysts: string[];   // 1-3 positive factors
  deviatesFromRules: boolean;
  deviationNote: string | null; // when AI recommends outside standard rules, explain why
  generatedAt: string;
}

interface PortfolioAnalysis {
  loading: boolean;
  error: string | null;
  netDelta: number | null;
  dominantRisk: string;
  sectorConcentration: string[];
  thetaYield: string;
  topRisks: string[];
  priorityActions: string[];
  marketContext: string;
  summary: string;
  generatedAt: string;
}

interface ActionVerdict {
  verdict: 'GO' | 'CAUTION' | 'STOP';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  headline: string;     // single punchy sentence — the gut-punch
  reasoning: string;    // 2-3 sentences of specific reasoning with numbers
  override?: boolean;   // trader consciously overriding a STOP
}

type EvaluatedAction = 'EXTEND_PROFIT' | 'CLOSE_ROLL' | 'TAKE_PROFIT' | 'CUT_LOSSES' | 'PLACE_GTC';

type StopStatus = 'live' | 'loose' | 'none' | 'unknown' | 'bypassed';

interface GtcOrderLeg { symbol: string; action: string; }
interface GtcOrder {
  id: string; price: string; stopPrice: string | null;
  orderType: string; timeInForce: string; legs: GtcOrderLeg[];
  complexOrderId?: string; // set when this order is part of a complex/OCO order
}
interface StopLossInfo { status: StopStatus; price: number | null; }

interface TrendResult {
  trend: 'uptrend' | 'downtrend' | 'sideways' | 'unknown';
  strategy: 'BPS' | 'BCS' | 'IC' | 'NO_TRADE';
  confidence: number;
  reason: string;
}

interface AuditEntry {
  id: string;
  timestamp: string;
  symbol: string;
  strategy: string;
  action: ActionType;
  orderType: string;
  limitPrice: number;
  quantity: number;
  orderId: string;
  status: 'submitted' | 'error' | 'dry-run';
  error?: string;
  estPnl?: number;
  closeProfitPct?: number;  // % profit captured on TAKE_PROFIT closes (e.g. 65 for 65%)
  creditAtClose?: number;   // credit per contract at time of close — used to back-calc pct
}

interface OrderLeg {
  symbol: string;
  quantity: number;
  action: 'Buy to Close' | 'Sell to Open' | 'Buy to Open' | 'Sell to Close';
  'instrument-type': 'Equity Option' | 'Index Option';
}
interface OrderBody {
  'order-type': 'Limit' | 'Market' | 'Stop' | 'Stop Limit';
  'time-in-force': 'GTC' | 'Day';
  price?: string;
  'price-effect'?: 'Debit' | 'Credit';
  legs: OrderLeg[];
}

interface BatchOrderItem {
  pos: Position;
  action: ActionType;
  orderBody: OrderBody;
  limitPrice: number;
  estPnl: number | null;
  stalePriceWarning: boolean;
  freshPrice: number | null;        // total value across all contracts × 100
  freshPerContract: number | null;  // per-contract spread value
  duplicateGtcWarning: boolean;
  priceError: string | null;        // null = ok, string = blocking error message
  // roll-specific
  rollExpiry?: string;
  rollShortStrike?: number;
  rollLongStrike?: number;
  rollCredit?: number;
  openOrderBody?: OrderBody;
}

interface OrderResult {
  symbol: string;
  action: ActionType;
  orderId: string;
  status: 'filled' | 'working' | 'rejected' | 'submitted' | 'error';
  error?: string;
  limitPrice: number;
  estPnl: number | null;
}

interface RollSuggestion {
  expiry: string;
  dte: number;
  shortStrike: number;
  longStrike: number;
  spreadWidth: number;
  credit: number;           // conservative estimate (mid * 0.7)
  creditMid: number;        // true mid (bid+ask)/2
  creditRatio: number;      // credit / spreadWidth — must be >= 1/3
  delta: number;
  shortSymbol: string;      // native OCC symbol from TastyTrade chain
  longSymbol: string;       // native OCC symbol from TastyTrade chain
  shortOi: number | null;
  longOi: number | null;
  shortBidAsk: number | null;   // ask - bid on short leg
  longBidAsk: number | null;    // ask - bid on long leg
  // Rule checks
  ruleViolations: string[];     // empty = all clear, strings = specific violations
  meetsMinCredit: boolean;      // credit >= 1/3 spread width
  meetsDte: boolean;            // 30-45 DTE
  meetsDelta: boolean;          // delta within strategy range
  meetsOi: boolean;             // OI >= 500 on both legs
  meetsBidAsk: boolean;         // bid-ask <= $0.10 on each leg
}

// ── Theme ──────────────────────────────────────────────────────────────────


// ── Futures Data ───────────────────────────────────────────────────────────
interface FuturesData {
  price: number;
  change: number;
  changePct: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  label: string;
  fetchedAt: string;
}

async function fetchFuturesData(): Promise<FuturesData | null> {
  try {
    const res = await fetch('/api/chart?symbol=ES%3DF', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    const bars: { c: number; o?: number }[] = data?.bars ?? [];
    if (bars.length < 2) return null;
    const latest = bars[bars.length - 1];
    const prev   = bars[bars.length - 2];
    const price     = latest.c;
    const open      = latest.o ?? prev.c;
    const change    = parseFloat((price - open).toFixed(2));
    const changePct = parseFloat(((change / open) * 100).toFixed(2));
    const bias: FuturesData['bias'] = changePct > 0.3 ? 'bullish' : changePct < -0.3 ? 'bearish' : 'neutral';
    const sign = change >= 0 ? '+' : '';
    return {
      price, change, changePct, bias,
      label: `ES ${price.toLocaleString()} ${sign}${changePct.toFixed(2)}%`,
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ── Market Hours ───────────────────────────────────────────────────────────
function isMarketOpen(): boolean {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const etOffset = -5 * 60; // EST (ignores DST — good enough for a guard)
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const etMin = utcMin + etOffset;
  const openMin = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN;
  const closeMin = MARKET_CLOSE_HOUR * 60;
  return etMin >= openMin && etMin < closeMin;
}

function getMarketStatus(): { open: boolean; label: string } {
  const open = isMarketOpen();
  return { open, label: open ? '● Market Open' : '○ Market Closed' };
}

// ── Audit Log ──────────────────────────────────────────────────────────────
function readAuditLog(): AuditEntry[] {
  try { return JSON.parse(localStorage.getItem(LS_AUDIT_LOG) ?? '[]'); } catch { return []; }
}

function writeAuditEntry(entry: AuditEntry) {
  try {
    const log = readAuditLog();
    log.unshift(entry);
    if (log.length > 500) log.length = 500; // cap at 500 entries
    localStorage.setItem(LS_AUDIT_LOG, JSON.stringify(log));
  } catch {}
}

function exportAuditCsv() {
  const log = readAuditLog();
  if (log.length === 0) return;
  const headers = ['Timestamp', 'Symbol', 'Strategy', 'Action', 'Order Type', 'Limit Price', 'Quantity', 'Order ID', 'Status', 'Est P&L', 'Close Profit %', 'Error'];
  const rows = log.map(e => [
    e.timestamp, e.symbol, e.strategy, e.action, e.orderType,
    e.limitPrice.toFixed(2), e.quantity, e.orderId, e.status,
    e.estPnl?.toFixed(2) ?? '', e.closeProfitPct?.toFixed(0) ?? '', e.error ?? ''
  ]);
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `hunter-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

// ── Smart GTC Default ─────────────────────────────────────────────────────
// Look up last 2-3 profitable TAKE_PROFIT closes for a symbol and average
// the closeProfitPct to suggest an informed default GTC percentage.
function getSmartGtcDefault(symbol: string): number {
  try {
    const log = readAuditLog();
    const relevant = log.filter(e =>
      e.symbol === symbol &&
      e.action === 'TAKE_PROFIT' &&
      e.status !== 'error' &&
      e.closeProfitPct != null &&
      e.closeProfitPct > 0
    );
    if (relevant.length === 0) return 0.50; // no history — default 50%
    const recent = relevant.slice(0, 3); // most recent 2-3
    const avg = recent.reduce((sum, e) => sum + (e.closeProfitPct ?? 50), 0) / recent.length;
    // Round to nearest 5% and clamp between 40-85%
    return Math.min(0.85, Math.max(0.40, Math.round(avg / 5) * 5)) / 100;
  } catch {
    return 0.50;
  }
}

// ── Trading Memory ─────────────────────────────────────────────────────────

interface TradeRecord {
  id: string;
  timestamp: string;        // ISO
  symbol: string;
  strategy: string;
  action: string;
  entryCredit: number;      // per-contract $ at entry (creditReceived / 100)
  exitPrice: number;        // limit price at close
  pnlPct: number;           // % of credit captured (positive = profit)
  dte: number;              // DTE when action taken
  ivr: number | null;
  buffer: number | null;
  aiVerdict: 'GO' | 'CAUTION' | 'STOP' | null;
  aiOverridden: boolean;    // trader overrode a STOP verdict
  outcome: 'WIN' | 'LOSS' | 'NEUTRAL'; // pnlPct >= 40 = WIN, <= -50 = LOSS
}

interface SymbolProfile {
  symbol: string;
  tradeCount: number;
  winRate: number;           // 0-1
  avgPnlPct: number;
  bestStrategy: string | null;
  ivrWinRange: [number, number] | null; // IVR range on winning trades
  earningsNote: string | null;          // free text from summarization
  recentTrades: TradeRecord[];          // last N raw trades
  historySummary: string | null;        // AI summary of older trades
  lastUpdated: string;
}

interface BehaviorProfile {
  totalTrades: number;
  overrideCount: number;
  overrideWins: number;       // overrides that turned out profitable
  ruleDeviationPatterns: string[];   // e.g. "holds past 21 DTE on IC"
  strengths: string[];
  weaknesses: string[];
  summary: string | null;    // AI-generated behavioral summary
  lastSummarized: string | null;
}

interface TradingMemory {
  symbolProfiles: Record<string, SymbolProfile>;
  behaviorProfile: BehaviorProfile;
  recentActions: TradeRecord[];   // ring buffer, last MEMORY_RAW_ACTIONS
  lastSummarized: string | null;
  version: number;
}

function emptyMemory(): TradingMemory {
  return {
    symbolProfiles: {},
    behaviorProfile: {
      totalTrades: 0, overrideCount: 0, overrideWins: 0,
      ruleDeviationPatterns: [], strengths: [], weaknesses: [],
      summary: null, lastSummarized: null,
    },
    recentActions: [],
    lastSummarized: null,
    version: 1,
  };
}

function readMemory(): TradingMemory {
  try {
    const raw = localStorage.getItem(LS_MEMORY);
    if (!raw) return emptyMemory();
    return { ...emptyMemory(), ...JSON.parse(raw) };
  } catch { return emptyMemory(); }
}

function writeMemory(mem: TradingMemory) {
  try { localStorage.setItem(LS_MEMORY, JSON.stringify(mem)); } catch {}
}

function recordTradeInMemory(
  pos: Position,
  action: string,
  limitPrice: number,
  verdict: ActionVerdict | null,
  overridden: boolean
) {
  const mem = readMemory();
  const pnlPct = pos.pnl != null && pos.creditReceived > 0
    ? (pos.pnl / pos.creditReceived) * 100 : 0;
  const outcome: TradeRecord['outcome'] = pnlPct >= 40 ? 'WIN' : pnlPct <= -50 ? 'LOSS' : 'NEUTRAL';

  const record: TradeRecord = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    symbol: pos.symbol,
    strategy: pos.strategy,
    action,
    entryCredit: pos.creditReceived / 100,
    exitPrice: limitPrice,
    pnlPct,
    dte: pos.dte,
    ivr: pos.ivr,
    buffer: pos.buffer,
    aiVerdict: verdict?.verdict ?? null,
    aiOverridden: overridden,
    outcome,
  };

  // Update symbol profile
  if (!mem.symbolProfiles[pos.symbol]) {
    mem.symbolProfiles[pos.symbol] = {
      symbol: pos.symbol, tradeCount: 0, winRate: 0, avgPnlPct: 0,
      bestStrategy: null, ivrWinRange: null, earningsNote: null,
      recentTrades: [], historySummary: null, lastUpdated: new Date().toISOString(),
    };
  }
  const profile = mem.symbolProfiles[pos.symbol];
  profile.recentTrades = [record, ...profile.recentTrades].slice(0, MEMORY_RAW_TRADES_PER_SYMBOL * 2);
  profile.tradeCount++;
  const allTrades = profile.recentTrades;
  const wins = allTrades.filter(t => t.outcome === 'WIN').length;
  profile.winRate = allTrades.length > 0 ? wins / allTrades.length : 0;
  profile.avgPnlPct = allTrades.length > 0
    ? allTrades.reduce((s, t) => s + t.pnlPct, 0) / allTrades.length : 0;
  profile.lastUpdated = new Date().toISOString();

  // Update behavior profile
  mem.behaviorProfile.totalTrades++;
  if (overridden) {
    mem.behaviorProfile.overrideCount++;
    if (outcome === 'WIN') mem.behaviorProfile.overrideWins++;
  }

  // Ring buffer for recent actions
  mem.recentActions = [record, ...mem.recentActions].slice(0, MEMORY_RAW_ACTIONS);

  writeMemory(mem);
  return mem;
}

function buildMemoryContext(symbol: string, action: string): string {
  const mem = readMemory();
  const lines: string[] = [];

  // Symbol-specific history
  const profile = mem.symbolProfiles[symbol];
  if (profile && profile.tradeCount > 0) {
    lines.push(`SYMBOL HISTORY — ${symbol}:`);
    lines.push(`  ${profile.tradeCount} trades | Win rate: ${Math.round(profile.winRate * 100)}% | Avg P&L: ${profile.avgPnlPct.toFixed(1)}%`);
    if (profile.bestStrategy) lines.push(`  Best strategy: ${profile.bestStrategy}`);
    if (profile.earningsNote) lines.push(`  Earnings pattern: ${profile.earningsNote}`);
    if (profile.historySummary) lines.push(`  History: ${profile.historySummary}`);
    if (profile.recentTrades.length > 0) {
      lines.push(`  Recent trades (newest first):`);
      profile.recentTrades.slice(0, MEMORY_RAW_TRADES_PER_SYMBOL).forEach(t => {
        const ago = Math.round((Date.now() - new Date(t.timestamp).getTime()) / 86400000);
        lines.push(`    ${ago}d ago: ${t.strategy} ${t.action} — ${t.pnlPct.toFixed(1)}% P&L at ${t.dte} DTE, IVR ${t.ivr ?? '?'}, buffer ${t.buffer?.toFixed(1) ?? '?'}% → ${t.outcome}${t.aiVerdict ? ` (AI said ${t.aiVerdict}${t.aiOverridden ? ', overridden' : ''})` : ''}`);
      });
    }
  }

  // Behavioral profile
  const bp = mem.behaviorProfile;
  if (bp.totalTrades > 0) {
    lines.push(`\nTRADER BEHAVIORAL PROFILE (${bp.totalTrades} total trades):`);
    if (bp.overrideCount > 0) {
      const overrideWinRate = bp.overrideCount > 0
        ? Math.round((bp.overrideWins / bp.overrideCount) * 100) : 0;
      lines.push(`  Overrode AI STOP verdicts ${bp.overrideCount} times — was right ${overrideWinRate}% of the time`);
    }
    if (bp.strengths.length > 0) lines.push(`  Strengths: ${bp.strengths.join(', ')}`);
    if (bp.weaknesses.length > 0) lines.push(`  Weaknesses: ${bp.weaknesses.join(', ')}`);
    if (bp.summary) lines.push(`  Pattern summary: ${bp.summary}`);
  }

  // Recent portfolio-wide actions for context
  const recentOther = mem.recentActions
    .filter(r => r.symbol !== symbol)
    .slice(0, 5);
  if (recentOther.length > 0) {
    lines.push(`\nRECENT OTHER TRADES (for portfolio context):`);
    recentOther.forEach(t => {
      const ago = Math.round((Date.now() - new Date(t.timestamp).getTime()) / 86400000);
      lines.push(`  ${ago}d ago: ${t.symbol} ${t.strategy} ${t.action} → ${t.outcome} (${t.pnlPct.toFixed(1)}%)`);
    });
  }

  return lines.length > 0 ? lines.join('\n') : '';
}

async function summarizeSymbolHistory(symbol: string): Promise<void> {
  const mem = readMemory();
  const profile = mem.symbolProfiles[symbol];
  if (!profile || profile.recentTrades.length <= MEMORY_RAW_TRADES_PER_SYMBOL) return;

  const toSummarize = profile.recentTrades.slice(MEMORY_RAW_TRADES_PER_SYMBOL);
  const prompt = `Summarize these trading history records for ${symbol} into 2-3 sentences. 
Focus on: patterns (what worked, what didn't), typical P&L range, IVR conditions, DTE behavior, any notable mistakes.
Be specific with numbers. Write in second person ("You typically...").

Records:
${toSummarize.map(t => `${t.strategy} ${t.action}: P&L ${t.pnlPct.toFixed(1)}%, DTE ${t.dte}, IVR ${t.ivr ?? '?'}, buffer ${t.buffer?.toFixed(1) ?? '?'}%, outcome ${t.outcome}`).join('\n')}

Existing summary to merge with (if any): ${profile.historySummary ?? 'none'}

Reply with ONLY the summary text, no JSON, no labels.`;

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        system: 'You are a concise trading journal summarizer. Respond with plain text only.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const summary = data?.content?.find((b: any) => b.type === 'text')?.text?.trim() ?? null;
    if (summary) {
      profile.historySummary = summary;
      profile.recentTrades = profile.recentTrades.slice(0, MEMORY_RAW_TRADES_PER_SYMBOL);
      writeMemory(mem);
    }
  } catch {}
}

async function summarizeBehaviorProfile(): Promise<void> {
  const mem = readMemory();
  const bp = mem.behaviorProfile;
  if (mem.recentActions.length < 5) return;

  const daysSince = mem.lastSummarized
    ? (Date.now() - new Date(mem.lastSummarized).getTime()) / 86400000
    : Infinity;
  if (daysSince < MEMORY_SUMMARIZE_INTERVAL_DAYS) return;

  const prompt = `Analyze these trading actions and behavioral data to identify patterns for this options trader.

STATS:
Total trades: ${bp.totalTrades}
AI override rate: ${bp.overrideCount} overrides out of ${bp.totalTrades} STOP verdicts
Override success rate: ${bp.overrideCount > 0 ? Math.round((bp.overrideWins / bp.overrideCount) * 100) : 0}%

RECENT ACTIONS (${mem.recentActions.length} records):
${mem.recentActions.map(t => `${t.symbol} ${t.strategy} ${t.action}: P&L ${t.pnlPct.toFixed(1)}%, DTE ${t.dte}, outcome ${t.outcome}${t.aiOverridden ? ' [overrode AI]' : ''}`).join('\n')}

Existing summary: ${bp.summary ?? 'none'}

Identify:
1. 1-2 clear strengths (what they do well consistently)
2. 1-2 clear weaknesses or recurring mistakes
3. One 3-sentence overall behavioral summary in second person

Reply as JSON: {"strengths": [...], "weaknesses": [...], "summary": "..."}`;

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: 'You are a trading coach analyzing a trader\'s patterns. Return JSON only.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const text = (data?.content?.find((b: any) => b.type === 'text')?.text ?? '')
      .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(text);
    bp.strengths = parsed.strengths ?? bp.strengths;
    bp.weaknesses = parsed.weaknesses ?? bp.weaknesses;
    bp.summary = parsed.summary ?? bp.summary;
    bp.lastSummarized = new Date().toISOString();
    mem.lastSummarized = new Date().toISOString();
    writeMemory(mem);
  } catch {}
}

function clearMemory() {
  try { localStorage.removeItem(LS_MEMORY); } catch {}
}

// ── Auth & API ─────────────────────────────────────────────────────────────
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

async function ttPost(path: string, token: string, body: unknown) {
  console.log('TT ORDER BODY:', JSON.stringify(body, null, 2));
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { sessionStorage.removeItem('tt_access_token'); window.location.href = '/login'; throw new Error('Session expired'); }
  const data = await res.json();
  console.log('TT ORDER RESPONSE:', JSON.stringify(data, null, 2));
  if (!res.ok) {
    const details = formatTastyTradeRejection(data);
    throw new Error(`Order rejected (${res.status}):\n${details}`);
  }
  return data;
}

async function cancelOrder(accountNumber: string, orderId: string, token: string, complexOrderId?: string) {
  // If part of a complex order, cancel the whole complex order
  const path = complexOrderId
    ? `${BASE}/accounts/${accountNumber}/complex-orders/${complexOrderId}`
    : `${BASE}/accounts/${accountNumber}/orders/${orderId}`;
  const res = await fetch(path, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (res.status === 401) {
    sessionStorage.removeItem('tt_access_token');
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const text = await res.text();
    console.error(`CANCEL RAW RESPONSE (${res.status}):`, text.slice(0, 500));
    throw new Error(`Cancel failed: ${text.slice(0, 200)}`);
  }
  const result = await res.json().catch(() => ({}));
  console.log('CANCEL RAW SUCCESS:', JSON.stringify(result).slice(0, 200));
  return result;
}

// TastyTrade supports a native dry-run: POST to same endpoint with ?dry-run=true
// Returns buying power effects and any errors without placing the order.
async function ttValidateOrder(path: string, token: string, body: unknown): Promise<{ valid: boolean; warnings: string[]; errors: string[] }> {
  try {
    const res = await fetch(`${BASE}${path}?dry-run=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    console.log('TT VALIDATE RESPONSE:', JSON.stringify(data, null, 2));
    const warnings = (data?.warnings ?? []).map((w: any) => w.message ?? String(w));
    const errors = (data?.errors ?? []).map((e: any) => e.message ?? String(e));
    if (!res.ok) {
      const errMsg =
        data?.error?.message ??
        data?.['error-message'] ??
        (Array.isArray(data?.error?.errors)
          ? data.error.errors.map((e: any) => `${e.domain ?? ''} ${e.reason ?? e.message ?? e}`).join('; ')
          : null) ??
        JSON.stringify(data?.error ?? data).slice(0, 200);
      return { valid: false, warnings, errors: [errMsg] };
    }
    return { valid: errors.length === 0, warnings, errors };
  } catch {
    return { valid: true, warnings: [], errors: [] };
  }
}

// ── Fresh Price Fetch ──────────────────────────────────────────────────────
async function fetchFreshPositionPrice(pos: Position, token: string): Promise<number | null> {
  try {
    const symbols = pos.legs.map(l => l.symbol);
    const qs = symbols.map(s => `equity-option=${encodeURIComponent(s)}`).join('&');
    const data = await ttFetch(`/market-data/by-type?${qs}`, token);
    const items: any[] = data?.data?.items ?? [];
    let total = 0;
    for (const leg of pos.legs) {
      const item = items.find((i: any) => i.symbol?.replace(/\s+/g, '') === leg.symbol?.replace(/\s+/g, ''));
      if (!item) return null;
      const bid = parseFloat(item.bid ?? '0');
      const ask = parseFloat(item.ask ?? '0');
      const mid = (bid + ask) / 2;
      total += leg.direction === 'Short' ? mid * leg.quantity : -(mid * leg.quantity);
    }
    return Math.abs(total * 100);
  } catch { return null; }
}

// ── Roll Chain Suggestion ──────────────────────────────────────────────────
async function fetchRollSuggestion(pos: Position, token: string, deltaOverride?: [number, number]): Promise<RollSuggestion | null> {
  try {
    const optType = pos.strategy === 'BCS' ? 'C' : 'P';
    const savedRules = (() => {
      try { return JSON.parse(localStorage.getItem('hunter-etf-rules') ?? '{}'); } catch { return {}; }
    })();
    const dMin = deltaOverride?.[0] ?? savedRules.SPREAD_DELTA_MIN ?? 0.20;
    const dMax = deltaOverride?.[1] ?? savedRules.SPREAD_DELTA_MAX ?? 0.25;
    const targetDelta = pos.strategy === 'BCS' ?  ((dMin + dMax) / 2) : -((dMin + dMax) / 2);
    const deltaMin    = pos.strategy === 'BCS' ?  dMin : -dMax;
    const deltaMax    = pos.strategy === 'BCS' ?  dMax : -dMin;

    // Step 1: get expirations, find one in 30-45 DTE window
    const chainData = await ttFetch(`/option-chains/${encodeURIComponent(pos.symbol)}/expirations`, token);
    const expirations: any[] = chainData?.data?.items ?? [];

    const today = new Date();
    // Sort by DTE ascending, find first in 30-45 window (prefer closest to 38 DTE)
    const candidates = expirations
      .map((e: any) => ({
        expiry: e['expiration-date'],
        dte: Math.round((new Date(e['expiration-date']).getTime() - today.getTime()) / 86400000),
      }))
      .filter(e => e.dte >= 28 && e.dte <= 50)
      .sort((a, b) => Math.abs(a.dte - 38) - Math.abs(b.dte - 38)); // prefer 38 DTE

    if (candidates.length === 0) return null;
    const { expiry, dte } = candidates[0];

    // Step 2: fetch full chain for that expiry — use nested format which includes greeks + OI
    const strikeData = await ttFetch(
      `/option-chains/${encodeURIComponent(pos.symbol)}/nested?expiration-date=${expiry}`,
      token
    );
    const expiryItems: any[] = strikeData?.data?.items ?? [];
    const matchedExpiry = expiryItems.find((item: any) => item['expiration-date'] === expiry);
    const strikes: any[] = matchedExpiry?.strikes ?? [];
    
    // DEBUG: check delta sign convention from TastyTrade
    if (strikes.length > 0) {
      const sample = strikes[Math.floor(strikes.length / 2)]; // pick a middle strike
      console.log(`DELTA CHECK ${pos.symbol}: put delta=${sample?.put?.delta} call delta=${sample?.call?.delta} strike=${sample?.['strike-price']}`);
    }
    
    // Step 3: find best short strike — closest to target delta, within range
    const origShort = pos.legs.find(l => l.direction === 'Short');
    const origLong  = pos.legs.find(l => l.direction === 'Long');
    if (!origShort || !origLong) return null;
    const width = Math.abs(origShort.strikePrice - origLong.strikePrice);

    let best: any = null;
    let bestDiff = Infinity;
    for (const s of strikes) {
    const leg = s[optType === 'P' ? 'put' : 'call'];
    if (!leg) continue;
    const delta = parseFloat(leg?.delta ?? '0');
    // Skip strikes outside the acceptable delta range
    if (delta < Math.min(deltaMin, deltaMax) || delta > Math.max(deltaMin, deltaMax)) continue;
    const diff = Math.abs(delta - targetDelta);
    if (diff < bestDiff) {
      bestDiff = diff;        
      best = {
          strike: s['strike-price'],
          delta,
          bid:  parseFloat(leg?.bid  ?? '0'),
          ask:  parseFloat(leg?.ask  ?? '0'),
          oi:   parseInt(leg?.['open-interest'] ?? leg?.['oi'] ?? '0', 10),
          symbol: leg?.symbol ?? null,   // native OCC symbol from TastyTrade
        };
      }
    }
    if (!best) return null;

    const shortStrike = best.strike;
    const longStrike = pos.strategy === 'BCS' ? shortStrike + width : shortStrike - width;

    // Step 4: find long leg data from chain for OI + bid-ask + native symbol
    let longLegData: any = null;
    for (const s of strikes) {
      if (s['strike-price'] === longStrike) {
        const leg = s[optType === 'P' ? 'put' : 'call'];
        if (leg) {
          longLegData = {
            bid:  parseFloat(leg?.bid  ?? '0'),
            ask:  parseFloat(leg?.ask  ?? '0'),
            oi:   parseInt(leg?.['open-interest'] ?? leg?.['oi'] ?? '0', 10),
            symbol: leg?.symbol ?? null,
          };
        }
        break;
      }
    }

    // Step 5: compute credit values
    const shortMid = (best.bid + best.ask) / 2;
    const longMid  = longLegData ? (longLegData.bid + longLegData.ask) / 2 : 0;
    const creditMid = parseFloat((shortMid - longMid).toFixed(2));
    const credit    = parseFloat((creditMid * 0.85).toFixed(2)); // 85% of mid — realistic limit
    const creditRatio = width > 0 ? creditMid / width : 0;

    // Step 6: build native OCC symbols — prefer chain symbols, fall back to builder
    const shortSymbol = best.symbol ?? buildOccSymbol(pos.symbol, expiry, optType, shortStrike);
    const longSymbol  = longLegData?.symbol ?? buildOccSymbol(pos.symbol, expiry, optType, longStrike);

    // Step 7: bid-ask spreads per leg
    const shortBidAsk = parseFloat((best.ask - best.bid).toFixed(2));
    const longBidAsk  = longLegData ? parseFloat((longLegData.ask - longLegData.bid).toFixed(2)) : null;

    // Step 8: Rule validation
    const ruleViolations: string[] = [];
    const meetsMinCredit = creditRatio >= (1/3);
    const meetsDte       = dte >= 30 && dte <= 45;
    const meetsDelta     = best.delta >= Math.min(deltaMin, deltaMax) && best.delta <= Math.max(deltaMin, deltaMax);
    const meetsOi        = (best.oi >= 500) && (longLegData == null || longLegData.oi >= 500);
    const meetsBidAsk    = shortBidAsk <= 0.10 && (longBidAsk == null || longBidAsk <= 0.10);

    if (!meetsMinCredit) ruleViolations.push(`Credit $${creditMid.toFixed(2)} < 1/3 of $${width} spread ($${(width/3).toFixed(2)} min) — not worth rolling`);
    if (!meetsDte)       ruleViolations.push(`DTE ${dte} outside 30-45 window`);
    if (!meetsDelta)     ruleViolations.push(`Delta ${best.delta.toFixed(2)} outside ${pos.strategy === 'BCS' ? '0.20-0.30' : '-0.20 to -0.30'} range`);
    if (!meetsOi)        ruleViolations.push(`OI too low — short: ${best.oi}, long: ${longLegData?.oi ?? '?'} (need ≥500)`);
    if (!meetsBidAsk)    ruleViolations.push(`Bid-ask too wide — short: $${shortBidAsk.toFixed(2)}, long: $${longBidAsk?.toFixed(2) ?? '?'} (need ≤$0.10)`);

    console.log(`ROLL SUGGESTION ${pos.symbol}: expiry=${expiry} DTE=${dte} short=${shortStrike} long=${longStrike} credit=$${credit} creditMid=$${creditMid} ratio=${creditRatio.toFixed(2)} violations=${ruleViolations.length}`);

    return {
      expiry, dte, shortStrike, longStrike, spreadWidth: width,
      credit, creditMid, creditRatio, delta: best.delta,
      shortSymbol, longSymbol,
      shortOi: best.oi || null,
      longOi: longLegData?.oi || null,
      shortBidAsk, longBidAsk,
      ruleViolations, meetsMinCredit, meetsDte, meetsDelta, meetsOi, meetsBidAsk,
    };
  } catch (e) {
    console.error('fetchRollSuggestion failed:', e);
    return null;
  }
}

// ── Roll validation helper ─────────────────────────────────────────────────
function rollIsBlocking(suggestion: RollSuggestion): boolean {
  // Only block on hard rule violations — soft warnings can be overridden
  return !suggestion.meetsMinCredit || !suggestion.meetsDte;
}

// ── OCC Symbol Builder ─────────────────────────────────────────────────────
function buildOccSymbol(underlying: string, expiry: string, optType: 'P' | 'C', strike: number): string {
  const exp = expiry.replace(/-/g, '').slice(2); // YYMMDD
  const under = underlying.padEnd(6, ' ');
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${under}${exp}${optType}${strikeStr}`;
}

function instrType(symbol: string): 'Equity Option' | 'Index Option' {
  return ['SPX', 'NDX', 'RUT', 'VIX'].includes(symbol.toUpperCase().trim()) ? 'Index Option' : 'Equity Option';
}

// ── Order Builders ─────────────────────────────────────────────────────────
function buildCloseOrder(pos: Position, limitPrice: number, tif: 'GTC' | 'Day' = 'Day'): OrderBody {
  const itype = instrType(pos.symbol);
  const effectiveTif = (!isMarketOpen() && tif === 'Day') ? 'GTC' : tif;
  // TastyTrade REST API price convention:
  // Negative = debit (you pay to close), Positive = credit (you receive to open)
  // A closing spread order is a debit — we pay to buy back what we sold.
  // Use price-effect: Debit with a POSITIVE price value (the absolute amount).
  // Both formats have been seen in the wild; using positive + price-effect is safest.
  // TastyTrade rejects Market orders on multi-leg spreads.
  // Always use Limit. Floor at $0.01 — TT accepts this as a valid close price
  // and will fill at market when the spread is essentially worthless.
  const safePrice = Math.max(limitPrice, 0.01);
  return {
    'order-type': 'Limit',
    'time-in-force': effectiveTif,
    price: safePrice.toFixed(2),
    'price-effect': 'Debit',
    legs: pos.legs.map(leg => ({
      symbol: leg.symbol,
      quantity: leg.quantity,
      action: leg.direction === 'Short' ? 'Buy to Close' : 'Sell to Close',
      'instrument-type': itype,
    })),
  };
}

function buildOpenSpreadOrder(
  underlying: string, expiry: string, optType: 'P' | 'C',
  shortStrike: number, longStrike: number, quantity: number, credit: number,
  shortSymbolOverride?: string, longSymbolOverride?: string
): OrderBody {
  const itype = instrType(underlying);
  // Prefer native OCC symbols from TastyTrade chain (guaranteed correct format)
  // Fall back to builder only if chain symbols aren't available
  const shortSym = shortSymbolOverride ?? buildOccSymbol(underlying, expiry, optType, shortStrike);
  const longSym  = longSymbolOverride  ?? buildOccSymbol(underlying, expiry, optType, longStrike);
  console.log(`BUILD OPEN SPREAD: short=${shortSym} long=${longSym} credit=$${credit} qty=${quantity}`);
  return {
    'order-type': 'Limit',
    'time-in-force': 'GTC',
    price: Math.abs(credit).toFixed(2),
    'price-effect': 'Credit',
    legs: [
      { symbol: shortSym, quantity, action: 'Sell to Open', 'instrument-type': itype },
      { symbol: longSym,  quantity, action: 'Buy to Open',  'instrument-type': itype },
    ],
  };
}

// ── Position Loading ───────────────────────────────────────────────────────
function parseOptionSymbol(sym: string): { optionType: 'P' | 'C'; strikePrice: number } {
  const match = sym.trim().replace(/\s+/g, '').match(/^([A-Z/]+)(\d{6})([CP])(\d{8})$/);
  if (!match) return { optionType: 'C', strikePrice: 0 };
  return { optionType: match[3] as 'P' | 'C', strikePrice: parseInt(match[4], 10) / 1000 };
}


function calculateSpreadCredit(legs: Pick<PositionLeg, 'direction' | 'quantity' | 'avgOpenPrice'>[]): number {
  // Returns the actual net opening credit for the whole position in dollars.
  // TT leg prices are per-share option prices; multiply by contracts * 100.
  const net = legs.reduce((sum, leg) => {
    const qty = Math.abs(Number(leg.quantity) || 0);
    const price = Number(leg.avgOpenPrice) || 0;
    return sum + (leg.direction === 'Short' ? price * qty : -price * qty);
  }, 0);
  return Math.max(0, Math.round(net * 100 * 100) / 100);
}

function sideGrossRisk(
  shorts: PositionLeg[],
  longs: PositionLeg[],
  side: 'P' | 'C'
): number {
  // Gross risk before credit for verticals on one side, in dollars.
  // For puts: short strike should be above long strike. For calls: short strike should be below long strike.
  const availableLongs = longs
    .filter(l => l.optionType === side && l.strikePrice > 0 && l.quantity > 0)
    .map(l => ({ ...l, remainingQty: Math.abs(l.quantity) }))
    .sort((a, b) => side === 'P' ? b.strikePrice - a.strikePrice : a.strikePrice - b.strikePrice);

  let gross = 0;
  const orderedShorts = shorts
    .filter(s => s.optionType === side && s.strikePrice > 0 && s.quantity > 0)
    .sort((a, b) => side === 'P' ? b.strikePrice - a.strikePrice : a.strikePrice - b.strikePrice);

  for (const short of orderedShorts) {
    let remainingShortQty = Math.abs(short.quantity);
    for (const long of availableLongs) {
      if (remainingShortQty <= 0) break;
      if (long.remainingQty <= 0) continue;
      const protects = side === 'P'
        ? long.strikePrice < short.strikePrice
        : long.strikePrice > short.strikePrice;
      if (!protects) continue;

      const matchedQty = Math.min(remainingShortQty, long.remainingQty);
      gross += Math.abs(short.strikePrice - long.strikePrice) * 100 * matchedQty;
      remainingShortQty -= matchedQty;
      long.remainingQty -= matchedQty;
    }

    // If any short contracts are unprotected, treat them as naked risk for margin display.
    // This keeps the number conservative instead of incorrectly showing $0 risk.
    if (remainingShortQty > 0) gross += short.strikePrice * 100 * remainingShortQty;
  }

  return gross;
}

function calculateMaxRisk(legs: PositionLeg[], creditReceived: number, strategy: string): number {
  const shorts = legs.filter(l => l.direction === 'Short');
  const longs = legs.filter(l => l.direction === 'Long');

  const putGross = sideGrossRisk(shorts, longs, 'P');
  const callGross = sideGrossRisk(shorts, longs, 'C');

  let grossRisk = 0;
  if (strategy === 'IC') {
    // An iron condor can only lose on one side at expiration, so use the larger side, not both.
    grossRisk = Math.max(putGross, callGross);
  } else if (strategy === 'BPS' || strategy === 'PUT') {
    grossRisk = putGross;
  } else if (strategy === 'BCS' || strategy === 'CALL') {
    grossRisk = callGross;
  } else {
    grossRisk = putGross + callGross;
  }

  return Math.max(0, Math.round((grossRisk - Math.abs(creditReceived)) * 100) / 100);
}

function normalizeOccSymbol(symbol: string): string { return String(symbol ?? '').replace(/\s+/g, '').trim(); }
function normalizeOrderAction(action: string): string { return String(action ?? '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase(); }
function isBuyToCloseAction(action: string): boolean { const n = normalizeOrderAction(action); return n === 'buy to close' || n === 'btc'; }
function isStopOrder(order: GtcOrder): boolean { return Boolean(order.stopPrice) || order.orderType.toLowerCase().includes('stop'); }

function pickOrderField(o: any, keys: string[]): string | null {
  for (const key of keys) { const v = o?.[key]; if (v !== undefined && v !== null && String(v).trim() !== '') return String(v); }
  return null;
}

function mapGtcOrder(o: any, parentTif?: string, parentComplexId?: string): GtcOrder {
  // Collect legs from direct legs array OR from nested orders' legs (automation/complex orders)
  let legs = (o?.legs ?? []).map((l: any) => ({ symbol: normalizeOccSymbol(String(l?.symbol ?? '')), action: String(l?.action ?? '') }));
  if (legs.length === 0) {
    for (const nested of o?.orders ?? []) {
      const nestedLegs = (nested?.legs ?? []).map((l: any) => ({ symbol: normalizeOccSymbol(String(l?.symbol ?? '')), action: String(l?.action ?? '') }));
      legs = legs.concat(nestedLegs);
    }
  }
  const tif = String(o?.['time-in-force'] ?? o?.timeInForce ?? parentTif ?? '');
  // complex-order-id comes from TT on individual orders; parentComplexId comes from collectRawOrders
  const complexOrderId = o?.['complex-order-id']
    ? String(o['complex-order-id'])
    : parentComplexId
    ? String(parentComplexId)
    : undefined;
  console.log(`MAP_GTC_ORDER id=${o?.id} complex-order-id=${o?.['complex-order-id']} parentComplexId=${parentComplexId} resolved=${complexOrderId}`);
  return {
    id: String(o?.id ?? ''),
    price: String(o?.price ?? o?.['limit-price'] ?? ''),
    stopPrice: pickOrderField(o, ['stop-trigger', 'stop-price', 'stopPrice', 'stop', 'trigger-price']),
    orderType: String(o?.['order-type'] ?? o?.orderType ?? ''),
    timeInForce: tif,
    legs,
    complexOrderId,
  };
}

function collectRawOrders(raw: any): any[] {
  const out: any[] = [];
  const visit = (order: any, parentTif?: string, parentComplexId?: string) => {
    if (!order || typeof order !== 'object') return;
    const tif = String(order?.['time-in-force'] ?? order?.timeInForce ?? parentTif ?? '');
    // Collect this order if it has direct legs
    if (Array.isArray(order.legs) && order.legs.length > 0) {
      // Inject complex-order-id from parent if not already set on the order
      const complexId = order['complex-order-id'] ?? parentComplexId;
      out.push({ ...order, 'complex-order-id': complexId, _inheritedTif: tif, _parentComplexId: parentComplexId });
    }
    // For complex/automation orders: also collect as a combined order with all nested legs merged
    if (Array.isArray(order.orders) && order.orders.length > 0) {
      const allLegs: any[] = [];
      for (const nested of order.orders) allLegs.push(...(nested?.legs ?? []));
      if (allLegs.length > 0) {
        out.push({ ...order, legs: allLegs, _inheritedTif: tif, _isCombined: true });
      }
      // Pass this order's ID as the parentComplexId to its nested orders
      const thisComplexId = String(order.id ?? parentComplexId ?? '');
      for (const nested of order.orders) visit(nested, tif, thisComplexId);
    }
  };
  for (const item of raw?.data?.items ?? []) visit(item);
  return out;
}

function findProfitGtcOrder(positionLegs: PositionLeg[], gtcOrders: GtcOrder[]): GtcOrder | null {
  // Find a GTC limit order (not a stop) that has Buy to Close on the short leg.
  // Also matches automation/complex orders where legs are combined from sub-orders.
  const shortLeg = positionLegs.find(l => l.direction === 'Short');
  if (!shortLeg?.symbol) return null;
  const shortSymbol = normalizeOccSymbol(shortLeg.symbol);
  return gtcOrders.find(order =>
    !isStopOrder(order) &&
    (order.orderType.toLowerCase().includes('limit') || order.orderType === '') &&
    order.legs.some(leg =>
      normalizeOccSymbol(leg.symbol) === shortSymbol && isBuyToCloseAction(leg.action)
    )
  ) ?? null;
}

async function ttPatch(path: string, token: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { sessionStorage.removeItem('tt_access_token'); window.location.href = '/login'; throw new Error('Session expired'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? data?.['error-message'] ?? `PATCH ${path} failed (${res.status})`);
  return data;
}

async function fetchAllComplexOrders(accountNumber: string, token: string): Promise<any> {
  // Paginate through all complex orders — TT defaults to 10/page
  const allItems: any[] = [];
  let page = 0;
  while (true) {
    const data = await ttFetch(`/accounts/${accountNumber}/complex-orders?page-offset=${page}&per-page=50`, token);
    const items = data?.data?.items ?? [];
    allItems.push(...items);
    const pagination = data?.pagination;
    if (!pagination || page >= (pagination['total-pages'] ?? 1) - 1) break;
    page++;
  }
  return { data: { items: allItems } };
}

async function fetchGtcOrders(accountNumber: string, token: string): Promise<GtcOrder[]> {
  try {
    // Use /orders/live only — it returns working + recent 24h orders.
    // ?status=Open and ?per-page=250 are invalid params that return 400.
    const [liveResult, complexResult] = await Promise.allSettled([
      ttFetch(`/accounts/${accountNumber}/orders/live`, token),
      fetchAllComplexOrders(accountNumber, token),
    ]);

    // Build a map from individual order ID → complex order ID
    // Orders from /orders/live don't have complex-order-id, but we can look them up
    // by matching their ID against nested orders in the complex orders response
    const individualToComplexId: Record<string, string> = {};
    if (complexResult.status === 'fulfilled') {
      for (const complexOrder of complexResult.value?.data?.items ?? []) {
        const complexId = String(complexOrder.id);
        for (const nestedOrder of complexOrder.orders ?? []) {
          if (nestedOrder.id) {
            individualToComplexId[String(nestedOrder.id)] = complexId;
          }
        }
      }
    }

    const requests = [liveResult, complexResult];
    const rawOrders = requests.flatMap(r => r.status === 'fulfilled' ? collectRawOrders(r.value) : []);
    // Inject complexOrderId for orders that came from /orders/live
    rawOrders.forEach(o => {
      if (!o['complex-order-id'] && individualToComplexId[String(o.id)]) {
        o['complex-order-id'] = individualToComplexId[String(o.id)];
      }
    });
    const seen = new Set<string>();
    return rawOrders.map(o => mapGtcOrder(o, o._inheritedTif, o._parentComplexId)).filter(order => {
      const tif = order.timeInForce.toUpperCase();
      const type = order.orderType.toLowerCase();
      // Parent OCO envelope has no tif/type — check nested sub-orders
      // Accept if any nested order has GTC tif, or if tif is empty (parent envelope)
      const isGtcTif = tif === 'GTC' || tif === '' || tif === 'PENDING';
      const isLimitOrStop = type.includes('limit') || type.includes('stop') || type === '';
      if ((!isGtcTif || !isLimitOrStop) && order.legs.length === 0) return false;
      if (order.legs.length === 0) return false;
      const key = `${order.id}|${order.orderType}|${order.price}|${order.stopPrice ?? ''}|${order.legs.map(l => `${l.symbol}:${l.action}`).join(',')}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  } catch { return []; }
}

function classifyPositionStopLoss(position: Pick<Position, 'legs' | 'creditReceived'>, gtcOrders: GtcOrder[], currentValueTotal?: number): StopLossInfo {
  const shortLeg = position.legs.find(l => l.direction === 'Short');
  if (!shortLeg?.symbol) return { status: 'unknown', price: null };
  const qty = shortLeg.quantity > 0 ? shortLeg.quantity : 1;
  const creditPerContract = position.creditReceived / (qty * 100);
  const stopThreshold = parseFloat((creditPerContract * 2).toFixed(2));
  const shortSymbol = normalizeOccSymbol(shortLeg.symbol);
  const match = gtcOrders.find(order =>
    isStopOrder(order) && order.legs.some(leg => normalizeOccSymbol(leg.symbol) === shortSymbol && isBuyToCloseAction(leg.action))
  );
  if (!match) return { status: 'none', price: null };
  const orderPrice = parseFloat(match.stopPrice ?? match.price);
  if (isNaN(orderPrice)) return { status: 'unknown', price: null };

  // Detect bypassed stop: stop trigger exists but current spread value has already blown past it.
  // This means the order gapped through and never filled — it's sitting useless.
  if (currentValueTotal != null) {
    const currentPerContract = currentValueTotal / (qty * 100);
    if (currentPerContract > orderPrice + 0.01) {
      return { status: 'bypassed', price: orderPrice };
    }
  }

  return orderPrice <= stopThreshold + 0.02 ? { status: 'live', price: orderPrice } : { status: 'loose', price: orderPrice };
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
    const key = `${pos['underlying-symbol']}::${pos['expires-at']?.slice(0, 10) ?? 'unknown'}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(pos);
  }

  const allOptionSymbols = optionPositions.map((p: any) => p.symbol).filter(Boolean);
  const currentPrices: Record<string, number> = {};
  const thetaMap: Record<string, number> = {};
  const gammaMap: Record<string, number> = {};
  const deltaMap: Record<string, number> = {};
  const vegaMap:  Record<string, number> = {};
  if (allOptionSymbols.length > 0) {
    try {
      for (let i = 0; i < allOptionSymbols.length; i += 50) {
        const chunk = allOptionSymbols.slice(i, i + 50);
        const qs = chunk.map((s: string) => `equity-option=${encodeURIComponent(s)}`).join('&');
        const priceData = await ttFetch(`/market-data/by-type?${qs}`, token);
        for (const item of priceData?.data?.items ?? []) {
          const sym = item.symbol?.replace(/\s+/g, '');
          if (!sym) continue;
          const bid = parseFloat(item.bid ?? '0');
          const ask = parseFloat(item.ask ?? '0');
          const mark = parseFloat(item.mark ?? item['mark-price'] ?? '0');
          const mid = (bid + ask) / 2;
          currentPrices[sym] = mid > 0 ? mid : mark > 0 ? mark : 0;
          const theta = parseFloat(item.theta ?? 'NaN');
          const gamma = parseFloat(item.gamma ?? 'NaN');
          const delta = parseFloat(item.delta ?? 'NaN');
          const vega  = parseFloat(item.vega  ?? 'NaN');
          if (!isNaN(theta)) thetaMap[sym] = theta;
          if (!isNaN(gamma)) gammaMap[sym] = gamma;
          if (!isNaN(delta)) deltaMap[sym] = delta;
          if (!isNaN(vega))  vegaMap[sym]  = vega;
        }
      }
    } catch {}
  }

  const ivrMap: Record<string, number | null> = {};
  const ivMap:  Record<string, number | null> = {};
  const hv30Map: Record<string, number | null> = {};
  const betaMap: Record<string, number | null> = {};
  const earningsMap: Record<string, string | null> = {};
  try {
    const underlyingSymbols: string[] = (optionPositions as any[]).map((p: any) => String(p['underlying-symbol'])).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
    const metricsData = await ttFetch(`/market-metrics?symbols=${encodeURIComponent(underlyingSymbols.join(','))}`, token);
    for (const item of metricsData?.data?.items ?? []) {
      const sym = item['symbol'];
      // IVR
      const rawIvr = item['implied-volatility-index-rank'] ?? item['iv-rank'] ?? null;
      const parsedIvr = rawIvr != null ? parseFloat(String(rawIvr)) : NaN;
      if (!isNaN(parsedIvr)) ivrMap[sym] = parsedIvr < 1 ? Math.round(parsedIvr * 100) : Math.round(parsedIvr);
      // IV (current implied volatility as %)
      const rawIv = item['implied-volatility'] ?? item['iv'] ?? item['implied-volatility-30-day'] ?? item['iv-30-day'] ?? null;
      const parsedIv = rawIv != null ? parseFloat(String(rawIv)) : NaN;
      if (!isNaN(parsedIv)) ivMap[sym] = parsedIv < 1 ? Math.round(parsedIv * 100) : Math.round(parsedIv);
      // HV30
      const rawHv = item['hv-30'] ?? item['historical-volatility-30'] ?? item['hv30'] ?? item['historical-volatility'] ?? null;
      const parsedHv = rawHv != null ? parseFloat(String(rawHv)) : NaN;
      if (!isNaN(parsedHv)) hv30Map[sym] = parsedHv < 1 ? Math.round(parsedHv * 100) : Math.round(parsedHv);
      // Debug: log raw metrics for indexes so we can see what fields come back
      if (['SPX','NDX','RUT','VIX'].includes(sym)) {
        console.log(`METRICS ${sym}:`, JSON.stringify(item).slice(0, 500));
      }
      // Beta
      const rawBeta = item['beta'] ?? item['beta-60-day'] ?? null;
      const parsedBeta = rawBeta != null ? parseFloat(String(rawBeta)) : NaN;
      if (!isNaN(parsedBeta)) betaMap[sym] = parsedBeta;
      // Earnings — next earnings date within 60 days
      const earningsRaw = item['earnings'] ?? item['next-earnings-date'] ?? null;
      if (earningsRaw) {
        const eDate = String(earningsRaw?.['expected-report-date'] ?? earningsRaw ?? '');
        if (eDate && eDate.match(/\d{4}-\d{2}-\d{2}/)) earningsMap[sym] = eDate;
      }
    }
  } catch {}

  const stockPrices: Record<string, number | null> = {};
  try {
    const underlyingSymbols: string[] = (optionPositions as any[]).map((p: any) => String(p['underlying-symbol'])).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
    const indexSymbols = underlyingSymbols.filter(s => ['SPX','NDX','RUT','VIX','DJX'].includes(s.toUpperCase()));
    const equitySymbols = underlyingSymbols.filter(s => !['SPX','NDX','RUT','VIX','DJX'].includes(s.toUpperCase()));
    const qsParts: string[] = [
      ...equitySymbols.map(s => `equity=${encodeURIComponent(s)}`),
      ...indexSymbols.map(s => `index=${encodeURIComponent(s)}`),
    ];
    if (qsParts.length > 0) {
      const stockData = await ttFetch(`/market-data/by-type?${qsParts.join('&')}`, token);
      for (const item of stockData?.data?.items ?? []) {
        const bid = parseFloat(item.bid ?? '0'); const ask = parseFloat(item.ask ?? '0');
        const mark = parseFloat(item.mark ?? item['mark-price'] ?? '0');
        const mid = (bid + ask) / 2;
        stockPrices[item.symbol] = mid > 0 ? mid : mark > 0 ? mark : 0;
      }
    }
  } catch {}

  const gtcOrders = await fetchGtcOrders(accountNumber, token);
  const gtcSymbols = new Set<string>();
  for (const order of gtcOrders) for (const leg of order.legs) {
    const parsed = parseOptionSymbol(leg.symbol);
    if (parsed.strikePrice > 0) gtcSymbols.add(leg.symbol.split(/\d{6}/)[0].trim());
  }

  try {
    const liveData = await Promise.allSettled([
      ttFetch(`/accounts/${accountNumber}/orders/live`, token),
    ]);
    const allOrders = (liveData[0].status === 'fulfilled' ? liveData[0].value?.data?.items : null) ?? [];
    for (const order of allOrders) {
      const status = (order['status'] ?? '').toLowerCase();
      if (['working', 'live', 'contingent', 'received', 'pending', 'queued'].includes(status)) {
        for (const leg of order.legs ?? []) {
          const sym = leg['underlying-symbol'] ?? leg.symbol ?? '';
          if (sym) gtcSymbols.add(sym.split(' ')[0].trim());
        }
      }
    }
  } catch {}

  try {
    const complexData = await fetchAllComplexOrders(accountNumber, token);
    for (const order of complexData?.data?.items ?? []) {
      // Parent OCO envelope has no status/tif/type — check nested sub-orders instead
      const nestedOrders: any[] = order.orders ?? [];
      const hasActiveNested = nestedOrders.some(no => {
        const s = (no['status'] ?? '').toLowerCase();
        return ['working', 'live', 'contingent', 'received', 'routed', 'pending', 'queued'].includes(s);
      });
      // Also accept if parent has no terminal-at (still open) and has nested orders
      const parentActive = !order['terminal-at'] && nestedOrders.length > 0;
      console.log(`COMPLEX ORDER: id=${order.id} hasActiveNested=${hasActiveNested} parentActive=${parentActive} nestedStatuses=${nestedOrders.map((o:any) => o['status']).join(',')}`);
      if (hasActiveNested || parentActive) {
        for (const nestedOrder of nestedOrders) for (const leg of nestedOrder.legs ?? []) {
          // Prefer underlying-symbol; fall back to parsing the OCC option symbol
          const underlying = leg['underlying-symbol'];
          if (underlying) {
            const sym = underlying.split(' ')[0].trim();
            gtcSymbols.add(sym);
            // Also add SPX↔SPXW variants
            if (sym === 'SPXW') gtcSymbols.add('SPX');
            if (sym === 'SPX') gtcSymbols.add('SPXW');
            console.log(`COMPLEX LEG underlying=${underlying} added=${sym}`);
          } else if (leg.symbol) {
            // OCC format: SPX   260726P07290000 — split on first digit sequence
            const fromOcc = leg.symbol.split(/\d{6}/)[0].trim();
            if (fromOcc) {
              gtcSymbols.add(fromOcc);
              if (fromOcc === 'SPXW') gtcSymbols.add('SPX');
              if (fromOcc === 'SPX') gtcSymbols.add('SPXW');
              console.log(`COMPLEX LEG occ=${leg.symbol} added=${fromOcc}`);
            }
          }
        }
      }
    }
  } catch {}

  const plBySymbol: Record<string, number> = {};
  try {
    const plData = await ttFetch(`/accounts/${accountNumber}/positions?include-marks=true`, token);
    for (const item of plData?.data?.items ?? []) {
      const sym = item['underlying-symbol']; if (!sym) continue;
      const expDate = item['expires-at']?.slice(0, 10) ?? 'unknown';
      const key = `${sym}::${expDate}`;
      const qty = parseFloat(item['quantity'] ?? '1');
      const multiplier = parseFloat(item['multiplier'] ?? '100');
      const avgOpen = parseFloat(item['average-open-price'] ?? '0');
      const markRaw = parseFloat(item['mark-price'] ?? '0');
      const closeRaw = parseFloat(item['close-price'] ?? '0');
      const mark = markRaw !== 0 ? markRaw : closeRaw;
      const dir = item['quantity-direction'] === 'Short' ? -1 : 1;
      plBySymbol[key] = (plBySymbol[key] ?? 0) + dir * (mark - avgOpen) * qty * multiplier;
    }
  } catch {}

  let profitTargets: Record<string, number> = {};
  try { profitTargets = JSON.parse(localStorage.getItem(LS_PROFIT_TARGETS) ?? '{}'); } catch {}

  const today = new Date();
  const positions: Position[] = Object.entries(groups).map(([key, legs]) => {
    const [symbol, expDate] = key.split('::');
    const dte = Math.round((new Date(expDate).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    const openedAt = legs[0]?.['created-at']?.slice(0, 10) ?? null;
    const entryDte = openedAt ? Math.round((new Date(expDate).getTime() - new Date(openedAt).getTime()) / (1000 * 60 * 60 * 24)) : dte;
    const putLegs = legs.filter((l: any) => parseOptionSymbol(l.symbol).optionType === 'P');
    const callLegs = legs.filter((l: any) => parseOptionSymbol(l.symbol).optionType === 'C');
    let strategy = 'UNKNOWN';
    if (putLegs.length >= 2 && callLegs.length === 0) strategy = 'BPS';
    else if (callLegs.length >= 2 && putLegs.length === 0) strategy = 'BCS';
    else if (putLegs.length >= 2 && callLegs.length >= 2) strategy = 'IC';
    else if (putLegs.length === 1) strategy = 'PUT';
    else if (callLegs.length === 1) strategy = 'CALL';

    const positionLegs: PositionLeg[] = legs.map((l: any) => {
      const parsed = parseOptionSymbol(l.symbol);
      return {
        symbol: l.symbol, optionType: parsed.optionType, strikePrice: parsed.strikePrice,
        direction: l['quantity-direction'] as 'Short' | 'Long',
        quantity: parseInt(l['quantity'] ?? '1', 10),
        avgOpenPrice: parseFloat(l['average-open-price'] ?? '0'),
        currentPrice: currentPrices[l.symbol?.replace(/\s+/g, '')] ?? null,
      };
    });

    const creditReceived = calculateSpreadCredit(positionLegs);

    let currentValue = 0; let hasCurrentPrices = true;
    for (const leg of legs) {
      const qty = parseInt(leg['quantity'] ?? '1', 10);
      const price = currentPrices[leg.symbol?.replace(/\s+/g, '')];
      if (price == null) { hasCurrentPrices = false; break; }
      currentValue += leg['quantity-direction'] === 'Short' ? price * qty : -(price * qty);
    }
    currentValue = currentValue * 100;

    const pnl = hasCurrentPrices ? Math.abs(creditReceived) - Math.abs(currentValue) : null;
    const pnlPct = creditReceived !== 0 && pnl != null ? (pnl / Math.abs(creditReceived)) * 100 : null;
    const profitTarget = profitTargets[key] ?? 0.5;
    const targetPrice = Math.abs(creditReceived) * profitTarget;
    const hitTarget = hasCurrentPrices && pnl != null && pnl >= Math.abs(creditReceived) * profitTarget;

    // Stop loss tracking only applies to defined-risk spreads (BPS/BCS/IC).
    // CSPs and single-leg positions (PUT/CALL) have no spread width to stop out of.
    const isSpread = strategy === 'BPS' || strategy === 'BCS' || strategy === 'IC';
    const currentValueForStop = hasCurrentPrices ? Math.abs(currentValue) : undefined;
    const stopLoss = isSpread
      ? classifyPositionStopLoss({ legs: positionLegs, creditReceived: Math.abs(creditReceived) }, gtcOrders, currentValueForStop)
      : { status: 'unknown' as const, price: null };

    // Only treat earnings as relevant if it occurs on or before this position's expiration.
    // Tastytrade market-metrics can return the next earnings date within ~60 days;
    // that is NOT the same as "earnings within expiry."
    const rawEarningsDate = earningsMap[symbol] ?? null;
    // Use string comparison (YYYY-MM-DD) — avoids UTC midnight timezone shifts
    // that cause new Date() comparisons to misclassify same-day or next-day earnings
    const earningsWithinExpiry = rawEarningsDate && rawEarningsDate <= expDate
      ? rawEarningsDate
      : null;

    return {
      key, symbol, expDate, dte, strategy, legs: positionLegs,
      creditReceived: Math.abs(creditReceived),
      currentValue: hasCurrentPrices ? Math.abs(currentValue) : null,
      pnl, pnlPct, targetPrice, profitTarget, hitTarget,
      plOpen: plBySymbol[key] != null ? Math.round(plBySymbol[key] * 100) / 100 : null,
      maxRisk: calculateMaxRisk(positionLegs, creditReceived, strategy),
      entryDte, entryDate: openedAt, needsClose: entryDte > 21 && dte <= 21, accountNumber,
      ivr: ivrMap[symbol] ?? null,
      iv: ivMap[symbol] ?? null,
      hv30: hv30Map[symbol] ?? null,
      beta: betaMap[symbol] ?? null,
      earningsDate: earningsWithinExpiry,
      hasGtc: (() => {
        // Check both the position symbol and its weekly option variant
        // SPX positions may have SPXW option legs; SPXW positions may have SPXW legs
        if (gtcSymbols.has(symbol)) { console.log(`HASGТС ${symbol}: direct match`); return true; }
        // Map underlying to possible OCC prefix variants
        const variants: Record<string, string> = { 'SPX': 'SPXW', 'NDX': 'NDXP', 'RUT': 'RUTW', 'VIX': 'VIXW' };
        const reverseVariants: Record<string, string> = { 'SPXW': 'SPX', 'NDXP': 'NDX', 'RUTW': 'RUT', 'VIXW': 'VIX' };
        const variant = variants[symbol] ?? reverseVariants[symbol];
        const result = variant ? gtcSymbols.has(variant) : false;
        console.log(`HASGTC ${symbol}: variant=${variant} result=${result} gtcSymbols=[${Array.from(gtcSymbols).join(',')}]`);
        return result;
      })(),
      gtcOrderId: (() => {
        const match = findProfitGtcOrder(positionLegs, gtcOrders);
        return match?.id ?? null;
      })(),
      gtcComplexOrderId: (() => {
        const match = findProfitGtcOrder(positionLegs, gtcOrders);
        return match?.complexOrderId ?? null;
      })(),
      gtcOrderPrice: (() => {
        const match = findProfitGtcOrder(positionLegs, gtcOrders);
        return match ? parseFloat(match.price) || null : null;
      })(),
      stopLossStatus: stopLoss.status, stopLossPrice: stopLoss.price,
      stockPrice: stockPrices[symbol] ?? null,
      buffer: (() => {
        const stock = stockPrices[symbol];
        if (stock == null) return null;
        const shorts = legs.filter((l: any) => l['quantity-direction'] === 'Short');
        if (!shorts[0]) return null;
        const shortStrike = parseOptionSymbol(shorts[0].symbol).strikePrice;
        const optType = parseOptionSymbol(shorts[0].symbol).optionType;
        return optType === 'P' ? ((stock - shortStrike) / stock) * 100 : ((shortStrike - stock) / stock) * 100;
      })(),
      theta: (() => {
        let net = 0; let any = false;
        for (const l of legs) {
          const val = thetaMap[l.symbol?.replace(/\s+/g, '')];
          if (val == null) continue;
          const qty = parseInt(l['quantity'] ?? '1', 10);
          net += l['quantity-direction'] === 'Short' ? Math.abs(val) * qty : -Math.abs(val) * qty;
          any = true;
        }
        return any ? parseFloat(net.toFixed(4)) : null;
      })(),
      gamma: (() => {
        let net = 0; let any = false;
        for (const l of legs) {
          const val = gammaMap[l.symbol?.replace(/\s+/g, '')];
          if (val == null) continue;
          const qty = parseInt(l['quantity'] ?? '1', 10);
          net += l['quantity-direction'] === 'Short' ? -Math.abs(val) * qty : Math.abs(val) * qty;
          any = true;
        }
        return any ? parseFloat(net.toFixed(4)) : null;
      })(),
      netDelta: (() => {
        let net = 0; let any = false;
        for (const l of legs) {
          const val = deltaMap[l.symbol?.replace(/\s+/g, '')];
          if (val == null) continue;
          const qty = parseInt(l['quantity'] ?? '1', 10);
          net += l['quantity-direction'] === 'Short' ? -val * qty : val * qty;
          any = true;
        }
        return any ? parseFloat(net.toFixed(4)) : null;
      })(),
      netVega: (() => {
        let net = 0; let any = false;
        for (const l of legs) {
          const val = vegaMap[l.symbol?.replace(/\s+/g, '')];
          if (val == null) continue;
          const qty = parseInt(l['quantity'] ?? '1', 10);
          net += l['quantity-direction'] === 'Short' ? -Math.abs(val) * qty : Math.abs(val) * qty;
          any = true;
        }
        return any ? parseFloat(net.toFixed(4)) : null;
      })(),
    };
  });

  const actionPriority: Record<string, number> = { CLOSE_ROLL: 0, CUT_LOSSES: 1, TAKE_PROFIT: 2, MANAGE: 3, WATCH: 4, HOLD: 5 };
  positions.sort((a, b) => {
    if (a.needsClose && !b.needsClose) return -1;
    if (!a.needsClose && b.needsClose) return 1;
    const aRec = getRecommendation(a, null).action;
    const bRec = getRecommendation(b, null).action;
    const aPri = actionPriority[aRec] ?? 9;
    const bPri = actionPriority[bRec] ?? 9;
    if (aPri !== bPri) return aPri - bPri;
    return a.dte - b.dte;
  });
  return positions;
}

// ── Recommendation Engine ──────────────────────────────────────────────────
interface Recommendation { action: ActionType; detail: string; }

// Classifies risk of holding past 21 DTE based on delta and buffer.
// Blanket CLOSE_ROLL only applies to high-risk profiles; low/medium get WATCH.
function classify21DteRisk(pos: Position): 'low' | 'medium' | 'high' {
  const absDelta = Math.abs(pos.netDelta ?? 0.30);
  const buffer   = pos.buffer ?? 0;
  if (absDelta < 0.10 && buffer > 5)  return 'low';
  if (absDelta < 0.15 && buffer > 3)  return 'medium';
  return 'high';
}

// Returns true when this was intentionally entered as a short-dated trade
function isShortDateEntry(pos: Position): boolean {
  return pos.entryDte <= 21;
}

function getRecommendation(pos: Position, trend: TrendResult | null): Recommendation {
  const pnlPct = pos.pnl != null && pos.creditReceived !== 0 ? (pos.pnl / pos.creditReceived) * 100 : 0;
  const shortPuts  = pos.legs.filter(l => l.optionType === 'P' && l.direction === 'Short');
  const shortCalls = pos.legs.filter(l => l.optionType === 'C' && l.direction === 'Short');
  const targetPct = pos.profitTarget * 100;
  const trendAgainst = trend && ((pos.strategy === 'BPS' && trend.trend === 'downtrend') || (pos.strategy === 'BCS' && trend.trend === 'uptrend'));
  const trendAligns = trend && ((pos.strategy === 'BPS' && trend.trend === 'uptrend') || (pos.strategy === 'BCS' && trend.trend === 'downtrend') || (pos.strategy === 'IC' && trend.trend === 'sideways'));
  const shortDate = isShortDateEntry(pos);
  const breached = pos.buffer != null && pos.buffer <= 0;
  const criticalBuffer = pos.buffer != null && pos.buffer < 2;
  const veryLargeLoss = pnlPct <= -200;
  const shortQty = Math.abs(pos.legs.find(l => l.direction === 'Short')?.quantity ?? 1);
  // stopLossPrice is a per-spread/per-contract option price (e.g. 1.56 = $156 per contract).
  // currentValue is the total buyback value for the whole position, so scale the stop by contracts.
  const stopLossBreached = pos.stopLossPrice != null && pos.currentValue != null && shortQty > 0
    ? pos.currentValue >= (pos.stopLossPrice * 100 * shortQty)
    : false;

  // needsClose only fires for standard entries (entryDte > 21) — short-dated entries skip this.
  // Risk-adjust the recommendation: low delta + wide buffer = theta still dominates, watch instead of close.
  if (pos.needsClose) {
    const risk = classify21DteRisk(pos);
    if (pnlPct < 0) return { action: 'MANAGE', detail: `${pos.dte} DTE with loss — review close/roll, don't auto-cut` };
    if (risk === 'low')    return { action: 'WATCH',      detail: `${pos.dte} DTE but δ${pos.netDelta?.toFixed(2)} + ${pos.buffer?.toFixed(1)}% buffer — theta dominates, monitor daily` };
    if (risk === 'medium') return { action: 'WATCH',      detail: `${pos.dte} DTE — low delta but tightening, watch buffer closely` };
    return                        { action: 'CLOSE_ROLL', detail: `${pos.dte} DTE — close or roll to next expiry` };
  }

  // CSP — assignment-aware breach handling
  if (pos.strategy === 'PUT') {
    if (breached) return { action: 'MANAGE', detail: `Strike breached — prepare for assignment or roll to avoid it` };
    if (pos.dte <= 5 && breached) return { action: 'MANAGE', detail: `Expiry near + breached — assignment likely, confirm you want shares` };
    if (pos.needsClose && pnlPct >= 0) return { action: 'TAKE_PROFIT', detail: `${pos.dte} DTE — take profit or let expire worthless` };
    if (pos.needsClose && pnlPct < 0)  return { action: 'MANAGE', detail: `${pos.dte} DTE with loss — roll down/out or accept assignment` };
    if (pos.hitTarget) return { action: 'TAKE_PROFIT', detail: `${Math.round(targetPct)}% target hit — close and sell next CSP` };
    if (!pos.hasGtc)   return { action: 'PLACE_GTC', detail: 'CSP — place profit target GTC' };
    return { action: 'HOLD', detail: `${pnlPct.toFixed(0)}% profit — ${pos.dte} DTE, theta working` };
  }

  // Covered Call — assignment means shares called away
  if (pos.strategy === 'CALL') {
    if (breached) return { action: 'MANAGE', detail: `Strike breached — shares may be called away at expiry` };
    if (pos.needsClose && pnlPct >= 0) return { action: 'TAKE_PROFIT', detail: `${pos.dte} DTE — close or let expire, sell next CC` };
    if (pos.hitTarget) return { action: 'TAKE_PROFIT', detail: `${Math.round(targetPct)}% target hit — close and sell next CC` };
    if (!pos.hasGtc)   return { action: 'PLACE_GTC', detail: 'Covered call — place profit target GTC' };
    return { action: 'HOLD', detail: `${pnlPct.toFixed(0)}% profit — ${pos.dte} DTE, theta working` };
  }

  // IC — identify which side is breached using actual stock price vs strike prices
  if (pos.strategy === 'IC') {
    if (breached) {
      const stock = pos.stockPrice;
      const shortPutStrike  = shortPuts[0]?.strikePrice ?? 0;
      const shortCallStrike = shortCalls[0]?.strikePrice ?? Infinity;
      // Determine which leg is actually in the money
      const putBreached  = stock != null ? stock < shortPutStrike  : pos.buffer != null && pos.buffer <= 0 && shortPuts.length > 0;
      const callBreached = stock != null ? stock > shortCallStrike : pos.buffer != null && pos.buffer <= 0 && shortCalls.length > 0;
      const putBuffer    = stock != null && shortPutStrike  > 0 ? ((stock - shortPutStrike)  / stock * 100).toFixed(1) : null;
      const callBuffer   = stock != null && shortCallStrike < Infinity ? ((shortCallStrike - stock) / stock * 100).toFixed(1) : null;
      if (putBreached && callBreached) return { action: 'CUT_LOSSES', detail: `Both sides breached — IC is fully in trouble, close immediately` };
      if (putBreached)  return { action: 'MANAGE', detail: `Put side breached (${shortPutStrike}P, stock $${stock?.toFixed(2)}) — close put spread, leave call side open${callBuffer ? `, call has ${callBuffer}% buffer` : ''}` };
      if (callBreached) return { action: 'MANAGE', detail: `Call side breached (${shortCallStrike}C, stock $${stock?.toFixed(2)}) — close call spread, leave put side open${putBuffer ? `, put has ${putBuffer}% buffer` : ''}` };
      return { action: 'MANAGE', detail: `Strike breached — close tested side` };
    }
  }

  // Hard exits: spreads only (BPS/BCS)
  // CUT_LOSSES requires multiple confirming signals — loss % alone is never enough.
  // A low-delta, wide-buffer position with 30+ DTE has a genuine recovery path via theta.
  if (breached) return { action: 'CUT_LOSSES', detail: `Short strike breached — exit or roll immediately` };

  // Bypassed stop: position is unprotected AND loss is meaningful — act now
  if (pos.stopLossStatus === 'bypassed' && pnlPct < -50) {
    const absDelta = Math.abs(pos.netDelta ?? 0.30);
    const buffer   = pos.buffer ?? 0;
    const dteFactor = pos.dte > 25 ? 1 : 2; // tighter buffer threshold when close to expiry
    if (absDelta > 0.20 || buffer < dteFactor) return { action: 'CUT_LOSSES', detail: `Stop bypassed + delta ${absDelta.toFixed(2)} + ${buffer.toFixed(1)}% buffer — unprotected, exit now` };
    if (absDelta > 0.10 || buffer < 3) return { action: 'MANAGE', detail: `Stop bypassed — set a new stop immediately. Delta ${absDelta.toFixed(2)}, ${buffer.toFixed(1)}% buffer` };
    return { action: 'WATCH', detail: `Stop bypassed but δ${absDelta.toFixed(2)}, ${buffer.toFixed(1)}% buffer, ${pos.dte} DTE — set a new stop, then hold` };
  }

  if (stopLossBreached) {
    const absDelta = pos.netDelta != null ? Math.abs(pos.netDelta) : null;
    const buffer   = pos.buffer ?? 0;
    if ((absDelta != null && absDelta > 0.20) || buffer < 1) return { action: 'CUT_LOSSES', detail: `Stop triggered + delta ${absDelta?.toFixed(2) ?? '?'} + ${buffer.toFixed(1)}% buffer — follow the risk plan` };
    if ((absDelta != null && absDelta > 0.10) || (buffer < 3 && pos.dte < 21)) return { action: 'MANAGE', detail: `Stop triggered, delta ${absDelta?.toFixed(2) ?? 'unknown'} — review carefully` };
    return { action: 'WATCH', detail: `Stop level hit but δ${absDelta?.toFixed(2) ?? 'low'}, ${buffer.toFixed(1)}% buffer, ${pos.dte} DTE — theta working, set a new stop` };
  }

  if (veryLargeLoss) {
    const absDelta = pos.netDelta != null ? Math.abs(pos.netDelta) : null;
    const buffer   = pos.buffer ?? 0;
    // Trend against + any meaningful exposure = cut. Don't need both delta AND buffer to be bad.
    if (trendAgainst && ((absDelta != null && absDelta > 0.15) || buffer < 3)) return { action: 'CUT_LOSSES', detail: `Down ${Math.abs(pnlPct).toFixed(0)}%, trend adverse, δ${absDelta?.toFixed(2) ?? '?'} + ${buffer.toFixed(1)}% buffer — thesis broken, exit` };
    // Trend against but Greeks are still ok — manage, don't panic cut
    if (trendAgainst && pos.dte > 21) return { action: 'MANAGE', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% with adverse trend — δ${absDelta?.toFixed(2) ?? 'low'} manageable with ${pos.dte} DTE, monitor closely` };
    if (trendAgainst) return { action: 'CUT_LOSSES', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% + adverse trend + only ${pos.dte} DTE — not enough time to recover` };
    // No adverse trend — evaluate purely on Greeks + DTE
    if ((absDelta != null && absDelta > 0.20) || buffer < 2) return { action: 'MANAGE', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% + exposed Greeks — manage actively` };
    if (pos.dte < 14) return { action: 'MANAGE', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% with only ${pos.dte} DTE — not enough theta time to recover, manage now` };
    return { action: 'WATCH', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% but δ${absDelta?.toFixed(2) ?? 'low'}, ${buffer.toFixed(1)}% buffer, ${pos.dte} DTE — theta has room to work` };
  }

  // Short-dated entry: maximize profit, but do not treat ordinary red P/L as a failure.
  if (shortDate) {
    if (pos.hitTarget) return { action: 'TAKE_PROFIT', detail: `${Math.round(targetPct)}% target hit — take it, no time to wait` };
    if (pnlPct >= 30 && pos.dte <= 7)  return { action: 'TAKE_PROFIT', detail: `${pnlPct.toFixed(0)}% profit at ${pos.dte} DTE — take profit now, gamma risk rising` };
    if (pnlPct >= 40)                  return { action: 'TAKE_PROFIT', detail: `${pnlPct.toFixed(0)}% profit — solid capture for short-dated trade` };
    if (!pos.hasGtc)                   return { action: 'PLACE_GTC', detail: 'Short-dated trade — place GTC immediately' };
    if (criticalBuffer && pnlPct < 0)  return { action: 'MANAGE', detail: `${pos.buffer?.toFixed(1)}% buffer with ${pos.dte} DTE — manage closely, not automatic cut` };
    if (pnlPct < -100 && trendAgainst) return { action: 'MANAGE', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% + adverse trend — review exit/roll` };
    if (pos.dte <= 3)                  return { action: 'TAKE_PROFIT', detail: `${pos.dte} DTE — expiry imminent, close to avoid pin/assignment risk` };
    if (trendAgainst)                  return { action: 'MANAGE', detail: `Trend against position with only ${pos.dte} DTE — watch closely` };
    if (pnlPct < 0)                    return { action: 'HOLD', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% — ${pos.dte} DTE, monitor buffer/theta` };
    return { action: 'HOLD', detail: `${pnlPct.toFixed(0)}% profit — ${pos.dte} DTE, short-dated, let theta work` };
  }

  // Standard entry
  if (pos.hitTarget)                  return { action: 'TAKE_PROFIT', detail: `${Math.round(targetPct)}% target — lock in $${pos.pnl?.toFixed(2)}` };
  if (!pos.hasGtc)                    return { action: 'PLACE_GTC', detail: 'No GTC order set — place profit target' };
  if (pnlPct < -150 && trendAgainst) {
    const absDelta = Math.abs(pos.netDelta ?? 0.30);
    const buffer   = pos.buffer ?? 0;
    if (absDelta > 0.20 || buffer < 2) return { action: 'CUT_LOSSES', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% + adverse trend + delta ${absDelta.toFixed(2)} — thesis broken, exit` };
    return { action: 'MANAGE', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% + adverse trend but δ${absDelta.toFixed(2)} is low — monitor, don't panic-cut` };
  }
  if (pnlPct < -50 && trendAgainst)  return { action: 'MANAGE', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% with adverse trend — manage actively` };
  if (pnlPct < -50) {
    const absDelta = pos.netDelta != null ? Math.abs(pos.netDelta) : null;
    const buffer   = pos.buffer ?? 0;
    if (pos.dte > 25 && (absDelta == null || absDelta < 0.10) && buffer > 3) return { action: 'WATCH', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% but δ${absDelta?.toFixed(2) ?? 'low'}, ${buffer.toFixed(1)}% buffer, ${pos.dte} DTE — theta working, hold and monitor` };
    return { action: 'MANAGE', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% — manage actively` };
  }
  if (pnlPct >= targetPct)           return { action: 'TAKE_PROFIT', detail: `${pnlPct.toFixed(0)}% profit` };
  // Mid-loss watch: down 20-50% with tightening buffer but not yet in manage territory
  if (pnlPct < -20) {
    const absDelta = pos.netDelta != null ? Math.abs(pos.netDelta) : null;
    const buffer   = pos.buffer ?? 999;
    if (buffer < 4 && pos.dte > 14) return { action: 'WATCH', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% with ${buffer.toFixed(1)}% buffer — theta working but monitor buffer daily` };
    if ((absDelta != null && absDelta > 0.15) && pos.dte > 21) return { action: 'WATCH', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% with delta ${absDelta.toFixed(2)} — directional exposure growing, watch closely` };
  }
  if (pnlPct < 0 && trendAgainst)    return { action: 'MANAGE', detail: `Down ${Math.abs(pnlPct).toFixed(0)}% with adverse trend` };
  if (trendAligns)                   return { action: 'HOLD', detail: `Trend confirms ${pos.strategy} — ${pnlPct.toFixed(0)}% profit` };
  return { action: 'HOLD', detail: `${pnlPct.toFixed(0)}% profit — ${pos.dte} DTE remaining` };

// Separate function so getRecommendation stays clean — called in PositionCard render
function getExtendSignal(pos: Position): string | null {
  if (!pos.hasGtc) return null;
  // Never suggest extending on short-dated entries — the goal is fast profit capture, not riding theta longer
  if (isShortDateEntry(pos)) return null;
  const pnlPct = pos.pnl != null && pos.creditReceived > 0 ? (pos.pnl / pos.creditReceived) * 100 : 0;
  // Only suggest extension when: profit > 50%, DTE > 25, IVR >= 35, buffer > 5%
  if (
    pnlPct >= 50 &&
    pos.dte >= 25 &&
    (pos.ivr == null || pos.ivr >= 35) &&
    (pos.buffer == null || pos.buffer >= 5)
  ) {
    return `↑ Consider extending — ${pnlPct.toFixed(0)}% profit with ${pos.dte}d left`;
  }
  return null;
}

// ── AI Analysis ───────────────────────────────────────────────────────────
const TRADING_CHAT_PROMPT = `You are a professional options trader and portfolio analyst advising a trader who uses the Options Hunter methodology as a foundation — but you treat those rules as informed guidelines, not rigid constraints.

You are in a live conversation about a specific position or portfolio. The trader has already seen a structured analysis. They are now asking follow-up questions to dig deeper.

RESPOND IN PLAIN CONVERSATIONAL PROSE. No JSON. No bullet headers. No structured output format. Talk like a senior trader giving direct advice over the phone — clear, specific, and honest. Use numbers when they matter. Be direct about risk. Don't hedge everything with disclaimers.

You know the methodology deeply:
- BPS for bullish/neutral, BCS for bearish, IC for range-bound
- 50% profit target with GTC at entry, hard close at 21 DTE (only for standard entries > 21 DTE; short-dated entries use lower take-profit thresholds and fast exit before expiry)
- IVR >= 30 for edge, buffer % to short strike is critical, gamma accelerates near expiry
- When to deviate: high IV exceptions, broken thesis, early close to protect profits

Keep responses focused and concise — 3-6 sentences unless the question genuinely requires more. If the trader asks about rolling, give specific guidance on strikes and expiry. If they ask about risk, quantify it. If they're thinking about something wrong, say so directly.`;

const TRADING_SYSTEM_PROMPT = `You are a professional options trader and portfolio analyst with deep expertise in selling premium through credit spreads. You advise a trader who follows the Options Hunter methodology as a foundation — but you treat those rules as informed guidelines, not rigid constraints. You understand when deviation is appropriate.

CORE METHODOLOGY (know it deeply, apply it intelligently):
- Strategies: Bull Put Spread (BPS) for bullish/neutral, Bear Call Spread (BCS) for bearish, Iron Condor (IC) for range-bound, Cash-Secured Put (CSP, displayed as strategy=PUT) for bullish/wheel entries — single short put, no long leg, assignment risk at expiry, Covered Call (CC, displayed as strategy=CALL) for income on held shares
- Entry rules (as guidelines): IVR ≥ 30, DTE 30-45, credit ≥ 1/3 spread width, OI ≥ 500, bid-ask ≤ $0.10
- Target exits: 50% profit (place GTC at entry), hard close at 21 DTE regardless of P&L — BUT ONLY when entry DTE was > 21. Short-dated entries (entered at ≤ 21 DTE) follow a different framework: maximize profit quickly, lower the take-profit threshold to 30-40%, tighten the loss tolerance, and exit before expiry to avoid pin/assignment risk. The 21 DTE hard-close rule does NOT apply to intentional short-dated trades.
- Short strike deltas: BPS -0.20 to -0.30, BCS +0.20 to +0.30, IC ±0.16 to ±0.20
- IC requires sideways price action 2+ weeks, no higher highs/lower lows

WHEN TO DEVIATE FROM RULES (apply professional judgment):
- If IV is very high (IVR > 70) and credit is exceptional, a wider spread or slightly aggressive delta can be justified
- If a position is at 40% profit but 15 DTE with gamma risk rising sharply, closing early beats waiting for 50%
- If trend has reversed hard against a spread, cutting losses at 1.5x credit is better than waiting for 2x
- If IVR just dropped below 30 mid-trade but P&L is positive, holding can still make sense if trend confirms
- Earnings risk only exists if earnings occurs on or before the option expiration; never mention post-expiration earnings as a current-position risk
- Sometimes doing nothing is the hardest but best trade

ANALYSIS PRINCIPLES:
- Always consider the trend direction vs. the strategy type — a BPS in a downtrend is broken thesis
- Buffer % to short strike is DTE-dependent — below 2% is always critical; below 3% matters at > 21 DTE; below 5% is only worth noting at > 30 DTE. A 3% buffer at 5 DTE is fine — theta is destroying the spread daily.
- NEVER label a buffer as "critical threshold" or "minimum acceptable" unless it is actually below 2%. A 3% buffer at 44 DTE is a WATCH item, not a crisis. Use language like "worth monitoring" or "on the tighter side" instead.
- IV edge = IV minus HV30. If either is unknown, say so but don't list it as a risk unless it's genuinely missing AND relevant to the recommendation.
- High gamma near expiry (DTE < 21) magnifies risk exponentially — treat with respect
- IV vs HV comparison: if IV >> HV (IV premium), edge exists; if IV ≈ HV, edge is thin
- Theta decay accelerates in final 3 weeks — this is your friend if positioned correctly
- Net delta tells you your directional exposure — you're supposed to be mostly neutral

OUTPUT FORMAT (JSON only, no prose outside the JSON):
For position analysis:
{
  "recommendation": "HOLD|CLOSE|ROLL|TAKE_PROFIT|CUT_LOSSES|WATCH|MANAGE",
  "confidence": "HIGH|MEDIUM|LOW",
  "summary": "1-2 sentence TL;DR",
  "reasoning": "2-3 sentence explanation of your reasoning, including what the key factors are",
  "risks": ["risk 1", "risk 2", "risk 3"],
  "catalysts": ["positive factor 1", "positive factor 2"],
  "deviatesFromRules": true|false,
  "deviationNote": "null or explanation of why professional judgment overrides the standard rule"
}

For portfolio analysis:
{
  "netDeltaBias": "BULLISH|BEARISH|NEUTRAL",
  "dominantRisk": "single sentence describing the biggest portfolio-level risk",
  "sectorConcentration": ["sector concern 1", "sector concern 2"],
  "thetaYield": "qualitative assessment of theta capture rate",
  "topRisks": ["risk 1", "risk 2", "risk 3"],
  "priorityActions": ["highest priority action", "second priority", "third priority"],
  "marketContext": "how current market conditions affect this portfolio",
  "summary": "2-3 sentence overall portfolio assessment"
}

Be direct. Be honest. If a position is in trouble, say so. If a rule should be broken, explain why.`;

function buildPositionPrompt(pos: Position, trend: TrendResult | null, futures?: FuturesData | null): string {
  const pnlPct = pos.pnl != null && pos.creditReceived > 0 ? ((pos.pnl / pos.creditReceived) * 100).toFixed(1) : 'unknown';
  const ivEdge = pos.iv != null && pos.hv30 != null ? (pos.iv - pos.hv30) : null;

  return `Analyze this open options position:

POSITION: ${pos.symbol} ${pos.strategy}${pos.strategy === 'PUT' ? ' (Cash-Secured Put — single short put, no spread protection, assignment risk if breached)' : pos.strategy === 'CALL' ? ' (Covered Call — short call against held shares, assignment means shares called away)' : ''}
Expiry: ${pos.expDate} | DTE: ${pos.dte} | Entry DTE: ${pos.entryDte}
Strikes: ${pos.legs.map(l => `${l.direction} ${l.strikePrice}${l.optionType}`).join(', ')}
Credit received: $${pos.creditReceived.toFixed(2)} | Current buyback: $${pos.currentValue?.toFixed(2) ?? 'unknown'}
P&L: ${pos.pnl != null ? `$${pos.pnl.toFixed(2)} (${pnlPct}% of credit)` : 'unknown'}
Profit target: ${Math.round(pos.profitTarget * 100)}% ($${pos.targetPrice.toFixed(2)})
Max risk: $${pos.maxRisk.toFixed(2)}

MARKET DATA:
Stock price: $${pos.stockPrice?.toFixed(2) ?? 'unknown'}
Buffer to short strike: ${pos.buffer?.toFixed(1) ?? 'unknown'}%
IVR: ${pos.ivr ?? 'unknown'}
Current IV: ${pos.iv ?? 'unknown'}%
HV30: ${pos.hv30 ?? 'unknown'}%
IV edge (IV - HV30): ${ivEdge != null ? `${ivEdge.toFixed(1)}%` : 'unknown'}
Beta: ${pos.beta ?? 'unknown'}

GREEKS (net position):
Theta: ${pos.theta?.toFixed(4) ?? 'unknown'} (daily decay)
Gamma: ${pos.gamma?.toFixed(4) ?? 'unknown'}

OPERATIONAL STATUS:
GTC order: ${pos.hasGtc ? 'Yes — profit target working' : 'No — unprotected'}
Stop loss: ${pos.stopLossStatus} ${pos.stopLossPrice ? `@ $${pos.stopLossPrice}` : ''}
Earnings within expiry: ${pos.earningsDate ? `Yes — ${pos.earningsDate}` : 'No'}
Stop loss status: ${pos.stopLossStatus}${pos.stopLossStatus === 'bypassed' ? ` — STOP WAS BYPASSED. Order at $${pos.stopLossPrice?.toFixed(2)} was gapped past and never filled. Position is currently unprotected. Recommend immediate manual intervention.` : pos.stopLossPrice ? ` @ $${pos.stopLossPrice}` : ''}

TREND ANALYSIS:
Direction: ${trend?.trend ?? 'unknown'} (confidence: ${trend?.confidence ?? 'unknown'}%)
Suggested strategy: ${trend?.strategy ?? 'unknown'}
Reason: ${trend?.reason ?? 'none'}
ES Futures: ${(() => {
  if (!futures) return 'unavailable';
  const beta = pos.beta ?? 1.0;
  const betaAdj = parseFloat((futures.changePct * beta).toFixed(2));
  const sign = betaAdj >= 0 ? '+' : '';
  const bufferAfterMove = pos.buffer != null
    ? parseFloat((pos.buffer + betaAdj).toFixed(1))
    : null;
  const bufferNote = bufferAfterMove != null
    ? ` Effective buffer after beta-adjusted move: ~${bufferAfterMove}% (static buffer at load was ${pos.buffer?.toFixed(1)}%).`
    : '';
  const urgencyNote = bufferAfterMove != null && bufferAfterMove < pos.buffer!
    ? ` Buffer is SHRINKING intraday — factor into urgency.`
    : bufferAfterMove != null && bufferAfterMove > pos.buffer!
    ? ` Buffer is IMPROVING intraday — reduce urgency of cut recommendations.`
    : '';
  return `${futures.label} — bias ${futures.bias}. Beta-adjusted impact on ${pos.symbol} (β${beta.toFixed(2)}): ${sign}${betaAdj}% today.${bufferNote}${urgencyNote}`;
})()}

Flags: ${[
  pos.needsClose ? '⚠ AT 21 DTE — must close or roll (entered at standard DTE)' : '',
  pos.entryDte <= 21 ? `ℹ SHORT-DATED ENTRY — entered at ${pos.entryDte} DTE, now ${pos.dte} DTE. Goal is fast profit capture, NOT the standard 50%/21-DTE framework. Evaluate for early exit at 30-40% or on any sign of adverse movement.` : '',
  pos.hitTarget ? '✓ Profit target hit' : '',
  !pos.hasGtc ? '⚠ No GTC order' : '',
  pos.buffer != null && pos.buffer < 2 ? `⚠ CRITICAL buffer ${pos.buffer.toFixed(1)}% at ${pos.dte} DTE — near breach` : pos.buffer != null && pos.buffer < 3 && pos.dte > 14 ? `⚠ Tight buffer ${pos.buffer.toFixed(1)}% at ${pos.dte} DTE` : pos.buffer != null && pos.buffer < 5 && pos.dte > 30 ? `ℹ Buffer ${pos.buffer.toFixed(1)}% with ${pos.dte} DTE — watch closely` : '',
  pos.earningsDate ? `⚠ Earnings ${pos.earningsDate}` : '',
].filter(Boolean).join(', ') || 'None'}

Provide your analysis as JSON only.`;
}

function buildPortfolioPrompt(positions: Position[], futures?: FuturesData | null): string {
  const lines = positions.map(p => {
    const pnlPct = p.pnl != null && p.creditReceived > 0 ? ((p.pnl / p.creditReceived) * 100).toFixed(0) : '?';
    return `${p.symbol} ${p.strategy}: DTE ${p.dte}, P&L ${pnlPct}%, buffer ${p.buffer?.toFixed(1) ?? '?'}%, IVR ${p.ivr ?? '?'}, ${p.needsClose ? 'NEEDS CLOSE' : p.hitTarget ? 'TARGET HIT' : 'active'}`;
  });

  const totalCredit = positions.reduce((s, p) => s + p.creditReceived, 0);
  const totalPnl = positions.reduce((s, p) => s + (p.pnl ?? 0), 0);
  const totalAtRisk = positions.reduce((s, p) => s + p.maxRisk, 0);
  const totalTheta = positions.reduce((s, p) => s + (p.theta ?? 0), 0);
  const urgentCount = positions.filter(p => p.needsClose || p.hitTarget || (p.buffer != null && p.buffer < 5)).length;

  return `Analyze this options portfolio as a whole:

PORTFOLIO SUMMARY:
${positions.length} open positions | ${urgentCount} requiring immediate attention
Total credit collected: $${totalCredit.toFixed(2)}
Current P&L: $${totalPnl.toFixed(2)} (${totalCredit > 0 ? ((totalPnl / totalCredit) * 100).toFixed(1) : 0}% of credit)
Total at risk: $${totalAtRisk.toFixed(2)}
Net theta/day: $${totalTheta.toFixed(2)}

POSITIONS:
${lines.join('\n')}

STRATEGY MIX:
BPS: ${positions.filter(p => p.strategy === 'BPS').length} | BCS: ${positions.filter(p => p.strategy === 'BCS').length} | IC: ${positions.filter(p => p.strategy === 'IC').length} | Other: ${positions.filter(p => !['BPS','BCS','IC'].includes(p.strategy)).length}

SYMBOLS: ${positions.map(p => p.symbol).filter((v, i, a) => a.indexOf(v) === i).join(', ')}

DTE DISTRIBUTION:
< 21 DTE: ${positions.filter(p => p.dte < 21).length} positions
21-30 DTE: ${positions.filter(p => p.dte >= 21 && p.dte <= 30).length} positions
> 30 DTE: ${positions.filter(p => p.dte > 30).length} positions

MARKET CONTEXT:
ES Futures: ${futures ? `${futures.label} — bias ${futures.bias}` : 'unavailable'}
${futures?.bias === 'bearish' ? 'WARNING: Futures bearish — BPS positions face directional headwind. Weight cut/manage recommendations higher.' : ''}
${futures?.bias === 'bullish' ? 'NOTE: Futures bullish — BPS positions have tailwind. Factor into urgency of cut recommendations.' : ''}

Provide portfolio-level analysis as JSON only.`;
}

const TRADING_VERDICT_PROMPT = `You are the most experienced options trader in the world. You have traded through every market cycle since the 1980s — Black Monday, the dot-com crash, 2008, COVID. You have made and lost fortunes and learned exactly when to hold, when to run, and when greed kills a good trade.

A trader is about to take an action on an open options position. Your job is to evaluate that specific action and deliver a verdict — instantly, honestly, without hedging.

You are NOT a financial advisor covering yourself with disclaimers. You are a mentor who will tell someone directly when they are about to make a stupid mistake, and who will give them confidence when the move is smart.

VERDICT SCALE:
- GO: This is a smart move. The data supports it. Execute it.
- CAUTION: This might work but there are real risks. Proceed carefully and know what you're risking.
- STOP: This is a mistake. The numbers say so. You need a very good reason to override this.

WHAT TO EVALUATE PER ACTION:
EXTEND_PROFIT (e.g. moving 50% target to 70%):
- Is the remaining premium worth the risk? Calculate: remaining_credit = credit × (1 - new_target). Is that worth holding?
- DTE: if < 21, gamma risk makes holding dangerous. If > 30, extension is more reasonable.
- Trend: if trend is confirmed aligned, extension has merit. If trend is uncertain or against, don't be greedy.
- Earnings approaching: never extend through an earnings event for extra premium.
- CRITICAL: If a position's earningsDate field is null or not provided, DO NOT guess, assume, or speculate about earnings timing. Instead use web search to look up the actual next earnings date for that ticker before giving any earnings-related advice. Never hallucinate earnings dates.
- Buffer: if buffer < 5%, don't extend — protect the capital.

CLOSE_ROLL (closing and re-entering):
- Are you rolling a winner (good) or a loser (dangerous — you're often just deferring pain)?
- Can you collect meaningful credit on the new spread? If not, the roll just costs you money.
- Is the trend still valid for the original strategy? Rolling a BPS in a downtrend is doubling a broken bet.
- Mechanically: roll at 21 DTE to avoid gamma, not before.

TAKE_PROFIT (closing for profit):
- Is this at or near the 50% target? Taking 40-50% is almost always correct.
- Is there a catalyst (earnings, Fed decision) making early exit smart? Good reason to deviate up.
- Are they leaving too much on the table? If at 20% profit with 35 DTE, hold.

CUT_LOSSES (closing at a loss):
- Is the thesis genuinely broken (trend reversed, breach imminent) or is this just uncomfortable?
- What's the actual loss vs max loss? If at 1x credit loss, cutting is reasonable. Beyond 2x, you should have cut already.
- Buffer: use DTE-aware judgment — < 2% at any DTE is critical; < 3% only concerning if DTE > 21; < 5% only worth noting if DTE > 30. Short-dated positions (< 14 DTE) with thin buffers are often fine — theta is working hard.

PLACE_GTC (placing a profit target order):
- Almost always a GO — this is standard practice and protects the position.
- Any profit target between 40-85% is valid and should NOT be flagged. The trader knows their target.
- Only CAUTION if: target is below 20% (fires almost immediately, not worth the order) or above 90% (basically never fires).
- Do NOT flag the buffer or any other position metric as a reason to CAUTION a PLACE_GTC. The GTC protects the position — placing it is always better than not placing it.
- Do NOT comment on whether 50% vs 65% vs 75% is the right target. That is the trader's decision.

OUTPUT FORMAT — JSON only, nothing else:
{
  "verdict": "GO|CAUTION|STOP",
  "confidence": "HIGH|MEDIUM|LOW",
  "headline": "Single blunt sentence. Max 15 words. Make it land.",
  "reasoning": "2-3 sentences. Be specific — use the actual numbers from the position. Tell them exactly why."
}`;

function buildVerdictPrompt(pos: Position, action: EvaluatedAction, detail?: string): string {
  const pnlPct = pos.pnl != null && pos.creditReceived > 0
    ? ((pos.pnl / pos.creditReceived) * 100).toFixed(1) : 'unknown';
  const creditPerContract = (pos.creditReceived / 100).toFixed(2);

  const actionDesc = action === 'EXTEND_PROFIT' && detail
    ? `EXTEND_PROFIT — moving profit target from current to ${detail}% (new BTC price: $${((pos.creditReceived / 100) * (1 - parseInt(detail) / 100)).toFixed(2)})`
    : action === 'CLOSE_ROLL'
    ? `CLOSE_ROLL — close current position and re-enter next expiry`
    : action === 'TAKE_PROFIT'
    ? `TAKE_PROFIT — close now for ${pnlPct}% of credit ($${pos.pnl?.toFixed(2) ?? '?'})`
    : action === 'CUT_LOSSES'
    ? `CUT_LOSSES — close at a loss of ${pnlPct}% (${pos.pnl?.toFixed(2) ?? '?'})`
    : `PLACE_GTC — set profit target GTC order`;

  // Pull relevant memory context for this symbol and action
  const memoryContext = buildMemoryContext(pos.symbol, action);

  return `Evaluate this specific action a trader is about to take:

ACTION: ${actionDesc}

POSITION: ${pos.symbol} ${pos.strategy}
DTE: ${pos.dte} | Entry DTE: ${pos.entryDte}
Strikes: ${pos.legs.map(l => `${l.direction} ${l.strikePrice}${l.optionType}`).join(', ')}
Credit (total): $${pos.creditReceived.toFixed(2)} | Per contract: $${creditPerContract}
Current buyback cost: $${pos.currentValue?.toFixed(2) ?? 'unknown'}
P&L: $${pos.pnl?.toFixed(2) ?? 'unknown'} (${pnlPct}% of credit)
Current profit target: ${Math.round(pos.profitTarget * 100)}%

Stock price: $${pos.stockPrice?.toFixed(2) ?? 'unknown'}
Buffer to short strike: ${pos.buffer?.toFixed(1) ?? 'unknown'}%
IVR: ${pos.ivr ?? 'unknown'} | IV: ${pos.iv ?? 'unknown'}% | HV30: ${pos.hv30 ?? 'unknown'}%
Theta/day: ${pos.theta?.toFixed(4) ?? 'unknown'} | Gamma: ${pos.gamma?.toFixed(4) ?? 'unknown'}
GTC working: ${pos.hasGtc ? 'Yes' : 'No'}
Stop loss: ${pos.stopLossStatus}${pos.stopLossStatus === 'bypassed' ? ` — BYPASSED at $${pos.stopLossPrice?.toFixed(2)}, never filled, UNPROTECTED` : pos.stopLossPrice ? ` @ $${pos.stopLossPrice}` : ''}
Earnings: ${pos.earningsDate ? `YES — ${pos.earningsDate}` : 'None within expiry'}

Flags: ${[
    pos.needsClose ? 'AT 21 DTE (standard entry — must close/roll)' : '',
    pos.entryDte <= 21 ? `SHORT-DATED ENTRY (entered at ${pos.entryDte} DTE, now ${pos.dte} DTE — fast profit capture goal, lower thresholds apply)` : '',
    pos.hitTarget ? 'TARGET HIT' : '',
    pos.buffer != null && pos.buffer < 2 ? `CRITICAL BUFFER ${pos.buffer.toFixed(1)}% at ${pos.dte} DTE` : pos.buffer != null && pos.buffer < 3 && pos.dte > 14 ? `TIGHT BUFFER ${pos.buffer.toFixed(1)}% at ${pos.dte} DTE` : pos.buffer != null && pos.buffer < 5 && pos.dte > 30 ? `WATCH BUFFER ${pos.buffer.toFixed(1)}% at ${pos.dte} DTE` : '',
    pos.earningsDate ? `EARNINGS ${pos.earningsDate}` : '',
    (pos.pnl ?? 0) < -pos.creditReceived ? 'LOSS EXCEEDS 1X CREDIT' : '',
  ].filter(Boolean).join(', ') || 'None'}
${memoryContext ? `\n${memoryContext}` : ''}
Give your verdict as JSON only.`;
}

async function evaluateAction(pos: Position, action: EvaluatedAction, detail?: string): Promise<ActionVerdict> {
  const prompt = buildVerdictPrompt(pos, action, detail);
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      system: TRADING_VERDICT_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error ?? `API error: ${res.status}`);
  }
  const data = await res.json();
  const text = (data?.content?.find((b: any) => b.type === 'text')?.text ?? '')
    .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(text);
  return {
    verdict: parsed.verdict,
    confidence: parsed.confidence,
    headline: parsed.headline,
    reasoning: parsed.reasoning,
  };
}

async function callAI(userMessage: string): Promise<string> {
  // Calls our own Next.js API route which proxies to Anthropic server-side.
  // Direct browser → api.anthropic.com calls are blocked by CORS.
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: TRADING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error ?? `API error: ${res.status}`);
  }
  const data = await res.json();
  const text = data?.content?.find((b: any) => b.type === 'text')?.text ?? '';
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
}

interface ChatMessagePart { type: 'text'; text: string; }
interface ChatImagePart { type: 'image'; source: { type: 'base64'; media_type: string; data: string }; }
type ChatContentPart = ChatMessagePart | ChatImagePart;
interface ChatMessage { role: 'user' | 'assistant'; content: string | ChatContentPart[]; }

async function callAIWithHistory(messages: ChatMessage[], systemOverride?: string): Promise<string> {
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      system: systemOverride ?? TRADING_SYSTEM_PROMPT,
      messages,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error ?? `API error: ${res.status}`);
  }
  const data = await res.json();
  const text = data?.content?.find((b: any) => b.type === 'text')?.text ?? '';
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
}

async function analyzePosition(pos: Position, trend: TrendResult | null): Promise<PositionAnalysis> {
  const prompt = buildPositionPrompt(pos, trend);
  const raw = await callAI(prompt);
  const parsed = JSON.parse(raw);
  return {
    positionKey: pos.key,
    symbol: pos.symbol,
    loading: false,
    error: null,
    recommendation: parsed.recommendation,
    confidence: parsed.confidence,
    summary: parsed.summary,
    reasoning: parsed.reasoning,
    risks: parsed.risks ?? [],
    catalysts: parsed.catalysts ?? [],
    deviatesFromRules: parsed.deviatesFromRules ?? false,
    deviationNote: parsed.deviationNote ?? null,
    generatedAt: new Date().toISOString(),
  };
}

async function analyzePortfolio(positions: Position[], futures?: FuturesData | null): Promise<PortfolioAnalysis> {
  const prompt = buildPortfolioPrompt(positions, futures);
  const raw = await callAI(prompt);
  const parsed = JSON.parse(raw);
  return {
    loading: false,
    error: null,
    netDelta: null,
    dominantRisk: parsed.dominantRisk ?? '',
    sectorConcentration: parsed.sectorConcentration ?? [],
    thetaYield: parsed.thetaYield ?? '',
    topRisks: parsed.topRisks ?? [],
    priorityActions: parsed.priorityActions ?? [],
    marketContext: parsed.marketContext ?? '',
    summary: parsed.summary ?? '',
    generatedAt: new Date().toISOString(),
  };
}

// Map index symbols to their chart-compatible equivalents
const INDEX_CHART_SYMBOLS: Record<string, string> = {
  'SPX': 'SPY',   // Use SPY as proxy for SPX trend — highly correlated, better data availability
  'NDX': 'QQQ',   // Use QQQ as proxy for NDX
  'RUT': 'IWM',   // Use IWM as proxy for RUT
  'VIX': 'VIX',
  'DJX': 'DIA',
};

async function getTrend(symbol: string): Promise<TrendResult> {
  const chartSymbol = INDEX_CHART_SYMBOLS[symbol.toUpperCase()] ?? symbol;
  const res = await fetch(`/api/chart?symbol=${encodeURIComponent(chartSymbol)}`, { cache: 'no-store' });
  if (!res.ok) return { trend: 'unknown', strategy: 'NO_TRADE', confidence: 0, reason: 'Chart data unavailable' };
  const data = await res.json();
  const bars: { c: number }[] = data?.bars ?? [];
  const closes = bars.map((b: any) => b.c).filter((c: any): c is number => Number.isFinite(c));
  if (closes.length < 50) return { trend: 'unknown', strategy: 'NO_TRADE', confidence: 0, reason: 'Not enough data' };
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const price = closes[closes.length - 1];
  const ma20 = avg(closes.slice(-20)); const ma50 = avg(closes.slice(-50));
  const mom20 = (price - closes[closes.length - 21]) / closes[closes.length - 21];
  const low20 = Math.min(...closes.slice(-20)); const high20 = Math.max(...closes.slice(-20));
  const higherLows = low20 > Math.min(...closes.slice(-40, -20)) * 0.985;
  const lowerHighs = high20 < Math.max(...closes.slice(-40, -20)) * 1.015;
  let score = 0;
  if (price > ma20) score += 2; else score -= 2;
  if (price > ma50) score += 2; else score -= 2;
  if (ma20 > ma50) score += 2; else score -= 2;
  if (mom20 > 0.03) score += 2; else if (mom20 < -0.03) score -= 2;
  if (higherLows) score += 2; else if (lowerHighs) score -= 2;
  const confidence = Math.min(100, Math.abs(score) * 10);
  if (score >= 4) return { trend: 'uptrend', strategy: 'BPS', confidence, reason: 'Price above MA20/MA50, positive momentum' };
  if (score <= -4) return { trend: 'downtrend', strategy: 'BCS', confidence, reason: 'Price below MA20/MA50, negative momentum' };
  return { trend: 'sideways', strategy: 'IC', confidence, reason: 'Mixed signals, range-bound' };
}

// ── Helpers ────────────────────────────────────────────────────────────────
function stratColor(strategy: string) {
  if (strategy === 'BPS')  return 'text-emerald-400 border-emerald-700';
  if (strategy === 'BCS')  return 'text-red-400 border-red-700';
  if (strategy === 'IC')   return 'text-blue-400 ac-border-faint';
  if (strategy === 'PUT')  return 'text-amber-400 border-amber-700';
  if (strategy === 'CALL') return 'text-orange-400 border-orange-700';
  return 'text-slate-400 border-slate-700';
}
function pnlColor(pnl: number | null) { return pnl == null ? 'text-slate-400' : pnl >= 0 ? 'text-emerald-400' : 'text-red-400'; }
function dteColor(dte: number) { if (dte <= 7) return 'text-red-500 font-bold'; if (dte <= 21) return 'text-yellow-400 font-bold'; return 'text-slate-400'; }

const ACTION_META: Record<ActionType, { label: string; color: string; btnClass: string }> = {
  HOLD:        { label: '● Hold',         color: 'text-slate-400',   btnClass: 'border-slate-600 text-slate-400' },
  WATCH:       { label: '⚠ Watch',        color: 'text-yellow-400',  btnClass: 'border-yellow-700 text-yellow-400' },
  MANAGE:      { label: '⚡ Manage',       color: 'text-orange-400',  btnClass: 'border-orange-600 text-orange-400' },
  TAKE_PROFIT: { label: '✓ Take Profit',  color: 'text-emerald-400', btnClass: 'border-emerald-600 text-emerald-400 hover:bg-emerald-600/20' },
  CUT_LOSSES:  { label: '✕ Cut Losses',   color: 'text-red-400',     btnClass: 'border-red-600 text-red-400 hover:bg-red-600/20' },
  CLOSE_ROLL:  { label: '↻ Close/Roll',   color: 'text-purple-400',  btnClass: 'border-purple-600 text-purple-400 hover:bg-purple-600/20' },
  PLACE_GTC:   { label: '⏱ Place GTC',   color: 'text-blue-400',    btnClass: 'ac-btn hover:ac-bg-20' },
};

function ThemeToggle({ theme, setTheme, accent, setAccent }: {
  theme: Theme; setTheme: (t: Theme) => void;
  accent: Accent; setAccent: (a: Accent) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1">
        {(Object.entries(ACCENTS) as [Accent, typeof ACCENTS[Accent]][]).map(([key, val]) => (
          <button key={key} onClick={() => { setAccent(key); applyAccent(key); try { localStorage.setItem(LS_ACCENT, key); } catch {} }}
            title={val.label}
            className={`w-3.5 h-3.5 rounded-full transition-all ${accent === key ? 'ring-2 ring-white/60 ring-offset-1 ring-offset-black scale-125' : 'opacity-60 hover:opacity-100'}`}
            style={{ backgroundColor: val.hex }}
          />
        ))}
      </div>
      <div className="w-px h-4 bg-white/20" />
      <div className="flex items-center gap-1 bg-black/20 rounded-lg p-1">
        {(['light', 'medium', 'dark'] as Theme[]).map((v, i) => (
          <button key={v} onClick={() => { setTheme(v); try { localStorage.setItem(LS_THEME, v); } catch {} }}
            className={`text-sm px-2 py-1 rounded transition-all ${theme === v ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white/80'}`}>
            {['☀', '◐', '☾'][i]}
          </button>
        ))}
      </div>
    </div>
  );
}

type BatchStatus = 'enriching' | 'ready' | 'submitting' | 'done' | 'error';

// ── Batch Confirm Modal ─────────────────────────────────────────────────────
function BatchConfirmModal({
  items: initialItems,
  onClose,
  onSuccess,
  dryRun,
  th,
}: {
  items: { pos: Position; action: ActionType }[];
  onClose: () => void;
  onSuccess: () => void;
  dryRun: boolean;
  th: typeof THEMES[Theme];
}) {
  const [status, setStatus] = useState<BatchStatus>('enriching');
  const [batchItems, setBatchItems] = useState<BatchOrderItem[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [orderResults, setOrderResults] = useState<OrderResult[]>([]);
  const [submitProgress, setSubmitProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  // Roll state per position
  const [rollInputs, setRollInputs] = useState<Record<string, { expiry: string; shortStrike: string; longStrike: string; credit: string }>>({});
  const [rollMode, setRollMode] = useState<Record<string, string>>({});
  const [rollAiGuidance, setRollAiGuidance] = useState<Record<string, { loading: boolean; text: string; error: string }>>({});
  const [rollSuggestions, setRollSuggestions] = useState<Record<string, RollSuggestion | null>>({});
  const [rollDeltaRange, setRollDeltaRange] = useState<[number, number]>(() => {
    try {
      const r = JSON.parse(localStorage.getItem('hunter-etf-rules') ?? '{}');
      return [r.SPREAD_DELTA_MIN ?? 0.20, r.SPREAD_DELTA_MAX ?? 0.25];
    } catch { return [0.20, 0.25]; }
  });
  const [verdicts, setVerdicts] = useState<Record<string, ActionVerdict>>({});
  const [overrides, setOverrides] = useState<Set<string>>(new Set());
  const [limitOverrides, setLimitOverrides] = useState<Record<string, string>>({});

  // GTC override confirmation
  const [gtcConfirmed, setGtcConfirmed] = useState<Set<string>>(new Set());

  const marketStatus = getMarketStatus();

  // Enrich logic
  useEffect(() => {
    let cancelled = false;
    async function enrich() {
      setStatus('enriching');
      try {
        let token: string;
        try {
          token = await getAccessToken();
        } catch (authErr: any) {
          if (!cancelled) { setErrorMsg(`Authentication error: ${authErr.message}. Try refreshing the page.`); setStatus('error'); }
          return;
        }
        const enriched: BatchOrderItem[] = [];

        for (const { pos, action } of initialItems) {
          const freshPrice = await fetchFreshPositionPrice(pos, token);
          const qty = pos.legs.find(l => l.direction === 'Short')?.quantity ?? 1;
          const freshPerContract = freshPrice != null ? freshPrice / (qty * 100) : null;
          const creditPerContract = pos.creditReceived / (qty * 100);

          const stalePriceWarning = freshPrice != null && pos.currentValue != null
            ? Math.abs(freshPrice - pos.currentValue) / pos.currentValue > STALE_PRICE_THRESHOLD
            : false;

          const duplicateGtcWarning = pos.hasGtc && (action === 'TAKE_PROFIT' || action === 'CUT_LOSSES' || action === 'CLOSE_ROLL');

          let limitPrice: number;
          let priceError: string | null = null;

          const effectiveValue = freshPrice ?? pos.currentValue;
          const effectivePerContract = freshPerContract ?? (pos.currentValue != null ? pos.currentValue / (qty * 100) : null);

          if (action === 'TAKE_PROFIT' || action === 'PLACE_GTC') {
            const effectiveProfitTarget = action === 'PLACE_GTC'
              ? getSmartGtcDefault(pos.symbol)
              : pos.profitTarget;
            const targetPrice = parseFloat((creditPerContract * (1 - effectiveProfitTarget)).toFixed(2));
            if (effectivePerContract != null && targetPrice >= effectivePerContract) {
              limitPrice = parseFloat(Math.max(effectivePerContract - 0.01, 0.01).toFixed(2));
            } else {
              limitPrice = Math.max(targetPrice, 0.01);
            }
            // Hard floor — negative or zero prices are always rejected by TastyTrade
            limitPrice = Math.max(parseFloat(limitPrice.toFixed(2)), 0.01);
          } else if (action === 'CUT_LOSSES' || action === 'CLOSE_ROLL') {
            if (effectivePerContract != null) {
              limitPrice = parseFloat((effectivePerContract * 1.02).toFixed(2));
            } else {
              limitPrice = parseFloat((creditPerContract * 0.5).toFixed(2));
              priceError = `No live price available — using estimated limit $${limitPrice.toFixed(2)}. Verify before submitting.`;
            }
          } else {
            const targetPrice = parseFloat((creditPerContract * (1 - pos.profitTarget)).toFixed(2));
            limitPrice = effectivePerContract != null
              ? Math.min(targetPrice, parseFloat((effectivePerContract - 0.01).toFixed(2)))
              : targetPrice;
          }

          if (action === 'PLACE_GTC' && effectivePerContract != null && limitPrice >= effectivePerContract) {
            priceError = `GTC limit $${limitPrice.toFixed(2)} ≥ live spread $${effectivePerContract.toFixed(2)} — would execute immediately. Use Take Profit instead.`;
          }

          const tif = action === 'PLACE_GTC' ? 'GTC' : 'Day';
          const orderBody = buildCloseOrder(pos, limitPrice, tif);
          const estPnl = effectiveValue != null ? pos.creditReceived - effectiveValue : pos.pnl;

          const item: BatchOrderItem = {
            pos, action, orderBody, limitPrice, estPnl,
            stalePriceWarning, freshPrice, freshPerContract, duplicateGtcWarning, priceError,
          };

          if (action === 'CLOSE_ROLL') {
            const suggestion = await fetchRollSuggestion(pos, token, rollDeltaRange).catch(() => null);
            if (!cancelled) setRollSuggestions(prev => ({ ...prev, [pos.key]: suggestion }));
            if (suggestion && !rollInputs[pos.key]) {
              setRollInputs(prev => ({
                ...prev,
                [pos.key]: {
                  expiry: suggestion.expiry,
                  shortStrike: String(suggestion.shortStrike),
                  longStrike: String(suggestion.longStrike),
                  credit: String(suggestion.credit),
                },
              }));
            }
          }

          enriched.push(item);
          if (!cancelled) setBatchItems([...enriched]);

          const evalAction = action === 'CLOSE_ROLL' ? 'CLOSE_ROLL'
            : action === 'TAKE_PROFIT' ? 'TAKE_PROFIT'
            : action === 'CUT_LOSSES' ? 'CUT_LOSSES'
            : action === 'PLACE_GTC' ? 'PLACE_GTC'
            : null;
          if (evalAction) {
            evaluateAction(pos, evalAction as EvaluatedAction).then(v => {
              if (!cancelled) setVerdicts(prev => ({ ...prev, [pos.key]: v }));
            }).catch(() => {});
          }
        }

        if (!cancelled) setStatus('ready');
      } catch (e: any) {
        if (!cancelled) { setErrorMsg(e.message); setStatus('error'); }
      }
    }
    enrich();
    return () => { cancelled = true; };
  }, [initialItems]);

  const fetchRollGuidance = async (posKey: string, pos: Position, suggestion: any | null) => {
    setRollAiGuidance(prev => ({ ...prev, [posKey]: { loading: true, text: '', error: '' } }));
    try {
      const ri = rollInputs[posKey];
      const suggestionText = suggestion
        ? `Rule-based suggestion: Expiry ${suggestion.expiry} (${suggestion.dte}d DTE) · Short ${suggestion.shortStrike} / Long ${suggestion.longStrike} · Credit mid $${suggestion.creditMid?.toFixed(2)} · Limit $${suggestion.credit?.toFixed(2)} · Delta ${suggestion.delta?.toFixed(2)} · Credit ratio ${(suggestion.creditRatio * 100)?.toFixed(0)}% · Violations: ${suggestion.ruleViolations?.join(', ') || 'none'}`
        : 'No rule-based suggestion available (chain data not loaded).';
      const userInputText = ri?.expiry
        ? `User-entered roll: Expiry ${ri.expiry} · Short ${ri.shortStrike} / Long ${ri.longStrike} · Credit $${ri.credit}`
        : 'User has not entered roll parameters yet.';
      const prompt = `You are reviewing a roll decision for an options spread.

CURRENT POSITION:
Symbol: ${pos.symbol} · Strategy: ${pos.strategy}
DTE remaining: ${pos.dte}d · Credit received: $${pos.creditReceived.toFixed(2)} · Current P&L: ${pos.pnl != null ? (pos.pnl >= 0 ? '+' : '') + '$' + pos.pnl.toFixed(2) : 'N/A'} (${pos.pnlPct != null ? pos.pnlPct.toFixed(1) + '%' : 'N/A'})
Buffer: ${pos.buffer != null ? pos.buffer.toFixed(1) + '%' : 'N/A'} · IVR: ${pos.ivr != null ? pos.ivr + '%' : 'N/A'} · Stock price: ${pos.stockPrice != null ? '$' + pos.stockPrice.toFixed(2) : 'N/A'}

${suggestionText}
${userInputText}

PROSPER RULES: Roll at 21 DTE or 2x credit loss. Roll out 35-45 DTE, same width. New credit >= 1/3 of width. Short delta 0.20-0.30. IVR >= 30.

COST TO CONSIDER:
Close only costs approximately $\${pos.currentValue != null ? pos.currentValue.toFixed(2) : Math.abs(pos.pnl ?? 0).toFixed(2)} (net loss ~$\${pos.pnl != null ? Math.abs(pos.pnl).toFixed(2) : 'unknown'} from $\${pos.creditReceived.toFixed(2)} original credit).
Rolling nets the new credit against that close cost. The trader needs to know: is paying to roll worth it, or is a clean close better?

Assess in 4-5 sentences: (1) explicitly state close-only cost vs net roll cost and which makes more sense financially, (2) realistic probability the roll recovers, (3) do the suggested strikes/expiry make sense, (4) one specific thing to watch. Use dollar amounts. Direct, no disclaimers.`;

      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514', max_tokens: 350,
          system: 'You are a brutally honest options trading coach. Give specific, direct guidance. No hedging, no disclaimers. 3-4 sentences max.',
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      const text = data?.content?.find((b: any) => b.type === 'text')?.text ?? '';
      setRollAiGuidance(prev => ({ ...prev, [posKey]: { loading: false, text, error: '' } }));
    } catch (e: any) {
      setRollAiGuidance(prev => ({ ...prev, [posKey]: { loading: false, text: '', error: e.message } }));
    }
  };

  const activeItems = batchItems
    .filter(i => !excluded.has(i.pos.key))
    .map(i => {
      const ovr = limitOverrides[i.pos.key];
      if (ovr !== undefined && ovr !== '') {
        const parsed = parseFloat(ovr);
        if (!isNaN(parsed) && parsed > 0) {
          const updatedBody = buildCloseOrder(i.pos, parsed, i.orderBody['time-in-force'] as 'GTC' | 'Day');
          return { ...i, limitPrice: parsed, orderBody: updatedBody };
        }
      }
      return i;
    });

  const totalDebit = activeItems.reduce((s, i) => s + i.limitPrice, 0);
  const totalEstPnl = activeItems.reduce((s, i) => s + (i.estPnl ?? 0), 0);
  const warningCount = activeItems.filter(i => i.stalePriceWarning || i.duplicateGtcWarning).length;
  const priceErrorCount = activeItems.filter(i => i.priceError != null).length;

  const needsGtcConfirmation = activeItems.filter(item =>
    item.pos.hasGtc && (item.action === 'TAKE_PROFIT' || item.action === 'CUT_LOSSES' || item.action === 'CLOSE_ROLL')
  );
  const allGtcConfirmed = needsGtcConfirmation.every(item => gtcConfirmed.has(item.pos.key));

  const submitAll = async () => {
    if (needsGtcConfirmation.length > 0 && !allGtcConfirmed) {
      setErrorMsg('You must confirm replacing the existing GTC orders before submitting.');
      return;
    }

    setStatus('submitting');
    setSubmitProgress(0);
    const results: OrderResult[] = [];
    try {
      const token = dryRun ? 'DRY-RUN' : await getAccessToken();
      let completed = 0;

      for (const item of activeItems) {
        try {
          let orderId: string;

          // AUTO CANCEL EXISTING GTC IF USER CONFIRMED
          if (!dryRun && item.pos.hasGtc && gtcConfirmed.has(item.pos.key) && item.pos.gtcOrderId) {
            try {
              const gtcComplexId = (item.pos as any).gtcComplexOrderId as string | undefined;
              console.log(`CANCEL DEBUG: symbol=${item.pos.symbol} orderId=${item.pos.gtcOrderId} complexId=${gtcComplexId}`);
              const cancelResult = await cancelOrder(item.pos.accountNumber, item.pos.gtcOrderId, token, gtcComplexId);
              console.log(`CANCEL SUCCESS: ${item.pos.symbol}`, cancelResult);
              await new Promise(r => setTimeout(r, 800));
            } catch (cancelErr: any) {
              console.error(`CANCEL FAILED: ${item.pos.symbol} orderId=${item.pos.gtcOrderId} error=`, cancelErr?.message);
              // TastyTrade may reject cancel if order is in terminal/partial state.
              // Proceed with placing the new order — TT will reject it if the old one
              // is still truly active, but the user will see a clear error message.
            }
          }

          if (!dryRun) {
            try {
              const liveTotal = await fetchFreshPositionPrice(item.pos, token);
              const qty = item.pos.legs.find((l: PositionLeg) => l.direction === 'Short')?.quantity ?? 1;
              const livePerContract = liveTotal != null ? liveTotal / (qty * 100) : null;
              const creditPerContract = item.pos.creditReceived / (qty * 100);

              if (livePerContract != null) {
                if (item.action === 'PLACE_GTC' && item.limitPrice >= livePerContract) {
                  throw new Error(`GTC limit $${item.limitPrice.toFixed(2)} ≥ live spread $${livePerContract.toFixed(2)}`);
                }
                if (item.action === 'TAKE_PROFIT' || item.action === 'CUT_LOSSES' || item.action === 'CLOSE_ROLL') {
                  const pctFromLive = Math.abs(item.limitPrice - livePerContract) / livePerContract;
                  if (pctFromLive > 0.30) {
                    const freshLimit = item.action === 'TAKE_PROFIT'
                      ? Math.max(parseFloat(Math.min(creditPerContract * (1 - item.pos.profitTarget), livePerContract - 0.01).toFixed(2)), 0.01)
                      : parseFloat((livePerContract * 1.02).toFixed(2));
                    item.orderBody = buildCloseOrder(item.pos, freshLimit, item.orderBody['time-in-force'] as 'GTC' | 'Day');
                    (item as any).limitPrice = freshLimit;
                  }
                }
              }
            } catch (priceCheckErr: any) {
              if (String(priceCheckErr.message).includes('already hit') || String(priceCheckErr.message).includes('≥ live')) {
                throw priceCheckErr;
              }
              console.warn(`Pre-submit price check failed for ${item.pos.symbol}:`, priceCheckErr.message);
            }
          }

          if (dryRun) {
            const token2 = await getAccessToken();
            const validation = await ttValidateOrder(`/accounts/${item.pos.accountNumber}/orders`, token2, item.orderBody);
            if (!validation.valid) {
              throw new Error(`Validation failed: ${validation.errors.join('; ')}`);
            }
            orderId = `DRY-${Date.now().toString(36).toUpperCase()}`;
          } else {
            const res = await ttPost(`/accounts/${item.pos.accountNumber}/orders`, token, item.orderBody);
            orderId = String(res?.data?.order?.id ?? res?.data?.id ?? 'submitted');
          }

          if (item.action === 'CLOSE_ROLL' && rollMode[item.pos.key] === 'roll') {
            const ri = rollInputs[item.pos.key];
            if (ri?.expiry && ri.shortStrike && ri.longStrike && ri.credit) {
              const _ed = new Date(ri.expiry); const _td = new Date(); _td.setHours(0,0,0,0);
              if (isNaN(_ed.getTime())) throw new Error('Roll expiry is not a valid date.');
              if (_ed <= _td) throw new Error('Roll expiry is in the past. Enter a future date.');
              const optType: 'P' | 'C' = item.pos.strategy === 'BCS' ? 'C' : 'P';
              const suggestion = rollSuggestions[item.pos.key];
              const qty = item.pos.legs[0]?.quantity ?? 1;

              const inputCredit = parseFloat(ri.credit);
              const inputWidth  = Math.abs(parseFloat(ri.shortStrike) - parseFloat(ri.longStrike));
              if (inputWidth > 0 && inputCredit < inputWidth / 3) {
                throw new Error(`Roll credit $${inputCredit.toFixed(2)} is less than 1/3 of spread width $${inputWidth} ($${(inputWidth/3).toFixed(2)} min). This roll doesn't meet the credit rule.`);
              }

              let finalCredit = inputCredit;
              if (!dryRun && suggestion) {
                try {
                  const liveChain = await ttFetch(`/option-chains/${encodeURIComponent(item.pos.symbol)}/nested?expiration-date=${ri.expiry}`, token);
                  const liveStrikes: any[] = liveChain?.data?.items?.[0]?.strikes ?? [];
                  let shortLive: any = null;
                  let longLive: any = null;
                  for (const s of liveStrikes) {
                    if (s['strike-price'] === parseFloat(ri.shortStrike)) shortLive = s[optType === 'P' ? 'put' : 'call'];
                    if (s['strike-price'] === parseFloat(ri.longStrike)) longLive = s[optType === 'P' ? 'put' : 'call'];
                  }
                  if (shortLive && longLive) {
                    const shortMid = (parseFloat(shortLive.bid ?? '0') + parseFloat(shortLive.ask ?? '0')) / 2;
                    const longMid = (parseFloat(longLive.bid ?? '0') + parseFloat(longLive.ask ?? '0')) / 2;
                    const liveCreditMid = shortMid - longMid;
                    const liveCredit85 = parseFloat((liveCreditMid * 0.85).toFixed(2));
                    if (liveCreditMid > 0 && Math.abs(liveCreditMid - inputCredit) / inputCredit > 0.20) {
                      finalCredit = liveCredit85;
                    }
                    if (inputWidth > 0 && liveCreditMid < inputWidth / 3) {
                      throw new Error(`Roll credit dropped to $${liveCreditMid.toFixed(2)} — no longer meets 1/3 rule.`);
                    }
                  }
                } catch (creditCheckErr: any) {
                  if (String(creditCheckErr.message).includes('1/3 rule') || String(creditCheckErr.message).includes('credit rule')) {
                    throw creditCheckErr;
                  }
                  console.warn(`Roll credit re-fetch failed for ${item.pos.symbol}:`, creditCheckErr.message);
                }
              }

              const openBody = buildOpenSpreadOrder(
                item.pos.symbol, ri.expiry, optType,
                parseFloat(ri.shortStrike), parseFloat(ri.longStrike),
                qty, finalCredit,
                suggestion?.shortSymbol, suggestion?.longSymbol
              );

              let openId: string;
              if (dryRun) {
                await new Promise(r => setTimeout(r, 200));
                openId = `DRY-${Date.now().toString(36).toUpperCase()}-OPEN`;
              } else {
                const openRes = await ttPost(`/accounts/${item.pos.accountNumber}/orders`, token, openBody);
                openId = String(openRes?.data?.order?.id ?? openRes?.data?.id ?? 'submitted');
              }

              writeAuditEntry({
                id: crypto.randomUUID(), timestamp: new Date().toISOString(),
                symbol: item.pos.symbol, strategy: item.pos.strategy, action: 'CLOSE_ROLL',
                orderType: 'Sell to Open (Roll)', limitPrice: finalCredit,
                quantity: qty, orderId: openId,
                status: dryRun ? 'dry-run' : 'submitted',
              });

              results.push({ symbol: item.pos.symbol, action: item.action, orderId: `Close #${orderId} · Open #${openId}`, status: 'working', limitPrice: item.limitPrice, estPnl: item.estPnl });
            } else {
              results.push({ symbol: item.pos.symbol, action: item.action, orderId, status: 'working', limitPrice: item.limitPrice, estPnl: item.estPnl });
            }
          } else {
            results.push({ symbol: item.pos.symbol, action: item.action, orderId, status: 'working', limitPrice: item.limitPrice, estPnl: item.estPnl });
          }

          const _auditQty = item.pos.legs.find(l => l.direction === 'Short')?.quantity ?? 1;
          const _creditPc = item.pos.creditReceived / (_auditQty * 100);
          const _closeProfitPct = (item.action === 'TAKE_PROFIT' && _creditPc > 0 && item.estPnl != null)
            ? Math.round(((item.pos.creditReceived - (item.limitPrice * _auditQty * 100)) / item.pos.creditReceived) * 100)
            : undefined;
          writeAuditEntry({
            id: crypto.randomUUID(), timestamp: new Date().toISOString(),
            symbol: item.pos.symbol, strategy: item.pos.strategy, action: item.action,
            orderType: item.orderBody['order-type'], limitPrice: item.limitPrice,
            quantity: _auditQty, orderId,
            status: dryRun ? 'dry-run' : 'submitted',
            estPnl: item.estPnl ?? undefined,
            closeProfitPct: _closeProfitPct,
            creditAtClose: _creditPc,
          });

          const verdict = verdicts[item.pos.key] ?? null;
          const overridden = overrides.has(item.pos.key);
          const updatedMem = recordTradeInMemory(item.pos, item.action, item.limitPrice, verdict, overridden);

          const profile = updatedMem.symbolProfiles[item.pos.symbol];
          if (profile && profile.recentTrades.length > MEMORY_RAW_TRADES_PER_SYMBOL) {
            summarizeSymbolHistory(item.pos.symbol).catch(() => {});
          }

        } catch (e: any) {
          results.push({ symbol: item.pos.symbol, action: item.action, orderId: '—', status: 'error', error: e.message, limitPrice: item.limitPrice, estPnl: item.estPnl });
          writeAuditEntry({
            id: crypto.randomUUID(), timestamp: new Date().toISOString(),
            symbol: item.pos.symbol, strategy: item.pos.strategy, action: item.action,
            orderType: item.orderBody['order-type'], limitPrice: item.limitPrice,
            quantity: item.pos.legs[0]?.quantity ?? 1, orderId: '—', status: 'error', error: e.message,
          });
        }
        completed++;
        setSubmitProgress(Math.round((completed / activeItems.length) * 100));
      }
      setOrderResults(results);
      setStatus('done');
    } catch (e: any) {
      setErrorMsg(e.message); setStatus('error');
    }
  };

  const filledCount = orderResults.filter(r => r.status === 'filled' || r.status === 'working' || r.status === 'submitted').length;
  const rejectedCount = orderResults.filter(r => r.status === 'error' || r.status === 'rejected').length;

  return (
    <div className="fixed inset-0 bg-black/85 flex items-center justify-center z-50 p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div className={`${th.sidebar} border ${th.border} rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col`}>

        {dryRun && (
          <div className="bg-amber-500/15 border-b border-amber-500/40 px-6 py-2 flex items-center gap-2 shrink-0">
            <span className="text-amber-400 font-bold text-sm">⚗</span>
            <span className="text-amber-300 text-xs font-bold tracking-wider">DRY RUN MODE — No real orders will be placed</span>
          </div>
        )}

        <div className={`flex items-center justify-between px-6 py-4 border-b ${th.border} shrink-0`}>
          <div>
            <h2 className={`text-sm font-bold ${th.text} tracking-wider`}>
              {status === 'done'
                ? dryRun ? 'DRY RUN COMPLETE' : 'ORDER RESULTS'
                : status === 'submitting'
                ? dryRun ? 'SIMULATING ORDERS...' : 'SUBMITTING ORDERS...'
                : `REVIEW ${activeItems.length} ORDER${activeItems.length !== 1 ? 'S' : ''}`}
            </h2>
          </div>
          {status !== 'submitting' && <button onClick={onClose} className={`text-xl ${th.textFaint} hover:${th.text}`}>✕</button>}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {needsGtcConfirmation.length > 0 && (
            <div className="bg-yellow-500/10 border border-yellow-500/40 rounded-xl p-4">
              <p className="text-yellow-400 font-bold text-sm mb-3">⚠ Existing GTC Close Order Detected</p>
              {needsGtcConfirmation.map(item => {
                const gtcProfit = item.pos.gtcOrderPrice != null && item.pos.creditReceived > 0
                  ? Math.round(((item.pos.creditReceived - (item.pos.gtcOrderPrice * (item.pos.legs.find(l => l.direction === 'Short')?.quantity ?? 1) * 100)) / item.pos.creditReceived) * 100)
                  : null;
                return (
                  <div key={item.pos.key} className="flex items-center justify-between py-2 border-b border-yellow-500/20 last:border-none">
                    <div>
                      <span className="text-xs font-medium">{item.pos.symbol}</span>
                      <span className="text-xs text-yellow-300 ml-2">— existing GTC Close at <span className="font-bold">{gtcProfit !== null ? `${gtcProfit}%` : '—'} profit</span></span>
                    </div>
                    <label className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={gtcConfirmed.has(item.pos.key)}
                        onChange={() => {
                          setGtcConfirmed(prev => {
                            const n = new Set(prev);
                            if (gtcConfirmed.has(item.pos.key)) n.delete(item.pos.key);
                            else n.add(item.pos.key);
                            return n;
                          });
                        }}
                        className="accent-yellow-400"
                      />
                      <span className="text-yellow-400 font-medium">Replace existing GTC</span>
                    </label>
                  </div>
                );
              })}
              <p className="text-[10px] text-yellow-300 mt-2">Confirming will cancel the old GTC and place the new close order.</p>
            </div>
          )}

          {/* Enriching spinner */}
          {status === 'enriching' && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <p className={`text-xs ${th.textFaint} tracking-widest`}>FETCHING LIVE PRICES & CHAIN DATA...</p>
            </div>
          )}

          {/* Submitting progress */}
          {status === 'submitting' && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <div className="w-full max-w-xs">
                <div className={`h-2 rounded-full ${th.border} border overflow-hidden`}>
                  <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${submitProgress}%` }} />
                </div>
              </div>
              <p className={`text-xs ${th.textFaint}`}>{submitProgress}% — {Math.round(activeItems.length * submitProgress / 100)} of {activeItems.length} orders submitted</p>
            </div>
          )}

          {/* Order results */}
          {status === 'done' && (
            <div className="p-6 space-y-4">
              <div className="flex gap-4">
                {filledCount > 0 && <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-emerald-500" /><span className="text-xs text-emerald-400 font-bold">{filledCount} submitted</span></div>}
                {rejectedCount > 0 && <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-red-500" /><span className="text-xs text-red-400 font-bold">{rejectedCount} rejected</span></div>}
              </div>
              <div className="space-y-2">
                {orderResults.map((r, i) => (
                  <div key={i} className={`p-3 rounded-lg border ${r.status === 'error' || r.status === 'rejected' ? 'border-red-500/40 bg-red-500/5' : 'border-emerald-500/20 bg-emerald-500/5'}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{r.symbol}</span>
                        <span className={`text-[10px] ${ACTION_META[r.action].color}`}>{ACTION_META[r.action].label}</span>
                        {(r.status === 'error' || r.status === 'rejected') && <span className="text-[9px] text-red-400 font-bold">REJECTED</span>}
                      </div>
                      <div className="text-right">
                        <p className={`text-[10px] ${th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>{r.orderId}</p>
                        {r.estPnl != null && <p className={`text-[10px] font-bold ${r.estPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{r.estPnl >= 0 ? '+' : ''}${r.estPnl.toFixed(2)}</p>}
                      </div>
                    </div>
                    {r.error && (
                      <div className="mt-2 p-2 rounded bg-red-500/10 border border-red-500/20">
                        <p className="text-[10px] text-red-300 leading-relaxed">
                          {r.error.includes('cannot_close_against_more_than_existing') || r.error.includes('closing order')
                            ? `TastyTrade blocked this order because an existing closing order is already working on this position. Go to TastyTrade → Activity → Working Orders, cancel the existing GTC on ${r.symbol}, then retry here.`
                            : r.error.includes('cannot_update_order') || r.error.includes('cancel')
                            ? `The existing GTC order could not be cancelled automatically. Cancel it manually in TastyTrade first, then retry.`
                            : r.error}
                        </p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <p className={`text-[10px} ${th.textFaint} text-center`}>
                {dryRun ? 'Dry run complete' : 'Verify working orders in TastyTrade. Positions will refresh on close.'}
              </p>
            </div>
          )}

          {status === 'error' && (
            <div className="p-6 flex flex-col items-center gap-3">
              <span className="text-2xl">✕</span>
              <p className="text-sm font-bold text-red-400">FAILED</p>
              <div className={`p-3 rounded-lg bg-red-500/10 border border-red-500/40 w-full`}>
                <p className="text-xs text-red-300" style={{ fontFamily: "'DM Mono', monospace" }}>{errorMsg}</p>
              </div>
            </div>
          )}

          {status === 'ready' && (
            <div className="space-y-2">
              {priceErrorCount > 0 && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/40">
                  <span className="text-red-400 font-bold">✕</span>
                  <p className="text-xs text-red-400 font-bold">{priceErrorCount} position{priceErrorCount !== 1 ? 's have' : ' has'} price errors — uncheck or fix before submitting.</p>
                </div>
              )}
              {warningCount > 0 && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                  <span className="text-yellow-400">⚠</span>
                  <p className="text-xs text-yellow-400">{warningCount} position{warningCount !== 1 ? 's have' : ' has'} warnings. Review before submitting.</p>
                </div>
              )}

              {batchItems.map(item => {
                const isExcluded = excluded.has(item.pos.key);
                const ri = rollInputs[item.pos.key];
                const suggestion = rollSuggestions[item.pos.key];
                const verdict = verdicts[item.pos.key];
                const isStopHigh = verdict?.verdict === 'STOP' && verdict.confidence === 'HIGH';
                const isOverridden = overrides.has(item.pos.key);
                return (
                  <div key={item.pos.key} className={`rounded-lg border transition-all ${
                    isExcluded ? 'opacity-40 border-dashed' :
                    item.priceError != null && !isExcluded ? 'border-red-500/70' :
                    isStopHigh && !isOverridden ? 'border-red-500/60' :
                    verdict?.verdict === 'CAUTION' ? 'border-yellow-500/40' :
                    item.stalePriceWarning || item.duplicateGtcWarning ? 'border-yellow-500/50' :
                    th.border
                  }`}>
                    <div className="flex items-center gap-3 px-4 py-3">
                      <input type="checkbox" checked={!isExcluded}
                        onChange={() => setExcluded(prev => { const n = new Set(prev); isExcluded ? n.delete(item.pos.key) : n.add(item.pos.key); return n; })}
                        className="w-4 h-4 accent-blue-500 cursor-pointer shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-sm font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{item.pos.symbol}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 border rounded font-bold ${stratColor(item.pos.strategy)}`}>{item.pos.strategy}</span>
                          <span className={`text-[10px] font-bold ${ACTION_META[item.action].color}`}>{ACTION_META[item.action].label}</span>
                          {verdict && <ActionVerdictBadge verdict={verdict} compact th={th} />}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                          <span className={`text-[10px] ${th.textFaint}`}>{item.pos.expDate} · {item.pos.dte}d</span>
                          {item.stalePriceWarning && <span className="text-[10px] text-yellow-400 font-bold">⚠ Price moved since load</span>}
                          {item.duplicateGtcWarning && <span className="text-[10px] text-yellow-400 font-bold">⚠ GTC already working</span>}
                        </div>
                        {item.priceError != null && !isExcluded && (
                          <div className="mt-1.5 flex items-start gap-1.5">
                            <span className="text-red-400 text-[9px] mt-0.5 shrink-0">✕</span>
                            <p className="text-[9px] text-red-400 leading-relaxed">{item.priceError}</p>
                          </div>
                        )}
                      </div>
                      <div className="text-right shrink-0 space-y-1 min-w-[140px]">
                        {/* Live spread value — shown prominently so user can sanity-check limit */}
                        {item.freshPerContract != null && (
                          <div className="flex items-center justify-end gap-1 mb-1">
                            <span className={`text-[9px] ${th.textFaint}`}>Live spread</span>
                            <span className="text-[11px] font-bold text-blue-300" style={{ fontFamily: "'DM Mono', monospace" }}>
                              ${item.freshPerContract.toFixed(2)}/ct
                            </span>
                          </div>
                        )}
                        <div className="flex items-center justify-end gap-1">
                          <span className={`text-[9px] ${th.textFaint}`}>Limit $</span>
                          <input
                            type="number"
                            step="0.01"
                            min="0.01"
                            value={limitOverrides[item.pos.key] ?? item.limitPrice.toFixed(2)}
                            onChange={e => setLimitOverrides(prev => ({ ...prev, [item.pos.key]: e.target.value }))}
                            onBlur={e => {
                              const v = parseFloat(e.target.value);
                              if (isNaN(v) || v <= 0) setLimitOverrides(prev => { const n = { ...prev }; delete n[item.pos.key]; return n; });
                              else setLimitOverrides(prev => ({ ...prev, [item.pos.key]: v.toFixed(2) }));
                            }}
                            className={`w-20 text-xs font-bold text-right px-1.5 py-0.5 rounded border ${
                              item.freshPerContract != null && parseFloat(limitOverrides[item.pos.key] ?? item.limitPrice.toFixed(2)) < item.freshPerContract * 0.5
                                ? 'border-orange-500/60 text-orange-400'  // limit looks suspiciously low vs live
                                : item.priceError != null
                                ? 'border-red-500/60 text-red-400'
                                : 'border-blue-500/40 text-blue-400'
                            } bg-transparent outline-none focus:ac-border`}
                            style={{ fontFamily: "'DM Mono', monospace" }}
                          />
                        </div>
                        {/* Warn if limit is far below live spread value */}
                        {item.freshPerContract != null && (() => {
                          const enteredLimit = parseFloat(limitOverrides[item.pos.key] ?? item.limitPrice.toFixed(2));
                          if (enteredLimit < item.freshPerContract * 0.5) {
                            return (
                              <p className="text-[9px] text-orange-400 font-bold">
                                ⚠ limit far below live ${item.freshPerContract.toFixed(2)}
                              </p>
                            );
                          }
                          return null;
                        })()}
                        {item.estPnl != null && (
                    <p className={`text-[10px} font-bold ${item.estPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {item.estPnl >= 0 ? '+' : ''}${item.estPnl.toFixed(2)}
                          </p>
                        )}
                        <p className={`text-[10px} ${th.textFaint}`}>{item.orderBody['time-in-force']}</p>
                      </div>
                    </div>

                    {item.action === 'CLOSE_ROLL' && !isExcluded && (
                      <div className={`px-4 pb-3 border-t ${th.borderLight}`}>
                        <div className="flex items-center gap-2 pt-2 pb-2">
                          <span className={`text-[9px} ${th.textFaint} uppercase`}>Action:</span>
                          <button onClick={() => setRollMode((p: Record<string,string>) => ({...p, [item.pos.key]: 'close'}))} className={`text-[9px] px-2 py-0.5 rounded border font-bold ${(rollMode[item.pos.key] ?? 'close') === 'close' ? 'border-emerald-500 text-emerald-400 bg-emerald-500/10' : th.border + ' ' + th.textFaint}`}>Close Only</button>
                          <button onClick={() => {
                            setRollMode((p: Record<string,string>) => ({...p, [item.pos.key]: 'roll'}));
                            if (!rollAiGuidance[item.pos.key]?.text && !rollAiGuidance[item.pos.key]?.loading) {
                              fetchRollGuidance(item.pos.key, item.pos, suggestion ?? null);
                            }
                          }} className={`text-[9px] px-2 py-0.5 rounded border font-bold ${rollMode[item.pos.key] === 'roll' ? 'border-purple-500 text-purple-400 bg-purple-500/10' : th.border + ' ' + th.textFaint}`}>Close + Roll</button>
                          <span className={`text-[9px} ${th.textFaint}`}>{rollMode[item.pos.key] === 'roll' ? 'Closes and opens new spread.' : 'Closes position only.'}</span>
                        </div>
                        <div className="pt-2 space-y-3" style={{display: rollMode[item.pos.key] === 'roll' ? undefined : 'none'}}>
                          {/* Cost comparison — instant, no API needed */}
                          {(() => {
                            const closeOnly = item.pos.currentValue ?? Math.abs(item.pos.pnl ?? 0);
                            const newCredit = suggestion?.credit ?? parseFloat(rollInputs[item.pos.key]?.credit ?? '0') ?? 0;
                            const netRollCost = closeOnly - newCredit;
                            const breakEven = newCredit > 0 ? (netRollCost / newCredit * 100).toFixed(0) : null;
                            const originalCredit = item.pos.creditReceived;
                            const totalCost = originalCredit > 0 ? ((closeOnly / originalCredit) * 100).toFixed(0) : null;
                            if (closeOnly <= 0) return null;
                            return (
                              <div className={`rounded-lg border ${th.border} p-3`} style={{ background: 'rgba(255,255,255,0.02)' }}>
                                <p className="text-[9px] text-white/40 uppercase tracking-widest mb-2 font-bold">Cost Comparison</p>
                                <div className="grid grid-cols-3 gap-3">
                                  <div>
                                    <p className="text-[9px] text-white/40 mb-0.5">Close only</p>
                                    <p className="text-sm font-bold text-red-400" style={{ fontFamily: "'DM Mono', monospace" }}>
                                      -${closeOnly.toFixed(2)}
                                    </p>
                                    <p className="text-[9px] text-white/30">{totalCost ? totalCost + '% of credit' : ''}</p>
                                  </div>
                                  <div>
                                    <p className="text-[9px] text-white/40 mb-0.5">New credit</p>
                                    <p className={`text-sm font-bold ${newCredit > 0 ? 'text-emerald-400' : 'text-white/30'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                                      {newCredit > 0 ? '+$' + newCredit.toFixed(2) : '—'}
                                    </p>
                                    <p className="text-[9px] text-white/30">{newCredit > 0 ? 'collected on roll' : 'enter roll params'}</p>
                                  </div>
                                  <div>
                                    <p className="text-[9px] text-white/40 mb-0.5">Net roll cost</p>
                                    <p className={`text-sm font-bold ${netRollCost <= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                                      {newCredit > 0 ? (netRollCost >= 0 ? '-$' : '+$') + Math.abs(netRollCost).toFixed(2) : '—'}
                                    </p>
                                    <p className="text-[9px] text-white/30">
                                      {breakEven && newCredit > 0 ? `need ${breakEven}% profit to break even` : ''}
                                    </p>
                                  </div>
                                </div>
                              </div>
                            );
                          })()}

                          {/* AI Roll Guidance */}
                          {(rollAiGuidance[item.pos.key]?.loading || rollAiGuidance[item.pos.key]?.text || rollAiGuidance[item.pos.key]?.error) && (
                            <div className={`rounded-lg border p-3 border-indigo-500/40 bg-indigo-500/5`}>
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-[9px] text-indigo-400 font-bold uppercase tracking-widest">◈ AI Roll Guidance</span>
                                {!rollAiGuidance[item.pos.key]?.loading && (
                                  <button
                                    onClick={() => fetchRollGuidance(item.pos.key, item.pos, suggestion ?? null)}
                                    className="text-[9px] text-indigo-400/60 hover:text-indigo-400 transition-colors">
                                    ↺ Regenerate
                                  </button>
                                )}
                              </div>
                              {rollAiGuidance[item.pos.key]?.loading && (
                                <div className="flex items-center gap-2">
                                  <div className="w-3 h-3 border border-indigo-400 border-t-transparent rounded-full animate-spin shrink-0" />
                                  <span className="text-[10px] text-indigo-400/60">Analyzing roll...</span>
                                </div>
                              )}
                              {rollAiGuidance[item.pos.key]?.text && (
                                <p className="text-[11px] text-indigo-100 leading-relaxed">{rollAiGuidance[item.pos.key].text}</p>
                              )}
                              {rollAiGuidance[item.pos.key]?.error && (
                                <p className="text-[10px] text-red-400">{rollAiGuidance[item.pos.key].error}</p>
                              )}
                            </div>
                          )}
                          {/* Delta Range control for this roll */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[9px] ${th.textFaint} tracking-wider`}>Δ RANGE</span>
                            {([
                              { label: 'Conservative', min: 0.15, max: 0.20 },
                              { label: 'Standard',     min: 0.20, max: 0.25 },
                              { label: 'Aggressive',   min: 0.25, max: 0.30 },
                            ] as { label: string; min: number; max: number }[]).map(p => (
                              <button key={p.label}
                                onClick={async () => {
                                  const range: [number, number] = [p.min, p.max];
                                  setRollDeltaRange(range);
                                  const token = await getAccessToken();
                                  const s = await fetchRollSuggestion(item.pos, token, range).catch(() => null);
                                  if (s) setRollSuggestions(prev => ({ ...prev, [item.pos.key]: s }));
                                }}
                                className={`text-[9px] px-2 py-0.5 rounded border transition-colors font-bold ${
                                  rollDeltaRange[0] === p.min && rollDeltaRange[1] === p.max
                                    ? 'border-blue-500 text-blue-300 bg-blue-500/15'
                                    : `${th.border} ${th.textFaint} hover:border-blue-500/50 hover:text-blue-400`
                                }`}>
                                {p.label}
                              </button>
                            ))}
                            <span className={`text-[9px] ${th.textFaint}`}>
                              ({rollDeltaRange[0].toFixed(2)}–{rollDeltaRange[1].toFixed(2)})
                            </span>
                          </div>

                          {suggestion && (
                            <div className={`rounded-lg border p-3 space-y-2 ${
                              rollIsBlocking(suggestion) ? 'border-red-500/50 bg-red-500/5' :
                              suggestion.ruleViolations.length > 0 ? 'border-yellow-500/40 bg-yellow-500/5' :
                              'border-blue-500/30 bg-blue-500/5'
                            }`}>
                              <div className="flex items-center justify-between flex-wrap gap-2">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-[9px] text-blue-400 font-bold uppercase tracking-widest">Suggested Roll</span>
                                  <span className="text-[10px] ac-text" style={{ fontFamily: "'DM Mono', monospace" }}>
                                    {suggestion.expiry} ({suggestion.dte}d) · {suggestion.shortStrike}/{suggestion.longStrike} · δ{suggestion.delta.toFixed(2)}
                                  </span>
                                </div>
                                <button onClick={() => setRollInputs(prev => ({
                                  ...prev,
                                  [item.pos.key]: { expiry: suggestion.expiry, shortStrike: String(suggestion.shortStrike), longStrike: String(suggestion.longStrike), credit: String(suggestion.credit) }
                                }))} className="text-[9px] px-2 py-0.5 border ac-btn rounded hover:ac-bg-20 transition-colors">
                                  Use this
                                </button>
                              </div>
                              <div className="grid grid-cols-4 gap-2">
                                <div>
                                  <p className={`text-[9px} ${th.textFaint}`}>Credit (mid)</p>
                                  <p className={`text-[10px} font-bold ${suggestion.meetsMinCredit ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                                    ${suggestion.creditMid.toFixed(2)}
                                  </p>
                                  <p className={`text-[9px} ${th.textFaint}`}>{(suggestion.creditRatio * 100).toFixed(0)}% of width</p>
                                </div>
                                <div>
                                  <p className={`text-[9px} ${th.textFaint}`}>Limit order</p>
                                  <p className={`text-[10px} font-bold text-blue-400`} style={{ fontFamily: "'DM Mono', monospace" }}>
                                    ${suggestion.credit.toFixed(2)}
                                  </p>
                                  <p className={`text-[9px} ${th.textFaint}`}>85% of mid</p>
                                </div>
                                <div>
                                  <p className={`text-[9px} ${th.textFaint}`}>OI (short/long)</p>
                                  <p className={`text-[10px} font-bold ${suggestion.meetsOi ? 'text-emerald-400' : 'text-yellow-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                                    {suggestion.shortOi ?? '?'} / {suggestion.longOi ?? '?'}
                                  </p>
                                  <p className={`text-[9px} ${th.textFaint}`}>need ≥500</p>
                                </div>
                                <div>
                                  <p className={`text-[9px} ${th.textFaint}`}>Bid-ask (sh/lg)</p>
                                  <p className={`text-[10px} font-bold ${suggestion.meetsBidAsk ? 'text-emerald-400' : 'text-yellow-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                                    ${suggestion.shortBidAsk?.toFixed(2) ?? '?'} / ${suggestion.longBidAsk?.toFixed(2) ?? '?'}
                                  </p>
                                  <p className={`text-[9px} ${th.textFaint}`}>need ≤$0.10</p>
                                </div>
                              </div>
                              {suggestion.ruleViolations.length > 0 && (
                                <div className="space-y-1">
                                  {suggestion.ruleViolations.map((v, i) => (
                                    <div key={i} className="flex items-start gap-1.5">
                                      <span className={`text-[9px} shrink-0 mt-0.5 ${rollIsBlocking(suggestion) ? 'text-red-400' : 'text-yellow-400'}`}>
                                        {rollIsBlocking(suggestion) ? '✕' : '⚠'}
                                      </span>
                                      <p className={`text-[9px} leading-relaxed ${rollIsBlocking(suggestion) ? 'text-red-300' : 'text-yellow-300'}`}>{v}</p>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          <div className="grid grid-cols-4 gap-2">
                            {[
                              { label: 'New Expiry', key: 'expiry', placeholder: (() => { const d = new Date(); d.setDate(d.getDate() + 45); return d.toISOString().slice(0, 10); })() },
                              { label: 'Short Strike', key: 'shortStrike', placeholder: '490' },
                              { label: 'Long Strike', key: 'longStrike', placeholder: '485' },
                              { label: 'Credit ($)', key: 'credit', placeholder: '1.50' },
                            ].map(f => (
                              <div key={f.key}>
                                <p className={`text-[9px} ${th.textFaint} mb-1`}>{f.label}</p>
                                <input
                                  value={ri?.[f.key as keyof typeof ri] ?? ''}
                                  onChange={e => setRollInputs(prev => ({ ...prev, [item.pos.key]: { ...prev[item.pos.key], [f.key]: e.target.value } }))}
                                  placeholder={f.placeholder}
                                  className={`w-full text-[10px] px-2 py-1.5 rounded border ${th.inputBorder} ${th.input} ${th.text} outline-none focus:border-purple-500`}
                                  style={{ fontFamily: "'DM Mono', monospace" }}
                                />
                              </div>
                            ))}
                          </div>

                          {ri?.credit && ri?.shortStrike && ri?.longStrike && (() => {
                            const inputCredit = parseFloat(ri.credit);
                            const inputWidth  = Math.abs(parseFloat(ri.shortStrike) - parseFloat(ri.longStrike));
                            const inputRatio  = inputWidth > 0 ? inputCredit / inputWidth : 0;
                            const minCredit   = inputWidth / 3;
                            if (inputCredit > 0 && inputRatio < 1/3) {
                              return (
                                <p className="text-[9px} text-red-400">
                                  ✕ Credit ${inputCredit.toFixed(2)} &lt; 1/3 of ${inputWidth} spread (${minCredit.toFixed(2)} min) — violates credit rule
                                </p>
                              );
                            }
                            if (inputCredit > 0) {
                              return (
                                <p className="text-[9px} text-emerald-400">
                                  ✓ Credit ratio {(inputRatio * 100).toFixed(0)}% of spread width — meets 1/3 rule
                                </p>
                              );
                            }
                            return null;
                          })()}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className={`px-6 py-4 border-t ${th.border} shrink-0`}>
          {status === 'ready' && (
            <div className="space-y-3">
              <div className={`flex items-center justify-between p-3 rounded-lg ${th.card}`}>
                <div className="flex gap-6">
                  <div>
                    <p className={`text-[9px} ${th.textFaint} uppercase tracking-widest`}>Orders</p>
                    <p className={`text-sm font-bold ${th.text}`}>{activeItems.length}</p>
                  </div>
                  <div>
                    <p className={`text-[9px} ${th.textFaint} uppercase tracking-widest`}>Total Debit</p>
                    <p className="text-sm font-bold text-blue-400" style={{ fontFamily: "'DM Mono', monospace" }}>${totalDebit.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className={`text-[9px} ${th.textFaint} uppercase tracking-widest`}>Est. P&L</p>
                    <p className={`text-sm font-bold ${totalEstPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                      {totalEstPnl >= 0 ? '+' : ''}${totalEstPnl.toFixed(2)}
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex gap-3">
                {needsGtcConfirmation.length > 0 && !allGtcConfirmed ? (
                  <button disabled className="flex-1 py-3 bg-slate-700 text-slate-400 rounded-xl text-xs font-bold tracking-widest cursor-not-allowed">
                    CONFIRM REPLACING EXISTING GTC TO CONTINUE
                  </button>
                ) : (
                  <button onClick={submitAll} disabled={activeItems.length === 0}
                    className={`flex-1 py-3 text-white rounded-xl text-xs font-bold tracking-widest transition-colors ${dryRun ? 'bg-amber-600 hover:bg-amber-500' : 'ac-btn-solid'}`}>
                    {dryRun ? `⚗ DRY RUN — Simulate ${activeItems.length} Order${activeItems.length !== 1 ? 's' : ''}` : `SUBMIT ${activeItems.length} ORDER${activeItems.length !== 1 ? 'S' : ''}`}
                  </button>
                )}
                <button onClick={onClose} className={`px-4 py-3 border ${th.border} ${th.textFaint} rounded-xl text-xs font-medium hover:border-white/30 transition-colors`}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {status === 'done' && (
            <div className="flex gap-3">
              <button onClick={() => { onSuccess(); onClose(); }} className={`flex-1 py-3 text-white rounded-xl text-xs font-bold tracking-widest transition-colors ${dryRun ? 'bg-amber-600 hover:bg-amber-500' : 'ac-btn-solid'}`}>
                {dryRun ? 'DRY RUN DONE — Close' : 'DONE — REFRESH POSITIONS'}
              </button>
            </div>
          )}
          {status === 'error' && (
            <button onClick={onClose} className={`w-full py-3 border ${th.border} ${th.textFaint} rounded-xl text-xs font-medium hover:border-white/30 transition-colors`}>
              Close
            </button>
          )}
          {(status === 'enriching' || status === 'submitting') && (
            <button disabled className="w-full py-3 bg-slate-700 text-slate-500 rounded-xl text-xs font-bold tracking-widest">
              {status === 'enriching' ? 'FETCHING DATA...' : 'SUBMITTING...'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Audit Log Panel ────────────────────────────────────────────────────────
function AuditLogPanel({ onClose, th }: { onClose: () => void; th: typeof THEMES[Theme] }) {
  const [log, setLog] = useState<AuditEntry[]>([]);

  useEffect(() => {
    setLog(readAuditLog());
  }, []);

  const clearAuditLog = () => {
    if (!confirm('Clear the audit log? This cannot be undone.')) return;
    try {
      localStorage.removeItem(LS_AUDIT_LOG);
      setLog([]);
    } catch {}
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className={`${th.card} border ${th.border} rounded-2xl w-full max-w-5xl max-h-[85vh] overflow-hidden shadow-2xl`}>
        <div className={`px-6 py-4 border-b ${th.border} flex items-center justify-between`}>
          <div>
            <h2 className={`text-lg font-bold ${th.text}`}>Audit Log</h2>
            <p className={`text-xs ${th.textFaint}`}>{log.length} recorded action{log.length === 1 ? '' : 's'}</p>
          </div>
          <button onClick={onClose} className={`text-xl ${th.textFaint} hover:${th.text}`}>×</button>
        </div>

        <div className="p-6 overflow-y-auto max-h-[65vh]">
          {log.length === 0 ? (
            <div className={`p-8 rounded-xl border ${th.border} text-center ${th.textMuted}`}>
              No audit entries yet.
            </div>
          ) : (
            <div className="space-y-2">
              {log.map((entry) => (
                <div key={entry.id} className={`p-4 rounded-xl border ${th.border} ${th.input}`}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className={`font-bold ${th.text}`}>{entry.symbol}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded ${th.tag} ${th.textMuted}`}>{entry.strategy}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded ${entry.status === 'error' ? 'bg-red-500/15 text-red-300' : entry.status === 'dry-run' ? 'bg-yellow-500/15 text-yellow-300' : 'bg-emerald-500/15 text-emerald-300'}`}>
                          {entry.status}
                        </span>
                      </div>
                      <p className={`text-xs ${th.textFaint} mt-1`}>
                        {new Date(entry.timestamp).toLocaleString()} · {entry.action} · {entry.orderType}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className={`text-sm font-mono ${th.text}`}>${entry.limitPrice.toFixed(2)}</p>
                      <p className={`text-xs ${th.textFaint}`}>Qty {entry.quantity}</p>
                    </div>
                  </div>
                  {entry.error && <p className="mt-2 text-xs text-red-300">{entry.error}</p>}
                  {entry.estPnl != null && <p className={`mt-2 text-xs ${entry.estPnl >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>Est. P/L: ${entry.estPnl.toFixed(2)}</p>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={`px-6 py-4 border-t ${th.border} flex gap-3 justify-end`}>
          <button onClick={exportAuditCsv} disabled={log.length === 0} className={`px-4 py-2 rounded-xl border ${th.border} ${th.textMuted} disabled:opacity-40 text-xs font-bold tracking-widest`}>
            Export CSV
          </button>
          <button onClick={clearAuditLog} disabled={log.length === 0} className="px-4 py-2 rounded-xl border border-red-500/40 text-red-300 disabled:opacity-40 text-xs font-bold tracking-widest">
            Clear
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-white text-black text-xs font-bold tracking-widest">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Memory Panel ───────────────────────────────────────────────────────────
function MemoryPanel({ onClose, th }: { onClose: () => void; th: typeof THEMES[Theme] }) {
  const [mem, setMem] = useState<TradingMemory>(readMemory);
  const [summarizing, setSummarizing] = useState(false);

  const handleSummarizeAll = async () => {
    setSummarizing(true);
    try {
      const m = readMemory();
      // Summarize all symbols with enough data
      for (const sym of Object.keys(m.symbolProfiles)) {
        if (m.symbolProfiles[sym].recentTrades.length > MEMORY_RAW_TRADES_PER_SYMBOL) {
          await summarizeSymbolHistory(sym);
        }
      }
      // Force behavior summarization regardless of time interval
      const m2 = readMemory();
      m2.lastSummarized = null; // reset so summarize runs
      writeMemory(m2);
      await summarizeBehaviorProfile();
      setMem(readMemory());
    } finally { setSummarizing(false); }
  };

  const symbols = Object.values(mem.symbolProfiles).sort((a, b) => b.tradeCount - a.tradeCount);
  const bp = mem.behaviorProfile;

  return (
    <div className="fixed inset-0 bg-black/85 flex items-center justify-center z-50 p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div className={`${th.sidebar} border ${th.border} rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col`}>
        <div className={`flex items-center justify-between px-6 py-4 border-b ${th.border} shrink-0`}>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-purple-400 text-sm">◆</span>
              <h2 className={`text-sm font-bold ${th.text} tracking-wider`}>TRADING MEMORY</h2>
            </div>
            <p className={`text-[10px] ${th.textFaint} mt-0.5`}>
              {bp.totalTrades} trades recorded · {symbols.length} symbols tracked
              {mem.lastSummarized ? ` · Last summarized ${Math.round((Date.now() - new Date(mem.lastSummarized).getTime()) / 86400000)}d ago` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleSummarizeAll} disabled={summarizing}
              className={`text-[10px] px-3 py-1.5 border border-purple-700 text-purple-400 rounded hover:border-purple-500 hover:bg-purple-500/10 transition-colors disabled:opacity-50`}>
              {summarizing ? '◈ Summarizing...' : '◈ Summarize Now'}
            </button>
            <button onClick={() => { clearMemory(); setMem(emptyMemory()); }}
              className={`text-[10px] px-3 py-1.5 border ${th.border} ${th.textFaint} rounded hover:border-red-500 hover:text-red-400 transition-colors`}>
              Clear
            </button>
            <button onClick={onClose} className={`text-xl ${th.textFaint} hover:${th.text}`}>✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {bp.totalTrades === 0 && (
            <div className="flex flex-col items-center justify-center h-40 gap-2">
              <p className={`text-sm ${th.textFaint}`}>No trades recorded yet</p>
              <p className={`text-[10px] ${th.textFaint} text-center max-w-xs`}>
                Memory builds automatically as you execute trades through Options Hunter. Each trade teaches the verdict engine your patterns.
              </p>
            </div>
          )}

          {/* Behavioral profile */}
          {bp.totalTrades > 0 && (
            <div className={`p-4 rounded-xl border border-purple-700/40 bg-purple-500/5`}>
              <p className="text-[9px] text-purple-400 uppercase tracking-widest mb-3 font-bold">Your Trading Profile</p>
              <div className="grid grid-cols-3 gap-4 mb-3">
                <div>
                  <p className={`text-[9px] ${th.textFaint}`}>Total trades</p>
                  <p className={`text-sm font-bold ${th.text}`}>{bp.totalTrades}</p>
                </div>
                <div>
                  <p className={`text-[9px] ${th.textFaint}`}>AI overrides</p>
                  <p className={`text-sm font-bold ${bp.overrideCount > 0 ? 'text-yellow-400' : th.textFaint}`}>
                    {bp.overrideCount}
                    {bp.overrideCount > 0 && <span className={`text-[10px] ml-1 ${th.textFaint}`}>({Math.round((bp.overrideWins / bp.overrideCount) * 100)}% right)</span>}
                  </p>
                </div>
                <div>
                  <p className={`text-[9px] ${th.textFaint}`}>Symbols tracked</p>
                  <p className={`text-sm font-bold ${th.text}`}>{symbols.length}</p>
                </div>
              </div>
              {bp.summary && <p className={`text-[11px] ${th.textFaint} leading-relaxed mb-2`}>{bp.summary}</p>}
              <div className="grid grid-cols-2 gap-3">
                {bp.strengths.length > 0 && (
                  <div>
                    <p className="text-[9px] text-emerald-400 font-bold mb-1">Strengths</p>
                    {bp.strengths.map((s, i) => <p key={i} className="text-[10px] text-emerald-300">▸ {s}</p>)}
                  </div>
                )}
                {bp.weaknesses.length > 0 && (
                  <div>
                    <p className="text-[9px] text-red-400 font-bold mb-1">Watch out for</p>
                    {bp.weaknesses.map((w, i) => <p key={i} className="text-[10px] text-red-300">▸ {w}</p>)}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Symbol profiles */}
          {symbols.length > 0 && (
            <div>
              <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-3 font-bold`}>Symbol History</p>
              <div className="space-y-3">
                {symbols.map(profile => (
                  <div key={profile.symbol} className={`p-4 rounded-lg border ${th.border}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-3">
                        <span className={`text-sm font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{profile.symbol}</span>
                        <span className={`text-[10px] ${th.textFaint}`}>{profile.tradeCount} trades</span>
                        <span className={`text-[10px] font-bold ${profile.winRate >= 0.6 ? 'text-emerald-400' : profile.winRate >= 0.4 ? 'text-yellow-400' : 'text-red-400'}`}>
                          {Math.round(profile.winRate * 100)}% win rate
                        </span>
                        <span className={`text-[10px] font-bold ${profile.avgPnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          avg {profile.avgPnlPct.toFixed(1)}% P&L
                        </span>
                      </div>
                    </div>
                    {profile.historySummary && (
                      <p className={`text-[10px] ${th.textFaint} leading-relaxed mb-2`}>{profile.historySummary}</p>
                    )}
                    {profile.recentTrades.slice(0, 3).map((t, i) => {
                      const ago = Math.round((Date.now() - new Date(t.timestamp).getTime()) / 86400000);
                      return (
                        <div key={i} className={`flex items-center gap-3 text-[9px] py-1 border-t ${th.borderLight} first:border-t-0`}>
                          <span className={`${th.textFaint} w-12 shrink-0`}>{ago}d ago</span>
                          <span className={`${th.text} w-16 shrink-0`} style={{ fontFamily: "'DM Mono', monospace" }}>{t.strategy}</span>
                          <span className={`${th.textFaint} flex-1`}>{t.action} @ {t.dte}d DTE</span>
                          <span className={`font-bold ${t.outcome === 'WIN' ? 'text-emerald-400' : t.outcome === 'LOSS' ? 'text-red-400' : 'text-slate-400'}`}>
                            {t.pnlPct >= 0 ? '+' : ''}{t.pnlPct.toFixed(1)}%
                          </span>
                          {t.aiVerdict && (
                            <span className={`${t.aiVerdict === 'STOP' ? 'text-red-400' : t.aiVerdict === 'CAUTION' ? 'text-yellow-400' : 'text-emerald-400'}`}>
                              AI:{t.aiVerdict}{t.aiOverridden ? '⚡' : ''}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryBar({ positions, th }: { positions: Position[]; th: typeof THEMES[Theme] }) {
  const totalCredit   = positions.reduce((s, p) => s + p.creditReceived, 0);
  const totalPnlOpen  = positions.reduce((s, p) => s + (p.pnl ?? p.plOpen ?? 0), 0);
  const capturedPct   = totalCredit > 0 ? (totalPnlOpen / totalCredit) * 100 : 0;
  const totalAtRisk   = positions.reduce((s, p) => s + p.maxRisk, 0);
  const totalTheta    = positions.reduce((s, p) => {
    if (p.currentValue != null && p.dte > 0) return s + p.currentValue / p.dte;
    if (p.dte > 0) return s + p.creditReceived / p.dte;
    return s;
  }, 0);
  // P&L Day: positions that have live pnl AND plOpen — difference is today's move
  const posWithDay    = positions.filter(p => p.pnl != null && p.plOpen != null);
  const totalPnlDay   = posWithDay.reduce((s, p) => s + (p.pnl! - p.plOpen!), 0);
  const hasDayPnl     = posWithDay.length > 0;

  return (
    <div className={`grid grid-cols-7 border-b ${th.border}`}>
      {[
        { label: 'Open Positions',  value: String(positions.length),                                                        sub: `${positions.length} position${positions.length !== 1 ? 's' : ''}`,                                                                           color: th.text },
        { label: 'P&L Open',        value: `${totalPnlOpen >= 0 ? '+' : ''}$${Math.abs(totalPnlOpen).toFixed(0)}`,          sub: `of $${totalCredit.toFixed(0)} credit · ${capturedPct.toFixed(0)}%`,                                                                           color: totalPnlOpen >= 0 ? 'text-emerald-400' : 'text-red-400' },
        { label: 'P&L Day',         value: hasDayPnl ? `${totalPnlDay >= 0 ? '+' : ''}$${Math.abs(totalPnlDay).toFixed(0)}` : '—', sub: hasDayPnl ? `${posWithDay.length} position${posWithDay.length !== 1 ? 's' : ''} with live prices` : 'refresh for live prices',       color: !hasDayPnl ? th.textFaint : totalPnlDay >= 0 ? 'text-emerald-400' : 'text-red-400' },
        { label: `${positions.length > 0 ? Math.round(positions.reduce((s,p) => s + p.profitTarget, 0) / positions.length * 100) : 50}% Target`, value: `$${Math.round(positions.reduce((s,p) => s + p.targetPrice, 0))}`, sub: `${totalCredit > 0 ? Math.round((totalPnlOpen / Math.max(positions.reduce((s,p) => s + p.targetPrice, 0), 1)) * 100) : 0}% of target`, color: 'text-yellow-400' },
        { label: 'At Risk',         value: `$${totalAtRisk.toFixed(0)}`,                                                     sub: 'max loss if expired',                                                                                                                         color: th.textMuted },
        { label: 'Est. Theta/Day',  value: totalTheta > 0 ? `+$${totalTheta.toFixed(2)}` : '—',                             sub: 'daily decay',                                                                                                                                 color: 'text-blue-400' },
        { label: 'Collateral',      value: `$${totalCredit.toFixed(0)}`,                                                     sub: `${positions.length} spread${positions.length !== 1 ? 's' : ''}`,                                                                             color: th.textMuted },
      ].map((item, i, arr) => (
        <div key={item.label} className={`p-4 ${i < arr.length - 1 ? `border-r ${th.border}` : ''} flex flex-col items-center text-center`}>
          <p className={`text-[10px] ${th.textFaint} uppercase tracking-widest mb-2`}>{item.label}</p>
          <p className={`text-2xl font-bold ${item.color}`} style={{ fontFamily: "'DM Mono', monospace" }}>{item.value}</p>
          <p className={`text-[10px] ${th.textFaint} mt-1`}>{item.sub}</p>
        </div>
      ))}
    </div>
  );
}

// ── Analysis Panel ─────────────────────────────────────────────────────────
const CONFIDENCE_COLOR: Record<string, string> = {
  HIGH: 'text-emerald-400', MEDIUM: 'text-yellow-400', LOW: 'text-orange-400',
};
const REC_COLOR: Record<string, string> = {
  HOLD: 'text-slate-400', WATCH: 'text-yellow-400', MANAGE: 'text-orange-400',
  TAKE_PROFIT: 'text-emerald-400', CUT_LOSSES: 'text-red-400',
  CLOSE: 'text-red-400', ROLL: 'text-purple-400',
};

// ── Chat Thread ────────────────────────────────────────────────────────────
// Reusable multi-turn chat component. Receives initial context as the first
// assistant message so the AI already "knows" the position or portfolio.

function ChatThread({ initialContext, systemPrompt, placeholder, th }: {
  initialContext: string;   // the analysis text shown as the first assistant message
  systemPrompt?: string;    // optional override — defaults to TRADING_SYSTEM_PROMPT
  placeholder?: string;
  th: typeof THEMES[Theme];
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: initialContext },
  ]);
  const [input, setInput] = useState('');
  const [pendingImage, setPendingImage] = useState<{ base64: string; mediaType: string; preview: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Scroll within the chat container only — never move the page
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const [meta, base64] = dataUrl.split(',');
      const mediaType = meta.match(/:(.*?);/)?.[1] ?? 'image/jpeg';
      setPendingImage({ base64, mediaType, preview: dataUrl });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const send = async () => {
    const text = input.trim();
    if (!text && !pendingImage || loading) return;
    setInput('');
    setError(null);
    const parts: ChatContentPart[] = [];
    if (pendingImage) parts.push({ type: 'image_url', image_url: { url: `data:${pendingImage.mediaType};base64,${pendingImage.base64}` } } as any);
    if (text) parts.push({ type: 'text', text });
    const userMsg: ChatMessage = { role: 'user', content: parts.length === 1 && !pendingImage ? text : parts };
    setPendingImage(null);
    const next: ChatMessage[] = [...messages, userMsg];
    setMessages(next);
    setLoading(true);
    try {
      const reply = await callAIWithHistory(next, systemPrompt);
      setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch (e: any) {
      setError(e.message ?? 'Failed');
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const getMessageText = (content: ChatMessage['content']): string => {
    if (typeof content === 'string') return content;
    return content.filter((p): p is ChatMessagePart => p.type === 'text').map(p => p.text).join(' ');
  };

  const getMessageImage = (content: ChatMessage['content']): string | null => {
    if (typeof content === 'string') return null;
    const img = content.find((p): p is ChatImagePart => p.type === 'image');
    return img ? `data:${img.source.media_type};base64,${img.source.data}` : null;
  };

  // Suggested follow-up prompts shown below the initial analysis
  const suggestions = [
    'What would make this go wrong fast?',
    'If I roll, what strikes should I target?',
    'Should I close early given current conditions?',
    'What\'s my max pain scenario here?',
  ];

  return (
    <div className={`border-t ${th.border} flex flex-col`} style={{ background: 'rgba(99,102,241,0.03)' }}>
      {/* Message history — skip the first assistant message, it's already shown above */}
      {messages.length > 1 && (
        <div ref={scrollContainerRef} className="px-4 py-3 space-y-3 max-h-80 overflow-y-auto">
          {messages.slice(1).map((m, i) => (
            <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {m.role === 'assistant' && (
                <span className="text-indigo-400 text-[10px] mt-1 shrink-0 font-bold">◈</span>
              )}
              <div className={`max-w-[85%] rounded-xl px-3 py-2 text-[11px] leading-relaxed ${
                m.role === 'user'
                  ? 'ac-bg-20 border ac-border/30 text-blue-100 ml-auto'
                  : `${th.card} border ${th.border} ${th.textMuted}`
              }`}>
                {(() => {
                  const imgSrc = getMessageImage(m.content);
                  const txt = getMessageText(m.content);
                  return (<>
                    {imgSrc && <img src={imgSrc} alt="attachment" className="rounded-lg max-w-full mb-1.5" style={{ maxHeight: '180px', objectFit: 'contain' }} />}
                    {txt && <span>{txt}</span>}
                  </>);
                })()}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex gap-3 justify-start">
              <span className="text-indigo-400 text-[10px] mt-1 shrink-0 font-bold">◈</span>
              <div className={`${th.card} border ${th.border} rounded-xl px-3 py-2`}>
                <div className="flex gap-1 items-center h-4">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}
          {error && (
            <p className="text-[10px] text-red-400 px-1">Error: {error} —
              <button onClick={() => { setError(null); send(); }} className="underline ml-1">retry</button>
            </p>
          )}
          <div ref={bottomRef} />
        </div>
      )}

      {/* Suggestions — only shown before any user message */}
      {messages.length === 1 && (
        <div className="px-4 pt-3 pb-1 flex flex-wrap gap-1.5">
          {suggestions.map((s, i) => (
            <button key={i} onClick={() => { setInput(s); setTimeout(() => inputRef.current?.focus(), 50); }}
              className={`text-[10px] px-2.5 py-1 rounded-full border ${th.border} ${th.textFaint} hover:border-indigo-500 hover:text-indigo-400 transition-colors`}>
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="px-4 py-3 space-y-2">
        {/* Image preview */}
        {pendingImage && (
          <div className="relative inline-block">
            <img src={pendingImage.preview} alt="pending" className="rounded-lg max-h-24 object-contain border border-indigo-500/40" />
            <button onClick={() => setPendingImage(null)}
              className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-slate-700 border border-slate-500 text-slate-300 text-[9px] flex items-center justify-center hover:bg-red-600 transition-colors">
              ✕
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          {/* Hidden file input */}
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageSelect} />
          {/* Attach button */}
          <button onClick={() => fileInputRef.current?.click()} disabled={loading}
            title="Attach image"
            className={`shrink-0 w-8 h-8 rounded-xl border ${th.border} ${th.textFaint} hover:border-indigo-500 hover:text-indigo-400 disabled:opacity-40 flex items-center justify-center transition-colors`}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
            </svg>
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={placeholder ?? 'Ask a follow-up question... (Enter to send, Shift+Enter for newline)'}
            rows={1}
            disabled={loading}
            className={`flex-1 resize-none text-[11px] px-3 py-2 rounded-xl border ${th.inputBorder} ${th.input} ${th.text} outline-none focus:border-indigo-500 transition-colors placeholder:${th.textFaint} disabled:opacity-50`}
            style={{ fontFamily: "'DM Sans', system-ui, sans-serif", minHeight: '36px', maxHeight: '120px' }}
            onInput={e => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
            }}
          />
          <button onClick={send} disabled={loading || (!input.trim() && !pendingImage)}
            className="shrink-0 w-8 h-8 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 disabled:text-slate-500 text-white flex items-center justify-center transition-colors text-sm">
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}

function AnalysisPanel({ analysis, pos, th }: { analysis: PositionAnalysis; pos: Position; th: typeof THEMES[Theme] }) {
  // Build a rich initial context string for the chat thread
  const chatContext = [
    `I've analyzed your ${analysis.symbol} ${pos.strategy} position (${pos.expDate}, ${pos.dte} DTE).`,
    ``,
    `**Recommendation: ${analysis.recommendation.replace('_', ' ')}** (${analysis.confidence} confidence)`,
    ``,
    analysis.summary,
    ``,
    analysis.reasoning,
    analysis.deviatesFromRules && analysis.deviationNote ? `\n**Note:** ${analysis.deviationNote}` : '',
    analysis.risks.length > 0 ? `\n**Key risks:** ${analysis.risks.join(' · ')}` : '',
    analysis.catalysts.length > 0 ? `\n**In your favor:** ${analysis.catalysts.join(' · ')}` : '',
  ].filter(Boolean).join('\n');

  return (
    <div className={`border-t ${th.border}`} style={{ background: 'rgba(99,102,241,0.04)' }}>
      <div className="px-4 py-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-[9px] text-indigo-400 tracking-widest font-bold uppercase">AI Analysis</span>
            <span className={`text-[10px] font-bold ${REC_COLOR[analysis.recommendation] ?? 'text-white'}`}>
              → {analysis.recommendation.replace('_', ' ')}
            </span>
            <span className={`text-[9px] font-bold ${CONFIDENCE_COLOR[analysis.confidence] ?? 'text-slate-400'}`}>
              {analysis.confidence} confidence
            </span>
            {analysis.deviatesFromRules && (
              <span className="text-[9px] px-2 py-0.5 rounded border border-yellow-600/50 text-yellow-400 font-bold">
                ⚡ Outside rules
              </span>
            )}
          </div>
          <span className={`text-[9px] ${th.textFaint}`}>{new Date(analysis.generatedAt).toLocaleTimeString()}</span>
        </div>

        <p className={`text-xs ${th.textMuted} leading-relaxed`}>{analysis.summary}</p>
        <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>{analysis.reasoning}</p>

        {analysis.deviatesFromRules && analysis.deviationNote && (
          <div className="flex items-start gap-2 p-2 rounded border border-yellow-600/30 bg-yellow-500/5">
            <span className="text-yellow-400 shrink-0 text-[10px] mt-0.5">⚡</span>
            <p className="text-[10px] text-yellow-300 leading-relaxed">{analysis.deviationNote}</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          {analysis.risks.length > 0 && (
            <div>
              <p className="text-[9px] text-red-400 uppercase tracking-widest mb-1.5 font-bold">Risks</p>
              <div className="space-y-1">
                {analysis.risks.map((r, i) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <span className="text-red-400 text-[9px] mt-0.5 shrink-0">▸</span>
                    <p className="text-[10px] text-red-300 leading-snug">{r}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {analysis.catalysts.length > 0 && (
            <div>
              <p className="text-[9px] text-emerald-400 uppercase tracking-widest mb-1.5 font-bold">In your favor</p>
              <div className="space-y-1">
                {analysis.catalysts.map((c, i) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <span className="text-emerald-400 text-[9px] mt-0.5 shrink-0">▸</span>
                    <p className="text-[10px] text-emerald-300 leading-snug">{c}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className={`flex items-center gap-2 pt-1`}>
          <span className="text-[9px] text-indigo-400 font-bold tracking-widest uppercase">◈ Ask a follow-up</span>
          <div className={`flex-1 h-px ${th.borderLight} border-t`} />
        </div>
      </div>

      <ChatThread
        initialContext={chatContext}
        systemPrompt={TRADING_CHAT_PROMPT}
        placeholder={`Ask about ${analysis.symbol}... e.g. "Should I roll to next month?"`}
        th={th}
      />
    </div>
  );
}

function PortfolioAnalysisPanel({ analysis, positions, onClose, th }: {
  analysis: PortfolioAnalysis; positions: Position[]; onClose: () => void; th: typeof THEMES[Theme];
}) {
  // Build rich initial context for portfolio chat
  const chatContext = [
    `I've analyzed your portfolio of ${positions.length} open positions.`,
    ``,
    analysis.summary,
    analysis.marketContext ? `\n**Market context:** ${analysis.marketContext}` : '',
    analysis.dominantRisk ? `\n**Dominant risk:** ${analysis.dominantRisk}` : '',
    analysis.priorityActions.length > 0 ? `\n**Priority actions:** ${analysis.priorityActions.map((a, i) => `${i+1}. ${a}`).join(' ')}` : '',
    analysis.topRisks.length > 0 ? `\n**Portfolio risks:** ${analysis.topRisks.join(' · ')}` : '',
    analysis.thetaYield ? `\n**Theta yield:** ${analysis.thetaYield}` : '',
    ``,
    `Positions: ${positions.map(p => `${p.symbol} ${p.strategy} (${p.dte}d, ${p.pnl != null ? ((p.pnl/p.creditReceived)*100).toFixed(0)+'% P&L' : 'no price'})`).join(', ')}`,
  ].filter(Boolean).join('\n');

  return (
    <div className="fixed inset-0 bg-black/85 flex items-center justify-center z-50 p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div className={`${th.sidebar} border ${th.border} rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col`}>
        <div className={`flex items-center justify-between px-6 py-4 border-b ${th.border} shrink-0`}>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-indigo-400 text-sm">◈</span>
              <h2 className={`text-sm font-bold ${th.text} tracking-wider`}>PORTFOLIO ANALYSIS</h2>
            </div>
            <p className={`text-[10px] ${th.textFaint} mt-0.5`}>Generated {new Date(analysis.generatedAt).toLocaleTimeString()}</p>
          </div>
          <button onClick={onClose} className={`text-xl ${th.textFaint} hover:${th.text}`}>✕</button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="p-6 space-y-5">
            {/* Summary */}
            <div className={`p-4 rounded-xl border ${th.border}`} style={{ background: 'rgba(99,102,241,0.05)' }}>
              <p className={`text-xs ${th.textMuted} leading-relaxed`}>{analysis.summary}</p>
            </div>

            {/* Market context */}
            {analysis.marketContext && (
              <div>
                <p className="text-[9px] text-indigo-400 uppercase tracking-widest mb-2 font-bold">Market Context</p>
                <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>{analysis.marketContext}</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-5">
              {analysis.priorityActions.length > 0 && (
                <div>
                  <p className="text-[9px] text-blue-400 uppercase tracking-widest mb-2 font-bold">Priority Actions</p>
                  <div className="space-y-2">
                    {analysis.priorityActions.map((a, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className="text-blue-400 text-[10px] font-bold shrink-0 mt-0.5">{i + 1}.</span>
                        <p className={`text-[10px] ${th.textMuted} leading-snug`}>{a}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {analysis.topRisks.length > 0 && (
                <div>
                  <p className="text-[9px] text-red-400 uppercase tracking-widest mb-2 font-bold">Portfolio Risks</p>
                  <div className="space-y-2">
                    {analysis.topRisks.map((r, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className="text-red-400 text-[9px] shrink-0 mt-0.5">▸</span>
                        <p className="text-[10px] text-red-300 leading-snug">{r}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {analysis.dominantRisk && (
              <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/20 bg-red-500/5">
                <span className="text-red-400 shrink-0 text-[10px] mt-0.5 font-bold">!</span>
                <div>
                  <p className="text-[9px] text-red-400 uppercase tracking-widest mb-1 font-bold">Dominant Risk</p>
                  <p className="text-[10px] text-red-300">{analysis.dominantRisk}</p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-5">
              {analysis.sectorConcentration.length > 0 && (
                <div>
                  <p className="text-[9px] text-yellow-400 uppercase tracking-widest mb-2 font-bold">Concentration Risk</p>
                  <div className="space-y-1">
                    {analysis.sectorConcentration.map((s, i) => (
                      <p key={i} className="text-[10px] text-yellow-300">▸ {s}</p>
                    ))}
                  </div>
                </div>
              )}
              {analysis.thetaYield && (
                <div>
                  <p className="text-[9px] text-emerald-400 uppercase tracking-widest mb-2 font-bold">Theta Yield</p>
                  <p className={`text-[10px] ${th.textMuted}`}>{analysis.thetaYield}</p>
                </div>
              )}
            </div>

            {/* Divider before chat */}
            <div className={`flex items-center gap-2 pt-1`}>
              <span className="text-[9px] text-indigo-400 font-bold tracking-widest uppercase">◈ Ask about your portfolio</span>
              <div className={`flex-1 h-px ${th.borderLight} border-t`} />
            </div>
          </div>

          <ChatThread
            initialContext={chatContext}
            systemPrompt={TRADING_CHAT_PROMPT}
            placeholder='Ask anything — e.g. "Which position should I close first if I need cash?" or "Am I too long tech?"'
            th={th}
          />
        </div>

        <div className={`px-6 py-4 border-t ${th.border} shrink-0`}>
          <button onClick={onClose} className={`w-full py-3 border ${th.border} ${th.textFaint} rounded-xl text-xs font-medium hover:border-white/30 transition-colors`}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Action Verdict Badge ───────────────────────────────────────────────────
const VERDICT_STYLE = {
  GO:      { border: 'border-emerald-500/60', bg: 'bg-emerald-500/8',  icon: '✓', iconColor: 'text-emerald-400', labelColor: 'text-emerald-300', label: 'GO' },
  CAUTION: { border: 'border-yellow-500/60',  bg: 'bg-yellow-500/8',   icon: '⚠', iconColor: 'text-yellow-400',  labelColor: 'text-yellow-300',  label: 'CAUTION' },
  STOP:    { border: 'border-red-500/60',     bg: 'bg-red-500/8',      icon: '✕', iconColor: 'text-red-400',     labelColor: 'text-red-300',     label: 'STOP' },
};

function ActionVerdictBadge({ verdict, compact = false, th }: {
  verdict: ActionVerdict;
  compact?: boolean;
  th: typeof THEMES[Theme];
}) {
  const style = VERDICT_STYLE[verdict.verdict];
  if (compact) {
    return (
      <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border ${style.border} ${style.bg}`}>
        <span className={`text-[10px] font-bold ${style.iconColor}`}>{style.icon}</span>
        <span className={`text-[10px] font-bold ${style.labelColor}`}>{style.label}</span>
        <span className={`text-[10px] ${th.textFaint} truncate max-w-[200px]`}>{verdict.headline}</span>
      </div>
    );
  }
  return (
    <div className={`rounded-xl border ${style.border} p-4 space-y-2`} style={{ background: 'rgba(0,0,0,0.3)' }}>
      <div className="flex items-center gap-2">
        <span className={`text-lg ${style.iconColor}`}>{style.icon}</span>
        <span className={`text-xs font-bold tracking-widest ${style.labelColor}`}>{style.label}</span>
        <span className={`text-[9px] font-bold ${verdict.confidence === 'HIGH' ? style.labelColor : 'text-slate-400'} ml-1`}>
          {verdict.confidence} CONFIDENCE
        </span>
      </div>
      <p className={`text-sm font-bold ${style.labelColor} leading-snug`}>{verdict.headline}</p>
      <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>{verdict.reasoning}</p>
    </div>
  );
}

// ── Extend Profit Button ───────────────────────────────────────────────────
// ── Extend Profit State Assessment ───────────────────────────────────────
// Evaluates whether conditions favor or warn against extending profit target
function assessExtendConditions(pos: Position): {
  signal: 'favorable' | 'neutral' | 'warning' | 'bad';
  reasons: string[];
  warnings: string[];
} {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let score = 0;

  // P&L check — most important
  const pnlPct = pos.pnl != null && pos.creditReceived > 0 ? (pos.pnl / pos.creditReceived) * 100 : 0;
  if (pnlPct < 0) {
    warnings.push(`Position is at a loss (${pnlPct.toFixed(0)}%) — extending a losing position is rarely right`);
    score -= 3;
  } else if (pnlPct < 30) {
    warnings.push(`Only ${pnlPct.toFixed(0)}% profit captured — haven't hit standard target yet`);
    score -= 1;
  } else if (pnlPct >= 50) {
    reasons.push(`${pnlPct.toFixed(0)}% profit already captured — solid base to extend from`);
    score += 2;
  }

  // DTE check
  if (pos.dte < 21) {
    warnings.push(`${pos.dte} DTE — gamma risk is elevated, holding longer is dangerous`);
    score -= 3;
  } else if (pos.dte < 28) {
    warnings.push(`${pos.dte} DTE — getting close to gamma zone, extend only if trend is strong`);
    score -= 1;
  } else if (pos.dte >= 30) {
    reasons.push(`${pos.dte} DTE — plenty of time, gamma risk is low`);
    score += 1;
  }

  // IVR check
  if (pos.ivr != null && pos.ivr < 30) {
    warnings.push(`IVR ${pos.ivr} — below minimum threshold, edge is thin`);
    score -= 2;
  } else if (pos.ivr != null && pos.ivr >= 40) {
    reasons.push(`IVR ${pos.ivr} — elevated volatility means more premium to capture`);
    score += 1;
  }

  // Buffer check
  if (pos.buffer != null && pos.buffer < 5 && pos.dte > 14) {
    warnings.push(`Buffer only ${pos.buffer.toFixed(1)}% — thin cushion makes holding longer risky`);
    score -= 2;
  } else if (pos.buffer != null && pos.buffer >= 10) {
    reasons.push(`${pos.buffer.toFixed(1)}% buffer — strong cushion supports holding longer`);
    score += 1;
  }

  // Theta check
  if (pos.theta != null && pos.theta < 0.02) {
    warnings.push(`Theta only $${(pos.theta * 100).toFixed(2)}/day — slow decay, extra holding time has low reward`);
    score -= 1;
  } else if (pos.theta != null && pos.theta >= 0.05) {
    reasons.push(`Theta $${(pos.theta * 100).toFixed(2)}/day — strong decay working in your favor`);
    score += 1;
  }

  const signal = score >= 3 ? 'favorable' : score >= 0 ? 'neutral' : score >= -2 ? 'warning' : 'bad';
  return { signal, reasons, warnings };
}

function ExtendProfitButton({ pos, th }: { pos: Position; th: typeof THEMES[Theme] }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<'success' | 'error' | null>(null);
  const [resultMsg, setResultMsg] = useState('');
  const [verdict, setVerdict] = useState<ActionVerdict | null>(null);
  const [verdictLoading, setVerdictLoading] = useState(false);
  const [selectedPct, setSelectedPct] = useState<number | null>(null);

  if (!pos.hasGtc) return null;

  const currentTargetPct = pos.gtcOrderPrice != null && pos.creditReceived > 0
    ? Math.round((1 - pos.gtcOrderPrice / (pos.creditReceived / 100)) * 100)
    : Math.round(pos.profitTarget * 100);

  const options = [55, 60, 65, 70, 75, 80, 85, 90].filter(pct => pct > currentTargetPct);
  if (options.length === 0) return null;

  // Re-fetch the live GTC order ID if it wasn't captured at load time
  const resolveGtcOrderId = async (token: string): Promise<string | null> => {
    if (pos.gtcOrderId) return pos.gtcOrderId;
    const orders = await fetchGtcOrders(pos.accountNumber, token);
    const shortSymbol = pos.legs.find(l => l.direction === 'Short')?.symbol ?? '';
    const match = orders.find(o =>
      !isStopOrder(o) &&
      o.legs.some(l => normalizeOccSymbol(l.symbol) === normalizeOccSymbol(shortSymbol) && isBuyToCloseAction(l.action))
    );
    return match?.id ?? null;
  };

  const handleOpen = async () => {
    setOpen(true);
    setResult(null);
    setVerdict(null);
    setSelectedPct(null);
    // Fetch a general extend verdict immediately when dropdown opens
    setVerdictLoading(true);
    try {
      const v = await evaluateAction(pos, 'EXTEND_PROFIT', String(options[0]));
      setVerdict(v);
    } catch { /* verdict optional */ }
    finally { setVerdictLoading(false); }
  };

  const handleSelectPct = async (pct: number) => {
    setSelectedPct(pct);
    setVerdict(null);
    setVerdictLoading(true);
    try {
      const v = await evaluateAction(pos, 'EXTEND_PROFIT', String(pct));
      setVerdict(v);
    } catch { /* verdict optional */ }
    finally { setVerdictLoading(false); }
  };

  const extend = async (targetPct: number) => {
    setLoading(true);
    setResult(null);
    try {
      const token = await getAccessToken();
      const orderId = await resolveGtcOrderId(token);
      if (!orderId) {
        throw new Error('Could not find a working GTC order for this position. It may have already been filled or cancelled. Refresh positions and try again.');
      }
      const newPrice = parseFloat(((pos.creditReceived / 100) * (1 - targetPct / 100)).toFixed(2));
      await ttPatch(
        `/accounts/${pos.accountNumber}/orders/${orderId}`,
        token,
        { price: newPrice.toFixed(2), 'time-in-force': 'GTC' }
      );
      setResult('success');
      setResultMsg(`Target extended to ${targetPct}% — GTC updated to $${newPrice.toFixed(2)}`);
      setOpen(false);
    } catch (e: any) {
      setResult('error');
      setResultMsg(e.message ?? 'Update failed');
    } finally {
      setLoading(false);
    }
  };

  const extendAssessment = assessExtendConditions(pos);
  const assessColor = extendAssessment.signal === 'favorable' ? 'border-emerald-600 text-emerald-400' :
                      extendAssessment.signal === 'neutral'   ? 'border-slate-600 text-slate-400' :
                      extendAssessment.signal === 'warning'   ? 'border-yellow-600 text-yellow-400' :
                                                                'border-red-700 text-red-400';

  return (
    <div className="relative">
      <button
        onClick={e => { e.stopPropagation(); open ? setOpen(false) : handleOpen(); }}
        className={`text-[9px] px-2.5 py-1 border rounded font-bold transition-colors ${
          result === 'success' ? 'border-emerald-600 text-emerald-400' :
          result === 'error'   ? 'border-red-600 text-red-400' :
          open ? 'ac-btn ac-bg-10' :
          assessColor
        }`}>
        {result === 'success' ? '✓ Extended' : result === 'error' ? '✕ Failed' : '↑ Extend Profit'}
      </button>

      {open && (
        <div className={`absolute bottom-full mb-2 left-0 z-30 ${th.sidebar} border ${th.border} rounded-xl shadow-2xl p-4 w-80`}
          onClick={e => e.stopPropagation()}>
          <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-2`}>
            Extend target — current: {currentTargetPct}%
          </p>

          {/* State assessment banner */}
          <div className={`mb-3 p-2.5 rounded-lg border text-[9px] leading-relaxed ${
            extendAssessment.signal === 'favorable' ? 'border-emerald-600/40 bg-emerald-500/5' :
            extendAssessment.signal === 'neutral'   ? 'border-slate-600/40 bg-slate-500/5' :
            extendAssessment.signal === 'warning'   ? 'border-yellow-600/40 bg-yellow-500/5' :
                                                      'border-red-600/40 bg-red-500/5'
          }`}>
            <p className={`font-bold mb-1 ${
              extendAssessment.signal === 'favorable' ? 'text-emerald-400' :
              extendAssessment.signal === 'neutral'   ? 'text-slate-400' :
              extendAssessment.signal === 'warning'   ? 'text-yellow-400' : 'text-red-400'
            }`}>
              {extendAssessment.signal === 'favorable' ? '✓ Conditions favor extension' :
               extendAssessment.signal === 'neutral'   ? '◦ Neutral — proceed with caution' :
               extendAssessment.signal === 'warning'   ? '⚠ Conditions are marginal' :
               '✕ Conditions do not favor extension'}
            </p>
            {extendAssessment.warnings.map((w, i) => (
              <p key={i} className="text-red-300/80 mt-0.5">▸ {w}</p>
            ))}
            {extendAssessment.reasons.map((r, i) => (
              <p key={i} className="text-emerald-300/80 mt-0.5">▸ {r}</p>
            ))}
          </div>

          {/* Verdict */}
          {verdictLoading && (
            <div className="flex items-center gap-2 mb-3 p-2 rounded-lg border border-indigo-700/40 bg-indigo-500/5">
              <div className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin shrink-0" />
              <p className="text-[10px] text-indigo-400">Evaluating move...</p>
            </div>
          )}
          {verdict && !verdictLoading && (
            <div className="mb-3">
              <ActionVerdictBadge verdict={verdict} th={th} />
            </div>
          )}

          {/* Target options */}
          <div className="space-y-1">
            {options.map(pct => {
              const newPrice = ((pos.creditReceived / 100) * (1 - pct / 100)).toFixed(2);
              const isSelected = selectedPct === pct;
              const isStop = verdict?.verdict === 'STOP' && verdict.confidence === 'HIGH';
              return (
                <div key={pct} className="space-y-1">
                  <button
                    disabled={loading}
                    onClick={() => handleSelectPct(pct)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border transition-colors text-[10px] font-bold ${
                      isSelected ? 'border-blue-500 bg-blue-500/15' : `${th.border} ac-hover-border hover:ac-bg-10`
                    } disabled:opacity-50`}>
                    <span className="text-blue-400">{pct}% profit target</span>
                    <span className={`${th.textFaint} font-normal`}>BTC @ ${newPrice}</span>
                  </button>
                  {/* Confirm button shown when selected */}
                  {isSelected && (
                    <div className="space-y-1 pl-2">
                      {isStop && (
                        <p className={`text-[9px] text-red-400 px-1`}>
                          AI says STOP — click confirm to override
                        </p>
                      )}
                      <button
                        disabled={loading}
                        onClick={() => extend(pct)}
                        className={`w-full py-1.5 rounded-lg text-[10px] font-bold transition-colors ${
                          isStop
                            ? 'bg-red-600/20 border border-red-600 text-red-400 hover:bg-red-600/40'
                            : 'ac-btn-solid text-white'
                        } disabled:opacity-50`}>
                        {loading ? 'Updating...' : isStop ? `Override & Extend to ${pct}%` : `Confirm — Extend to ${pct}%`}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {result === 'error' && <p className="text-[9px] text-red-400 mt-2 whitespace-pre-line">{resultMsg}</p>}
          <button onClick={() => setOpen(false)} className={`w-full mt-3 text-[9px] ${th.textFaint} hover:${th.text} text-center`}>
            Cancel
          </button>
        </div>
      )}

      {result === 'success' && resultMsg && (
        <p className={`absolute bottom-full mb-1 left-0 text-[9px] text-emerald-400 whitespace-nowrap bg-black/80 px-2 py-1 rounded border border-emerald-700`}>
          {resultMsg}
        </p>
      )}
    </div>
  );
}

// ── Set / Update Stop Loss Button ─────────────────────────────────────────
// When a GTC profit-target order already exists on the position, TastyTrade
// rejects a second standalone stop order targeting the same legs. The correct
// approach is to:
//   1. Cancel the existing standalone GTC limit order
//   2. Re-submit both the profit target AND the stop together as an OCO
//      complex order via POST /accounts/{acct}/complex-orders
// If no existing GTC limit order exists, we submit the stop as a standalone
// order via POST /accounts/{acct}/orders.

async function ttDelete(path: string, token: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (res.status === 401) { sessionStorage.removeItem('tt_access_token'); window.location.href = '/login'; throw new Error('Session expired'); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message ?? data?.['error-message'] ?? `DELETE ${path} failed (${res.status})`);
  }
}


function formatTastyTradeRejection(data: any): string {
  const lines: string[] = [];
  const seen = new Set<string>();

  const add = (label: string, value: unknown) => {
    if (value == null) return;
    const text = String(value).trim();
    if (!text) return;
    const line = label ? `${label}: ${text}` : text;
    if (!seen.has(line)) { seen.add(line); lines.push(line); }
  };

  const describeObject = (obj: any, fallbackLabel: string) => {
    if (!obj || typeof obj !== 'object') return false;
    const code = obj.code ?? obj.reason ?? obj.name ?? obj.type ?? obj.domain ?? obj.id ?? obj['error-code'] ?? obj['check-name'] ?? obj.check;
    const msg = obj.message ?? obj['error-message'] ?? obj.description ?? obj.detail ?? obj.details ?? obj.error ?? obj.result;
    const status = obj.status ?? obj.outcome ?? obj.passed;

    if (msg != null || code != null) {
      const label = code ? `${fallbackLabel} ${code}` : fallbackLabel;
      const suffix = status != null && status !== true ? ` (${String(status)})` : '';
      add(label, `${msg ?? 'failed'}${suffix}`);
      return true;
    }
    return false;
  };

  const walk = (obj: any, label = 'Check', depth = 0) => {
    if (obj == null || depth > 6) return;
    if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
      add(label, obj);
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((item, idx) => walk(item, `${label} ${idx + 1}`, depth + 1));
      return;
    }
    if (typeof obj !== 'object') return;

    describeObject(obj, label);

    const priorityKeys = [
      'errors', 'error', 'warnings', 'warning', 'preflight-checks', 'preflightChecks',
      'preflight_checks', 'preflight', 'checks', 'violations', 'rejections', 'messages'
    ];
    for (const key of priorityKeys) {
      if (obj[key] != null) walk(obj[key], key.replace(/[-_]/g, ' '), depth + 1);
    }

    for (const [key, val] of Object.entries(obj)) {
      if (priorityKeys.includes(key)) continue;
      if (val && typeof val === 'object') walk(val, key.replace(/[-_]/g, ' '), depth + 1);
    }
  };

  walk(data, 'Broker');

  if (lines.length === 0) {
    const fallback = JSON.stringify(data?.error ?? data ?? {}).slice(0, 1000);
    return fallback || 'Unknown broker rejection. Open the browser console for the raw response.';
  }

  return lines.slice(0, 12).join('\n');
}

async function ttPostComplex(path: string, token: string, body: unknown) {
  console.log('TT COMPLEX ORDER BODY:', JSON.stringify(body, null, 2));
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { sessionStorage.removeItem('tt_access_token'); window.location.href = '/login'; throw new Error('Session expired'); }
  const data = await res.json();
  console.log('TT COMPLEX ORDER RESPONSE:', JSON.stringify(data, null, 2));
  if (!res.ok) {
    const details = formatTastyTradeRejection(data);
    throw new Error(`Complex order rejected (${res.status}):\n${details}`);
  }
  return data;
}

// ── Stop/GTC AI suggestion ─────────────────────────────────────────────────
interface StopGtcSuggestion {
  gtcPrice: number;       // recommended profit-target BTC price
  gtcPct: number;         // what % of credit that represents
  stopPrice: number;      // recommended stop trigger price
  stopMultiple: number;   // how many × credit that is
  rationale: string;      // 2-3 sentence explanation
  gtcRationale: string;   // why this GTC level specifically
  stopRationale: string;  // why this stop level specifically
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  deviatesFromRules: boolean;
  deviationNote: string | null;
}

const STOP_GTC_SYSTEM_PROMPT = `You are an expert options trader specializing in credit spreads using the Options Hunter methodology. Your job is to recommend optimal GTC profit-target and stop-loss prices for an open spread position.

CRITICAL RULE — STOP MUST BE ABOVE CURRENT SPREAD VALUE:
The stop trigger price MUST be strictly above the current spread value (buyback cost). A stop at or below the current value would execute immediately and be rejected by the broker. This is a hard constraint — never violate it.

CRITICAL RULE — GTC MUST BE BELOW CURRENT SPREAD VALUE:
The GTC profit-target price MUST be strictly below the current spread value. A GTC at or above current value would execute immediately. This is a hard constraint — never violate it.

STOP LOSS PHILOSOPHY — ANCHOR TO CURRENT VALUE, NOT ORIGINAL CREDIT:
The "2× original credit" rule is an ENTRY rule designed for when you first open the position. Once significant profit has been captured, it becomes meaningless and dangerous — a position at 80% profit with a 2× credit stop has virtually no protection.

CORRECT APPROACH: Anchor the stop to the CURRENT spread value, not original credit.
- Ask: "How much of my captured profit am I willing to give back before stopping out?"
- A position at 50%+ profit captured: stop should be set to protect most of that gain — typically current value × 2.0 to 3.0 (allowing the spread to double or triple from here before stopping)
- A position at 20-40% profit: more room needed — current value × 2.5 to 4.0
- A position at 0-20% profit or a loss: tighter protection — current value × 1.5 to 2.5

ADDITIONAL STOP ADJUSTMENTS (on top of current-value anchor):
- Buffer < 2%: tighten aggressively — near breach, use current value × 1.5 to 2.0
- Buffer < 5% AND DTE > 21: tighten — position needs protection, use current value × 1.5 to 2.5
- Buffer < 5% AND DTE < 14: less urgent — theta working hard, normal stop is fine
- Buffer > 15%: can use current value × 3.0 to 4.0 — stock has room to move
- DTE < 21: position should be closing anyway — note this and set tight stop
- DTE > 35: more time = more room for noise — slightly looser stop acceptable
- High IVR (>60): spreads swing more on normal days — use current value × 2.5 minimum to avoid noise triggers
- Low IVR (<30): IV collapsing, edge gone — tighter stop appropriate, current value × 1.5 to 2.0
- Earnings within expiry: binary event risk — tighten significantly, current value × 1.5
- Trend against strategy: thesis may be broken — tighten to current value × 1.5 to 2.0

GTC PROFIT TARGET:
- Standard: 50% of original credit received
- Tighten to 40% if: DTE < 25, buffer < 5%, earnings approaching, or significant profit already captured (>60%) and you want to lock it in
- Loosen to 60-65% if: DTE > 35, trend strongly confirms, IVR elevated with more premium to capture
- The GTC price = credit_per_contract × (1 - target_pct/100). MUST be below current spread value.

OUTPUT FORMAT — JSON only, nothing else:
{
  "gtcPrice": <number: BTC limit price, MUST be below current spread value>,
  "gtcPct": <number: percentage of credit this represents, e.g. 50>,
  "stopPrice": <number: stop trigger price, MUST be above current spread value>,
  "stopMultiple": <number: how many times the CURRENT spread value this represents — NOT original credit>,
  "rationale": "<2-3 sentence overall rationale — reference actual numbers from the position>",
  "gtcRationale": "<1-2 sentences specifically about the GTC choice>",
  "stopRationale": "<1-2 sentences specifically about the stop — reference current spread value, not original credit>",
  "confidence": "HIGH|MEDIUM|LOW",
  "deviatesFromRules": true|false,
  "deviationNote": null or "<explanation if deviating from standard rules>"
}`;

function buildStopGtcPrompt(pos: Position): string {
  const creditPerContract = pos.creditReceived / 100;
  const qty = pos.legs.find(l => l.direction === 'Short')?.quantity ?? 1;
  const currentValuePerContract = pos.currentValue != null ? pos.currentValue / (qty * 100) : null;
  const pnlPct = pos.pnl != null && pos.creditReceived > 0
    ? ((pos.pnl / pos.creditReceived) * 100).toFixed(1) : 'unknown';
  const profitCaptured = currentValuePerContract != null
    ? parseFloat(((1 - currentValuePerContract / creditPerContract) * 100).toFixed(1))
    : null;
  const currentGtcPct = pos.gtcOrderPrice != null
    ? Math.round((1 - pos.gtcOrderPrice / creditPerContract) * 100)
    : Math.round(pos.profitTarget * 100);

  const gtcMax  = currentValuePerContract != null ? (currentValuePerContract - 0.01).toFixed(2) : 'N/A';
  const stopMin = currentValuePerContract != null ? (currentValuePerContract + 0.01).toFixed(2) : 'N/A';
  const stopMax = (creditPerContract * 3.0).toFixed(2);

  return `Recommend optimal GTC profit-target and stop-loss prices for this position.

HARD PRICE CONSTRAINTS (broker rejects violations):
Current spread value (live): ${currentValuePerContract?.toFixed(2) ?? 'unknown'}/contract
GTC MUST be below: ${gtcMax} (below current spread value)
Stop MUST be between: ${stopMin} and ${stopMax} (above current value, below 3x original credit)

POSITION: ${pos.symbol} ${pos.strategy}
Expiry: ${pos.expDate} | DTE: ${pos.dte} | Entry DTE: ${pos.entryDte}
Strikes: ${pos.legs.map(l => l.direction + ' ' + l.strikePrice + l.optionType).join(', ')}

CREDIT AND P&L:
Original credit: ${creditPerContract.toFixed(2)}/contract (${pos.creditReceived.toFixed(2)} total)
Current spread value: ${currentValuePerContract?.toFixed(2) ?? 'unknown'}/contract
Profit captured: ${profitCaptured != null ? profitCaptured + '%' : pnlPct + '%'} of original credit
P&L dollars: ${pos.pnl?.toFixed(2) ?? 'unknown'}
${profitCaptured != null && profitCaptured > 50 ? 'WARNING: ' + profitCaptured + '% profit already captured. Stop must protect this gain — anchor to current spread value, NOT original credit. A stop at 2x original credit is meaningless here.' : ''}

MARKET DATA:
Stock price: ${pos.stockPrice?.toFixed(2) ?? 'unknown'}
Buffer to short strike: ${pos.buffer?.toFixed(1) ?? 'unknown'}%
IVR: ${pos.ivr ?? 'unknown'} | IV: ${pos.iv ?? 'unknown'}% | HV30: ${pos.hv30 ?? 'unknown'}%
Theta/day: ${pos.theta?.toFixed(4) ?? 'unknown'} | Gamma: ${pos.gamma?.toFixed(4) ?? 'unknown'}
Earnings within expiry: ${pos.earningsDate ? 'YES — ' + pos.earningsDate : 'None'}

CURRENT ORDERS:
GTC profit-target: ${pos.hasGtc ? 'Yes — at $' + (pos.gtcOrderPrice?.toFixed(2) ?? '?') + '/contract (' + currentGtcPct + '% profit)' : 'None set'}
Stop loss: ${pos.stopLossStatus}${pos.stopLossPrice ? ' @ $' + pos.stopLossPrice.toFixed(2) + '/contract' : ''}

FLAGS: ${[
  pos.needsClose ? 'AT 21 DTE — closing soon anyway (standard entry)' : '',
  pos.entryDte <= 21 ? `SHORT-DATED ENTRY (entered at ${pos.entryDte} DTE, now ${pos.dte} DTE — set tight stop, lower GTC target to 30-40%)` : '',
  pos.buffer != null && pos.buffer < 2 ? 'CRITICAL buffer ' + pos.buffer.toFixed(1) + '% at ' + pos.dte + ' DTE — near breach' : pos.buffer != null && pos.buffer < 3 && pos.dte > 14 ? 'TIGHT buffer ' + pos.buffer.toFixed(1) + '% at ' + pos.dte + ' DTE' : pos.buffer != null && pos.buffer < 5 && pos.dte > 30 ? 'WATCH buffer ' + pos.buffer.toFixed(1) + '% at ' + pos.dte + ' DTE' : '',
  pos.earningsDate ? 'EARNINGS ' + pos.earningsDate : '',
  (pos.ivr ?? 0) < 30 ? 'IVR BELOW 30 — edge thin' : '',
  (pos.ivr ?? 0) > 70 ? 'IVR ABOVE 70 — elevated volatility' : '',
  profitCaptured != null && profitCaptured > 70 ? profitCaptured + '% PROFIT CAPTURED — stop must protect gains, anchor to current value' : '',
].filter(Boolean).join(' | ') || 'None'}

IMPORTANT: stopMultiple in your response should be relative to the CURRENT spread value (${currentValuePerContract?.toFixed(2) ?? '?'}), not original credit. Respond as JSON only.`;
}
async function fetchStopGtcSuggestion(pos: Position): Promise<StopGtcSuggestion> {
  const prompt = buildStopGtcPrompt(pos);
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: STOP_GTC_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`AI request failed: ${res.status}`);
  const data = await res.json();
  const text = (data?.content?.find((b: any) => b.type === 'text')?.text ?? '')
    .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(text) as StopGtcSuggestion;
}

function SetStopLossButton({ pos, th }: { pos: Position; th: typeof THEMES[Theme] }) {
  // ── Price bounds ──────────────────────────────────────────────────────────
  // All valid GTC and stop prices must respect these hard bounds derived from
  // live spread value and credit received. These are enforced everywhere:
  // AI suggestion prompt, input validation, and pre-submit preflight.
  //
  // GTC (profit target BTC price):
  //   MUST be below current spread value — otherwise executes immediately.
  //   Minimum meaningful target: 10% of credit (anything less = take profit now).
  //   Maximum: current spread value - $0.01
  //
  // Stop trigger:
  //   MUST be above current spread value — otherwise executes immediately.
  //   Maximum reasonable stop: 3× credit per contract (beyond that = max loss anyway).
  //   Minimum: current spread value + $0.01

  const creditPerContract = pos.creditReceived / 100;
  const qty = pos.legs.find(l => l.direction === 'Short')?.quantity ?? 1;
  // currentValue from pos is total across all contracts × 100
  // Per-contract spread value = currentValue / (qty * 100)
  const liveValuePerContract = pos.currentValue != null
    ? pos.currentValue / (qty * 100)
    : null;

  // Hard bounds
  const gtcMin  = parseFloat((creditPerContract * 0.05).toFixed(2));            // 5% profit floor
  const gtcMax  = liveValuePerContract != null
    ? parseFloat((liveValuePerContract - 0.01).toFixed(2))
    : parseFloat((creditPerContract * 0.90).toFixed(2));                        // fallback: 10% profit
  const stopMin = liveValuePerContract != null
    ? parseFloat((liveValuePerContract + 0.01).toFixed(2))
    : parseFloat((creditPerContract * 1.50).toFixed(2));                        // fallback: 1.5× credit
  const stopMax = parseFloat((creditPerContract * 3.0).toFixed(2));             // 3× credit hard ceiling

  // ── State ─────────────────────────────────────────────────────────────────
  const [open, setOpen]       = useState(false);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase]     = useState('');
  const [result, setResult]   = useState<'success' | 'error' | null>(null);
  const [resultMsg, setResultMsg] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [stopPct,   setStopPct]   = useState('200');  // default: 200% of credit = 2× rule
  const [gtcPrice,  setGtcPrice]  = useState('');

  // AI suggestion
  const [suggestion, setSuggestion]           = useState<StopGtcSuggestion | null>(null);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [suggestionError, setSuggestionError]   = useState<string | null>(null);

  // Live price fetch state
  const [livePrice, setLivePrice]         = useState<number | null>(null);  // per-contract
  const [livePriceLoading, setLivePriceLoading] = useState(false);
  const [livePriceError, setLivePriceError]   = useState<string | null>(null);

  // Confirmation step before destructive OCO replace
  const [confirming, setConfirming] = useState(false);

  // ── Linked stop price ↔ pct setters ──────────────────────────────────────
  // Entering a $ amount updates the % display; entering a % updates the $ amount.
  // Both anchor to creditPerContract so the relationship is always: price = pct/100 × credit.
  const setStopFromPrice = (val: string) => {
    setStopPrice(val);
    const num = parseFloat(val);
    if (!isNaN(num) && creditPerContract > 0) {
      setStopPct(((num / creditPerContract) * 100).toFixed(0));
    }
  };

  const setStopFromPct = (val: string) => {
    setStopPct(val);
    const num = parseFloat(val);
    if (!isNaN(num) && creditPerContract > 0) {
      const price = parseFloat(((num / 100) * creditPerContract).toFixed(2));
      setStopPrice(price.toFixed(2));
    }
  };

  // Mounted guard — prevents state updates after unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const needsOco = pos.hasGtc && !!pos.gtcOrderId;
  const existingGtcPrice = pos.gtcOrderPrice
    ?? parseFloat((creditPerContract * (1 - pos.profitTarget)).toFixed(2));

  // ── Validation helpers ────────────────────────────────────────────────────
  const effectiveLive = livePrice ?? liveValuePerContract;  // prefer freshly fetched

  function validateGtc(val: number): string | null {
    if (isNaN(val) || val <= 0) return 'Enter a valid GTC price';
    if (val < gtcMin) return `GTC $${val.toFixed(2)} is too low — minimum is $${gtcMin.toFixed(2)} (5% profit)`;
    if (effectiveLive != null && val >= effectiveLive)
      return `GTC $${val.toFixed(2)} ≥ current spread value $${effectiveLive.toFixed(2)} — would execute immediately. Lower it or use Take Profit.`;
    return null;
  }

  function validateStop(val: number): string | null {
    if (isNaN(val) || val <= 0) return 'Enter a valid stop price';
    if (effectiveLive != null && val <= effectiveLive)
      return `Stop $${val.toFixed(2)} ≤ current spread value $${effectiveLive.toFixed(2)} — would execute immediately. Raise it.`;
    if (val > stopMax)
      return `Stop $${val.toFixed(2)} exceeds 3× credit ($${stopMax.toFixed(2)}) — beyond max loss, no protection value.`;
    return null;
  }

  const gtcError  = needsOco ? validateGtc(parseFloat(gtcPrice || '0'))  : null;
  const stopError = validateStop(parseFloat(stopPrice || '0'));
  const hasErrors = !!stopError || (needsOco && !!gtcError);

  // ── Live price fetch ──────────────────────────────────────────────────────
  const fetchLivePrice = async () => {
    if (!mountedRef.current) return;
    setLivePriceLoading(true);
    setLivePriceError(null);
    try {
      const token = await getAccessToken();
      const fresh = await fetchFreshPositionPrice(pos, token);
      if (!mountedRef.current) return;
      if (fresh != null) {
        const perContract = fresh / (qty * 100);
        setLivePrice(perContract);
        console.log(`LIVE PRICE FETCH ${pos.symbol}: $${perContract.toFixed(4)}/contract (total $${fresh.toFixed(2)})`);
      } else {
        setLivePriceError('Could not fetch live price — using last known value');
      }
    } catch (e: any) {
      if (!mountedRef.current) return;
      setLivePriceError(`Price fetch failed: ${e.message}`);
    } finally {
      if (mountedRef.current) setLivePriceLoading(false);
    }
  };

  // ── AI suggestion ─────────────────────────────────────────────────────────
  const fetchSuggestion = async () => {
    if (!mountedRef.current) return;
    setSuggestionLoading(true);
    setSuggestionError(null);
    try {
      const s = await fetchStopGtcSuggestion(pos);
      if (!mountedRef.current) return;

      // Clamp AI suggestion to hard bounds before showing
      const clampedGtc  = Math.min(Math.max(s.gtcPrice,  gtcMin),  gtcMax);
      const clampedStop = Math.min(Math.max(s.stopPrice, stopMin), stopMax);

      // If live price is known, enforce directional constraint
      const live = livePrice ?? liveValuePerContract;
      const safeGtc  = live != null ? Math.min(clampedGtc,  live - 0.01) : clampedGtc;
      const safeStop = live != null ? Math.max(clampedStop, live + 0.01) : clampedStop;

      if (!mountedRef.current) return;
      setSuggestion({
        ...s,
        gtcPrice:  parseFloat(safeGtc.toFixed(2)),
        stopPrice: parseFloat(safeStop.toFixed(2)),
        gtcPct:    Math.round((1 - safeGtc / creditPerContract) * 100),
        stopMultiple: parseFloat((safeStop / creditPerContract).toFixed(1)),
      });
      setGtcPrice(safeGtc.toFixed(2));
      setStopPrice(safeStop.toFixed(2));
    } catch (e: any) {
      if (!mountedRef.current) return;
      setSuggestionError(e.message ?? 'AI suggestion failed');
    } finally {
      if (mountedRef.current) setSuggestionLoading(false);
    }
  };

  // ── Open handler ──────────────────────────────────────────────────────────
  const handleOpen = async () => {
    setOpen(true);
    setResult(null);
    setPhase('');
    setSuggestion(null);
    setSuggestionError(null);
    setConfirming(false);
    setLivePrice(null);
    setLivePriceError(null);

    // Step 1: fetch live price first so bounds are accurate
    setLivePriceLoading(true);
    try {
      const token = await getAccessToken();
      if (!mountedRef.current) return;
      const fresh = await fetchFreshPositionPrice(pos, token);
      if (!mountedRef.current) return;
      if (fresh != null) {
        const perContract = fresh / (qty * 100);
        setLivePrice(perContract);
        console.log(`LIVE PRICE FETCH ${pos.symbol}: $${perContract.toFixed(4)}/contract`);
        // Set initial input defaults using live price
        const initGtc  = Math.min(existingGtcPrice, perContract - 0.01);
        // Default stop = 200% of original credit (2× rule), must be above live value
        const twoXStop = creditPerContract * 2.0;
        const initStop = Math.max(twoXStop, perContract + 0.01);
        setGtcPrice(Math.max(initGtc, gtcMin).toFixed(2));
        setStopFromPrice(Math.min(initStop, stopMax).toFixed(2));
      } else {
        setLivePriceError('Could not fetch live price — using estimates');
        setGtcPrice(Math.max(existingGtcPrice, gtcMin).toFixed(2));
        const naiveStop = Math.max(creditPerContract * 2.0, stopMin);
        setStopFromPrice(Math.min(naiveStop, stopMax).toFixed(2));
      }
    } catch (e: any) {
      if (!mountedRef.current) return;
      // Keep modal open even on price fetch failure — show error, use fallback values
      console.warn('SetStopLossButton live price fetch failed:', e.message);
      setLivePriceError(`Price fetch failed: ${e.message ?? 'unknown error'}`);
      setGtcPrice(Math.max(existingGtcPrice, gtcMin).toFixed(2));
      setStopFromPrice(Math.min(creditPerContract * 2.0, stopMax).toFixed(2));
    } finally {
      if (mountedRef.current) setLivePriceLoading(false);
    }

    // Step 2: fetch AI suggestion (non-blocking, runs after live price)
    if (mountedRef.current) fetchSuggestion();
  };

  const applySuggestion = () => {
    if (!suggestion) return;
    setGtcPrice(suggestion.gtcPrice.toFixed(2));
    setStopFromPrice(suggestion.stopPrice.toFixed(2));
  };

  // ── Submit ────────────────────────────────────────────────────────────────
  const submit = async () => {
    const stopTrigger = parseFloat(stopPrice);
    const gtcLimit    = parseFloat(gtcPrice);
    let preflightContext = '';

    // Final pre-submit validation — fetch fresh price one more time
    setLoading(true);
    setPhase('Verifying live prices...');
    setResult(null);
    try {
      const token = await getAccessToken();

      // Re-fetch live price immediately before submit
      const freshTotal = await fetchFreshPositionPrice(pos, token);
      const freshPerContract = freshTotal != null ? freshTotal / (qty * 100) : null;
      if (freshPerContract != null) {
        console.log(`PRE-SUBMIT LIVE PRICE ${pos.symbol}: $${freshPerContract.toFixed(4)}/contract`);
        setLivePrice(freshPerContract);
        preflightContext = [
          `Symbol: ${pos.symbol} ${pos.strategy}`,
          `Action: ${needsOco ? 'Replace existing GTC with OCO profit + stop' : 'Place stop order'}`,
          `Live spread value: $${freshPerContract.toFixed(2)} debit`,
          needsOco ? `Profit GTC limit: $${gtcLimit.toFixed(2)} debit` : null,
          `Stop trigger: $${stopTrigger.toFixed(2)} debit`,
          `Original credit: $${creditPerContract.toFixed(2)} | Qty: ${qty}`,
        ].filter(Boolean).join('\n');

        // Hard stop: block if prices violate bounds against fresh price
        if (needsOco && gtcLimit >= freshPerContract) {
          setResult('error');
          setResultMsg(
            `GTC $${gtcLimit.toFixed(2)} ≥ live spread value $${freshPerContract.toFixed(2)}. ` +
            `Spread has moved — profit target already hit. Use Take Profit instead.`
          );
          return;
        }
        if (stopTrigger <= freshPerContract) {
          setResult('error');
          setResultMsg(
            `Stop $${stopTrigger.toFixed(2)} ≤ live spread value $${freshPerContract.toFixed(2)}. ` +
            `Spread has moved — stop would execute immediately. Raise the stop trigger.`
          );
          return;
        }
      }

      const itype = instrType(pos.symbol);
      // Simple /orders endpoint only accepts 'Equity Option' as instrument-type on legs,
      // even for index options (SPX/SPXW). 'Index Option' is only valid on /complex-orders.
      const simpleItype = 'Equity Option' as const;
      const complexItype = itype;
      const legsForSimple = pos.legs.map(leg => ({
        symbol: leg.symbol,
        quantity: leg.quantity,
        action: (leg.direction === 'Short' ? 'Buy to Close' : 'Sell to Close') as 'Buy to Close' | 'Sell to Close',
        'instrument-type': simpleItype,
      }));
      const legsForComplex = pos.legs.map(leg => ({
        symbol: leg.symbol,
        quantity: leg.quantity,
        action: (leg.direction === 'Short' ? 'Buy to Close' : 'Sell to Close') as 'Buy to Close' | 'Sell to Close',
        'instrument-type': complexItype,
      }));

      if (needsOco) {
        setPhase('Cancelling existing GTC order...');
        console.log('CANCEL EXISTING GTC ORDER:', pos.gtcOrderId);
        const complexId = (pos as any).gtcComplexOrderId;
        console.log(`PLACE_GTC CANCEL: orderId=${pos.gtcOrderId} complexId=${complexId}`);
        try {
          if (complexId) {
            console.log(`Cancelling complex order ${complexId}`);
            await ttDelete(`/accounts/${pos.accountNumber}/complex-orders/${complexId}`, token);
          } else {
            console.log(`Cancelling simple order ${pos.gtcOrderId}`);
            await ttDelete(`/accounts/${pos.accountNumber}/orders/${pos.gtcOrderId}`, token);
          }
          console.log(`Cancel complete`);
        } catch (cancelErr: any) {
          // Cancel may fail if order is already in terminal state or was a complex order
          // that needs manual cancellation. Log and proceed — TastyTrade will reject the
          // new OCO if the old order is still truly active, giving a clear error.
          console.warn(`Cancel failed for ${pos.symbol} order ${pos.gtcOrderId}:`, cancelErr.message);
          setPhase('Cancel failed — attempting OCO placement anyway...');
        }
        await new Promise(r => setTimeout(r, 500));

        setPhase('Placing OCO order...');
        const ocoBody = {
          type: 'OCO',
          orders: [
            {
              'order-type': 'Limit',
              'time-in-force': 'GTC',
              price: gtcLimit.toFixed(2),
              'price-effect': 'Debit',
              legs: legsForComplex,
            },
            {
              'order-type': 'Stop',
              'time-in-force': 'GTC',
              'stop-trigger': stopTrigger.toFixed(2),
              'price-effect': 'Debit',
              legs: legsForComplex,
            },
          ],
        };
        const res = await ttPostComplex(`/accounts/${pos.accountNumber}/complex-orders`, token, ocoBody);
        const orderId = String(res?.data?.['complex-order']?.id ?? res?.data?.id ?? 'submitted');
        setResult('success');
        setResultMsg(`OCO placed — profit @ $${gtcLimit.toFixed(2)} / stop @ $${stopTrigger.toFixed(2)} (ID #${orderId})`);
      } else {
        setPhase('Placing stop order...');
        const stopBody = {
          'order-type': 'Stop Limit',
          'time-in-force': 'GTC',
          'stop-trigger': stopTrigger.toFixed(2),
          price: stopTrigger.toFixed(2),  // limit = trigger for spreads
          'price-effect': 'Debit',
          legs: legsForSimple,
        };
        console.log('STOP ORDER PAYLOAD:', JSON.stringify(stopBody, null, 2));
        const stopRes = await fetch(`${BASE}/accounts/${pos.accountNumber}/orders`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(stopBody),
        });
        const stopData = await stopRes.json().catch(() => ({}));
        console.log('STOP ORDER RESPONSE status:', stopRes.status);
        console.log('STOP ORDER RESPONSE body:', JSON.stringify(stopData, null, 2));
        if (!stopRes.ok) {
          const detail = stopData?.error?.message
            ?? stopData?.['error-message']
            ?? stopData?.errors?.map((e: any) => `${e.field ?? ''}: ${e.message ?? e.reason ?? JSON.stringify(e)}`).join('; ')
            ?? JSON.stringify(stopData).slice(0, 600);
          throw new Error(`TastyTrade rejected stop order (${stopRes.status}): ${detail}`);
        }
        const res = stopData;
        const orderId = String(res?.data?.order?.id ?? res?.data?.id ?? 'submitted');
        setResult('success');
        setResultMsg(`Stop Limit placed @ $${stopTrigger.toFixed(2)} (ID #${orderId})`);
      }
      setOpen(false);
      setConfirming(false);
    } catch (e: any) {
      setResult('error');
      const baseMsg = e.message ?? 'Failed';
      setResultMsg(preflightContext ? `${baseMsg}\n\nOrder values checked:\n${preflightContext}` : baseMsg);
    } finally {
      setLoading(false);
      setPhase('');
    }
  };

  // ── Derived display values ────────────────────────────────────────────────
  const btnLabel =
    result === 'success' ? '✓ Stop Set'       :
    result === 'error'   ? '✕ Failed'          :
    pos.stopLossStatus === 'none'  ? '+ Set Stop'      :
    pos.stopLossStatus === 'loose' ? '⚠ Update Stop'   :
    '✎ Stop';

  const stopParsed  = parseFloat(stopPrice || '0');
  const gtcParsed   = parseFloat(gtcPrice  || '0');
  const stopMultipleDisplay = creditPerContract > 0 ? (stopParsed / creditPerContract).toFixed(1) : '—';
  const gtcPctDisplay       = creditPerContract > 0 ? Math.round((1 - gtcParsed / creditPerContract) * 100) : 0;
  const effectiveLiveDisplay = livePrice ?? liveValuePerContract;

  return (
    <div className="relative">
      <button
        onClick={e => { e.stopPropagation(); open ? setOpen(false) : handleOpen(); }}
        className={`text-[9px] px-2.5 py-1 border rounded font-bold transition-colors ${
          result === 'success' ? 'border-emerald-600 text-emerald-400' :
          result === 'error'   ? 'border-red-600 text-red-400' :
          open ? 'border-orange-500 text-orange-400 bg-orange-500/10' :
          pos.stopLossStatus === 'none'  ? 'border-red-700 text-red-400 hover:border-orange-500 hover:text-orange-400' :
          pos.stopLossStatus === 'loose' ? 'border-yellow-700 text-yellow-400 hover:border-orange-500 hover:text-orange-400' :
          'border-slate-600 text-slate-400 hover:border-orange-500 hover:text-orange-400'
        }`}>
        {btnLabel}
      </button>

      {open && (
        <div
          className={`absolute bottom-full mb-2 left-0 z-30 ${th.sidebar} border ${th.border} rounded-xl shadow-2xl p-4 w-96`}
          onClick={e => e.stopPropagation()}>

          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest`}>
              {needsOco ? 'Set Stop Loss — OCO' : 'Set Stop Loss'}
            </p>
            <span className={`text-[9px] font-bold ${th.textFaint}`}>{pos.symbol} {pos.strategy}</span>
          </div>

          {/* Live price bar */}
          <div className={`flex items-center justify-between px-3 py-2 rounded-lg border ${th.borderLight} mb-3`}>
            <div className="flex items-center gap-2">
              <span className={`text-[9px] ${th.textFaint} uppercase tracking-widest`}>Live spread value</span>
              {livePriceLoading && <div className="w-3 h-3 border border-blue-500 border-t-transparent rounded-full animate-spin" />}
              {!livePriceLoading && effectiveLiveDisplay != null && (
                <span className="text-[11px] font-bold text-blue-400" style={{ fontFamily: "'DM Mono', monospace" }}>
                  ${effectiveLiveDisplay.toFixed(2)}/contract
                </span>
              )}
              {!livePriceLoading && effectiveLiveDisplay == null && (
                <span className={`text-[10px] ${th.textFaint}`}>unavailable</span>
              )}
            </div>
            <button
              onClick={fetchLivePrice}
              disabled={livePriceLoading}
              className={`text-[9px] ${th.textFaint} ac-hover-text transition-colors disabled:opacity-40`}>
              ↻
            </button>
          </div>

          {livePriceError && (
            <p className="text-[9px] text-yellow-400 mb-2">⚠ {livePriceError}</p>
          )}

          {/* OCO info */}
          {needsOco && (
            <div className="mb-3 p-2.5 rounded-lg border border-yellow-600/40 bg-yellow-500/5">
              <p className="text-[10px] text-yellow-300 leading-relaxed">
                <span className="font-bold">⚠ Existing GTC (${existingGtcPrice.toFixed(2)}) will be cancelled</span> and replaced with an OCO pair. One fills → the other cancels.
              </p>
            </div>
          )}

          {/* AI Suggestion */}
          <div className={`mb-3 rounded-lg border ${th.borderLight} overflow-hidden`}>
            <div className={`flex items-center justify-between px-3 py-2 ${th.card}`}>
              <div className="flex items-center gap-1.5">
                <span className="text-indigo-400 text-[10px]">◈</span>
                <span className="text-[9px] text-indigo-400 font-bold uppercase tracking-widest">AI Recommendation</span>
                {suggestion && <span className={`text-[9px] ${th.textFaint}`}>— within valid bounds</span>}
              </div>
              {!suggestionLoading && (
                <button onClick={fetchSuggestion} className={`text-[9px] ${th.textFaint} hover:text-indigo-400 transition-colors`}>
                  ↻ Refresh
                </button>
              )}
            </div>

            {suggestionLoading && (
              <div className="flex items-center gap-2 px-3 py-3">
                <div className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin shrink-0" />
                <p className="text-[10px] text-indigo-400">Analyzing position...</p>
              </div>
            )}

            {suggestionError && !suggestionLoading && (
              <div className="px-3 py-2 flex items-center justify-between">
                <p className="text-[10px] text-red-400">{suggestionError}</p>
                <button onClick={fetchSuggestion} className="text-[9px] text-blue-400 hover:underline">Retry</button>
              </div>
            )}

            {suggestion && !suggestionLoading && (
              <div className="px-3 py-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div className="p-2 rounded border border-emerald-700/40 bg-emerald-500/5">
                    <p className="text-[9px] text-emerald-400 font-bold uppercase tracking-widest mb-0.5">GTC Target</p>
                    <p className="text-sm font-bold text-emerald-400" style={{ fontFamily: "'DM Mono', monospace" }}>${suggestion.gtcPrice.toFixed(2)}</p>
                    <p className={`text-[9px] ${th.textFaint}`}>{suggestion.gtcPct}% profit</p>
                  </div>
                  <div className="p-2 rounded border border-orange-700/40 bg-orange-500/5">
                    <p className="text-[9px] text-orange-400 font-bold uppercase tracking-widest mb-0.5">Stop Trigger</p>
                    <p className="text-sm font-bold text-orange-400" style={{ fontFamily: "'DM Mono', monospace" }}>${suggestion.stopPrice.toFixed(2)}</p>
                    <p className={`text-[9px] ${th.textFaint}`}>{suggestion.stopMultiple}× credit</p>
                  </div>
                </div>
                <p className={`text-[10px] ${th.textFaint} leading-relaxed`}>{suggestion.rationale}</p>
                {suggestion.gtcRationale && <p className="text-[9px] text-emerald-400/80"><span className="font-bold">GTC: </span>{suggestion.gtcRationale}</p>}
                {suggestion.stopRationale && <p className="text-[9px] text-orange-400/80"><span className="font-bold">Stop: </span>{suggestion.stopRationale}</p>}
                {suggestion.deviatesFromRules && suggestion.deviationNote && (
                  <p className="text-[9px] text-yellow-400">⚡ {suggestion.deviationNote}</p>
                )}
                <div className="flex items-center justify-between pt-1">
                  <span className={`text-[9px] font-bold ${suggestion.confidence === 'HIGH' ? 'text-emerald-400' : suggestion.confidence === 'MEDIUM' ? 'text-yellow-400' : 'text-slate-400'}`}>
                    {suggestion.confidence} confidence
                  </span>
                  <button onClick={applySuggestion} className="text-[9px] px-2.5 py-1 border border-indigo-600 text-indigo-400 rounded hover:bg-indigo-600/20 transition-colors font-bold">
                    Use these values ↓
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Inputs */}
          <div className="space-y-2 mb-3">
            {needsOco && (
              <div>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] ${th.textFaint} w-28 shrink-0`}>GTC target $</span>
                  <input
                    type="number" min={gtcMin} max={gtcMax} step="0.01" value={gtcPrice}
                    onChange={e => setGtcPrice(e.target.value)}
                    className={`flex-1 text-[11px] px-2 py-1.5 rounded border ${
                      gtcError ? 'border-red-500' : th.inputBorder
                    } ${th.input} text-emerald-400 outline-none focus:border-emerald-500`}
                    style={{ fontFamily: "'DM Mono', monospace" }}
                  />
                  {gtcPctDisplay > 0 && <span className={`text-[9px] ${th.textFaint} w-12 shrink-0`}>{gtcPctDisplay}%</span>}
                </div>
                {gtcError && <p className="text-[9px] text-red-400 mt-1 ml-28">{gtcError}</p>}
                {!gtcError && effectiveLiveDisplay != null && (
                  <p className={`text-[9px] ${th.textFaint} mt-0.5 ml-28`}>
                    valid range: ${gtcMin.toFixed(2)} – ${Math.min(gtcMax, effectiveLiveDisplay - 0.01).toFixed(2)}
                  </p>
                )}
              </div>
            )}
            <div>
              <div className="flex items-center gap-2">
                <span className={`text-[10px] ${th.textFaint} w-28 shrink-0`}>Stop trigger</span>
                {/* Dollar input */}
                <div className="flex items-center gap-1 flex-1">
                  <span className={`text-[9px] ${th.textFaint}`}>$</span>
                  <input
                    type="number" min={stopMin} max={stopMax} step="0.01" value={stopPrice}
                    onChange={e => setStopFromPrice(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !hasErrors && !confirming) setConfirming(true); if (e.key === 'Escape') setOpen(false); }}
                    autoFocus={!needsOco}
                    className={`flex-1 text-[11px] px-2 py-1.5 rounded border ${
                      stopError ? 'border-red-500' : th.inputBorder
                    } ${th.input} text-orange-400 outline-none focus:border-orange-500`}
                    style={{ fontFamily: "'DM Mono', monospace" }}
                  />
                </div>
                {/* Percent input — linked */}
                <div className="flex items-center gap-1 w-20 shrink-0">
                  <input
                    type="number" min={100} max={300} step={5} value={stopPct}
                    onChange={e => setStopFromPct(e.target.value)}
                    className={`w-full text-[11px] px-2 py-1.5 rounded border ${th.inputBorder} ${th.input} text-orange-400/70 outline-none focus:border-orange-500`}
                    style={{ fontFamily: "'DM Mono', monospace" }}
                  />
                  <span className={`text-[9px] ${th.textFaint} shrink-0`}>%</span>
                </div>
              </div>
              {/* Quick % presets */}
              <div className="flex items-center gap-1.5 mt-1.5 ml-28">
                {[['150%', '150'], ['200%', '200'], ['250%', '250'], ['300%', '300']].map(([label, val]) => (
                  <button key={val} onClick={() => setStopFromPct(val)}
                    className={`text-[8px] px-1.5 py-0.5 rounded border transition-colors ${
                      stopPct === val
                        ? 'border-orange-500 text-orange-400 bg-orange-500/10'
                        : `${th.border} ${th.textFaint} hover:border-orange-500/50 hover:text-orange-400/70`
                    }`}>
                    {label}
                  </button>
                ))}
                <span className={`text-[8px] ${th.textFaint} ml-1`}>of credit</span>
              </div>
              {stopError && <p className="text-[9px] text-red-400 mt-1 ml-28">{stopError}</p>}
              {!stopError && effectiveLiveDisplay != null && (
                <p className={`text-[9px] ${th.textFaint} mt-0.5 ml-28`}>
                  valid range: ${Math.max(stopMin, effectiveLiveDisplay + 0.01).toFixed(2)} – ${stopMax.toFixed(2)}
                </p>
              )}
            </div>
          </div>

          {/* Confirmation step for OCO — destructive, show summary before committing */}
          {confirming && !hasErrors && (
            <div className="mb-3 p-3 rounded-lg border border-orange-600/50 bg-orange-500/5 space-y-2">
              <p className="text-[10px] text-orange-300 font-bold">Confirm order</p>
              {needsOco && (
                <p className="text-[10px] text-yellow-300">
                  1. Cancel existing GTC #{pos.gtcOrderId} (${existingGtcPrice.toFixed(2)})
                </p>
              )}
              <p className="text-[10px] text-orange-300">
                {needsOco ? '2.' : '1.'} Place {needsOco ? 'OCO' : 'Stop Limit GTC'}:
                {needsOco && ` profit target $${gtcParsed.toFixed(2)} (${gtcPctDisplay}%)`}
                {needsOco && ' /'} stop trigger ${stopParsed.toFixed(2)} ({stopMultipleDisplay}× credit)
              </p>
              {effectiveLiveDisplay != null && (
                <p className={`text-[9px] ${th.textFaint}`}>
                  Live spread: ${effectiveLiveDisplay.toFixed(2)} | Credit: ${creditPerContract.toFixed(2)} | Qty: {qty}
                </p>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={submit}
                  disabled={loading}
                  className={`flex-1 py-2 text-white text-[10px] font-bold rounded-lg transition-colors disabled:opacity-50 ${
                    needsOco ? 'bg-yellow-600 hover:bg-yellow-500' : 'bg-orange-600 hover:bg-orange-500'
                  }`}>
                  {loading ? (phase || 'Submitting...') : 'Confirm & Submit'}
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  disabled={loading}
                  className={`px-4 py-2 border ${th.border} ${th.textFaint} rounded-lg text-[10px] hover:border-white/30 transition-colors disabled:opacity-50`}>
                  Back
                </button>
              </div>
            </div>
          )}

          {/* Primary action button — leads to confirm step, not direct submit */}
          {!confirming && (
            <button
              disabled={hasErrors || livePriceLoading}
              onClick={() => setConfirming(true)}
              className={`w-full py-2 text-white text-[10px] font-bold rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                needsOco ? 'bg-yellow-600 hover:bg-yellow-500' : 'bg-orange-600 hover:bg-orange-500'
              }`}>
              {livePriceLoading
                ? 'Fetching live price...'
                : hasErrors
                ? 'Fix errors above to continue'
                : needsOco
                ? `Review OCO — profit $${gtcParsed.toFixed(2)} / stop $${stopParsed.toFixed(2)}`
                : `Review Stop @ $${stopParsed.toFixed(2)}`}
            </button>
          )}

          {result === 'error' && <p className="text-[9px] text-red-400 mt-2 leading-relaxed whitespace-pre-line">{resultMsg}</p>}
          <button onClick={() => { setOpen(false); setConfirming(false); }} className={`w-full mt-2 text-[9px] ${th.textFaint} hover:${th.text} text-center`}>
            Cancel
          </button>
        </div>
      )}

      {result === 'success' && resultMsg && (
        <p className="absolute bottom-full mb-1 left-0 text-[9px] text-emerald-400 whitespace-nowrap bg-black/80 px-2 py-1 rounded border border-emerald-700 max-w-xs truncate" title={resultMsg}>
          {resultMsg}
        </p>
      )}
    </div>
  );
}
// ── Greek Value Tint Helpers ──────────────────────────────────────────────
// Returns a faint background class based on how favorable the Greek is
// for a short premium (credit spread) position.

function thetaTint(theta: number | null): string {
  if (theta == null) return '';
  if (theta >= 0.10) return 'bg-emerald-500/10 rounded px-1';
  if (theta >= 0.05) return 'bg-emerald-500/8 rounded px-1';
  if (theta >= 0.01) return 'bg-emerald-500/5 rounded px-1';
  if (theta < 0)     return 'bg-red-500/10 rounded px-1';
  return '';
}

function deltaTint(delta: number | null): string {
  if (delta == null) return '';
  const abs = Math.abs(delta);
  if (abs <= 0.05)  return 'bg-emerald-500/10 rounded px-1';
  if (abs <= 0.10)  return 'bg-emerald-500/8 rounded px-1';
  if (abs <= 0.15)  return 'bg-yellow-500/8 rounded px-1';
  if (abs <= 0.25)  return 'bg-orange-500/10 rounded px-1';
  return 'bg-red-500/10 rounded px-1';
}

function gammaTint(gamma: number | null): string {
  if (gamma == null) return '';
  const abs = Math.abs(gamma);
  if (abs <= 0.001)  return 'bg-emerald-500/10 rounded px-1';
  if (abs <= 0.003)  return 'bg-emerald-500/8 rounded px-1';
  if (abs <= 0.006)  return 'bg-yellow-500/8 rounded px-1';
  if (abs <= 0.010)  return 'bg-orange-500/10 rounded px-1';
  return 'bg-red-500/10 rounded px-1';
}

function vegaTint(vega: number | null): string {
  if (vega == null) return '';
  // Short vega (negative) is favorable for premium sellers
  if (vega <= -0.10) return 'bg-emerald-500/10 rounded px-1';
  if (vega <= -0.05) return 'bg-emerald-500/8 rounded px-1';
  if (vega <= -0.01) return 'bg-emerald-500/5 rounded px-1';
  if (vega >= 0)     return 'bg-red-500/10 rounded px-1';
  return '';
}

// ── Buffer Color Helpers ──────────────────────────────────────────────────
function bufferColor(buffer: number | null, dte: number): string {
  if (buffer == null) return 'text-[#808080]';

  // Breached or effectively at the short strike is the only true red condition.
  if (buffer <= 0) return 'text-red-400';

  // DTE-aware coloring: the same buffer is less dangerous with fewer days remaining.
  // Short-dated positions should warn, not panic, unless the strike is breached.
  if (dte <= 7) {
    if (buffer < 1) return 'text-orange-400';
    if (buffer < 2) return 'text-yellow-400';
    return 'text-emerald-400';
  }
  if (dte <= 21) {
    if (buffer < 1) return 'text-orange-400';
    if (buffer < 2) return 'text-yellow-400';
    if (buffer < 3) return 'text-yellow-400';
    return 'text-emerald-400';
  }
  if (dte <= 30) {
    if (buffer < 1) return 'text-red-400';
    if (buffer < 2) return 'text-orange-400';
    if (buffer < 3) return 'text-yellow-400';
    if (buffer < 5) return 'text-yellow-400';
    return 'text-emerald-400';
  }

  // Longer-dated positions need a wider cushion because there is more time to move.
  if (buffer < 1) return 'text-red-400';
  if (buffer < 2) return 'text-orange-400';
  if (buffer < 5) return 'text-yellow-400';
  return 'text-emerald-400';
}

// Highlights the active row in the tooltip table
function isBufferRow(buffer: number, label: string): boolean {
  if (label === '> 8%')  return buffer >= 8;
  if (label === '5-8%')  return buffer >= 5 && buffer < 8;
  if (label === '3-5%')  return buffer >= 3 && buffer < 5;
  if (label === '2-3%')  return buffer >= 2 && buffer < 3;
  if (label === '< 2%')  return buffer < 2;
  return false;
}

// Highlights the active DTE column in the tooltip table (col index 0-4)
function isDteCol(dte: number, col: number): boolean {
  if (col === 0) return dte > 30;
  if (col === 1) return dte >= 21 && dte <= 30;
  if (col === 2) return dte >= 14 && dte < 21;
  if (col === 3) return dte >= 7 && dte < 14;
  if (col === 4) return dte < 7;
  return false;
}

function PositionCard({ pos, th, checked, onToggle, onProfitTargetChange, onExecute }: {
  pos: Position;
  th: typeof THEMES[Theme];
  checked: boolean;
  onToggle: (key: string) => void;
  onProfitTargetChange: (key: string, value: number) => void;
  onExecute: (pos: Position, action: ActionType) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [trend, setTrend] = useState<TrendResult | null>(null);
  const [wheelCycle, setWheelCycle] = useState<WheelCycle | null>(() => getWheelCycleForPos(pos));
  const isWheelCandidate = (pos.strategy === 'PUT' || pos.strategy === 'CALL') && !wheelCycle;
  const showWheelBanner  = isWheelCandidate && !readWheelCycles().find(c => c.symbol === pos.symbol && c.cspExpiry === pos.expDate && c.dismissedBanner);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetInput, setTargetInput] = useState(String(Math.round(pos.profitTarget * 100)));
  const [analysis, setAnalysis] = useState<PositionAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const [sparkData, setSparkData] = useState(null as number[] | null);
  const [sparkLoading, setSparkLoading] = useState(false);
  const chartPopupRef = useRef(null as HTMLDivElement | null);
  const chartButtonRef = useRef<HTMLButtonElement>(null);
  const [chartPopupPos, setChartPopupPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!showChart) return;
    const handler = (e: MouseEvent) => {
      if (chartPopupRef.current && !chartPopupRef.current.contains(e.target as Node)) {
        setShowChart(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showChart]);

  const handleAnalyze = async () => {
    if (analysis) return; // already have it — button handles show/hide
    setAnalysisLoading(true);
    setAnalysisError(null);
    try {
      const result = await analyzePosition(pos, trend);
      setAnalysis(result);
      setShowAnalysis(true);
    } catch (e: any) {
      setAnalysisError(e.message ?? 'Analysis failed');
      setShowAnalysis(true);
    } finally {
      setAnalysisLoading(false);
    }
  };

  useEffect(() => {
    getTrend(pos.symbol).then(t => setTrend(t)).catch(() => {});
  }, [pos.symbol]);

  const rec = getRecommendation(pos, trend);

  const shortPuts  = pos.legs.filter(l => l.optionType === 'P' && l.direction === 'Short');
  const longPuts   = pos.legs.filter(l => l.optionType === 'P' && l.direction === 'Long');
  const shortCalls = pos.legs.filter(l => l.optionType === 'C' && l.direction === 'Short');
  const longCalls  = pos.legs.filter(l => l.optionType === 'C' && l.direction === 'Long');

  const strikesSummary = () => {
    if (pos.strategy === 'BPS' && shortPuts[0] && longPuts[0]) return `${shortPuts[0].strikePrice}P / ${longPuts[0].strikePrice}P`;
    if (pos.strategy === 'BCS' && shortCalls[0] && longCalls[0]) return `${shortCalls[0].strikePrice}C / ${longCalls[0].strikePrice}C`;
    if (pos.strategy === 'IC') return `${shortPuts[0]?.strikePrice}P/${longPuts[0]?.strikePrice}P · ${shortCalls[0]?.strikePrice}C/${longCalls[0]?.strikePrice}C`;
    return pos.legs.map(l => `${l.strikePrice}${l.optionType}`).join(' / ');
  };

  const handleTargetSave = () => {
    const val = Math.min(100, Math.max(10, parseInt(targetInput) || 50)) / 100;
    setEditingTarget(false);
    onProfitTargetChange(pos.key, val);
  };

  const borderClass = checked
    ? 'border-blue-500/60'
    : pos.needsClose ? 'border-red-500/60'
    : pos.hitTarget ? 'border-emerald-500/60'
    : th.border;

  return (
    <div className={`border ${borderClass} ${th.card} rounded-lg transition-all`}>
      {pos.stopLossStatus === 'bypassed' && (
        <div className="bg-orange-500/15 border-b border-orange-500/60 px-4 py-1.5 flex items-center gap-2">
          <span className="text-orange-400 text-xs font-bold">✗</span>
          <span className="text-xs text-orange-400 font-bold tracking-wider">
            STOP BYPASSED — order at ${pos.stopLossPrice?.toFixed(2)} never filled, position is unprotected — set a new stop now
          </span>
        </div>
      )}
      {pos.needsClose && (() => {
        const risk = classify21DteRisk(pos);
        if (risk === 'high') return (
          <div className="bg-red-500/10 border-b border-red-500/40 px-4 py-1.5 flex items-center gap-2">
            <span className="text-red-400 text-xs">⚠</span>
            <span className="text-xs text-red-400 font-bold tracking-wider">CLOSE NOW — {pos.dte} DTE</span>
          </div>
        );
        if (risk === 'medium') return (
          <div className="bg-yellow-500/10 border-b border-yellow-500/30 px-4 py-1.5 flex items-center gap-2">
            <span className="text-yellow-400 text-xs">⚠</span>
            <span className="text-xs text-yellow-400 font-bold tracking-wider">WATCH — {pos.dte} DTE · low delta, monitor buffer daily</span>
          </div>
        );
        return (
          <div className="bg-blue-500/10 border-b border-blue-500/30 px-4 py-1.5 flex items-center gap-2">
            <span className="text-blue-400 text-xs">◦</span>
            <span className="text-xs text-blue-400 font-bold tracking-wider">THETA WORKING — {pos.dte} DTE · δ{pos.netDelta?.toFixed(2)}, {pos.buffer?.toFixed(1)}% buffer, consider holding</span>
          </div>
        );
      })()}
      {!pos.needsClose && isShortDateEntry(pos) && (
        <div className="bg-purple-500/10 border-b border-purple-500/30 px-4 py-1.5 flex items-center gap-2">
          <span className="text-purple-400 text-xs">⚡</span>
          <span className="text-xs text-purple-300 font-bold tracking-wider">SHORT-DATED ENTRY — {pos.entryDte}d at entry · {pos.dte} DTE left · maximize profit fast</span>
        </div>
      )}
      {pos.hitTarget && !pos.needsClose && (
        <div className="bg-emerald-500/10 border-b border-emerald-500/40 px-4 py-1.5 flex items-center gap-2">
          <span className="text-emerald-400 text-xs">✓</span>
          <span className="text-xs text-emerald-400 font-bold tracking-wider">{Math.round(pos.profitTarget * 100)}% PROFIT TARGET HIT</span>
        </div>
      )}
      {showWheelBanner && !bannerDismissed && (
        <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-1.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-amber-400 text-xs">⟳</span>
            <span className="text-xs text-amber-300 tracking-wide">Wheel candidate detected — track as a wheel cycle?</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => { const c = startWheelCycle(pos); setWheelCycle(c); }}
              className="text-[9px] px-2 py-0.5 border border-amber-500 text-amber-300 rounded font-bold hover:bg-amber-500/20 transition-colors">
              Start Wheel
            </button>
            <button onClick={() => { dismissWheelBanner(pos); setBannerDismissed(true); }}
              className="text-[9px] px-2 py-0.5 border border-white/10 text-white/30 rounded hover:border-white/30 hover:text-white/50 transition-colors">
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="flex items-stretch">
        {/* Checkbox */}
        <div className="flex items-center px-3 border-r border-inherit shrink-0 cursor-pointer" onClick={e => { e.stopPropagation(); onToggle(pos.key); }}>
          <input type="checkbox" checked={checked} onChange={() => onToggle(pos.key)}
            className="w-4 h-4 accent-blue-500 cursor-pointer" onClick={e => e.stopPropagation()} />
        </div>

        {/* Expand toggle */}
        <button onClick={() => setExpanded(!expanded)}
          className={`px-3 flex items-center border-r ${th.borderLight} ${th.textFaint} hover:${th.textMuted} transition-colors shrink-0`}>
          <span className="text-[10px]">{expanded ? '▲' : '▼'}</span>
        </button>

        {/* Data columns */}
        <div className="overflow-x-auto flex-1" style={{ minWidth: 0 }}>
          <div className="grid px-4 py-3" style={{ gridTemplateColumns: '72px 120px 80px 70px 110px 80px 80px 90px 70px 50px 45px 45px 45px 55px 60px 90px 130px', gap: '0 12px', alignItems: 'start', minWidth: '1464px' }}>

            {/* ── POSITION ───────────────────────────── */}
            <div className="border-t-2 border-slate-600/60 pt-1">
              <p className={`font-bold ${th.text} text-sm leading-tight`} style={{ fontFamily: "'DM Mono', monospace" }}>{pos.symbol}</p>
              <span className={`text-[10px] px-1.5 py-0.5 border rounded font-bold ${stratColor(pos.strategy)}`}>{pos.strategy}</span>
              {wheelCycle && (
                <span className="ml-1 text-[9px] px-1 py-0.5 border border-amber-600/60 rounded text-amber-400 font-bold">WHEEL</span>
              )}
              {/* Chart button */}
              <div className="relative mt-1">
                <button
                  onClick={e => {
                    e.stopPropagation();
                    if (!showChart) {
                      setShowChart(true);
                      if (!sparkData) {
                        setSparkLoading(true);
                        fetch(`/api/chart?symbol=${encodeURIComponent(pos.symbol)}`)
                          .then(r => r.json())
                          .then(d => {
                            const closes = (d?.bars ?? []).map((b: any) => b?.c).filter((v: any) => v != null).slice(-90);
                            setSparkData(closes);
                          })
                          .catch(() => setSparkData([]))
                          .finally(() => setSparkLoading(false));
                      }
                    } else { setShowChart(false); }
                  }}
                  ref={chartButtonRef}
                className={`inline-flex items-center gap-0.5 text-[9px] transition-colors ${showChart ? 'text-blue-400' : 'text-slate-500 hover:text-blue-400'}`}
                  title="Quick chart"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                  </svg>
                  <span className="tracking-wide">chart</span>
                </button>

                {showChart && (
                  <div
                    ref={chartPopupRef}
                    className={`fixed z-[9999] ${th.sidebar} border ${th.border} rounded-xl shadow-2xl p-3`}
                    style={{ width: '280px', top: chartPopupPos?.top ?? 0, left: chartPopupPos?.left ?? 0 }}
                    onClick={e => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className={`text-[10px] font-bold ${th.textFaint} tracking-widest`}>{pos.symbol}</span>
                      <button onClick={() => setShowChart(false)} className="text-slate-500 hover:text-white transition-colors text-sm leading-none">✕</button>
                    </div>
                      {sparkLoading && (
                        <div className="flex items-center justify-center h-16">
                          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        </div>
                      )}
                      {!sparkLoading && sparkData && sparkData.length > 1 && (() => {
                        const min = Math.min(...sparkData);
                        const max = Math.max(...sparkData);
                        const range = max - min || 1;
                        const w = 256, h = 56;
                        const pts = sparkData.map((v, i) => {
                          const x = (i / (sparkData.length - 1)) * w;
                          const y = h - ((v - min) / range) * h;
                          return `${x.toFixed(1)},${y.toFixed(1)}`;
                        }).join(' ');
                        const isUp = sparkData[sparkData.length - 1] >= sparkData[0];
                        const color = isUp ? '#10b981' : '#ef4444';
                        const lastPrice = sparkData[sparkData.length - 1];
                        const changePct = ((lastPrice - sparkData[0]) / sparkData[0] * 100).toFixed(1);
                        return (
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <span className={`text-[10px] font-bold ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{pos.symbol}</span>
                              <span className="text-[10px] font-bold" style={{ color }}>
                                ${lastPrice.toFixed(2)} <span className="text-[9px]">{isUp ? '+' : ''}{changePct}% 30d</span>
                              </span>
                            </div>
                            <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: '56px' }}>
                              <defs>
                                <linearGradient id={`grad-${pos.symbol}-${pos.key}`} x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="0%" stopColor={color} stopOpacity="0.3" />
                                  <stop offset="100%" stopColor={color} stopOpacity="0" />
                                </linearGradient>
                              </defs>
                              <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
                              <polygon points={`0,${h} ${pts} ${w},${h}`} fill={`url(#grad-${pos.symbol}-${pos.key})`} />
                            </svg>
                          </div>
                        );
                      })()}
                      {!sparkLoading && sparkData && sparkData.length === 0 && (
                        <p className={`text-[9px] ${th.textFaint} text-center py-3`}>Chart data unavailable</p>
                      )}
                    <a
                      href={`https://www.tradingview.com/chart/?symbol=${pos.symbol}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="flex items-center justify-center gap-2 w-full py-2 rounded-lg text-[10px] text-blue-400 font-bold tracking-wider transition-colors border border-blue-500/30 hover:border-blue-500/60 hover:bg-blue-500/10"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                      Open in TradingView
                    </a>
                  </div>
                )}
              </div>
            </div>

            <div className="border-t-2 border-slate-600/60 pt-1 border-r border-r-slate-700/40 pr-2">
              <p className={`text-[9px] ${th.textFaint}`}>Entry / Expiry / DTE</p>
              <p className="text-xs leading-tight" style={{ fontFamily: "'DM Mono', monospace" }}>
                {pos.entryDate && <span className={`block text-[10px] ${th.textFaint}`}>{pos.entryDate}</span>}
                <span className={`block font-bold ${th.text}`}>{pos.expDate}</span>
                <span className={`block ${dteColor(pos.dte)}`}>({pos.dte}d)</span>
              </p>
            </div>

            {/* ── MARKET ─────────────────────────────── */}
            <div className="border-t-2 border-sky-600/50 pt-1">
              <p className={`text-[9px] ${th.textFaint}`}>Stock</p>
              <p className={`text-xs ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{pos.stockPrice != null ? `$${pos.stockPrice.toFixed(2)}` : '—'}</p>
            </div>

            <div className="relative group border-t-2 border-sky-600/50 pt-1">
              <p className={`text-[9px] ${th.textFaint}`}>% Buffer</p>
              <p className={`text-xs font-bold ${bufferColor(pos.buffer, pos.dte)}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                {pos.buffer != null ? `${pos.buffer.toFixed(1)}%` : '—'}
              </p>
              {/* Tooltip */}
              <div className="absolute bottom-full left-0 mb-2 z-50 hidden group-hover:block w-72 pointer-events-none">
                <div className="bg-[#1a1a1a] border border-[#333] rounded-xl p-3 shadow-2xl text-[10px]">
                  <p className="text-white font-bold mb-2 tracking-wide">BUFFER RISK GUIDE</p>
                  <p className="text-[#888] mb-2">Color adjusts based on buffer % <span className="text-white">and</span> DTE remaining. Same buffer is safer with less time left.</p>
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th className="text-left text-[#666] pb-1 pr-2 font-normal">Buffer</th>
                        <th className="text-center text-[#666] pb-1 px-1 font-normal">&gt;30d</th>
                        <th className="text-center text-[#666] pb-1 px-1 font-normal">21-30d</th>
                        <th className="text-center text-[#666] pb-1 px-1 font-normal">14-21d</th>
                        <th className="text-center text-[#666] pb-1 px-1 font-normal">7-14d</th>
                        <th className="text-center text-[#666] pb-1 px-1 font-normal">&lt;7d</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { label: '> 8%',  cols: ['🟢','🟢','🟢','🟢','🟢'] },
                        { label: '5-8%',  cols: ['🟢','🟢','🟢','🟡','🟢'] },
                        { label: '3-5%',  cols: ['🟡','🟡','🟢','🟢','🟢'] },
                        { label: '2-3%',  cols: ['🟠','🟠','🟡','🟡','🟢'] },
                        { label: '< 2%',  cols: ['🔴','🔴','🟠','🟡','🟡'] },
                      ].map(row => (
                        <tr key={row.label} className={pos.buffer != null && isBufferRow(pos.buffer, row.label) ? 'bg-white/5 rounded' : ''}>
                          <td className="text-[#aaa] pr-2 py-0.5 font-mono">{row.label}</td>
                          {row.cols.map((c, i) => (
                            <td key={i} className={`text-center px-1 py-0.5 ${pos.dte != null && isDteCol(pos.dte, i) ? 'bg-white/10 rounded' : ''}`}>{c}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-[#555] mt-2 leading-tight">Your position: <span className="text-white">{pos.buffer?.toFixed(1) ?? '—'}% buffer</span> at <span className="text-white">{pos.dte}d DTE</span></p>
                </div>
              </div>
            </div>

            <div className="border-t-2 border-sky-600/50 pt-1 border-r border-r-slate-700/40 pr-2">
              <p className={`text-[9px] ${th.textFaint}`}>Strikes</p>
              <p className={`text-xs ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{strikesSummary()}</p>
            </div>

            {/* ── P&L ────────────────────────────────── */}
            <div className="border-t-2 border-emerald-600/50 pt-1">
              <p className={`text-[9px] ${th.textFaint}`}>Buyback</p>
              <p className={`text-xs ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{pos.currentValue != null ? `$${pos.currentValue.toFixed(2)}` : '—'}</p>
            </div>

            <div className="border-t-2 border-emerald-600/50 pt-1">
              <p className={`text-[9px] ${th.textFaint}`}>Credit</p>
              <p className="text-xs font-bold text-emerald-400" style={{ fontFamily: "'DM Mono', monospace" }}>${pos.creditReceived.toFixed(2)}</p>
            </div>

            <div onClick={e => e.stopPropagation()} className="border-t-2 border-emerald-600/50 pt-1">
              <p className={`text-[9px] ${th.textFaint}`}>{Math.round(pos.profitTarget * 100)}% Target</p>
              {editingTarget ? (
                <div className="flex items-center gap-1">
                  <input type="number" min="10" max="100" value={targetInput}
                    onChange={e => setTargetInput(e.target.value)}
                    onBlur={handleTargetSave}
                    onKeyDown={e => { if (e.key === 'Enter') handleTargetSave(); if (e.key === 'Escape') setEditingTarget(false); }}
                    autoFocus className="text-xs w-12 bg-transparent border-b border-blue-500 outline-none text-blue-400"
                    style={{ fontFamily: "'DM Mono', monospace" }} />
                  <span className="text-[9px] text-blue-400">%</span>
                </div>
              ) : (
                <div className="cursor-pointer" onClick={() => { setTargetInput(String(Math.round(pos.profitTarget * 100))); setEditingTarget(true); }}>
                  <p className={`text-xs ac-hover-text transition-colors ${pos.hitTarget ? 'text-emerald-400 font-bold' : th.textFaint}`}
                    style={{ fontFamily: "'DM Mono', monospace" }}>
                    ${pos.targetPrice.toFixed(2)}{pos.hitTarget && ' ✓'}
                  </p>
                </div>
              )}
            </div>

            <div className="border-t-2 border-emerald-600/50 pt-1 border-r border-r-slate-700/40 pr-2">
              <p className={`text-[9px] ${th.textFaint}`}>P/L Open</p>
              {(() => {
                // Prefer pnl (live mid from market-data) over plOpen (EOD marks)
                const displayPnl = pos.pnl ?? pos.plOpen;
                const isStale = pos.pnl == null && pos.plOpen != null;
                if (displayPnl == null) return <p className={`text-xs ${th.textFaint}`}>—</p>;
                return (
                  <>
                    <p className={`text-xs font-bold ${displayPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                      {displayPnl >= 0 ? '+' : ''}${displayPnl.toFixed(0)}{isStale && <span className="text-[8px] opacity-50 ml-0.5">~</span>}
                    </p>
                    {pos.creditReceived !== 0 && (
                      <p className={`font-normal text-[10px] ${displayPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                        ({displayPnl >= 0 ? '+' : ''}{(displayPnl / Math.abs(pos.creditReceived) * 100).toFixed(1)}%)
                      </p>
                    )}
                  </>
                );
              })()}
            </div>

            {/* ── GREEKS ─────────────────────────────── */}
            <div className="border-t-2 border-purple-600/50 pt-1">
              <p className={`text-[9px] ${th.textFaint}`}>Theta</p>
              <p className={`text-xs font-bold inline-block ${thetaTint(pos.theta)} ${pos.theta != null ? (pos.theta >= 0 ? 'text-emerald-400' : 'text-red-400') : th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                {pos.theta != null ? (pos.theta >= 0 ? '+' : '') + pos.theta.toFixed(3) : '—'}
              </p>
              <p className={`text-[8px] mt-0.5 ${th.textFaint}`}>
                {pos.theta == null ? '' : pos.theta >= 0.10 ? '★ strong decay' : pos.theta >= 0.05 ? '✓ good decay' : pos.theta >= 0.01 ? '~ light decay' : '✗ paying theta'}
              </p>
            </div>

            <div className="border-t-2 border-purple-600/50 pt-1">
              <p className={`text-[9px] ${th.textFaint}`}>Delta</p>
              <p className={`text-xs font-bold inline-block ${deltaTint(pos.netDelta)} ${pos.netDelta != null ? (Math.abs(pos.netDelta) > 0.15 ? 'text-yellow-400' : 'text-emerald-400') : th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                {pos.netDelta != null ? (pos.netDelta >= 0 ? '+' : '') + pos.netDelta.toFixed(3) : '—'}
              </p>
              <p className={`text-[8px] mt-0.5 ${th.textFaint}`}>
                {pos.netDelta == null ? '' : (() => {
                  const t = deltaTint(pos.netDelta);
                  if (t.includes('emerald') && t.includes('10')) return '✓ neutral';
                  if (t.includes('emerald')) return '✓ near neutral';
                  if (t.includes('yellow')) return '~ directional';
                  if (t.includes('orange')) return '⚠ exposed';
                  return '✗ high exposure';
                })()}
              </p>
            </div>

            <div className="border-t-2 border-purple-600/50 pt-1">
              <p className={`text-[9px] ${th.textFaint}`}>Gamma</p>
              <p className={`text-xs font-bold inline-block ${gammaTint(pos.gamma)} ${pos.gamma != null ? (
                Math.abs(pos.gamma) <= 0.003 ? 'text-emerald-400' :
                Math.abs(pos.gamma) <= 0.006 ? 'text-yellow-400' :
                Math.abs(pos.gamma) <= 0.010 ? 'text-orange-400' :
                'text-red-400'
              ) : th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                {pos.gamma != null ? pos.gamma.toFixed(4) : '—'}
              </p>
              <p className={`text-[8px] mt-0.5 ${th.textFaint}`}>
                {pos.gamma == null ? '' : (() => {
                  const t = gammaTint(pos.gamma);
                  if (t.includes('emerald') && t.includes('10')) return '✓ low risk';
                  if (t.includes('emerald')) return '✓ manageable';
                  if (t.includes('yellow')) return '~ watch';
                  if (t.includes('orange')) return '⚠ elevated';
                  return '✗ high gamma';
                })()}
              </p>
            </div>

            <div className="border-t-2 border-purple-600/50 pt-1">
              <p className={`text-[9px] ${th.textFaint}`}>Vega</p>
              <p className={`text-xs font-bold inline-block ${vegaTint(pos.netVega)} ${pos.netVega != null ? (pos.netVega < 0 ? 'text-emerald-400' : 'text-red-400') : th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                {pos.netVega != null ? (pos.netVega >= 0 ? '+' : '') + pos.netVega.toFixed(3) : '—'}
              </p>
              <p className={`text-[8px] mt-0.5 ${th.textFaint}`}>
                {pos.netVega == null ? '' : (() => {
                  const t = vegaTint(pos.netVega);
                  if (t.includes('emerald') && t.includes('10')) return '✓ short vega';
                  if (t.includes('emerald') && t.includes('8')) return '✓ short vega';
                  if (t.includes('emerald')) return '~ slight short';
                  return '✗ long vega (wrong side)';
                })()}
              </p>
            </div>

            <div className="border-t-2 border-purple-600/50 pt-1 border-r border-r-slate-700/40 pr-2">
              <p className={`text-[9px] ${th.textFaint}`}>IVR</p>
              <p className={`text-xs font-bold ${pos.ivr != null ? (pos.ivr >= 30 ? 'text-emerald-400' : 'text-yellow-400') : th.textFaint}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                {pos.ivr ?? '—'}
              </p>
            </div>

            {/* ── ORDERS ─────────────────────────────── */}
            <div className="border-t-2 border-amber-600/50 pt-1">
              <p className={`text-[9px] ${th.textFaint}`}>GTC</p>
              <p className={`text-xs font-bold ${pos.hasGtc ? 'text-emerald-400' : 'text-red-400'}`}>{pos.hasGtc ? '✓ Live' : '✕ None'}</p>
            </div>

            <div className="border-t-2 border-amber-600/50 pt-1 border-r border-r-slate-700/40 pr-2">
              <p className={`text-[9px] ${th.textFaint}`}>Stop Loss</p>
              {(pos.strategy !== 'BPS' && pos.strategy !== 'BCS' && pos.strategy !== 'IC') ? (
                <p className={`text-xs font-bold ${th.textFaint}`}>— N/A</p>
              ) : (() => {
                const cfg =
                  pos.stopLossStatus === 'live'     ? { icon: '✓', label: 'Stop',     cls: 'text-emerald-400' } :
                  pos.stopLossStatus === 'loose'    ? { icon: '⚠', label: 'Loose',    cls: 'text-yellow-400'  } :
                  pos.stopLossStatus === 'none'     ? { icon: '✕', label: 'None',     cls: 'text-red-400'     } :
                  pos.stopLossStatus === 'bypassed' ? { icon: '✗', label: 'Bypassed', cls: 'text-orange-400'  } :
                                                      { icon: '—', label: '?',        cls: th.textFaint       };
                return (
                  <p className={`text-xs font-bold ${cfg.cls}`}>
                    {cfg.icon} {cfg.label}
                    {pos.stopLossPrice != null && (
                      <span className={`ml-1 ${th.textFaint} text-[10px] font-normal`}>${pos.stopLossPrice.toFixed(2)}</span>
                    )}
                  </p>
                );
              })()}
            </div>

            {/* ── ACTION ─────────────────────────────── */}
            <div className="border-t-2 border-slate-500/40 pt-1">
              <p className={`text-[9px] ${th.textFaint}`}>Suggested</p>
              <span className={`text-[10px] font-bold ${ACTION_META[rec.action].color}`}>{ACTION_META[rec.action].label}</span>
              <p className={`text-[9px] ${th.textFaint} mt-0.5 leading-tight`}>{rec.detail}</p>
              {(() => { const sig = getExtendSignal(pos); return sig ? <p className="text-[9px] text-blue-400 mt-0.5 leading-tight">{sig}</p> : null; })()}
            </div>
          </div>
        </div>
      </div>

      {/* Action + Analyze row */}
      <div className={`flex items-center justify-between px-4 py-2 border-t ${th.borderLight}`}>
        {/* Quick action buttons */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {(['TAKE_PROFIT', 'CUT_LOSSES', 'CLOSE_ROLL', 'PLACE_GTC'] as ActionType[]).map(action => {
            const meta = ACTION_META[action];
            const pnlPct = pos.pnl != null && pos.creditReceived > 0 ? (pos.pnl / pos.creditReceived) * 100 : null;

            // TAKE_PROFIT — only show when profit target hit (≥50%) or AI recommends it
            if (action === 'TAKE_PROFIT' && !pos.hitTarget && rec.action !== 'TAKE_PROFIT') return null;

            // CUT_LOSSES — only show for a true hard-exit situation.
            // Ordinary red P/L on a credit spread is mark-to-market noise unless the
            // short strike is breached, the stop threshold is reached, or loss is extreme.
            if (action === 'CUT_LOSSES') {
              const breached = pos.buffer != null && pos.buffer <= 0;
              const atExtremeLoss = pnlPct != null && pnlPct <= -200;
              const shortQty = Math.abs(pos.legs.find(l => l.direction === 'Short')?.quantity ?? 1);
              // stopLossPrice is per contract; currentValue is total position buyback value.
              const stopLossBreached = pos.stopLossPrice != null && pos.currentValue != null && shortQty > 0
                ? pos.currentValue >= (pos.stopLossPrice * 100 * shortQty)
                : false;
              if (!breached && !atExtremeLoss && !stopLossBreached && rec.action !== 'CUT_LOSSES') return null;
            }

            // PLACE_GTC — hide when already has GTC
            if (action === 'PLACE_GTC' && pos.hasGtc) return null;

            return (
              <button key={action}
                onClick={e => { e.stopPropagation(); onExecute(pos, action); }}
                className={`text-[9px] px-2.5 py-1 border rounded font-bold transition-colors ${meta.btnClass}`}>
                {meta.label}
              </button>
            );
          })}
          {/* Extend Profit — only show when profit ≥50% AND DTE ≥ 14 */}
          {(() => {
            const pnlPct = pos.pnl != null && pos.creditReceived > 0 ? (pos.pnl / pos.creditReceived) * 100 : null;
            const canExtend = pnlPct != null && pnlPct >= 50 && pos.dte >= 14;
            return canExtend ? <ExtendProfitButton pos={pos} th={th} /> : null;
          })()}
          {/* Stop only applies to defined-risk spreads — not CSPs or single-leg positions */}
          {(pos.strategy === 'BPS' || pos.strategy === 'BCS' || pos.strategy === 'IC') && (
            <SetStopLossButton pos={pos} th={th} />
          )}
          {(['TAKE_PROFIT', 'CUT_LOSSES', 'CLOSE_ROLL', 'PLACE_GTC'] as ActionType[]).includes(rec.action) && (
            <span className={`text-[9px] ${th.textFaint} ml-1`}>← suggested</span>
          )}
        </div>

        <button
          onClick={e => { e.stopPropagation(); if (analysis || analysisLoading) { setShowAnalysis(v => !v); } else { handleAnalyze(); } }}
          className={`text-[10px] px-3 py-1 border rounded-lg transition-colors font-bold flex items-center gap-1.5 ${
            showAnalysis && analysis
              ? 'border-indigo-500 text-indigo-300 bg-indigo-500/10'
              : analysis
              ? 'border-indigo-600 text-indigo-400 hover:bg-indigo-500/10'
              : 'border-indigo-800 text-indigo-500 hover:border-indigo-600 hover:text-indigo-400'
          }`}>
          <span>◈</span>
          <span>{analysisLoading ? 'Analyzing...' : showAnalysis && analysis ? 'Hide Analysis' : analysis ? 'Show Analysis' : 'Analyze with AI'}</span>
        </button>
      </div>

{/* Expanded legs */}
      {expanded && (
        <div className={`border-t ${th.border} px-4 py-3`}>

          {/* ── MID Tracker ─────────────────────────────────────────────── */}
          {(() => {
            const qty = Math.abs(pos.legs.find(l => l.direction === 'Short')?.quantity ?? 1);
            const credit = pos.creditReceived / (qty * 100);
            const mid = pos.currentValue != null ? pos.currentValue / (qty * 100) : null;
            const stopPrice = pos.stopLossPrice;
            const target50 = credit * (1 - pos.profitTarget);
            const breakeven = credit;
            const barLeft  = stopPrice ?? credit * 2.0;
            const barRight = 0;
            const barRange = barLeft - barRight || 1;
            const pct = mid != null ? Math.max(0, Math.min(100, ((barLeft - mid) / barRange) * 100)) : null;
            const breakevenPct = Math.max(0, Math.min(100, ((barLeft - breakeven) / barRange) * 100));
            const targetPct    = Math.max(0, Math.min(100, ((barLeft - target50) / barRange) * 100));
            const isProfit   = mid != null && mid < credit;
            const isAtTarget = mid != null && mid <= target50;
            const barColor   = mid == null ? '#4b5563'
              : isAtTarget   ? '#10b981'
              : isProfit     ? '#34d399'
              : mid < credit * 1.2 ? '#facc15'
              : '#f87171';
            return (
              <div className="mb-4">
                <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-2`}>MID Tracker</p>
                <div className="flex items-center gap-6 mb-2 flex-wrap">
                  {[
                    { label: 'Credit',     val: `$${credit.toFixed(2)}`,    cls: 'text-emerald-400' },
                    { label: 'Current MID',val: mid != null ? `$${mid.toFixed(2)}` : '—',
                      cls: mid == null ? th.textFaint : isProfit ? 'text-emerald-400' : 'text-red-400' },
                    { label: 'Breakeven',  val: `$${breakeven.toFixed(2)}`, cls: 'text-yellow-400' },
                    { label: `${Math.round(pos.profitTarget * 100)}% Target`, val: `$${target50.toFixed(2)}`, cls: 'text-blue-400' },
                    { label: 'Stop',       val: stopPrice != null ? `$${stopPrice.toFixed(2)}` : '—', cls: 'text-red-400' },
                    { label: 'To B/E',     val: mid != null ? (mid <= credit ? '✓ Profit' : `$${(mid - credit).toFixed(2)} away`) : '—',
                      cls: mid != null && mid <= credit ? 'text-emerald-400' : 'text-yellow-400' },
                  ].map(({ label, val, cls }) => (
                    <div key={label}>
                      <p className={`text-[8px] ${th.textFaint} uppercase tracking-wider`}>{label}</p>
                      <p className={`text-[11px] font-bold ${cls}`} style={{ fontFamily: "'DM Mono', monospace" }}>{val}</p>
                    </div>
                  ))}
                </div>
                <div className="relative h-4 rounded-full overflow-visible" style={{ background: 'rgba(255,255,255,0.06)' }}>
                  {pct != null && (
                    <div className="absolute top-0 left-0 h-full rounded-full transition-all duration-500"
                      style={{ width: `${pct}%`, background: `linear-gradient(to right, #ef4444, ${barColor})` }} />
                  )}
                  <div className="absolute top-0 h-full w-px bg-yellow-400/70" style={{ left: `${breakevenPct}%` }}>
                    <span className="absolute -top-4 text-[8px] text-yellow-400 -translate-x-1/2 whitespace-nowrap">B/E</span>
                  </div>
                  <div className="absolute top-0 h-full w-px bg-blue-400/70" style={{ left: `${targetPct}%` }}>
                    <span className="absolute -top-4 text-[8px] text-blue-400 -translate-x-1/2 whitespace-nowrap">{Math.round(pos.profitTarget * 100)}%</span>
                  </div>
                  {pct != null && (
                    <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-white shadow-lg transition-all duration-500"
                      style={{ left: `calc(${pct}% - 6px)`, background: barColor }} />
                  )}
                  <div className="flex justify-between mt-5">
                    <span className="text-[8px] text-red-400">STOP ${stopPrice?.toFixed(2) ?? '—'}</span>
                    <span className="text-[8px] text-emerald-400">MAX PROFIT $0</span>
                  </div>
                </div>
              </div>
            );
          })()}

{/* ── Wheel Cycle Summary ─────────────────────────────────── */}
          {(pos.strategy === 'PUT' || pos.strategy === 'CALL') && (
            <div className="mb-4">
              <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-2`}>Wheel Cycle</p>
              {wheelCycle ? (
                <div className="flex items-center gap-6 flex-wrap">
                  {[
                    { label: 'Status',      val: wheelCycle.status.replace('_', ' ').toUpperCase(), cls: 'text-amber-400' },
                    { label: 'CSP Strike',  val: `$${wheelCycle.cspStrike}`,                        cls: 'text-white' },
                    { label: 'Premium In',  val: `$${wheelCycle.totalPremiumCollected.toFixed(2)}`,  cls: 'text-emerald-400' },
                    { label: 'Eff. Basis',  val: wheelCycle.effectiveCostBasis != null ? `$${wheelCycle.effectiveCostBasis.toFixed(2)}` : '—', cls: 'text-blue-400' },
                    { label: 'CCs Sold',    val: String(wheelCycle.coveredCalls.length),             cls: 'text-white' },
                  ].map(({ label, val, cls }) => (
                    <div key={label}>
                      <p className={`text-[8px] ${th.textFaint} uppercase tracking-wider`}>{label}</p>
                      <p className={`text-[11px] font-bold ${cls}`} style={{ fontFamily: "'DM Mono', monospace" }}>{val}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <p className={`text-[10px] ${th.textFaint}`}>Not tracked as a wheel cycle.</p>
                  <button onClick={() => { const c = startWheelCycle(pos); setWheelCycle(c); }}
                    className="text-[9px] px-2 py-0.5 border border-amber-600/60 text-amber-400 rounded font-bold hover:bg-amber-500/10 transition-colors">
                    ⟳ Track as Wheel
                  </button>
                </div>
              )}
            </div>
          )}

          <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-2`}>Legs</p>
          <div className="space-y-1.5">
            {pos.legs.map((leg, i) => (
              <div key={i} className="flex items-center gap-4 flex-wrap">
                <span className={`text-[10px] w-10 font-bold ${leg.direction === 'Short' ? 'text-red-400' : 'text-emerald-400'}`}>{leg.direction}</span>
                <span className={`text-[10px] ${th.text}`} style={{ fontFamily: "'DM Mono', monospace" }}>{leg.quantity}x {leg.strikePrice} {leg.optionType === 'P' ? 'Put' : 'Call'}</span>
                <span className={`text-[10px] ${th.textFaint}`}>Avg open: <span className={th.text}>${leg.avgOpenPrice.toFixed(2)}</span></span>
                {leg.currentPrice != null && <span className={`text-[10px] ${th.textFaint}`}>Current: <span className={th.text}>${leg.currentPrice.toFixed(2)}</span></span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI analysis panel */}
      {showAnalysis && (
        <>
          {analysisLoading && (
            <div className={`border-t ${th.border} px-4 py-4 flex items-center gap-3`} style={{ background: 'rgba(99,102,241,0.04)' }}>
              <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin shrink-0" />
              <p className={`text-xs ${th.textFaint}`}>Analyzing position with AI...</p>
              <button onClick={() => setShowAnalysis(false)} className={`ml-auto text-[10px] ${th.textFaint} hover:${th.text}`}>✕</button>
            </div>
          )}
          {analysisError && (
            <div className={`border-t ${th.border} px-4 py-3 flex items-center gap-2`}>
              <p className="text-[10px] text-red-400">Analysis failed: {analysisError}</p>
              <button onClick={() => { setAnalysisError(null); handleAnalyze(); }} className="text-[10px] text-blue-400 hover:underline">Retry</button>
              <button onClick={() => setShowAnalysis(false)} className={`ml-auto text-[10px] ${th.textFaint}`}>✕</button>
            </div>
          )}
          {analysis && !analysisLoading && (
            <div className="relative">
              <button onClick={() => setShowAnalysis(false)} className={`absolute top-3 right-3 text-[10px] ${th.textFaint} hover:${th.text} z-10`}>✕</button>
              <AnalysisPanel analysis={analysis} pos={pos} th={th} />
              <div className={`p-4 border border-indigo-500/30 rounded-lg bg-indigo-500/5 text-xs ${th.text}`}>
                AI Position Analysis would appear here<br />
                (component temporarily commented out to make build pass)
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Position Section with group-action header ──────────────────────────────
function PositionSection({ title, titleColor, positions, th, checked, onToggle, onToggleAll, onProfitTargetChange, groupAction, onGroupAction, onExecute }: {
  title: string; titleColor: string; positions: Position[];
  th: typeof THEMES[Theme]; checked: Set<string>;
  onToggle: (key: string) => void; onToggleAll: (keys: string[], select: boolean) => void;
  onProfitTargetChange: (key: string, value: number) => void;
  groupAction: ActionType; onGroupAction: (positions: Position[], action: ActionType) => void;
  onExecute: (pos: Position, action: ActionType) => void;
}) {
  const keys = positions.map(p => p.key);
  const allChecked = keys.length > 0 && keys.every(k => checked.has(k));
  const someChecked = keys.some(k => checked.has(k));
  const meta = ACTION_META[groupAction];
  const checkboxRef = (el: HTMLInputElement | null) => { if (el) el.indeterminate = someChecked && !allChecked; };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <input type="checkbox" ref={checkboxRef} checked={allChecked}
            onChange={() => onToggleAll(keys, !allChecked)}
            className="w-4 h-4 accent-blue-500 cursor-pointer" />
          <p className={`text-[10px] ${titleColor} tracking-widest font-bold uppercase`}>{title} — {positions.length}</p>
        </div>
        {groupAction !== 'HOLD' && (
          <button onClick={() => onGroupAction(positions, groupAction)}
            className={`text-[10px] px-3 py-1.5 border rounded font-bold transition-colors ${meta.btnClass}`}>
            {meta.label} All
          </button>
        )}
      </div>
      <div className="space-y-2">
        {positions.map(p => (
          <PositionCard key={p.key} pos={p} th={th} checked={checked.has(p.key)} onToggle={onToggle} onProfitTargetChange={onProfitTargetChange} onExecute={onExecute} />
        ))}
      </div>
    </div>
  );
}

// ── Sticky Bulk Action Bar ─────────────────────────────────────────────────
function BulkActionBar({ selectedKeys, positions, onExecute, onClear, th }: {
  selectedKeys: Set<string>; positions: Position[];
  onExecute: (items: { pos: Position; action: ActionType }[]) => void;
  onClear: () => void; th: typeof THEMES[Theme];
}) {
  if (selectedKeys.size === 0) return null;
  const selected = positions.filter(p => selectedKeys.has(p.key));
  const actions: ActionType[] = ['TAKE_PROFIT', 'CUT_LOSSES', 'CLOSE_ROLL', 'PLACE_GTC'];

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div className="mx-auto max-w-7xl px-6 pb-4">
        <div className={`${th.sidebar} border ${th.border} rounded-xl px-5 py-3 flex items-center gap-4 shadow-2xl`}>
          <div className="flex items-center gap-2 shrink-0">
            <span className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-white text-[10px] font-bold">{selectedKeys.size}</span>
            <span className={`text-xs font-bold ${th.text}`}>selected</span>
          </div>
          <div className={`w-px h-6 ${th.border} border-l`} />
          <div className="flex items-center gap-2 flex-1 flex-wrap">
            {actions.map(action => {
              const meta = ACTION_META[action];
              return (
                <button key={action}
                  onClick={() => onExecute(selected.map(pos => ({ pos, action })))}
                  className={`text-[10px] px-3 py-1.5 border rounded font-bold transition-colors ${meta.btnClass}`}>
                  {meta.label}
                </button>
              );
            })}
          </div>
          <button onClick={onClear} className={`text-[10px] ${th.textFaint} hover:${th.text} shrink-0 transition-colors`}>
            ✕ Clear
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

// ── Performance Panel ──────────────────────────────────────────────────────
function PerformancePanel({ onClose, th }: { onClose: () => void; th: typeof THEMES[Theme] }) {
  const auditLog: AuditEntry[] = (() => {
    try { return JSON.parse(localStorage.getItem('hunter-audit-log') ?? '[]'); } catch { return []; }
  })();

  const closed = auditLog.filter(e => e.status === 'submitted' && e.estPnl != null &&
    (e.action === 'TAKE_PROFIT' || e.action === 'CUT_LOSSES' || e.action === 'CLOSE_ROLL'));

  const winners = closed.filter(e => (e.estPnl ?? 0) > 0);
  const losers  = closed.filter(e => (e.estPnl ?? 0) <= 0);
  const winRate    = closed.length > 0 ? (winners.length / closed.length * 100) : 0;
  const avgWin     = winners.length > 0 ? winners.reduce((s, e) => s + (e.estPnl ?? 0), 0) / winners.length : 0;
  const avgLoss    = losers.length  > 0 ? Math.abs(losers.reduce((s, e) => s + (e.estPnl ?? 0), 0) / losers.length) : 0;
  const expectancy = (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss;
  const totalPnl   = closed.reduce((s, e) => s + (e.estPnl ?? 0), 0);

  // Monthly bucketing
  const byMonth: Record<string, { pnl: number; trades: number; wins: number }> = {};
  for (const e of closed) {
    const month = e.timestamp.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { pnl: 0, trades: 0, wins: 0 };
    byMonth[month].pnl    += e.estPnl ?? 0;
    byMonth[month].trades += 1;
    if ((e.estPnl ?? 0) > 0) byMonth[month].wins += 1;
  }
  const months       = Object.keys(byMonth).sort();
  const last3Months  = months.slice(-3);
  const last12Months = months.slice(-12);
  const qPnl = last3Months.reduce((s, m)  => s + byMonth[m].pnl, 0);
  const yPnl = last12Months.reduce((s, m) => s + byMonth[m].pnl, 0);
  const mPnl = months.length > 0 ? byMonth[months[months.length - 1]].pnl : 0;

  // By symbol
  const bySymbol: Record<string, { pnl: number; trades: number; wins: number }> = {};
  for (const e of closed) {
    if (!bySymbol[e.symbol]) bySymbol[e.symbol] = { pnl: 0, trades: 0, wins: 0 };
    bySymbol[e.symbol].pnl    += e.estPnl ?? 0;
    bySymbol[e.symbol].trades += 1;
    if ((e.estPnl ?? 0) > 0) bySymbol[e.symbol].wins += 1;
  }
  const symbolRows  = Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl);
  const maxSymbolPnl = Math.max(...symbolRows.map(r => Math.abs(r[1].pnl)), 1);
  const maxBarPnl    = Math.max(...months.map(m => Math.abs(byMonth[m].pnl)), 1);

  const kpis = [
    { label: 'Win Rate',    value: `${winRate.toFixed(0)}%`,                              sub: `${winners.length}W / ${losers.length}L`,     color: winRate >= 70 ? 'text-emerald-400' : winRate >= 50 ? 'text-yellow-400' : 'text-red-400' },
    { label: 'Expectancy', value: `${expectancy >= 0 ? '+' : ''}$${expectancy.toFixed(0)}`, sub: 'per trade avg',                             color: expectancy >= 0 ? 'text-emerald-400' : 'text-red-400' },
    { label: 'Total P&L',  value: `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(0)}`,    sub: 'all closed trades',                         color: totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400' },
    { label: 'Avg Win',    value: `+$${avgWin.toFixed(0)}`,                                sub: `avg loss: -$${avgLoss.toFixed(0)}`,          color: 'text-emerald-400' },
  ];

  const periods = [
    { label: 'This Month',   value: mPnl, sub: 'current month' },
    { label: 'Last Quarter', value: qPnl, sub: 'last 3 months' },
    { label: 'Last 12 Mo',   value: yPnl, sub: 'rolling annual' },
  ];

  return (
    <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div className={`${th.sidebar} border ${th.border} rounded-2xl w-full max-w-5xl max-h-[90vh] flex flex-col`}>

        {/* Header */}
        <div className={`flex items-center justify-between px-6 py-4 border-b ${th.border} shrink-0`}>
          <div>
            <h2 className={`text-sm font-bold ${th.text} tracking-wider`}>PERFORMANCE</h2>
            <p className={`text-[10px] ${th.textFaint}`}>{closed.length} closed trades · estimated P&L from audit log</p>
          </div>
          <button onClick={onClose} className={`${th.textFaint} hover:text-white text-lg leading-none`}>✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {closed.length === 0 ? (
            <div className={`text-center py-16 ${th.textFaint}`}>
              <p className="text-3xl mb-3">📊</p>
              <p className="text-sm">No closed trades in audit log yet.</p>
              <p className="text-[11px] mt-1 opacity-60">Trades appear here after you submit Take Profit, Cut Losses, or Close/Roll orders.</p>
            </div>
          ) : (
            <>
              {/* KPI strip */}
              <div className="grid grid-cols-4 gap-3">
                {kpis.map(k => (
                  <div key={k.label} className={`${th.card} border ${th.border} rounded-xl p-4`}>
                    <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-1`}>{k.label}</p>
                    <p className={`text-xl font-bold ${k.color}`} style={{ fontFamily: "'DM Mono', monospace" }}>{k.value}</p>
                    <p className={`text-[9px] ${th.textFaint} mt-0.5`}>{k.sub}</p>
                  </div>
                ))}
              </div>

              {/* Period P&L */}
              <div className="grid grid-cols-3 gap-3">
                {periods.map(p => (
                  <div key={p.label} className={`${th.card} border ${th.border} rounded-xl p-4`}>
                    <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-1`}>{p.label}</p>
                    <p className={`text-xl font-bold ${p.value >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                      {p.value >= 0 ? '+' : ''}${p.value.toFixed(0)}
                    </p>
                    <p className={`text-[9px] ${th.textFaint} mt-0.5`}>{p.sub}</p>
                  </div>
                ))}
              </div>

              {/* Monthly bar chart */}
              {months.length > 0 && (
                <div className={`${th.card} border ${th.border} rounded-xl p-4`}>
                  <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-4`}>Monthly P&L</p>
                  <div className="flex items-end gap-2" style={{ height: '120px' }}>
                    {months.slice(-12).map(m => {
                      const d = byMonth[m];
                      const pct = Math.abs(d.pnl) / maxBarPnl;
                      const h = Math.max(pct * 90, 4);
                      return (
                        <div key={m} className="flex-1 flex flex-col items-center justify-end gap-1" style={{ height: '120px' }}>
                          <p className={`text-[8px] ${th.textFaint} text-center`}>{d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(0)}</p>
                          <div
                            className={`w-full rounded-t transition-all ${d.pnl >= 0 ? 'bg-emerald-500/60 hover:bg-emerald-500/80' : 'bg-red-500/60 hover:bg-red-500/80'}`}
                            style={{ height: `${h}px` }}
                            title={`${m}: ${d.trades} trades, ${d.wins} wins`}
                          />
                          <p className={`text-[8px] ${th.textFaint} text-center`}>{m.slice(5)}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* By Symbol */}
              {symbolRows.length > 0 && (
                <div className={`${th.card} border ${th.border} rounded-xl p-4`}>
                  <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-3`}>By Symbol</p>
                  <div className="space-y-2">
                    {symbolRows.map(([sym, d]) => (
                      <div key={sym} className="flex items-center gap-3">
                        <span className={`text-[10px] font-bold ${th.text} w-16 shrink-0`}>{sym}</span>
                        <span className={`text-[9px] ${th.textFaint} w-16 shrink-0`}>{d.trades} trade{d.trades !== 1 ? 's' : ''}</span>
                        <span className={`text-[9px] w-14 shrink-0 ${d.wins / d.trades >= 0.7 ? 'text-emerald-400' : d.wins / d.trades >= 0.5 ? 'text-yellow-400' : 'text-red-400'}`}>
                          {(d.wins / d.trades * 100).toFixed(0)}% win
                        </span>
                        <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${d.pnl >= 0 ? 'bg-emerald-500' : 'bg-red-500'}`}
                            style={{ width: `${Math.min(Math.abs(d.pnl) / maxSymbolPnl * 100, 100)}%` }}
                          />
                        </div>
                        <span className={`text-[10px] font-bold w-16 text-right shrink-0 ${d.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                          {d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(0)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Trade log */}
              <div className={`${th.card} border ${th.border} rounded-xl p-4`}>
                <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-3`}>Trade History</p>
                <div className="space-y-0 max-h-64 overflow-y-auto">
                  {[...closed].reverse().map(e => (
                    <div key={e.id} className={`flex items-center gap-3 py-2 border-b ${th.borderLight} last:border-0`}>
                      <span className={`text-[9px] ${th.textFaint} w-20 shrink-0`}>{e.timestamp.slice(0, 10)}</span>
                      <span className={`text-[10px] font-bold ${th.text} w-14 shrink-0`}>{e.symbol}</span>
                      <span className={`text-[9px] ${th.textFaint} w-10 shrink-0`}>{e.strategy}</span>
                      <span className={`text-[9px] w-24 shrink-0 ${
                        e.action === 'TAKE_PROFIT' ? 'text-emerald-400' :
                        e.action === 'CUT_LOSSES'  ? 'text-red-400'     : 'text-blue-400'
                      }`}>{e.action.replace(/_/g, ' ')}</span>
                      <span className={`text-[10px] font-bold ml-auto ${(e.estPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`} style={{ fontFamily: "'DM Mono', monospace" }}>
                        {(e.estPnl ?? 0) >= 0 ? '+' : ''}${(e.estPnl ?? 0).toFixed(0)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <p className={`text-[9px] ${th.textFaint} text-center pb-2`}>
                ⚠ P&L figures are estimates from order submission. Actual fills may differ. Reconcile with TastyTrade for accurate accounting.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PortfolioPage() {
  const [theme, setTheme] = useState<Theme>(getSavedTheme);
  const th = THEMES[theme];
  const [accent, setAccent] = useState<Accent>(getSavedAccent);
  useEffect(() => { applyAccent(accent); }, [accent]);
  useEffect(() => { injectAccentStyle(); applyAccent(getSavedAccent()); }, []);

  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [batchItems, setBatchItems] = useState<{ pos: Position; action: ActionType }[] | null>(null);
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [showPerformance, setShowPerformance] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [dryRunMode, setDryRunMode] = useState<boolean>(isDryRun);
  const [portfolioAnalysis, setPortfolioAnalysis] = useState<PortfolioAnalysis | null>(null);
  const [portfolioAnalysisLoading, setPortfolioAnalysisLoading] = useState(false);
  const [futures, setFutures] = useState<FuturesData | null>(null);

  // Trigger weekly behavior summarization silently on load
  useEffect(() => { summarizeBehaviorProfile().catch(() => {}); }, []);

  // Fetch ES futures on load and refresh every 5 minutes
  useEffect(() => {
    const load = () => fetchFuturesData().then(f => { if (f) setFutures(f); }).catch(() => {});
    load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const handleAnalyzePortfolio = async () => {
    if (positions.length === 0) return;
    setPortfolioAnalysisLoading(true);
    try {
const result = await analyzePortfolio(positions, futures ?? undefined);
      setPortfolioAnalysis(result);
    } catch (e: any) {
      setPortfolioAnalysis({ loading: false, error: e.message, netDelta: null, dominantRisk: '', sectorConcentration: [], thetaYield: '', topRisks: [], priorityActions: [], marketContext: '', summary: '', generatedAt: new Date().toISOString() });
    } finally {
      setPortfolioAnalysisLoading(false);
    }
  };

  const marketStatus = getMarketStatus();

  const fetchPositions = async () => {
    setLoading(true); setError(''); setChecked(new Set());
    try {
      const data = await loadPositions();
      setPositions(data);
      setLastRefresh(new Date());
    } catch (e: any) {
      if (e.message === 'Not authenticated' || e.message === 'Session expired') { window.location.href = '/login'; return; }
      setError(e.message);
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchPositions(); }, []);

  const handleProfitTargetChange = (key: string, value: number) => {
    try {
      const targets = JSON.parse(localStorage.getItem(LS_PROFIT_TARGETS) ?? '{}');
      targets[key] = value; localStorage.setItem(LS_PROFIT_TARGETS, JSON.stringify(targets));
    } catch {}
    setPositions(prev => prev.map(p => {
      if (p.key !== key) return p;
      return { ...p, profitTarget: value, targetPrice: p.creditReceived * value, hitTarget: p.pnl != null && p.pnl >= p.creditReceived * value };
    }));
  };

  const onToggle = (key: string) => setChecked(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const onToggleAll = (keys: string[], select: boolean) => setChecked(prev => { const n = new Set(prev); keys.forEach(k => select ? n.add(k) : n.delete(k)); return n; });
  const onClear = () => setChecked(new Set());

  const openBatch = (items: { pos: Position; action: ActionType }[]) => { if (items.length > 0) setBatchItems(items); };
  const onGroupAction = (pos: Position[], action: ActionType) => openBatch(pos.map(p => ({ pos: p, action })));
  const onBulkExecute = (items: { pos: Position; action: ActionType }[]) => { openBatch(items); onClear(); };

  const needsClose = positions.filter(p => p.needsClose);
  const hitTarget  = positions.filter(p => p.hitTarget && !p.needsClose);
  const noGtc      = positions.filter(p => !p.hasGtc && !p.needsClose && !p.hitTarget);
  const normal     = positions.filter(p => !p.needsClose && !p.hitTarget && p.hasGtc);

  return (
    <div className={`min-h-screen ${th.bg} pb-24 transition-colors duration-200`} style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>

      {/* Header */}
      <div className={`${th.header} border-b ${th.border} px-6 py-4 flex items-center justify-between sticky top-0 z-50`}>
        <div className="flex items-center gap-6">
          <div>
            <h1 className="text-base font-bold tracking-widest text-white" style={{ fontFamily: "'DM Mono', monospace" }}>OPTIONS HUNTER</h1>
            <p className="text-[10px] text-white/50 mt-0.5 tracking-wider" style={{ fontFamily: "'DM Mono', monospace" }}>PORTFOLIO MANAGEMENT</p>
          </div>
          <nav className="flex items-center gap-1 bg-black/20 rounded-lg p-1">
            <Link href="/"              className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">HUNTER</Link>
            <span                       className="text-xs px-3 py-1.5 rounded text-white tracking-wider active-nav" style={{ backgroundColor: `rgba(var(--accent-r),var(--accent-g),var(--accent-b),0.25)`, borderBottom: `2px solid var(--accent)` }}>PORTFOLIO</span>
            <Link href="/engine" className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">ENGINE</Link>
            <Link href="/rinse-repeat"  className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">RINSE & REPEAT</Link>
            <Link href="/trade-log"     className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">TRADE LOG</Link>
            <Link href="/performance"   className="text-xs px-3 py-1.5 rounded text-white/50 hover:text-white/80 transition-colors tracking-wider">PERFORMANCE</Link>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-[10px] font-bold ${marketStatus.open ? 'text-emerald-400' : 'text-yellow-400'}`}>{marketStatus.label}</span>
          {futures && (
            <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[10px] font-bold ${
              futures.bias === 'bullish' ? 'border-emerald-700 text-emerald-400 bg-emerald-500/8' :
              futures.bias === 'bearish' ? 'border-red-700 text-red-400 bg-red-500/8' :
              'border-slate-700 text-slate-400'
            }`}>
              <span>{futures.bias === 'bullish' ? '▲' : futures.bias === 'bearish' ? '▼' : '◆'}</span>
              <span style={{ fontFamily: "'DM Mono', monospace" }}>{futures.label}</span>
            </div>
          )}
          {lastRefresh && <span className="text-[10px] text-white/30">Updated {lastRefresh.toLocaleTimeString()}</span>}
          {/* Dry Run toggle — always visible */}
          <button
            onClick={() => { const next = !dryRunMode; setDryRunMode(next); setDryRun(next); }}
            className={`text-[10px] px-3 py-1.5 border rounded font-bold transition-colors tracking-wider ${
              dryRunMode
                ? 'border-amber-500 text-amber-300 bg-amber-500/15'
                : 'border-white/10 text-white/30 hover:border-amber-700 hover:text-amber-500'
            }`}>
            ⚗ {dryRunMode ? 'Dry Run ON' : 'Dry Run'}
          </button>
          <button onClick={() => setShowAuditLog(true)}
            className="text-[10px] px-3 py-1.5 border border-white/20 text-white/60 rounded hover:border-white/40 hover:text-white/80 transition-colors tracking-wider">
            📋 Audit Log
          </button>
          <button onClick={() => setShowMemory(true)}
            className="text-[10px] px-3 py-1.5 border border-purple-800 text-purple-400 rounded hover:border-purple-600 hover:text-purple-300 transition-colors tracking-wider">
            ◆ Memory
          </button>
          {positions.length > 0 && (
            <button onClick={handleAnalyzePortfolio} disabled={portfolioAnalysisLoading}
              className="text-[10px] px-3 py-1.5 border border-indigo-700 text-indigo-400 rounded hover:border-indigo-500 hover:text-indigo-300 transition-colors tracking-wider disabled:opacity-50 font-bold">
              {portfolioAnalysisLoading ? '◈ Analyzing...' : '◈ Analyze Portfolio'}
            </button>
          )}
          <a href="https://my.tastytrade.com" target="_blank" rel="noopener noreferrer"
            className="text-[10px] px-3 py-1.5 border border-white/20 text-white/60 rounded hover:border-white/40 hover:text-white/80 transition-colors tracking-wider">
            TastyTrade ↗
          </a>
          <button onClick={fetchPositions} disabled={loading}
            className="text-[10px] px-3 py-1.5 border border-white/20 text-white/60 rounded hover:border-white/40 hover:text-white/80 transition-colors tracking-wider disabled:opacity-40">
            {loading ? 'LOADING...' : '↻ REFRESH'}
          </button>
          <button onClick={() => { sessionStorage.removeItem('tt_access_token'); window.location.href = '/login'; }}
            className="text-[10px] px-3 py-1.5 border border-white/10 text-white/30 rounded hover:border-white/30 hover:text-white/60 transition-colors tracking-wider">
            SIGN OUT
          </button>
          <ThemeToggle theme={theme} setTheme={setTheme} accent={accent} setAccent={setAccent} />
        </div>
      </div>

      {/* Dry run mode banner — persistent, hard to miss */}
      {dryRunMode && (
        <div className="bg-amber-500/15 border-b border-amber-500/40 px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-amber-400 text-lg font-bold">⚗</span>
            <div>
              <p className="text-amber-300 text-xs font-bold tracking-wider">DRY RUN MODE IS ACTIVE</p>
              <p className="text-amber-500 text-[10px]">All order actions will be simulated — nothing will be sent to TastyTrade</p>
            </div>
          </div>
          <button
            onClick={() => { setDryRunMode(false); setDryRun(false); }}
            className="text-[10px] px-3 py-1.5 border border-amber-600 text-amber-400 rounded hover:bg-amber-500/20 transition-colors font-bold">
            Turn Off Dry Run
          </button>
        </div>
      )}

      {error && <div className="mx-6 mt-4 p-4 bg-red-500/10 border border-red-500 rounded-lg text-red-400 text-sm">{error}</div>}

      {loading && positions.length === 0 && (
        <div className="flex items-center justify-center h-64">
          <div className={`text-sm ${th.textFaint} tracking-widest`}>FETCHING POSITIONS...</div>
        </div>
      )}

      {!loading && !error && positions.length === 0 && (
        <div className="flex flex-col items-center justify-center h-64 gap-2">
          <p className={`text-sm ${th.textFaint} tracking-widest`}>NO OPEN POSITIONS FOUND</p>
          <p className={`text-xs ${th.textFaint}`}>Options positions from your TastyTrade account will appear here</p>
        </div>
      )}

      {positions.length > 0 && (
        <>
          {/* <SummaryBar positions={positions} th={th} /> */}
          <div className="overflow-x-auto">
            <div className="p-6 space-y-8" style={{ minWidth: '1600px' }}>

              {needsClose.length > 0 && (
                <PositionSection
                  title="⚠ Close Now — 21 DTE or Less" titleColor="text-red-400"
                  positions={needsClose} th={th} checked={checked}
                  onToggle={onToggle} onToggleAll={onToggleAll}
                  onProfitTargetChange={handleProfitTargetChange}
                  groupAction="CLOSE_ROLL" onGroupAction={onGroupAction}
                  onExecute={(pos, action) => openBatch([{ pos, action }])}
                />
              )}

              {hitTarget.length > 0 && (
                <PositionSection
                  title="✓ Profit Target Hit" titleColor="text-emerald-400"
                  positions={hitTarget} th={th} checked={checked}
                  onToggle={onToggle} onToggleAll={onToggleAll}
                  onProfitTargetChange={handleProfitTargetChange}
                  groupAction="TAKE_PROFIT" onGroupAction={onGroupAction}
                  onExecute={(pos, action) => openBatch([{ pos, action }])}
                />
              )}

              {noGtc.length > 0 && (
                <PositionSection
                  title="⏱ Missing GTC Order" titleColor="text-blue-400"
                  positions={noGtc} th={th} checked={checked}
                  onToggle={onToggle} onToggleAll={onToggleAll}
                  onProfitTargetChange={handleProfitTargetChange}
                  groupAction="PLACE_GTC" onGroupAction={onGroupAction}
                  onExecute={(pos, action) => openBatch([{ pos, action }])}
                />
              )}

              {normal.length > 0 && (
                <PositionSection
                  title="Active Positions" titleColor={th.textFaint}
                  positions={normal} th={th} checked={checked}
                  onToggle={onToggle} onToggleAll={onToggleAll}
                  onProfitTargetChange={handleProfitTargetChange}
                  groupAction="HOLD" onGroupAction={onGroupAction}
                  onExecute={(pos, action) => openBatch([{ pos, action }])}
                />
              )}
            </div>
          </div>
        </>
      )}

      <BulkActionBar
        selectedKeys={checked} positions={positions}
        onExecute={onBulkExecute} onClear={onClear} th={th}
      />

      {batchItems && (
        <BatchConfirmModal
          items={batchItems}
          dryRun={dryRunMode}
          onClose={() => setBatchItems(null)}
          onSuccess={fetchPositions}
          th={th}
        />
      )}

      {showAuditLog && <AuditLogPanel onClose={() => setShowAuditLog(false)} th={th} />}
      {showPerformance && <PerformancePanel onClose={() => setShowPerformance(false)} th={th} />}
      {showMemory && <MemoryPanel onClose={() => setShowMemory(false)} th={th} />}

      {portfolioAnalysis && !portfolioAnalysis.error && (
        <PortfolioAnalysisPanel analysis={portfolioAnalysis} positions={positions} onClose={() => setPortfolioAnalysis(null)} th={th} />
      )}      {portfolioAnalysis?.error && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-red-900/80 border border-red-500 rounded-lg px-4 py-3 text-xs text-red-300 flex items-center gap-3">
          Portfolio analysis failed: {portfolioAnalysis.error}
          <button onClick={() => setPortfolioAnalysis(null)} className="text-red-400 hover:text-red-200">✕</button>
        </div>
      )}
    </div>
  );
}
