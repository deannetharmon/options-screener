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
