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
  SPREAD_WIDTH: 5,      // $5 wide spreads
};

export type Strategy = 'BPS' | 'BCS' | 'IC' | 'UNKNOWN';
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
  const legs = chain.filter(
    (o) => o.expirationDate === expDate && o.optionType === optionType
  );

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

export function runChecklist(
  symbol: string,
  metrics: MarketMetrics,
  chainData: { expirations: string[]; chains: Record<string, OptionChainItem[]> },
  chartTrend: 'uptrend' | 'downtrend' | 'sideways' | null = null,
  currentPrice: number | null = null
): ScreenResult {
  const failReasons: string[] = [];

  // IVR
  const ivrValue = metrics.ivRank;
  const ivrCheck: CheckResult = ivrValue == null
    ? { status: 'warn', value: 'N/A', reason: 'IV Rank not available' }
    : ivrValue >= RULES.IVR_MIN
    ? { status: 'pass', value: `${ivrValue.toFixed(1)}%`, reason: 'Above minimum' }
    : { status: 'fail', value: `${ivrValue.toFixed(1)}%`, reason: `Below ${RULES.IVR_MIN}%` };
  if (ivrCheck.status === 'fail') failReasons.push(`IVR ${ivrCheck.value}`);

  // IVx
  const ivxValue = metrics.impliedVolatility;
  const ivxCheck: CheckResult = ivxValue == null
    ? { status: 'warn', value: 'N/A', reason: 'IVx not available' }
    : ivxValue >= RULES.IVX_MIN
    ? { status: 'pass', value: `${ivxValue.toFixed(1)}%`, reason: 'Sufficient premium' }
    : { status: 'fail', value: `${ivxValue.toFixed(1)}%`, reason: `Below ${RULES.IVX_MIN}%` };
  if (ivxCheck.status === 'fail') failReasons.push(`IVx ${ivxCheck.value}`);

  // Earnings
  const earningsDate = metrics.earningsExpectedDate;
  let earningsCheck: CheckResult;
  if (!earningsDate) {
    earningsCheck = { status: 'pass', value: 'None found', reason: 'Safe' };
  } else {
    const daysAway = daysUntil(earningsDate);
    if (daysAway < 0) {
      earningsCheck = { status: 'pass', value: `${daysAway}d (past)`, reason: 'Already reported' };
    } else if (daysAway <= RULES.EARNINGS_BUFFER_DAYS) {
      earningsCheck = { status: 'fail', value: `${daysAway}d`, reason: 'Too close' };
      failReasons.push(`Earnings in ${daysAway} days`);
    } else {
      earningsCheck = { status: 'pass', value: `${daysAway}d`, reason: 'Safe' };
    }
  }

  let strategy: Strategy = 'UNKNOWN';
  if (chartTrend === 'uptrend') strategy = 'BPS';
  else if (chartTrend === 'downtrend') strategy = 'BCS';

  const validExpirations = chainData.expirations.filter((exp) => {
    const dte = getDTE(exp);
    if (dte < RULES.DTE_MIN || dte > RULES.DTE_MAX) return false;
    if (earningsDate) {
      const earningsDTE = daysUntil(earningsDate);
      if (earningsDTE >= 0 && earningsDTE <= dte) return false;
    }
    return true;
  });

  let bestCandidate: SpreadCandidate | null = null;
  let oiCheck: CheckResult = { status: 'pending', value: '—', reason: 'Awaiting chain' };
  let deltaCheck: CheckResult = { status: 'pending', value: '—', reason: 'Awaiting chain' };
  let creditCheck: CheckResult = { status: 'pending', value: '—', reason: 'Awaiting chain' };

  if (strategy !== 'UNKNOWN' && validExpirations.length > 0) {
    for (const exp of validExpirations) {
      const candidate = findBestSpread(chainData.chains[exp] || [], strategy as 'BPS' | 'BCS', exp);
      if (candidate) {
        bestCandidate = candidate;
        break;
      }
    }

    if (bestCandidate) {
      oiCheck = { status: 'pass', value: `${bestCandidate.shortOI}/${bestCandidate.longOI}`, reason: 'OK' };
      deltaCheck = { status: 'pass', value: `${bestCandidate.shortDelta.toFixed(2)}`, reason: 'In range' };
      creditCheck = { status: 'pass', value: `$${bestCandidate.credit.toFixed(2)}`, reason: `${(bestCandidate.creditRatio * 100).toFixed(0)}% of width` };
    } else {
      // fallback failure reasons...
      deltaCheck = { status: 'fail', value: 'None', reason: 'No delta match' };
      failReasons.push('No suitable delta/OI/credit');
    }
  }

  const qualified = ivrCheck.status === 'pass' &&
    ivxCheck.status === 'pass' &&
    earningsCheck.status === 'pass' &&
    oiCheck.status === 'pass' &&
    deltaCheck.status === 'pass' &&
    creditCheck.status === 'pass' &&
    bestCandidate !== null;

  return {
    symbol,
    price: currentPrice,
    checks: { ivr: ivrCheck, ivx: ivxCheck, earnings: earningsCheck, oi: oiCheck, delta: deltaCheck, credit: creditCheck },
    qualified,
    bestCandidate,
    failReasons,
    strategy,
  };
}
