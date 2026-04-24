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

// Find the best spread candidate for a given strategy and expiration
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

  // Sort by strike — ascending for puts, descending for calls
  const sorted =
    strategy === 'BPS'
      ? legs.sort((a, b) => b.strikePrice - a.strikePrice) // highest put first
      : legs.sort((a, b) => a.strikePrice - b.strikePrice); // lowest call first

  const spreadWidth = 5; // $5 wide spreads as default

  for (const shortLeg of sorted) {
    const delta = shortLeg.delta;
    if (delta == null) continue;

    const absDelta = Math.abs(delta);
    if (absDelta < RULES.DELTA_MIN || absDelta > RULES.DELTA_MAX) continue;
    if (shortLeg.openInterest < RULES.OI_MIN) continue;

    // Find protection leg
    const longStrike =
      strategy === 'BPS'
        ? shortLeg.strikePrice - spreadWidth
        : shortLeg.strikePrice + spreadWidth;

    const longLeg = legs.find((o) => o.strikePrice === longStrike);
    if (!longLeg) continue;
    if (longLeg.openInterest < RULES.OI_MIN) continue;

    // Credit = short bid - long ask (worst case) or mid - mid
    const credit = shortLeg.mid - longLeg.mid;
    const creditRatio = credit / spreadWidth;

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
      spreadWidth,
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

  // --- IVR Check ---
  const ivrValue = metrics.ivRank;
  const ivrCheck: CheckResult =
    ivrValue == null
      ? { status: 'warn', value: 'N/A', reason: 'IV Rank not available' }
      : ivrValue >= RULES.IVR_MIN
      ? { status: 'pass', value: `${ivrValue.toFixed(1)}%`, reason: 'Above 30% minimum' }
      : { status: 'fail', value: `${ivrValue.toFixed(1)}%`, reason: `Below ${RULES.IVR_MIN}% minimum` };

  if (ivrCheck.status === 'fail') failReasons.push(`IVR ${ivrCheck.value} < ${RULES.IVR_MIN}%`);

  // --- IVx Check ---
  const ivxValue = metrics.impliedVolatility;
  const ivxCheck: CheckResult =
    ivxValue == null
      ? { status: 'warn', value: 'N/A', reason: 'IVx not available' }
      : ivxValue >= RULES.IVX_MIN
      ? { status: 'pass', value: `${ivxValue.toFixed(1)}%`, reason: 'Sufficient premium' }
      : { status: 'fail', value: `${ivxValue.toFixed(1)}%`, reason: `Below ${RULES.IVX_MIN}% — credits will be thin` };

  if (ivxCheck.status === 'fail') failReasons.push(`IVx ${ivxCheck.value} < ${RULES.IVX_MIN}%`);

  // --- Earnings Check ---
  const earningsDate = metrics.earningsExpectedDate;
  let earningsCheck: CheckResult;
  if (!earningsDate) {
    earningsCheck = { status: 'pass', value: 'None found', reason: 'No upcoming earnings detected' };
  } else {
    const daysAway = daysUntil(earningsDate);
    if (daysAway < 0) {
      earningsCheck = { status: 'pass', value: `${earningsDate} (past)`, reason: 'Already reported' };
    } else if (daysAway <= RULES.EARNINGS_BUFFER_DAYS) {
      earningsCheck = {
        status: 'fail',
        value: `${earningsDate} (${daysAway}d)`,
        reason: `Earnings in ${daysAway} days — too close`,
      };
      failReasons.push(`Earnings in ${daysAway} days`);
    } else {
      earningsCheck = {
        status: 'pass',
        value: `${earningsDate} (${daysAway}d)`,
        reason: 'Safe — earnings after expiry window',
      };
    }
  }

  // --- Strategy from chart trend ---
  let strategy: Strategy = 'UNKNOWN';
  if (chartTrend === 'uptrend') strategy = 'BPS';
  else if (chartTrend === 'downtrend') strategy = 'BCS';
  else if (chartTrend === 'sideways') strategy = 'IC';

  // --- Find best expiry and spread ---
  const validExpirations = chainData.expirations.filter((exp) => {
    const dte = getDTE(exp);
    if (dte < RULES.DTE_MIN || dte > RULES.DTE_MAX) return false;
    // Check earnings don't fall within this expiry window
    if (earningsDate) {
      const earningsDTE = daysUntil(earningsDate);
      if (earningsDTE >= 0 && earningsDTE <= dte) return false;
    }
    return true;
  });

  let bestCandidate: SpreadCandidate | null = null;
  let oiCheck: CheckResult = { status: 'pending', value: '—', reason: 'Awaiting chain check' };
  let deltaCheck: CheckResult = { status: 'pending', value: '—', reason: 'Awaiting chain check' };
  let creditCheck: CheckResult = { status: 'pending', value: '—', reason: 'Awaiting chain check' };

  if (strategy !== 'UNKNOWN' && validExpirations.length > 0) {
    for (const exp of validExpirations) {
      const allLegs = chainData.chains[exp] || [];
      const candidate = findBestSpread(allLegs, strategy as 'BPS' | 'BCS', exp);
      if (candidate) {
        bestCandidate = candidate;
        break;
      }
    }

    if (bestCandidate) {
      oiCheck = {
        status: 'pass',
        value: `${bestCandidate.shortOI} / ${bestCandidate.longOI}`,
        reason: `Both legs ≥ ${RULES.OI_MIN}`,
      };
      deltaCheck = {
        status: 'pass',
        value: `${bestCandidate.shortDelta.toFixed(2)}`,
        reason: `Within ${RULES.DELTA_MIN}–${RULES.DELTA_MAX} range`,
      };
      creditCheck = {
        status: 'pass',
        value: `$${bestCandidate.credit.toFixed(2)} / $${bestCandidate.spreadWidth} wide`,
        reason: `${(bestCandidate.creditRatio * 100).toFixed(0)}% of spread width ≥ 33%`,
      };
    } else {
      // Figure out which check failed by examining the chain
      const allLegs = validExpirations.flatMap((exp) => chainData.chains[exp] || []);
      const optionType = strategy === 'BPS' ? 'P' : 'C';
      const targetLegs = allLegs.filter((o) => o.optionType === optionType);

      const hasTargetDelta = targetLegs.some((o) => {
        const abs = Math.abs(o.delta || 0);
        return abs >= RULES.DELTA_MIN && abs <= RULES.DELTA_MAX;
      });

      const hasOI = targetLegs.some((o) => {
        const abs = Math.abs(o.delta || 0);
        return abs >= RULES.DELTA_MIN && abs <= RULES.DELTA_MAX && o.openInterest >= RULES.OI_MIN;
      });

      if (!hasTargetDelta) {
        deltaCheck = { status: 'fail', value: 'None found', reason: 'No strikes at target delta' };
        oiCheck = { status: 'pending', value: '—', reason: 'Delta failed first' };
        creditCheck = { status: 'pending', value: '—', reason: 'Delta failed first' };
        failReasons.push('No strikes at target delta range');
      } else if (!hasOI) {
        oiCheck = {
          status: 'fail',
          value: `< ${RULES.OI_MIN}`,
          reason: `OI below ${RULES.OI_MIN} at target strikes`,
        };
        deltaCheck = { status: 'pass', value: 'Found', reason: 'Target delta strikes exist' };
        creditCheck = { status: 'pending', value: '—', reason: 'OI failed first' };
        failReasons.push(`OI < ${RULES.OI_MIN} at target strikes`);
      } else {
        creditCheck = {
          status: 'fail',
          value: `< $${(RULES.CREDIT_RATIO * 5).toFixed(2)}`,
          reason: `Credit below ⅓ of spread width`,
        };
        deltaCheck = { status: 'pass', value: 'Found', reason: 'Target delta strikes exist' };
        oiCheck = { status: 'pass', value: `≥ ${RULES.OI_MIN}`, reason: 'Adequate OI found' };
        failReasons.push('Credit < ⅓ of spread width');
      }
    }
  } else if (strategy === 'UNKNOWN') {
    oiCheck = { status: 'pending', value: '—', reason: 'Chart trend needed' };
    deltaCheck = { status: 'pending', value: '—', reason: 'Chart trend needed' };
    creditCheck = { status: 'pending', value: '—', reason: 'Chart trend needed' };
  } else {
    oiCheck = { status: 'fail', value: 'None', reason: 'No valid expirations in 21-45 DTE window' };
    failReasons.push('No valid expirations');
  }

  const qualified =
    ivrCheck.status === 'pass' &&
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
