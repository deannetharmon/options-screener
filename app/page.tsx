'use client';
import { useState } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────
interface CheckResult {
  status: 'pass' | 'fail' | 'warn' | 'pending';
  value: string;
  reason: string;
}
interface SpreadCandidate {
  strategy: string;
  expiration: string;
  dte: number;
  shortStrike: number;
  longStrike: number;
  shortDelta: number;
  credit: number;
  spreadWidth: number;
  creditRatio: number;
  roc: number;
  pop: number | null;
  shortOI: number;
  longOI: number;
  // IC specific
  shortCallStrike?: number;
  longCallStrike?: number;
  callCredit?: number;
  callWidth?: number;
  totalCredit?: number;
  optimized?: boolean;
}
interface ScreenResult {
  symbol: string;
  strategy: string;
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

// ── Rules ──────────────────────────────────────────────────────────────────
const DEFAULT_RULES = {
  IVR_MIN: 30,
  IVR_IC_MAX: 70,
  OI_MIN: 0,
  BID_ASK_MAX: 0.10,
  CREDIT_RATIO_MIN: 0.15,
  SPREAD_DELTA_MIN: 0.20,
  SPREAD_DELTA_MAX: 0.30,
  IC_DELTA_MIN: 0.16,
  IC_DELTA_MAX: 0.20,
  DTE_MIN: 30,
  DTE_MAX: 45,
  MAX_SPREAD_WIDTH: 50,
  ROC_MIN_SPREAD: 15,
  ROC_MIN_IC: 30,
};
type RulesType = typeof DEFAULT_RULES;

const RULE_LABELS: Record<string, string> = {
  IVR_MIN: 'IVR Min %',
  IVR_IC_MAX: 'IVR IC Max %',
  OI_MIN: 'Min Open Interest',
  BID_ASK_MAX: 'Max Bid-Ask $',
  CREDIT_RATIO_MIN: 'Min Credit Ratio',
  SPREAD_DELTA_MIN: 'Spread Delta Min',
  SPREAD_DELTA_MAX: 'Spread Delta Max',
  IC_DELTA_MIN: 'IC Delta Min',
  IC_DELTA_MAX: 'IC Delta Max',
  DTE_MIN: 'DTE Min',
  DTE_MAX: 'DTE Max',
  MAX_SPREAD_WIDTH: 'Max Spread Width $',
  ROC_MIN_SPREAD: 'Min ROC Spread %',
  ROC_MIN_IC: 'Min ROC IC %',
};

function daysUntil(dateStr: string): number {
  const target = new Date(dateStr);
  const now = new Date();
  return Math.round((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

// ── Width steps ────────────────────────────────────────────────────────────
function getWidthSteps(maxWidth: number): number[] {
  const steps: number[] = [];
  for (let w = 5; w <= maxWidth; w += 5) steps.push(w);
  return steps;
}

function getBidAskMax(price: number | null): number {
  if (price == null) return 1.50;
  if (price >= 500) return 3.00;
  if (price >= 200) return 1.50;
  if (price >= 100) return 0.50;
  return 0.10;
}

// ── TastyTrade API ─────────────────────────────────────────────────────────
const BASE = 'https://api.tastytrade.com';

async function ttFetch(path: string, token: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function getAccessToken(): Promise<string> {
  const refreshToken = process.env.NEXT_PUBLIC_TASTYTRADE_REFRESH_TOKEN;
  const clientSecret = process.env.NEXT_PUBLIC_TASTYTRADE_CLIENT_SECRET;
  const clientId = process.env.NEXT_PUBLIC_TASTYTRADE_CLIENT_ID;
  if (!refreshToken || !clientSecret || !clientId) {
    throw new Error('TastyTrade credentials not configured (NEXT_PUBLIC_ vars missing)');
  }
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken.trim(),
      client_id: clientId.trim(),
      client_secret: clientSecret.trim(),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function getMarketMetrics(symbols: string[], token: string) {
  const data = await ttFetch(`/market-metrics?symbols=${symbols.join(',')}`, token);
  return (data.data?.items || []).map((item: any) => ({
    symbol: item.symbol,
    ivRank: item['implied-volatility-index-rank'] != null
      ? parseFloat(item['implied-volatility-index-rank']) * 100
      : null,
    earningsExpectedDate: item['earnings']?.['expected-report-date'] || null,
  }));
}

async function getQuote(symbol: string, token: string): Promise<number | null> {
  try {
    const data = await ttFetch(`/market-data/by-type?equity=${encodeURIComponent(symbol)}`, token);
    const item = data.data?.items?.[0];
    if (!item) return null;
    const last = item.last != null ? parseFloat(item.last) : null;
    const bid = item.bid != null ? parseFloat(item.bid) : null;
    const ask = item.ask != null ? parseFloat(item.ask) : null;
    return last ?? (bid && ask ? (bid + ask) / 2 : null);
  } catch {
    return null;
  }
}

async function getChain(symbol: string, token: string, RULES: RulesType) {
  const nested = await ttFetch(`/option-chains/${symbol}/nested`, token);
  const expirations: string[] = [];
  const chains: Record<string, any[]> = {};
  const expirationGroups = nested?.data?.items?.[0]?.expirations ?? [];
  const allOCCSymbols: string[] = [];
  const symbolMeta: Record<string, { expDate: string; strike: number; optionType: string }> = {};

  for (const expGroup of expirationGroups) {
    const expDate: string = expGroup['expiration-date'];
    if (!expDate) continue;
    const dte = daysUntil(expDate);
    if (dte < RULES.DTE_MIN - 5 || dte > RULES.DTE_MAX + 5) continue;
    for (const strike of expGroup.strikes ?? []) {
      const strikePrice = parseFloat(strike['strike-price'] ?? '0');
      const callSym: string = strike['call'];
      const putSym: string = strike['put'];
      if (callSym) {
        allOCCSymbols.push(callSym);
        symbolMeta[callSym] = { expDate, strike: strikePrice, optionType: 'C' };
      }
      if (putSym) {
        allOCCSymbols.push(putSym);
        symbolMeta[putSym] = { expDate, strike: strikePrice, optionType: 'P' };
      }
    }
  }

  if (allOCCSymbols.length === 0) return { expirations, chains };

  const chunkSize = 100;
  for (let i = 0; i < allOCCSymbols.length; i += chunkSize) {
    const chunk = allOCCSymbols.slice(i, i + chunkSize);
    const qs = chunk.map(s => `equity-option=${encodeURIComponent(s)}`).join('&');
    let greeksData: any;
    try {
      greeksData = await ttFetch(`/market-data/by-type?${qs}`, token);
    } catch (e) {
      console.warn('Greeks fetch failed for chunk', i, e);
      continue;
    }
    const items = greeksData?.data?.items ?? [];
    for (const item of items) {
      const occSym: string = item.symbol;
      const meta = symbolMeta[occSym];
      if (!meta) continue;
      const bid = parseFloat(item.bid ?? '0');
      const ask = parseFloat(item.ask ?? '0');
      const delta = item.delta != null ? parseFloat(item.delta) : null;
      const oi = parseInt(item['open-interest'] ?? '0', 10);
      if (!expirations.includes(meta.expDate)) expirations.push(meta.expDate);
      if (!chains[meta.expDate]) chains[meta.expDate] = [];
      chains[meta.expDate].push({
        strikePrice: meta.strike,
        expirationDate: meta.expDate,
        optionType: meta.optionType,
        delta, openInterest: oi, bid, ask,
        mid: (bid + ask) / 2,
      });
    }
  }

  expirations.sort();
  console.log('CHAIN DEBUG:', symbol, 'expirations:', expirations, 'total options:', Object.values(chains).flat().length);
  console.log('CHAIN PER EXP:', Object.fromEntries(Object.entries(chains).map(([k, v]) => [k, v.length])));
  return { expirations, chains };
}

// ── Screener Logic ─────────────────────────────────────────────────────────

function trySpreadAtWidth(
  legs: any[],
  strategy: 'BPS' | 'BCS',
  expDate: string,
  width: number,
  price: number | null,
  RULES: RulesType
): SpreadCandidate | null {
  const bidAskMax = getBidAskMax(price);
  const sorted = strategy === 'BPS'
    ? [...legs].sort((a, b) => b.strikePrice - a.strikePrice)
    : [...legs].sort((a, b) => a.strikePrice - b.strikePrice);

  for (const shortLeg of sorted) {
    const delta = shortLeg.delta;
    if (delta == null) continue;
    const absDelta = Math.abs(delta);
    if (absDelta < RULES.SPREAD_DELTA_MIN || absDelta > RULES.SPREAD_DELTA_MAX) continue;
    if (shortLeg.openInterest < RULES.OI_MIN) continue;
    if (shortLeg.ask - shortLeg.bid > bidAskMax) continue;

    const longStrike = strategy === 'BPS'
      ? shortLeg.strikePrice - width
      : shortLeg.strikePrice + width;
    const longLeg = legs.find((o: any) => Math.abs(o.strikePrice - longStrike) < 0.01);
    if (!longLeg || longLeg.openInterest < RULES.OI_MIN) continue;
    if (longLeg.ask - longLeg.bid > bidAskMax) continue;

    const credit = parseFloat((shortLeg.mid - longLeg.mid).toFixed(2));
    if (credit <= 0) continue;
    const creditRatio = credit / width;
    if (creditRatio < RULES.CREDIT_RATIO_MIN) continue;
    const maxLoss = width - credit;
    const roc = maxLoss > 0 ? (credit / maxLoss) * 100 : 0;
    if (roc < RULES.ROC_MIN_SPREAD) continue;

    return {
      strategy, expiration: expDate, dte: daysUntil(expDate),
      shortStrike: shortLeg.strikePrice, longStrike,
      shortDelta: absDelta, shortOI: shortLeg.openInterest, longOI: longLeg.openInterest,
      credit, spreadWidth: width, creditRatio, roc,
      pop: (1 - absDelta) * 100,
      optimized: true,
    };
  }
  return null;
}

function findBestSpread(
  chain: any[],
  strategy: 'BPS' | 'BCS',
  expDate: string,
  price: number | null,
  RULES: RulesType
): SpreadCandidate | null {
  const optionType = strategy === 'BPS' ? 'P' : 'C';
  const legs = chain.filter(o => o.expirationDate === expDate && o.optionType === optionType);
  const widthSteps = getWidthSteps(RULES.MAX_SPREAD_WIDTH);

  console.log(`${strategy} ${expDate} optimizing across widths:`, widthSteps, 'legs available:', legs.length);

  let best: SpreadCandidate | null = null;
  for (const width of widthSteps) {
    const candidate = trySpreadAtWidth(legs, strategy, expDate, width, price, RULES);
    if (candidate && (best === null || candidate.roc > best.roc)) {
      best = candidate;
    }
  }

  if (best) {
    console.log(`${strategy} ${expDate} best: width=$${best.spreadWidth} roc=${best.roc.toFixed(1)}% strike=${best.shortStrike}/${best.longStrike}`);
  } else {
    console.log(`${strategy} ${expDate} no qualifying candidate found across all widths`);
  }

  return best;
}

function tryICSideAtWidth(
  legs: any[],
  side: 'put' | 'call',
  width: number,
  price: number | null,
  RULES: RulesType,
  minCallStrike?: number
): { shortStrike: number; longStrike: number; shortDelta: number; credit: number; creditRatio: number; roc: number; shortOI: number; longOI: number } | null {
  const bidAskMax = getBidAskMax(price);
  const sorted = side === 'put'
    ? [...legs].sort((a, b) => b.strikePrice - a.strikePrice)
    : [...legs].sort((a, b) => a.strikePrice - b.strikePrice);

  for (const shortLeg of sorted) {
    if (side === 'call' && minCallStrike != null && shortLeg.strikePrice <= minCallStrike) continue;
    const delta = shortLeg.delta;
    if (delta == null) continue;
    const absDelta = Math.abs(delta);
    if (absDelta < RULES.IC_DELTA_MIN || absDelta > RULES.IC_DELTA_MAX) continue;
    if (shortLeg.openInterest < RULES.OI_MIN) continue;
    if (shortLeg.ask - shortLeg.bid > bidAskMax) continue;

    const longStrike = side === 'put'
      ? shortLeg.strikePrice - width
      : shortLeg.strikePrice + width;
    const longLeg = legs.find((o: any) => Math.abs(o.strikePrice - longStrike) < 0.01);
    if (!longLeg || longLeg.openInterest < RULES.OI_MIN) continue;
    if (longLeg.ask - longLeg.bid > bidAskMax) continue;

    const credit = parseFloat((shortLeg.mid - longLeg.mid).toFixed(2));
    if (credit <= 0) continue;
    const creditRatio = credit / width;
    if (creditRatio < RULES.CREDIT_RATIO_MIN) continue;
    const maxLoss = width - credit;
    const roc = maxLoss > 0 ? (credit / maxLoss) * 100 : 0;

    return { shortStrike: shortLeg.strikePrice, longStrike, shortDelta: absDelta, credit, creditRatio, roc, shortOI: shortLeg.openInterest, longOI: longLeg.openInterest };
  }
  return null;
}

function findBestIC(
  chain: any[],
  expDate: string,
  price: number | null,
  RULES: RulesType
): SpreadCandidate | null {
  const puts = chain.filter((o: any) => o.expirationDate === expDate && o.optionType === 'P');
  const calls = chain.filter((o: any) => o.expirationDate === expDate && o.optionType === 'C');
  const widthSteps = getWidthSteps(RULES.MAX_SPREAD_WIDTH);

  // Find best put side independently
  let bestPut: (ReturnType<typeof tryICSideAtWidth> & { width: number }) | null = null;
  for (const width of widthSteps) {
    const candidate = tryICSideAtWidth(puts, 'put', width, price, RULES);
    if (candidate && (bestPut === null || candidate.roc > bestPut.roc)) {
      bestPut = { ...candidate, width };
    }
  }
  if (!bestPut) { console.log(`IC ${expDate} no qualifying put side`); return null; }

  // Find best call side independently (must be above put short strike)
  let bestCall: (ReturnType<typeof tryICSideAtWidth> & { width: number }) | null = null;
  for (const width of widthSteps) {
    const candidate = tryICSideAtWidth(calls, 'call', width, price, RULES, bestPut.shortStrike);
    if (candidate && (bestCall === null || candidate.roc > bestCall.roc)) {
      bestCall = { ...candidate, width };
    }
  }
  if (!bestCall) { console.log(`IC ${expDate} no qualifying call side`); return null; }

  const totalCredit = parseFloat((bestPut.credit + bestCall.credit).toFixed(2));
  const maxLoss = Math.max(bestPut.width - bestPut.credit, bestCall.width - bestCall.credit);
  const roc = maxLoss > 0 ? (totalCredit / maxLoss) * 100 : 0;

  if (roc < RULES.ROC_MIN_IC) {
    console.log(`IC ${expDate} combined ROC ${roc.toFixed(1)}% below min ${RULES.ROC_MIN_IC}%`);
    return null;
  }

  console.log(`IC ${expDate} best: put ${bestPut.shortStrike}/${bestPut.longStrike} w=$${bestPut.width} · call ${bestCall.shortStrike}/${bestCall.longStrike} w=$${bestCall.width} ROC=${roc.toFixed(1)}%`);

  return {
    strategy: 'IC', expiration: expDate, dte: daysUntil(expDate),
    shortStrike: bestPut.shortStrike, longStrike: bestPut.longStrike,
    shortDelta: bestPut.shortDelta, shortOI: bestPut.shortOI, longOI: bestPut.longOI,
    credit: bestPut.credit, spreadWidth: bestPut.width,
    creditRatio: bestPut.creditRatio, roc,
    pop: (1 - bestPut.shortDelta - bestCall.shortDelta) * 100,
    shortCallStrike: bestCall.shortStrike, longCallStrike: bestCall.longStrike,
    callCredit: bestCall.credit, callWidth: bestCall.width,
    totalCredit,
    optimized: true,
  };
}

function runChecklist(
  symbol: string,
  strategy: 'BPS' | 'BCS' | 'IC',
  metrics: any,
  chainData: { expirations: string[]; chains: Record<string, any[]> },
  price: number | null,
  RULES: RulesType
): ScreenResult {
  const failReasons: string[] = [];
  const ivrValue = metrics.ivRank;
  const earningsDate = metrics.earningsExpectedDate;

  const ivrCheck: CheckResult = ivrValue == null
    ? { status: 'warn', value: 'N/A', reason: 'Not available' }
    : ivrValue < RULES.IVR_MIN
    ? (() => { failReasons.push(`IVR ${ivrValue.toFixed(1)}% < ${RULES.IVR_MIN}%`); return { status: 'fail' as const, value: `${ivrValue.toFixed(1)}%`, reason: `Below ${RULES.IVR_MIN}% minimum` }; })()
    : { status: 'pass', value: `${ivrValue.toFixed(1)}%`, reason: 'Above minimum' };

  let earningsCheck: CheckResult;
  if (!earningsDate) {
    earningsCheck = { status: 'pass', value: 'None found', reason: 'Safe to trade' };
  } else {
    const daysAway = daysUntil(earningsDate);
    if (daysAway < 0) {
      earningsCheck = { status: 'pass', value: `${earningsDate} (past)`, reason: 'Already reported' };
    } else if (daysAway < 30) {
      failReasons.push(`Earnings in ${daysAway}d`);
      earningsCheck = { status: 'fail', value: `${daysAway}d (${earningsDate})`, reason: 'Within expiry window' };
    } else {
      earningsCheck = { status: 'pass', value: `${daysAway}d (${earningsDate})`, reason: 'Outside expiry window' };
    }
  }

  const validExpirations = chainData.expirations.filter(exp => {
    const dte = daysUntil(exp);
    if (dte < RULES.DTE_MIN || dte > RULES.DTE_MAX) return false;
    if (earningsDate) {
      const ed = daysUntil(earningsDate);
      if (ed >= 0 && ed <= dte) return false;
    }
    return true;
  });

  console.log(`${symbol} validExpirations:`, validExpirations);

  let bestCandidate: SpreadCandidate | null = null;
  if (ivrCheck.status !== 'fail' && earningsCheck.status !== 'fail' && validExpirations.length > 0) {
    for (const exp of validExpirations) {
      const chainItems = chainData.chains[exp] || [];
      bestCandidate = strategy === 'IC'
        ? findBestIC(chainItems, exp, price, RULES)
        : findBestSpread(chainItems, strategy, exp, price, RULES);
      console.log(`${symbol} ${strategy} ${exp} result:`, bestCandidate
        ? `found: ${bestCandidate.shortStrike}/${bestCandidate.longStrike} w=$${bestCandidate.spreadWidth} roc=${bestCandidate.roc.toFixed(1)}%`
        : 'null');
      if (bestCandidate) break;
    }
  }

  if (!bestCandidate && validExpirations.length === 0 && !failReasons.some(r => r.includes('IVR') || r.includes('Earnings'))) {
    failReasons.push('No 30-45 DTE expirations');
  } else if (!bestCandidate && validExpirations.length > 0 && !failReasons.length) {
    failReasons.push('No qualifying strikes found');
  }

  const oiCheck: CheckResult = bestCandidate
    ? { status: 'pass', value: `${bestCandidate.shortOI}/${bestCandidate.longOI}`, reason: `Both legs ≥ ${RULES.OI_MIN}` }
    : { status: 'fail', value: 'None', reason: failReasons[failReasons.length - 1] || 'No candidate' };

  const deltaCheck: CheckResult = bestCandidate
    ? { status: 'pass', value: bestCandidate.shortDelta.toFixed(2), reason: 'Within target range' }
    : { status: 'pending', value: '—', reason: 'No candidate' };

  const creditCheck: CheckResult = bestCandidate
    ? { status: 'pass', value: `$${(bestCandidate.totalCredit ?? bestCandidate.credit).toFixed(2)}`, reason: `${(bestCandidate.creditRatio * 100).toFixed(0)}% of width` }
    : { status: 'pending', value: '—', reason: 'No candidate' };

  const rocMin = strategy === 'IC' ? RULES.ROC_MIN_IC : RULES.ROC_MIN_SPREAD;
  const rocCheck: CheckResult = bestCandidate
    ? { status: bestCandidate.roc >= rocMin ? 'pass' : 'fail', value: `${bestCandidate.roc.toFixed(0)}%`, reason: `Min ${rocMin}%` }
    : { status: 'pending', value: '—', reason: 'No candidate' };

  const qualified =
    ivrCheck.status === 'pass' &&
    earningsCheck.status === 'pass' &&
    oiCheck.status === 'pass' &&
    deltaCheck.status === 'pass' &&
    creditCheck.status === 'pass' &&
    rocCheck.status === 'pass' &&
    bestCandidate !== null;

  return { symbol, strategy, price, ivr: ivrValue, qualified, bestCandidate, failReasons, checks: { ivr: ivrCheck, earnings: earningsCheck, oi: oiCheck, delta: deltaCheck, credit: creditCheck, roc: rocCheck } };
}

// ── UI Components ──────────────────────────────────────────────────────────
const statusColor = (s: string) =>
  s === 'pass' ? 'text-emerald-400' : s === 'fail' ? 'text-red-400' : s === 'warn' ? 'text-yellow-400' : 'text-slate-400';
const statusIcon = (s: string) =>
  s === 'pass' ? '✓' : s === 'fail' ? '✗' : s === 'warn' ? '⚠' : '—';

function StrikesDisplay({ c }: { c: SpreadCandidate }) {
  const widthTag = (w: number) => (
    <span className="text-slate-400 mx-0.5">·${w}·</span>
  );
  if (c.strategy === 'IC' && c.shortCallStrike != null && c.longCallStrike != null) {
    return (
      <div className="text-xs shrink-0">
        <span className="text-slate-400">Strikes </span>
        <span className="text-white">{c.shortStrike}/{c.longStrike}</span>
        {widthTag(c.spreadWidth)}
        <span className="text-white">{c.shortCallStrike}/{c.longCallStrike}</span>
        {widthTag(c.callWidth ?? c.spreadWidth)}
      </div>
    );
  }
  return (
    <div className="text-xs shrink-0">
      <span className="text-slate-400">Strikes </span>
      <span className="text-white">{c.shortStrike}/{c.longStrike}</span>
      {widthTag(c.spreadWidth)}
    </div>
  );
}

function ResultCard({ result }: { result: ScreenResult }) {
  const [expanded, setExpanded] = useState(false);
  const c = result.bestCandidate;
  const stratBg = result.strategy === 'BPS'
    ? 'bg-emerald-900/30 border-emerald-800 text-emerald-400'
    : result.strategy === 'BCS'
    ? 'bg-red-900/30 border-red-800 text-red-400'
    : 'bg-blue-900/30 border-blue-800 text-blue-400';

  return (
    <div
      className={`border rounded-lg overflow-hidden cursor-pointer transition-all ${result.qualified ? 'border-slate-700 bg-slate-900/40' : 'border-slate-800 bg-slate-900/20 opacity-70'}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="px-4 py-3 flex items-center gap-4 flex-wrap">
        <div className="w-16 shrink-0">
          <p className="font-bold text-white">{result.symbol}</p>
          {result.price && <p className="text-[10px] text-slate-400">${result.price.toFixed(2)}</p>}
        </div>
        <span className={`text-[10px] px-2 py-0.5 border rounded shrink-0 ${stratBg}`}>{result.strategy}</span>
        <div className="text-xs text-slate-400 shrink-0">
          IVR <span className={result.ivr != null && result.ivr >= 30 ? 'text-emerald-400' : 'text-red-400'}>
            {result.ivr != null ? `${result.ivr.toFixed(1)}%` : 'N/A'}
          </span>
        </div>
        {c && <>
          <div className="text-xs shrink-0">
            <span className="text-slate-400">Exp </span>
            <span className="text-white">{c.expiration}</span>
            <span className="text-slate-400 ml-1">({c.dte}d)</span>
          </div>
          <StrikesDisplay c={c} />
          <div className="text-xs shrink-0">
            <span className="text-slate-400">Credit </span>
            <span className="text-emerald-400 font-bold">${(c.totalCredit ?? c.credit).toFixed(2)}</span>
          </div>
          <div className="text-xs shrink-0">
            <span className="text-slate-400">ROC </span>
            <span className="text-white">{c.roc.toFixed(0)}%</span>
          </div>
          {c.pop != null && (
            <div className="text-xs shrink-0">
              <span className="text-slate-400">POP </span>
              <span className="text-white">{c.pop.toFixed(0)}%</span>
            </div>
          )}
          <div className="text-xs shrink-0">
            <span className="text-slate-400">δ </span>
            <span className="text-white">{c.shortDelta.toFixed(2)}</span>
          </div>
          <span className="text-[9px] text-slate-400 border border-slate-700/50 rounded px-1 py-0.5 shrink-0">opt</span>
        </>}
        {!result.qualified && result.failReasons.length > 0 && (
          <div className="text-[10px] text-red-400 ml-auto">{result.failReasons.slice(0, 2).join(' · ')}</div>
        )}
        <div className="ml-auto text-slate-400 text-xs shrink-0">{expanded ? '▲' : '▼'}</div>
      </div>

      {expanded && (
        <div className="border-t border-slate-800 px-4 py-3 grid grid-cols-2 md:grid-cols-3 gap-3">
          {Object.entries(result.checks).map(([key, check]) => (
            <div key={key} className="flex items-start gap-2">
              <span className={`text-xs mt-0.5 ${statusColor(check.status)}`}>{statusIcon(check.status)}</span>
              <div>
                <p className="text-[10px] text-slate-400 uppercase tracking-wider">{key}</p>
                <p className="text-xs text-white">{check.value}</p>
                <p className="text-[10px] text-slate-400">{check.reason}</p>
              </div>
            </div>
          ))}
          {c && c.strategy === 'IC' && c.callWidth != null && c.callWidth !== c.spreadWidth && (
            <div className="col-span-2 md:col-span-3 mt-1 pt-2 border-t border-slate-800">
              <p className="text-[10px] text-slate-400">
                Asymmetric widths — Put: ${c.spreadWidth} · Call: ${c.callWidth} (each optimized for best ROC)
              </p>
            </div>
          )}
          {result.failReasons.length > 0 && (
            <div className="col-span-2 md:col-span-3 mt-1 pt-2 border-t border-slate-800">
              <p className="text-[10px] text-red-400">{result.failReasons.join(' · ')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────
export default function Home() {
  const [bpsTickers, setBpsTickers] = useState('');
  const [bcsTickers, setBcsTickers] = useState('');
  const [icTickers, setIcTickers] = useState('');
  const [results, setResults] = useState<ScreenResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [runtimeRules, setRuntimeRules] = useState<RulesType>(() => {
    try {
      const saved = localStorage.getItem('prosper-rules');
      return saved ? { ...DEFAULT_RULES, ...JSON.parse(saved) } : { ...DEFAULT_RULES };
    } catch { return { ...DEFAULT_RULES }; }
  });

  const parseTickers = (input: string) =>
    input.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);

  const downloadCSV = () => {
    const headers = ['Symbol','Strategy','Qualified','Price','IVR','Expiration','DTE',
      'Short Put Strike','Long Put Strike','Put Width',
      'Short Call Strike','Long Call Strike','Call Width',
      'Short Delta','Credit','ROC%','POP%','Short OI','Long OI','Total Credit','Fail Reasons'];
    const rows = results.map(r => {
      const c = r.bestCandidate;
      return [
        r.symbol, r.strategy, r.qualified ? 'YES' : 'NO',
        r.price?.toFixed(2) || '', r.ivr?.toFixed(1) || '',
        c?.expiration || '', c?.dte || '',
        c?.shortStrike || '', c?.longStrike || '', c?.spreadWidth || '',
        c?.shortCallStrike || '', c?.longCallStrike || '', c?.callWidth || '',
        c?.shortDelta?.toFixed(2) || '',
        c?.credit?.toFixed(2) || '', c?.roc?.toFixed(0) || '', c?.pop?.toFixed(0) || '',
        c?.shortOI || '', c?.longOI || '',
        c?.totalCredit?.toFixed(2) || '',
        r.failReasons.join('; ')
      ].map(v => `"${v}"`).join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `prosper-screen-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  const runScreen = async (rules: RulesType) => {
    setError('');
    setResults([]);
    const bps = parseTickers(bpsTickers);
    const bcs = parseTickers(bcsTickers);
    const ic = parseTickers(icTickers);
    if (!bps.length && !bcs.length && !ic.length) {
      setError('Enter at least one ticker.');
      return;
    }
    setLoading(true);
    try {
      setStatus('Getting access token...');
      const token = await getAccessToken();
      const allSymbols = Array.from(new Set([...bps, ...bcs, ...ic]));
      setStatus('Fetching market metrics...');
      const metricsArray = await getMarketMetrics(allSymbols, token);
      const metricsMap = Object.fromEntries(metricsArray.map((m: any) => [m.symbol, m]));
      const screenResults: ScreenResult[] = [];
      const buckets = [
        { symbols: bps, strategy: 'BPS' as const },
        { symbols: bcs, strategy: 'BCS' as const },
        { symbols: ic, strategy: 'IC' as const },
      ];
      for (const { symbols, strategy } of buckets) {
        for (const symbol of symbols) {
          setStatus(`Scanning ${symbol}...`);
          try {
            const metrics = metricsMap[symbol] || { symbol, ivRank: null, earningsExpectedDate: null };
            const [chainData, price] = await Promise.all([
              getChain(symbol, token, rules),
              getQuote(symbol, token),
            ]);
            const result = runChecklist(symbol, strategy, metrics, chainData, price, rules);
            screenResults.push(result);
          } catch (e: any) {
            screenResults.push({
              symbol, strategy, price: null, ivr: null, qualified: false, bestCandidate: null,
              failReasons: [e.message],
              checks: {
                ivr: { status: 'fail', value: 'Error', reason: e.message },
                earnings: { status: 'pending', value: '—', reason: '—' },
                oi: { status: 'pending', value: '—', reason: '—' },
                delta: { status: 'pending', value: '—', reason: '—' },
                credit: { status: 'pending', value: '—', reason: '—' },
                roc: { status: 'pending', value: '—', reason: '—' },
              },
            });
          }
        }
      }
      screenResults.sort((a, b) => {
        if (a.qualified && !b.qualified) return -1;
        if (!a.qualified && b.qualified) return 1;
        return (b.ivr ?? 0) - (a.ivr ?? 0);
      });
      setResults(screenResults);
    } catch (e: any) {
      setError(e.message);
    }
    setStatus('');
    setLoading(false);
  };

  const qualified = results.filter(r => r.qualified);
  const disqualified = results.filter(r => !r.qualified);

  return (
    <div className="min-h-screen bg-[#080c14] text-slate-100 font-mono">
      <div className="border-b border-slate-800 px-6 py-4">
        <h1 className="text-base font-bold tracking-widest text-white">PROSPER OPTIONS SCREENER</h1>
        <p className="text-[10px] text-slate-400 mt-0.5 tracking-wider">BPS · BCS · IRON CONDOR</p>
      </div>

      <div className="flex h-[calc(100vh-57px)]">
        {/* Sidebar */}
        <div className="w-64 border-r border-slate-800 p-4 overflow-auto flex flex-col gap-4 shrink-0">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[9px] px-1.5 py-0.5 bg-emerald-900/40 text-emerald-400 border border-emerald-800/60 rounded tracking-wider">BULLISH</span>
              <span className="text-[10px] text-slate-400 tracking-wider">BPS</span>
            </div>
            <textarea value={bpsTickers} onChange={e => setBpsTickers(e.target.value)} placeholder="AAPL, MSFT, XOM"
              className="w-full bg-slate-900/60 border border-slate-700/60 rounded p-2 text-xs h-16 resize-none focus:outline-none focus:border-emerald-700/60 placeholder-slate-700 leading-relaxed" />
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[9px] px-1.5 py-0.5 bg-red-900/40 text-red-400 border border-red-800/60 rounded tracking-wider">BEARISH</span>
              <span className="text-[10px] text-slate-400 tracking-wider">BCS</span>
            </div>
            <textarea value={bcsTickers} onChange={e => setBcsTickers(e.target.value)} placeholder="META, NVDA"
              className="w-full bg-slate-900/60 border border-slate-700/60 rounded p-2 text-xs h-16 resize-none focus:outline-none focus:border-red-700/60 placeholder-slate-700 leading-relaxed" />
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[9px] px-1.5 py-0.5 bg-blue-900/40 text-blue-400 border border-blue-800/60 rounded tracking-wider">NEUTRAL</span>
              <span className="text-[10px] text-slate-400 tracking-wider">IC</span>
            </div>
            <textarea value={icTickers} onChange={e => setIcTickers(e.target.value)} placeholder="SPY, QQQ"
              className="w-full bg-slate-900/60 border border-slate-700/60 rounded p-2 text-xs h-16 resize-none focus:outline-none focus:border-blue-700/60 placeholder-slate-700 leading-relaxed" />
          </div>

          {/* Active Rules — live from runtimeRules */}
          <div className="text-[9px] text-slate-400 space-y-1 border-t border-slate-800 pt-3">
            <p className="text-slate-400 mb-1.5 tracking-widest text-[9px]">ACTIVE RULES</p>
            <div className="flex justify-between"><span>IVR</span><span className="text-slate-400">≥ {runtimeRules.IVR_MIN}%</span></div>
            <div className="flex justify-between"><span>DTE</span><span className="text-slate-400">{runtimeRules.DTE_MIN}–{runtimeRules.DTE_MAX} days</span></div>
            <div className="flex justify-between"><span>BPS/BCS delta</span><span className="text-slate-400">{runtimeRules.SPREAD_DELTA_MIN}–{runtimeRules.SPREAD_DELTA_MAX}</span></div>
            <div className="flex justify-between"><span>IC delta</span><span className="text-slate-400">{runtimeRules.IC_DELTA_MIN}–{runtimeRules.IC_DELTA_MAX}</span></div>
            <div className="flex justify-between"><span>Credit ratio</span><span className="text-slate-400">≥ {(runtimeRules.CREDIT_RATIO_MIN * 100).toFixed(0)}%</span></div>
            <div className="flex justify-between"><span>OI per leg</span><span className="text-slate-400">≥ {runtimeRules.OI_MIN}</span></div>
            <div className="flex justify-between"><span>Bid-Ask</span><span className="text-slate-400">≤ ${runtimeRules.BID_ASK_MAX}</span></div>
            <div className="flex justify-between"><span>Max width</span><span className="text-slate-400">${runtimeRules.MAX_SPREAD_WIDTH} (opt)</span></div>
            <div className="flex justify-between"><span>Min ROC spread</span><span className="text-slate-400">{runtimeRules.ROC_MIN_SPREAD}%</span></div>
            <div className="flex justify-between"><span>Min ROC IC</span><span className="text-slate-400">{runtimeRules.ROC_MIN_IC}%</span></div>
          </div>

          {error && (
            <div className="text-[10px] text-red-400 bg-red-900/20 border border-red-800/60 rounded p-2 leading-relaxed">{error}</div>
          )}

          <button
            onClick={() => setShowRulesModal(true)}
            disabled={loading}
            className="w-full bg-white text-black py-2.5 rounded text-xs font-bold tracking-widest hover:bg-slate-200 transition-colors disabled:opacity-40 mt-auto"
          >
            {loading ? 'SCANNING...' : 'RUN SCREENER'}
          </button>
        </div>

        {/* Main content */}
        <div className="flex-1 overflow-auto p-5">
          {results.length === 0 && !loading && (
            <div className="h-full flex flex-col items-center justify-center text-slate-400">
              <div className="text-4xl mb-3 opacity-30">◈</div>
              <p className="text-[10px] tracking-widest">ADD TICKERS AND RUN SCREENER</p>
            </div>
          )}
          {loading && (
            <div className="h-full flex flex-col items-center justify-center gap-2">
              <div className="text-[10px] tracking-widest text-slate-400 animate-pulse">{status || 'SCANNING...'}</div>
            </div>
          )}
          {results.length > 0 && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div className="flex gap-4 text-[10px] tracking-wider">
                  <span className="text-emerald-400">{qualified.length} QUALIFIED</span>
                  <span className="text-slate-400">{disqualified.length} DISQUALIFIED</span>
                  <span className="text-slate-400">{results.length} SCANNED</span>
                </div>
                <button onClick={downloadCSV} className="text-[10px] px-3 py-1.5 border border-slate-700 rounded hover:border-slate-500 transition-colors tracking-wider">↓ CSV</button>
              </div>
              {qualified.length > 0 && (
                <div>
                  <p className="text-[9px] text-emerald-600 tracking-widest mb-2">QUALIFIED</p>
                  <div className="space-y-2">{qualified.map(r => <ResultCard key={`${r.symbol}-${r.strategy}`} result={r} />)}</div>
                </div>
              )}
              {disqualified.length > 0 && (
                <div>
                  <p className="text-[9px] text-slate-400 tracking-widest mb-2">DISQUALIFIED</p>
                  <div className="space-y-2">{disqualified.map(r => <ResultCard key={`${r.symbol}-${r.strategy}`} result={r} />)}</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Rules Modal */}
      {showRulesModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-slate-900 border border-slate-700 rounded-lg p-6 w-[500px] max-h-[80vh] overflow-auto">
            <h2 className="text-xs font-bold tracking-widest text-white mb-1">SCREENING RULES</h2>
            <p className="text-[9px] text-slate-400 mb-4 tracking-wider">
              Width optimizer tries $5 → ${runtimeRules.MAX_SPREAD_WIDTH} in $5 steps and returns best ROC. IC sides optimized independently.
            </p>
            <div className="grid grid-cols-2 gap-3 mb-6">
              {([
                'IVR_MIN', 'IVR_IC_MAX',
                'DTE_MIN', 'DTE_MAX',
                'SPREAD_DELTA_MIN', 'SPREAD_DELTA_MAX',
                'IC_DELTA_MIN', 'IC_DELTA_MAX',
                'OI_MIN', 'BID_ASK_MAX',
                'CREDIT_RATIO_MIN', 'MAX_SPREAD_WIDTH',
                'ROC_MIN_SPREAD', 'ROC_MIN_IC',
              ] as (keyof RulesType)[]).map(key => (
                <div key={key}>
                  <p className="text-[9px] text-slate-400 tracking-wider mb-1">
                    {RULE_LABELS[key] ?? key}
                    {key === 'MAX_SPREAD_WIDTH' && <span className="text-slate-400 ml-1">(optimizer cap)</span>}
                  </p>
                  <input
                    type="number"
                    step="any"
                    value={runtimeRules[key]}
                    onChange={e => setRuntimeRules(prev => ({ ...prev, [key]: parseFloat(e.target.value) || 0 }))}
                    className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-slate-500"
                  />
                </div>
              ))}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setRuntimeRules({ ...DEFAULT_RULES })}
                className="flex-1 border border-slate-700 text-yellow-600 py-2 rounded text-xs tracking-widest hover:border-yellow-600"
              >
                RESET
              </button>
              <button
                onClick={() => setShowRulesModal(false)}
                className="flex-1 border border-slate-700 text-slate-400 py-2 rounded text-xs tracking-widest hover:border-slate-500"
              >
                CANCEL
              </button>
              <button
                onClick={() => {
                  setShowRulesModal(false);
                  localStorage.setItem('prosper-rules', JSON.stringify(runtimeRules));
                  console.log('RUN clicked with rules:', runtimeRules);
                  runScreen(runtimeRules);
                }}
                className="flex-1 bg-white text-black py-2 rounded text-xs font-bold tracking-widest hover:bg-slate-200"
              >
                RUN
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
