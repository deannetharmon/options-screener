// lib/portfolio/positionLifecycle.ts

export type OptionType = 'P' | 'C';
export type LegDirection = 'Short' | 'Long';

export interface LifecycleLeg {
  symbol: string;
  optionType: OptionType;
  strikePrice: number;
  direction: LegDirection;
  quantity: number;
  avgOpenPrice?: number;
  currentPrice?: number | null;
}

export interface LifecycleStockPosition {
  symbol: string;
  quantity: number;
  averageOpenPrice?: number | null;
  currentPrice?: number | null;
}

export type PositionLifecycleType =
  | 'SPREAD'
  | 'CSP'
  | 'ASSIGNED_STOCK'
  | 'COVERED_CALL'
  | 'PMCC'
  | 'UNKNOWN';

export interface LifecycleClassificationInput {
  symbol: string;
  legs?: LifecycleLeg[];
  stockPosition?: LifecycleStockPosition | null;
}

export interface LifecycleClassification {
  type: PositionLifecycleType;
  symbol: string;
  contracts: number;
  shares: number;
  shortPuts: LifecycleLeg[];
  longPuts: LifecycleLeg[];
  shortCalls: LifecycleLeg[];
  longCalls: LifecycleLeg[];
  reason: string;
}

function absQty(qty: number | null | undefined): number {
  return Math.abs(Number(qty ?? 0));
}

function totalContracts(legs: LifecycleLeg[]): number {
  if (!legs.length) return 0;
  return legs.reduce((max, leg) => Math.max(max, absQty(leg.quantity)), 0);
}

export function splitOptionLegs(legs: LifecycleLeg[] = []) {
  const shortPuts = legs.filter(
    leg => leg.optionType === 'P' && leg.direction === 'Short'
  );

  const longPuts = legs.filter(
    leg => leg.optionType === 'P' && leg.direction === 'Long'
  );

  const shortCalls = legs.filter(
    leg => leg.optionType === 'C' && leg.direction === 'Short'
  );

  const longCalls = legs.filter(
    leg => leg.optionType === 'C' && leg.direction === 'Long'
  );

  return { shortPuts, longPuts, shortCalls, longCalls };
}

export function isSpreadPosition(legs: LifecycleLeg[] = []): boolean {
  const { shortPuts, longPuts, shortCalls, longCalls } = splitOptionLegs(legs);

  const putSpread = shortPuts.length > 0 && longPuts.length > 0;
  const callSpread = shortCalls.length > 0 && longCalls.length > 0;

  return putSpread || callSpread;
}

export function isCashSecuredPut(legs: LifecycleLeg[] = []): boolean {
  const { shortPuts, longPuts, shortCalls, longCalls } = splitOptionLegs(legs);

  return (
    shortPuts.length === 1 &&
    longPuts.length === 0 &&
    shortCalls.length === 0 &&
    longCalls.length === 0
  );
}

export function isAssignedStock(
  stockPosition: LifecycleStockPosition | null | undefined,
  legs: LifecycleLeg[] = []
): boolean {
  return Boolean(stockPosition && absQty(stockPosition.quantity) > 0 && legs.length === 0);
}

export function isCoveredCall(
  stockPosition: LifecycleStockPosition | null | undefined,
  legs: LifecycleLeg[] = []
): boolean {
  const { shortPuts, longPuts, shortCalls, longCalls } = splitOptionLegs(legs);
  const shares = absQty(stockPosition?.quantity);

  return (
    shares >= 100 &&
    shortCalls.length > 0 &&
    shortPuts.length === 0 &&
    longPuts.length === 0 &&
    longCalls.length === 0
  );
}

export function classifyPositionLifecycle(
  input: LifecycleClassificationInput
): LifecycleClassification {
  const legs = input.legs ?? [];
  const stockPosition = input.stockPosition ?? null;
  const shares = absQty(stockPosition?.quantity);

  const { shortPuts, longPuts, shortCalls, longCalls } = splitOptionLegs(legs);
  const contracts = totalContracts(legs);

  if (isCoveredCall(stockPosition, legs)) {
    return {
      type: 'COVERED_CALL',
      symbol: input.symbol,
      contracts,
      shares,
      shortPuts,
      longPuts,
      shortCalls,
      longCalls,
      reason: 'Stock shares plus one or more short calls.',
    };
  }

  if (isAssignedStock(stockPosition, legs)) {
    return {
      type: 'ASSIGNED_STOCK',
      symbol: input.symbol,
      contracts: 0,
      shares,
      shortPuts,
      longPuts,
      shortCalls,
      longCalls,
      reason: 'Stock shares with no option legs.',
    };
  }

  if (isCashSecuredPut(legs)) {
    return {
      type: 'CSP',
      symbol: input.symbol,
      contracts,
      shares,
      shortPuts,
      longPuts,
      shortCalls,
      longCalls,
      reason: 'Single short put with no long hedge.',
    };
  }

  if (isSpreadPosition(legs)) {
    return {
      type: 'SPREAD',
      symbol: input.symbol,
      contracts,
      shares,
      shortPuts,
      longPuts,
      shortCalls,
      longCalls,
      reason: 'Defined-risk spread detected from long and short option legs.',
    };
  }

  return {
    type: 'UNKNOWN',
    symbol: input.symbol,
    contracts,
    shares,
    shortPuts,
    longPuts,
    shortCalls,
    longCalls,
    reason: 'No lifecycle classification matched.',
  };
}

// CSP math

export function calcCspEffectiveBuyPrice(
  strike: number,
  premiumPerShare: number
): number {
  return strike - premiumPerShare;
}

export function calcCspCashRequired(
  strike: number,
  contracts: number
): number {
  return strike * 100 * contracts;
}

export function calcCspOptionPnl(
  entryPremiumPerShare: number,
  currentOptionValuePerShare: number,
  contracts: number
): number {
  return (entryPremiumPerShare - currentOptionValuePerShare) * 100 * contracts;
}

// Stock / covered-call math

export function calcCoveredShares(
  sharesHeld: number,
  callContracts: number
): number {
  return Math.min(absQty(sharesHeld), absQty(callContracts) * 100);
}

export function calcUncoveredShares(
  sharesHeld: number,
  callContracts: number
): number {
  return Math.max(0, absQty(sharesHeld) - absQty(callContracts) * 100);
}

export function calcUnrealizedStockPnl(
  currentPrice: number,
  effectiveCostBasis: number,
  sharesHeld: number
): number {
  return (currentPrice - effectiveCostBasis) * sharesHeld;
}

export function calcCalledAwayProfit(
  callStrike: number,
  effectiveCostBasis: number,
  coveredShares: number,
  realizedPremiumPnl: number
): number {
  return (callStrike - effectiveCostBasis) * coveredShares + realizedPremiumPnl;
}
