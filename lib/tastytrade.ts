const BASE_URL = 'https://api.tastytrade.com';

export interface TTSession {
  token: string;
  expiresAt: string;
}

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

// Authenticate with TastyTrade and return session token
export async function authenticate(username: string, password: string): Promise<TTSession> {
  const token = process.env.TASTYTRADE_SESSION_TOKEN;
  if (!token) {
    throw new Error('No session token configured');
  }
  return {
    token,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}
// Fetch IV Rank and earnings date for a list of symbols
export async function getMarketMetrics(symbols: string[], token: string): Promise<MarketMetrics[]> {
  const symbolList = symbols.join(',');
  const res = await fetch(`${BASE_URL}/market-metrics?symbols=${symbolList}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) throw new Error(`Failed to fetch market metrics: ${res.statusText}`);

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

// Fetch options chain for a symbol and expiration
export async function getOptionsChain(
  symbol: string,
  token: string
): Promise<{ expirations: string[]; chains: Record<string, OptionChainItem[]> }> {
  const res = await fetch(
    `${BASE_URL}/option-chains/${symbol}/nested`,
    { headers: { Authorization: `Bearer ${token}` }, }
  );

  if (!res.ok) throw new Error(`Failed to fetch chain for ${symbol}: ${res.statusText}`);

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
        items.push({
          symbol: leg.symbol,
          strikePrice: parseFloat(strike['strike-price']),
          expirationDate: expDate,
          optionType: type === 'call' ? 'C' : 'P',
          delta: leg.delta != null ? parseFloat(leg.delta) : null,
          openInterest: parseInt(leg['open-interest'] || '0', 10),
          bid: parseFloat(leg.bid || '0'),
          ask: parseFloat(leg.ask || '0'),
          mid: (parseFloat(leg.bid || '0') + parseFloat(leg.ask || '0')) / 2,
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
