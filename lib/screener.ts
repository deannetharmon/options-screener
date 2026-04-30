import { OptionChainItem, MarketMetrics } from './tastytrade';

export const RULES = {
  IVR_MIN: 30,
  IVR_IC_MAX: 70,
  OI_MIN: 500,
  BID_ASK_MAX: 0.10,
  CREDIT_RATIO_MIN: 1 / 3,
  // BPS/BCS
  SPREAD_DELTA_MIN: 0.20,
  SPREAD_DELTA_MAX: 0.30,
  // IC
  IC_DELTA_MIN: 0.16,
  IC_DELTA_MAX: 0.20,
  DTE_MIN: 30,
  DTE_MAX: 45,
  SPREAD_WIDTH: 5,
  ROC_MIN_SPREAD: 20,
  ROC_MIN_IC: 30,
};

export type Strategy = 'BPS' | 'BCS' | 'IC';
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
  roc: number;
  pop: number | null;
  // IC only
  shortCallStrike?: number;
  longCallStrike?: number;
  shortCallDelta?: number;
  shortCallOI?: number;
  longCallOI?: number;
  callCredit?: number;
  totalCredit?: number;
}

export interface ScreenResult {
  symbol: string;
  strategy: Strategy;
  price: number | null;
  ivr: number | null;
  qualified: boolean;
  bestCandidate: SpreadCandidate | null;
  failReasons: string[];
  checks: {
    ivr: CheckResult;
    earnings: CheckResult;
    oi: CheckResult;
    delta: CheckResult;
    credit: CheckResult;
    roc: CheckResult;
  };
}

function daysUntil(dateStr: string): number {
  const target = new Date(dateStr);
  const now = new Date();
  return Math.round((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function findBestSpread(
  chain: OptionChainItem[],
  strategy: 'BPS' | 'BCS',
  expDate: string
): SpreadCandidate | null {
  const optionType = strategy === 'BPS' ? 'P' : 'C';
  const legs = chain.filter(o => o.expirationDate === expDate && o.optionType === optionType);
  if (legs.length === 0) return null;

  const sorted = strategy === 'BPS'
    ? legs.sort((a, b) => b.strikePrice - a.strikePrice)
    : legs.sort((a, b) => a.strikePrice - b.strikePrice);

  for (const shortLeg of sorted) {
    const delta = shortLeg.delta;
    if (delta == null) continue;
    const absDelta = Math.abs(delta);
    if (absDelta < RULES.SPREAD_DELTA_MIN || absDelta > RULES.SPREAD_DELTA_MAX) continue;
    if (shortLeg.openInterest < RULES.OI_MIN) continue;
    if (shortLeg.ask - shortLeg.bid > RULES.BID_ASK_MAX) continue;

    const longStrike = strategy === 'BPS'
      ? shortLeg.strikePrice - RULES.SPREAD_WIDTH
      : shortLeg.strikePrice + RULES.SPREAD_WIDTH;

    const longLeg = legs.find(o => Math.abs(o.strikePrice - longStrike) < 0.01);
    if (!longLeg || longLeg.openInterest < RULES.OI_MIN) continue;
    if (longLeg.ask - longLeg.bid > RULES.BID_ASK_MAX) continue;

    const credit = parseFloat((shortLeg.mid - longLeg.mid).toFixed(2));
    if (credit <= 0) continue;

    const creditRatio = credit / RULES.SPREAD_WIDTH;
    if (creditRatio < RULES.CREDIT_RATIO_MIN) continue;

    const maxLoss = RULES.SPREAD_WIDTH - credit;
    const roc = maxLoss > 0 ? (credit / maxLoss) * 100 : 0;
    if (roc < RULES.ROC_MIN_SPREAD) continue;

    const dte = daysUntil(expDate);
    const pop = shortLeg.delta != null ? (1 - Math.abs(shortLeg.delta)) * 100 : null;

    return {
      strategy,
      expiration: expDate,
      dte,
      shortStrike: shortLeg.strikePrice,
      longStrike,
      shortDelta: absDelta,
      shortOI: shortLeg.openInterest,
      longOI: longLeg.openInterest,
      credit,
      spreadWidth: RULES.SPREAD_WIDTH,
      creditRatio,
      roc,
      pop,
    };
  }

  return null;
}

function findBestIC(
  chain: OptionChainItem[],
  expDate: string
): SpreadCandidate | null {
  const puts = chain.filter(o => o.expirationDate === expDate && o.optionType === 'P')
    .sort((a, b) => b.strikePrice - a.strikePrice);
  const calls = chain.filter(o => o.expirationDate === expDate && o.optionType === 'C')
    .sort((a, b) => a.strikePrice - b.strikePrice);

  for (const shortPut of puts) {
    const putDelta = shortPut.delta;
    if (putDelta == null) continue;
    const absPutDelta = Math.abs(putDelta);
    if (absPutDelta < RULES.IC_DELTA_MIN || absPutDelta > RULES.IC_DELTA_MAX) continue;
    if (shortPut.openInterest < RULES.OI_MIN) continue;
    if (shortPut.ask - shortPut.bid > RULES.BID_ASK_MAX) continue;

    const longPutStrike = shortPut.strikePrice - RULES.SPREAD_WIDTH;
    const longPut = puts.find(o => Math.abs(o.strikePrice - longPutStrike) < 0.01);
    if (!longPut || longPut.openInterest < RULES.OI_MIN) continue;
    if (longPut.ask - longPut.bid > RULES.BID_ASK_MAX) continue;

    const putCredit = parseFloat((shortPut.mid - longPut.mid).toFixed(2));
    if (putCredit <= 0) continue;
    if (putCredit / RULES.SPREAD_WIDTH < RULES.CREDIT_RATIO_MIN) continue;

    for (const shortCall of calls) {
      if (shortCall.strikePrice <= shortPut.strikePrice) continue;
      const callDelta = shortCall.delta;
      if (callDelta == null) continue;
      const absCallDelta = Math.abs(callDelta);
      if (absCallDelta < RULES.IC_DELTA_MIN || absCallDelta > RULES.IC_DELTA_MAX) continue;
      if (shortCall.openInterest < RULES.OI_MIN) continue;
      if (shortCall.ask - shortCall.bid > RULES.BID_ASK_MAX) continue;

      const longCallStrike = shortCall.strikePrice + RULES.SPREAD_WIDTH;
      const longCall = calls.find(o => Math.abs(o.strikePrice - longCallStrike) < 0.01);
      if (!longCall || longCall.openInterest < RULES.OI_MIN) continue;
      if (longCall.ask - longCall.bid > RULES.BID_ASK_MAX) continue;

      const callCredit = parseFloat((shortCall.mid - longCall.mid).toFixed(2));
      if (callCredit <= 0) continue;
      if (callCredit / RULES.SPREAD_WIDTH < RULES.CREDIT_RATIO_MIN) continue;

      const totalCredit = parseFloat((putCredit + callCredit).toFixed(2));
      const maxLoss = RULES.SPREAD_WIDTH - Math.max(putCredit, callCredit);
      const roc = maxLoss > 0 ? (totalCredit / maxLoss) * 100 : 0;
      if (roc < RULES.ROC_MIN_IC) continue;

      const dte = daysUntil(expDate);
      const pop = (1 - absPutDelta - absCallDelta) * 100;

      return {
        strategy: 'IC',
        expiration: expDate,
        dte,
        shortStrike: shortPut.strikePrice,
        longStrike: longPutStrike,
        shortDelta: absPutDelta,
        shortOI: shortPut.openInterest,
        longOI: longPut.openInterest,
        credit: putCredit,
        spreadWidth: RULES.SPREAD_WIDTH,
        creditRatio: putCredit / RULES.SPREAD_WIDTH,
        roc,
        pop,
        shortCallStrike: shortCall.strikePrice,
        longCallStrike,
        shortCallDelta: absCallDelta,
        shortCallOI: shortCall.openInterest,
        longCallOI: longCall.openInterest,
        callCredit,
        totalCredit,
      };
    }
  }

  return null;
}

export function runChecklist(
  symbol: string,
  strategy: Strategy,
  metrics: MarketMetrics,
  chainData: { expirations: string[]; chains: Record<string, OptionChainItem[]> },
  currentPrice: number | null = null
): ScreenResult {
  const failReasons: string[] = [];

  // IVR check
  const ivrValue = metrics.ivRank;
  let ivrCheck: CheckResult;
  if (ivrValue == null) {
    ivrCheck = { status: 'warn', value: 'N/A', reason: 'Not available' };
  } else if (ivrValue < RULES.IVR_MIN) {
    ivrCheck = { status: 'fail', value: `${ivrValue.toFixed(1)}%`, reason: `Below ${RULES.IVR_MIN}% minimum` };
    failReasons.push(`IVR ${ivrValue.toFixed(1)}% < 30%`);
  } else if (strategy === 'IC' && ivrValue > RULES.IVR_IC_MAX) {
    ivrCheck = { status: 'warn', value: `${ivrValue.toFixed(1)}%`, reason: 'Above 70% for IC — verify reason' };
  } else {
    ivrCheck = { status: 'pass', value: `${ivrValue.toFixed(1)}%`, reason: 'Above minimum' };
  }

  // Earnings check
  const earningsDate = metrics.earningsExpectedDate;
  let earningsCheck: CheckResult;
  if (!earningsDate) {
    earningsCheck = { status: 'pass', value: 'None found', reason: 'Safe to trade' };
  } else {
    const daysAway = daysUntil(earningsDate);
    if (daysAway < 0) {
      earningsCheck = { status: 'pass', value: `${earningsDate} (past)`, reason: 'Already reported' };
    } else if (daysAway <= RULES.DTE_MAX) {
      earningsCheck = { status: 'fail', value: `${daysAway}d (${earningsDate})`, reason: 'Within expiry window' };
      failReasons.push(`Earnings in ${daysAway} days`);
    } else {
      earningsCheck = { status: 'pass', value: `${daysAway}d (${earningsDate})`, reason: 'Outside expiry window' };
    }
  }

  // Valid expirations (DTE 30-45, no earnings inside)
  const validExpirations = chainData.expirations.filter(exp => {
    const dte = daysUntil(exp);
    if (dte < RULES.DTE_MIN || dte > RULES.DTE_MAX) return false;
    if (earningsDate) {
      const earningsDTE = daysUntil(earningsDate);
      if (earningsDTE >= 0 && earningsDTE <= dte) return false;
    }
    return true;
  });

  // Find best candidate
  let bestCandidate: SpreadCandidate | null = null;

  if (ivrCheck.status !== 'fail' && earningsCheck.status !== 'fail' && validExpirations.length > 0) {
    for (const exp of validExpirations) {
      const chainItems = chainData.chains[exp] || [];
      if (strategy === 'BPS' || strategy === 'BCS') {
        bestCandidate = findBestSpread(chainItems, strategy, exp);
      } else if (strategy === 'IC') {
        bestCandidate = findBestIC(chainItems, exp);
      }
      if (bestCandidate) break;
    }
  }

  // OI check
  let oiCheck: CheckResult;
  if (bestCandidate) {
    oiCheck = {
      status: 'pass',
      value: `${bestCandidate.shortOI}/${bestCandidate.longOI}`,
      reason: 'Both legs ≥ 500',
    };
  } else if (validExpirations.length === 0) {
    oiCheck = { status: 'fail', value: 'No valid DTE', reason: 'No expirations in 30–45 DTE window' };
    failReasons.push('No 30-45 DTE expirations');
  } else {
    oiCheck = { status: 'fail', value: 'None', reason: 'No strikes met all criteria' };
    if (!failReasons.some(r => r.includes('DTE'))) failReasons.push('No qualifying strikes found');
  }

  // Delta check
  const deltaCheck: CheckResult = bestCandidate
    ? { status: 'pass', value: bestCandidate.shortDelta.toFixed(2), reason: 'Within target range' }
    : { status: bestCandidate === null && oiCheck.status === 'fail' ? 'fail' : 'pending', value: '—', reason: 'No candidate' };

  // Credit check
  const creditCheck: CheckResult = bestCandidate
    ? {
        status: 'pass',
        value: `$${(bestCandidate.totalCredit ?? bestCandidate.credit).toFixed(2)}`,
        reason: `${(bestCandidate.creditRatio * 100).toFixed(0)}% of width`,
      }
    : { status: bestCandidate === null && oiCheck.status === 'fail' ? 'fail' : 'pending', value: '—', reason: 'No candidate' };

  // ROC check
  const rocCheck: CheckResult = bestCandidate
    ? {
        status: bestCandidate.roc >= (strategy === 'IC' ? RULES.ROC_MIN_IC : RULES.ROC_MIN_SPREAD) ? 'pass' : 'fail',
        value: `${bestCandidate.roc.toFixed(0)}%`,
        reason: `Min ${strategy === 'IC' ? RULES.ROC_MIN_IC : RULES.ROC_MIN_SPREAD}%`,
      }
    : { status: 'pending', value: '—', reason: 'No candidate' };

  const qualified =
    ivrCheck.status === 'pass' &&
    earningsCheck.status === 'pass' &&
    oiCheck.status === 'pass' &&
    deltaCheck.status === 'pass' &&
    creditCheck.status === 'pass' &&
    rocCheck.status === 'pass' &&
    bestCandidate !== null;

  return {
    symbol,
    strategy,
    price: currentPrice,
    ivr: ivrValue,
    qualified,
    bestCandidate,
    failReasons,
    checks: {
      ivr: ivrCheck,
      earnings: earningsCheck,
      oi: oiCheck,
      delta: deltaCheck,
      credit: creditCheck,
      roc: rocCheck,
    },
  };
}
