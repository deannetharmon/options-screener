// lib/screener.ts
import { OptionChainItem, MarketMetrics } from './tastytrade';

export const RULES = {
  IVR_MIN: 30,
  IVX_MIN: 35,
  OI_MIN: 500,
  CREDIT_RATIO: 1 / 3,
  DELTA_MIN: 0.15,
  DELTA_MAX: 0.30,
  DTE_MIN: 21,
  DTE_MAX: 45,
  EARNINGS_BUFFER: 21,
  BID_ASK_MAX: 0.10,
  MIN_PRICE: 50,
  MIN_VOLUME: 2000000,     // Your new 2M minimum
  MIN_ROC: 25,
  MIN_POP: 65,
};

export type Strategy = 'BPS' | 'BCS' | 'IC' | 'UNKNOWN';
export type Trend = 'uptrend' | 'downtrend' | 'sideways' | null;

export interface CheckResult {
  status: 'pass' | 'fail' | 'warn' | 'pending';
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
  pop: number;
}

export interface ScreenResult {
  symbol: string;
  price: number | null;
  checks: {
    ivr: CheckResult;
    ivx: CheckResult;
    earnings: CheckResult;
    volume: CheckResult;
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
  const legs = chain.filter(o => o.expirationDate === expDate && o.optionType === optionType);

  const sorted = strategy === 'BPS'
    ? legs.sort((a, b) => b.strikePrice - a.strikePrice)
    : legs.sort((a, b) => a.strikePrice - b.strikePrice);

  const spreadWidth = 5;

  for (const shortLeg of sorted) {
    const delta = shortLeg.delta;
    if (delta == null) continue;
    const absDelta = Math.abs(delta);
    if (absDelta < RULES.DELTA_MIN || absDelta > RULES.DELTA_MAX) continue;
    if (shortLeg.openInterest < RULES.OI_MIN) continue;

    const longStrike = strategy === 'BPS'
      ? shortLeg.strikePrice - spreadWidth
      : shortLeg.strikePrice + spreadWidth;

    const longLeg = legs.find(o => o.strikePrice === longStrike);
    if (!longLeg || longLeg.openInterest < RULES.OI_MIN) continue;

    const credit = shortLeg.mid - longLeg.mid;
    const creditRatio = credit / spreadWidth;
    if (creditRatio < RULES.CREDIT_RATIO) continue;

    const roc = (credit / (spreadWidth - credit)) * 100;

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
      roc,
      pop: Math.round(100 - absDelta * 100),
    };
  }
  return null;
}

export function runChecklist(
  symbol: string,
  metrics: MarketMetrics,
  chainData: { expirations: string[]; chains: Record<string, OptionChainItem[]> },
  chartTrend: Trend,
  currentPrice: number | null,
  avgVolume: number = 0
): ScreenResult {
  const failReasons: string[] = [];

  // IVR
  const ivrCheck: CheckResult = metrics.ivRank && metrics.ivRank >= RULES.IVR_MIN
    ? { status: 'pass', value: `${metrics.ivRank.toFixed(1)}%`, reason: 'OK' }
    : { status: 'fail', value: metrics.ivRank ? `${metrics.ivRank.toFixed(1)}%` : 'N/A', reason: 'Below minimum' };

  // IVx
  const ivxCheck: CheckResult = metrics.impliedVolatility && metrics.impliedVolatility >= RULES.IVX_MIN
    ? { status: 'pass', value: `${metrics.impliedVolatility.toFixed(1)}%`, reason: 'OK' }
    : { status: 'fail', value: metrics.impliedVolatility ? `${metrics.impliedVolatility.toFixed(1)}%` : 'N/A', reason: 'Below minimum' };

  // Earnings
  let earningsCheck: CheckResult;
  if (!metrics.earningsExpectedDate) {
    earningsCheck = { status: 'pass', value: 'None', reason: 'Clear' };
  } else {
    const days = daysUntil(metrics.earningsExpectedDate);
    earningsCheck = days > RULES.EARNINGS_BUFFER
      ? { status: 'pass', value: `${days}d away`, reason: 'Safe' }
      : { status: 'fail', value: `${days}d away`, reason: 'Too close' };
  }

  // Volume
  const volumeCheck: CheckResult = avgVolume >= RULES.MIN_VOLUME
    ? { status: 'pass', value: `${(avgVolume/1000000).toFixed(1)}M`, reason: 'Liquid' }
    : { status: 'fail', value: `${(avgVolume/1000000).toFixed(1)}M`, reason: 'Below 2M' };

  // Strategy
  let strategy: Strategy = 'UNKNOWN';
  if (chartTrend === 'uptrend') strategy = 'BPS';
  else if (chartTrend === 'downtrend') strategy = 'BCS';
  else if (chartTrend === 'sideways') strategy = 'IC';

  let bestCandidate: SpreadCandidate | null = null;
  let oiCheck: CheckResult = { status: 'pending', value: '—', reason: 'Waiting' };
  let deltaCheck: CheckResult = { status: 'pending', value: '—', reason: 'Waiting' };
  let creditCheck: CheckResult = { status: 'pending', value: '—', reason: 'Waiting' };

  if (strategy !== 'UNKNOWN') {
    const validExps = chainData.expirations.filter(exp => {
      const dte = getDTE(exp);
      return dte >= RULES.DTE_MIN && dte <= RULES.DTE_MAX;
    });

    for (const exp of validExps) {
      const candidate = findBestSpread(chainData.chains[exp] || [], strategy as 'BPS' | 'BCS', exp);
      if (candidate) {
        bestCandidate = candidate;
        break;
      }
    }

    if (bestCandidate) {
      oiCheck = { status: 'pass', value: 'OK', reason: '≥500 both legs' };
      deltaCheck = { status: 'pass', value: bestCandidate.shortDelta.toFixed(2), reason: 'In range' };
      creditCheck = { status: 'pass', value: `$${bestCandidate.credit.toFixed(2)}`, reason: `${(bestCandidate.creditRatio*100).toFixed(0)}% of width` };
    } else {
      oiCheck = { status: 'fail', value: 'No', reason: 'No valid spread' };
    }
  }

  const qualified = ivrCheck.status === 'pass' &&
                    ivxCheck.status === 'pass' &&
                    earningsCheck.status === 'pass' &&
                    volumeCheck.status === 'pass' &&
                    oiCheck.status === 'pass' &&
                    deltaCheck.status === 'pass' &&
                    creditCheck.status === 'pass' &&
                    bestCandidate !== null;

  return {
    symbol,
    price: currentPrice,
    checks: { ivr: ivrCheck, ivx: ivxCheck, earnings: earningsCheck, volume: volumeCheck, oi: oiCheck, delta: deltaCheck, credit: creditCheck },
    qualified,
    bestCandidate,
    failReasons,
    strategy,
  };
}
