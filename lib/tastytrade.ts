// lib/tastytrade.ts
const BASE_URL = 'https://api.tastytrade.com';
const SANDBOX_URL = 'https://api.cert.tastyworks.com';

export interface OptionChainItem {
  symbol: string;
  strikePrice: number;
  expirationDate: string;
  optionType: 'C' | 'P';
  delta: number | null;
  openInterest: number;
  bid: number;
  ask: number;
  mid: number;
  impliedVolatility: number | null;
}

export interface MarketMetrics {
  symbol: string;
  ivRank: number | null;
  impliedVolatility: number | null;
  earningsExpectedDate: string | null;
}

export interface Quote {
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
}

// This tells the code whether we are using real money or fake money (sandbox)
export interface TastytradeConfig {
  isSandbox: boolean;
}

function getBaseUrl(isSandbox: boolean): string {
  return isSandbox ? SANDBOX_URL : BASE_URL;
}

function authHeader(token: string) {
  return { Authorization: token };
}

// ====================== EXISTING FUNCTIONS (unchanged) ======================
export async function getMarketMetrics(symbols: string[], token: string): Promise<MarketMetrics[]> {
  const symbolList = symbols.join(',');
  const res = await fetch(`${BASE_URL}/market-metrics?symbols=${encodeURIComponent(symbolList)}`, {
    headers: authHeader(token),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Market metrics failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const items = data.data?.items || [];

  return items.map((item: any) => ({
    symbol: item.symbol,
    ivRank: item['iv-rank'] != null ? parseFloat(item['iv-rank']) * 100 : null,
    impliedVolatility: item['implied-volatility-index'] != null
      ? parseFloat(item['implied-volatility-index']) * 100
      : null,
    earningsExpectedDate: item['earnings']?.['expected-report-date'] || null,
  }));
}

export async function getOptionsChain(
  symbol: string,
  token: string
): Promise<{ expirations: string[]; chains: Record<string, OptionChainItem[]> }> {
  const res = await fetch(`${BASE_URL}/option-chains/${symbol}/nested`, {
    headers: authHeader(token),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Option chain failed for ${symbol} (${res.status}): ${text}`);
  }

  const data = await res.json();
  const expirations: string[] = [];
  const chains: Record<string, OptionChainItem[]> = {};

  const expirationGroups = data.data?.items?.[0]?.expirations || [];

  for (const exp of expirationGroups) {
    const expDate: string = exp['expiration-date'];
    expirations.push(expDate);
    const items: OptionChainItem[] = [];

    for (const strike of exp.strikes || []) {
      for (const type of ['call', 'put'] as const) {
        const leg = strike[type];
        if (!leg) continue;

        const bid = parseFloat(leg.bid || '0');
        const ask = parseFloat(leg.ask || '0');

        items.push({
          symbol: leg.symbol,
          strikePrice: parseFloat(strike['strike-price']),
          expirationDate: expDate,
          optionType: type === 'call' ? 'C' : 'P',
          delta: leg.delta != null ? parseFloat(leg.delta) : null,
          openInterest: parseInt(leg['open-interest'] || '0', 10),
          bid,
          ask,
          mid: (bid + ask) / 2,
          impliedVolatility: leg['implied-volatility'] != null
            ? parseFloat(leg['implied-volatility']) * 100
            : null,
        });
      }
    }

    chains[expDate] = items;
  }

  return { expirations, chains };
}

export async function getQuote(symbol: string, token: string): Promise<Quote> {
  const res = await fetch(`${BASE_URL}/market-data/quotes?symbols=${symbol}`, {
    headers: authHeader(token),
  });

  if (!res.ok) return { symbol, last: null, bid: null, ask: null };

  const data = await res.json();
  const item = data.data?.items?.[0];
  if (!item) return { symbol, last: null, bid: null, ask: null };

  return {
    symbol,
    last: item.last != null ? parseFloat(item.last) : null,
    bid: item.bid != null ? parseFloat(item.bid) : null,
    ask: item.ask != null ? parseFloat(item.ask) : null,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.TASTYTRADE_CLIENT_ID!,
      client_secret: process.env.TASTYTRADE_CLIENT_SECRET!,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

// ====================== NEW TRADING FUNCTIONS (this is what we added) ======================

/** Get your account number(s) */
export async function getCustomerAccounts(token: string, isSandbox = false) {
  const base = getBaseUrl(isSandbox);
  const res = await fetch(`${base}/customers/me/accounts`, {
    headers: authHeader(token),
  });

  if (!res.ok) throw new Error(`Failed to get accounts: ${res.status}`);
  const data = await res.json();
  return data.data?.items || [];
}

/** Place an order (or dry-run to test safely) */
export async function placeOrder(
  accountNumber: string,
  orderPayload: any,
  token: string,
  isSandbox = false,
  dryRun = true
) {
  const base = getBaseUrl(isSandbox);
  let url = `${base}/accounts/${accountNumber}/orders`;

  if (dryRun) {
    url += '/dry-run';   // This is safe — it only checks, doesn't trade
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeader(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(orderPayload),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Order failed (${res.status}): ${errorText}`);
  }

  return await res.json();
}
