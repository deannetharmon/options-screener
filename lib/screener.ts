// lib/screener.ts
import { OptionChainItem, MarketMetrics } from './tastytrade';

export const RULES = {
  IVR_MIN: 30,
  IVX_MIN: 35,
  OI_MIN: 500,
  CREDIT_RATIO: 1 / 3,
  DELTA_MIN: 0.15,
  DELTA_MAX: 0.22,
  DTE_MIN: 21,
  DTE_MAX: 45,
  EARNINGS_BUFFER_DAYS: 21,
  SPREAD_WIDTH: 5,
};

export type Strategy = 'BPS' | 'BCS' | 'IC' | 'UNKNOWN';
export type Trend = 'uptrend' | 'downtrend' | 'sideways' | null;   // ← Added this

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'pending';

export interface CheckResult {
  status: CheckStatus;
  value: string;
  reason: string;
}

export interface SpreadCandidate {
  strategy: Strategy;
  expiration: string;
  dte: number;
  shortStrike: number;
  longStrike: number;
  shortDelta: number;
  shortOI: number;
  longOI: number;
  credit: number;
  spreadWidth: number;
  creditRatio: number;
  pop: number | null;
}

export interface ScreenResult {
  symbol: string;
  price: number | null;
  checks: {
    ivr: CheckResult;
    ivx: CheckResult;
    earnings: CheckResult;
    oi: CheckResult;
    delta: CheckResult;
    credit: CheckResult;
  };
  qualified: boolean;
  bestCandidate: SpreadCandidate | null;
  failReasons: string[];
  strategy: Strategy;
}

// ... (keep the rest of the file exactly as I gave you last time - daysUntil, getDTE, findBestSpread, runChecklist)
