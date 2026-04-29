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
export type Trend = 'uptrend' | 'downtrend' | 'sideways' | null;

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

function daysUntil(dateStr: string): number {
  const target = new Date(dateStr);
  const now = new Date();
  return Math.round((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function getDTE(expirationDate: string): number {
  return daysUntil(expirationDate);
}

function findBestSpread(
  chain: OptionChainItem[],
  strategy: 'BPS' | 'BCS',
  expDate: string
): SpreadCandidate | null {
  const optionType = strategy === 'BPS' ? 'P' : 'C';
  const legs = chain.filter((o) => o.expirationDate === expDate && o.optionType === optionType);
  if (legs.length === 0) return null;

  const sorted = strategy === 'BPS'
    ? legs.sort((a, b) => b.strikePrice - a.strikePrice)
    : legs.sort((a, b) => a.strikePrice - b.strikePrice);

  for (const shortLeg of sorted) {
    const delta = shortLeg.delta;
    if (delta == null) continue;
    const absDelta = Math.abs(delta);
    if (absDelta < RULES.DELTA_MIN || absDelta > RULES.DELTA_MAX) continue;
    if (shortLeg.openInterest < RULES.OI_MIN) continue;

    const longStrike = strategy === 'BPS'
      ? shortLeg.strikePrice - RULES.SPREAD_WIDTH
      : shortLeg.strikePrice + RULES.SPREAD_WIDTH;

    const longLeg = legs.find((o) => o.strikePrice === longStrike);
    if (!longLeg || longLeg.openInterest < RULES.OI_MIN) continue;

    const credit = shortLeg.mid - longLeg.mid;
    const creditRatio = credit / RULES.SPREAD_WIDTH;
    if (creditRatio < RULES.CREDIT_RATIO) continue;

    return {
      strategy,
      expiration: expDate,
      dte: getDTE(expDate),
      shortStrike: shortLeg.strikePrice,
      longStrike,
      shortDelta: absDelta,
      shortOI: shortLeg.openInterest,
      longOI: longLeg.openInterest,
      credit,
      spreadWidth: RULES.SPREAD_WIDTH,
      creditRatio,
      pop: null,
    };
  }
  return null;
}

export function runChecklist(...) { /* keep your full runChecklist function from before */ }
