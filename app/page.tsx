'use client';

import { useState } from 'react';

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
  shortCallStrike?: number;
  longCallStrike?: number;
  callCredit?: number;
  totalCredit?: number;
}

interface CheckResult {
  status: 'pass' | 'fail' | 'warn' | 'pending';
  value: string;
  reason: string;
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

const statusColor = (s: string) => {
  if (s === 'pass') return 'text-emerald-400';
  if (s === 'fail') return 'text-red-400';
  if (s === 'warn') return 'text-yellow-400';
  return 'text-slate-500';
};

const statusIcon = (s: string) => {
  if (s === 'pass') return '✓';
  if (s === 'fail') return '✗';
  if (s === 'warn') return '⚠';
  return '—';
};

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
          {result.price && <p className="text-[10px] text-slate-500">${result.price.toFixed(2)}</p>}
        </div>
        <span className={`text-[10px] px-2 py-0.5 border rounded shrink-0 ${stratBg}`}>{result.strategy}</span>
        <div className="text-xs text-slate-400 shrink-0">
          IVR <span className={result.ivr != null && result.ivr >= 30 ? 'text-emerald-400' : 'text-red-400'}>
            {result.ivr != null ? `${result.ivr.toFixed(1)}%` : 'N/A'}
          </span>
        </div>
        {c && (
          <>
            <div className="text-xs shrink-0"><span className="text-slate-500">Exp </span><span className="text-white">{c.expiration}</span><span className="text-slate-600 ml-1">({c.dte}d)</span></div>
            <div className="text-xs shrink-0"><span className="text-slate-500">Strikes </span><span className="text-white">{c.shortStrike}/{c.longStrike}</span></div>
            <div className="text-xs shrink-0"><span className="text-slate-500">Credit </span><span className="text-emerald-400 font-bold">${(c.totalCredit ?? c.credit).toFixed(2)}</span></div>
            <div className="text-xs shrink-0"><span className="text-slate-500">ROC </span><span className="text-white">{c.roc.toFixed(0)}%</span></div>
            {c.pop != null && <div className="text-xs shrink-0"><span className="text-slate-500">POP </span><span className="text-white">{c.pop.toFixed(0)}%</span></div>}
            <div className="text-xs shrink-0"><span className="text-slate-500">δ </span><span className="text-white">{c.shortDelta.toFixed(2)}</span></div>
          </>
        )}
        {!result.qualified && result.failReasons.length > 0 && (
          <div className="text-[10px] text-red-400 ml-auto">{result.failReasons.slice(0, 2).join(' · ')}</div>
        )}
        <div className="ml-auto text-slate-600 text-xs shrink-0">{expanded ? '▲' : '▼'}</div>
      </div>
      {expanded && (
        <div className="border-t border-slate-800 px-4 py-3 grid grid-cols-2 md:grid-cols-3 gap-3">
          {Object.entries(result.checks).map(([key, check]) => (
            <div key={key} className="flex items-start gap-2">
              <span className={`text-xs mt-0.5 ${statusColor(check.status)}`}>{statusIcon(check.status)}</span>
              <div>
                <p className="text-[10px] text-slate-500 uppercase tracking-wider">{key}</p>
                <p className="text-xs text-white">{check.value}</p>
                <p className="text-[10px] text-slate-500">{check.reason}</p>
              </div>
            </div>
          ))}
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

export default function Home() {
  const [bpsTickers, setBpsTickers] = useState('');
  const [bcsTickers, setBcsTickers] = useState('');
  const [icTickers, setIcTickers] = useState('');
  const [results, setResults] = useState<ScreenResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [tokenExpiry, setTokenExpiry] = useState<number>(0);
  const [error, setError] = useState('');

  const clientId = '4d4c851b-bdaf-4ac9-b39b-811e604739f2';
  const isConnected = !!accessToken && Date.now() < tokenExpiry;

  const refreshToken = async (): Promise<string> => {
    const storedRefreshToken = process.env.NEXT_PUBLIC_TASTYTRADE_REFRESH_TOKEN;
    const clientSecret = process.env.NEXT_PUBLIC_TASTYTRADE_CLIENT_SECRET;

    if (!storedRefreshToken || !clientSecret) {
      throw new Error('TastyTrade credentials not configured.');
    }

    const res = await fetch('https://api.tastytrade.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: storedRefreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token refresh failed: ${text}`);
    }

    const data = await res.json();
    const expiry = Date.now() + ((data.expires_in || 900) * 1000);
    setAccessToken(data.access_token);
    setTokenExpiry(expiry);
    return data.access_token;
  };

  const getToken = async (): Promise<string> => {
    if (accessToken && Date.now() < tokenExpiry - 60000) return accessToken;
    return refreshToken();
  };

  const parseTickers = (input: string) =>
    input.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);

  const runScreen = async () => {
    setError('');
    const bps = parseTickers(bpsTickers);
    const bcs = parseTickers(bcsTickers);
    const ic = parseTickers(icTickers);

    if (bps.length === 0 && bcs.length === 0 && ic.length === 0) {
      setError('Enter at least one ticker.');
      return;
    }

    setLoading(true);
    setResults([]);

    try {
      const token = await getToken();
      const res = await fetch('/api/screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bps, bcs, ic, accessToken: token }),
      });

      const data = await res.json();
      if (data.error) setError(data.error);
      else setResults(data.results || []);
    } catch (e: any) {
      setError(e.message);
    }

    setLoading(false);
  };

  const downloadCSV = async () => {
    const res = await fetch('/api/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results }),
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `prosper-screen-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  const qualified = results.filter(r => r.qualified);
  const disqualified = results.filter(r => !r.qualified);

  return (
    <div className="min-h-screen bg-[#080c14] text-slate-100 font-mono">
      <div className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold tracking-widest text-white">PROSPER OPTIONS SCREENER</h1>
          <p className="text-[10px] text-slate-500 mt-0.5 tracking-wider">BPS · BCS · IRON CONDOR</p>
        </div>
        <div className="flex items-center gap-3">
          {isConnected
            ? <span className="text-[10px] text-emerald-400 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block animate-pulse"></span>TASTYTRADE CONNECTED</span>
            : <span className="text-[10px] text-slate-500 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-slate-500 inline-block"></span>CONNECTING...</span>
          }
        </div>
      </div>

      <div className="flex h-[calc(100vh-57px)]">
        <div className="w-64 border-r border-slate-800 p-4 overflow-auto flex flex-col gap-4 shrink-0">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[9px] px-1.5 py-0.5 bg-emerald-900/40 text-emerald-400 border border-emerald-800/60 rounded tracking-wider">BULLISH</span>
              <span className="text-[10px] text-slate-400 tracking-wider">BPS</span>
            </div>
            <textarea value={bpsTickers} onChange={e => setBpsTickers(e.target.value)} placeholder="AAPL, MSFT, XOM" className="w-full bg-slate-900/60 border border-slate-700/60 rounded p-2 text-xs h-16 resize-none focus:outline-none focus:border-emerald-700/60 placeholder-slate-700 leading-relaxed" />
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[9px] px-1.5 py-0.5 bg-red-900/40 text-red-400 border border-red-800/60 rounded tracking-wider">BEARISH</span>
              <span className="text-[10px] text-slate-400 tracking-wider">BCS</span>
            </div>
            <textarea value={bcsTickers} onChange={e => setBcsTickers(e.target.value)} placeholder="META, NVDA" className="w-full bg-slate-900/60 border border-slate-700/60 rounded p-2 text-xs h-16 resize-none focus:outline-none focus:border-red-700/60 placeholder-slate-700 leading-relaxed" />
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[9px] px-1.5 py-0.5 bg-blue-900/40 text-blue-400 border border-blue-800/60 rounded tracking-wider">NEUTRAL</span>
              <span className="text-[10px] text-slate-400 tracking-wider">IC</span>
            </div>
            <textarea value={icTickers} onChange={e => setIcTickers(e.target.value)} placeholder="SPY, QQQ" className="w-full bg-slate-900/60 border border-slate-700/60 rounded p-2 text-xs h-16 resize-none focus:outline-none focus:border-blue-700/60 placeholder-slate-700 leading-relaxed" />
          </div>
          <div className="text-[9px] text-slate-600 space-y-1 border-t border-slate-800 pt-3">
            <p className="text-slate-500 mb-1.5 tracking-widest text-[9px]">ACTIVE RULES</p>
            <div className="flex justify-between"><span>IVR</span><span className="text-slate-500">≥ 30%</span></div>
            <div className="flex justify-between"><span>DTE</span><span className="text-slate-500">30–45 days</span></div>
            <div className="flex justify-between"><span>BPS/BCS delta</span><span className="text-slate-500">0.20–0.30</span></div>
            <div className="flex justify-between"><span>IC delta</span><span className="text-slate-500">0.16–0.20</span></div>
            <div className="flex justify-between"><span>Credit</span><span className="text-slate-500">≥ ⅓ width</span></div>
            <div className="flex justify-between"><span>OI per leg</span><span className="text-slate-500">≥ 500</span></div>
            <div className="flex justify-between"><span>Bid-Ask</span><span className="text-slate-500">≤ $0.10</span></div>
            <div className="flex justify-between"><span>Width</span><span className="text-slate-500">$5</span></div>
          </div>
          {error && <div className="text-[10px] text-red-400 bg-red-900/20 border border-red-800/60 rounded p-2 leading-relaxed">{error}</div>}
          <button onClick={runScreen} disabled={loading} className="w-full bg-white text-black py-2.5 rounded text-xs font-bold tracking-widest hover:bg-slate-200 transition-colors disabled:opacity-40 mt-auto">
            {loading ? 'SCANNING...' : 'RUN SCREENER'}
          </button>
        </div>

        <div className="flex-1 overflow-auto p-5">
          {results.length === 0 && !loading && (
            <div className="h-full flex flex-col items-center justify-center text-slate-700">
              <div className="text-4xl mb-3 opacity-30">◈</div>
              <p className="text-[10px] tracking-widest">ADD TICKERS AND RUN SCREENER</p>
            </div>
          )}
          {loading && <div className="h-full flex flex-col items-center justify-center"><div className="text-[10px] tracking-widest text-slate-500 animate-pulse">FETCHING MARKET DATA...</div></div>}
          {results.length > 0 && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div className="flex gap-4 text-[10px] tracking-wider">
                  <span className="text-emerald-400">{qualified.length} QUALIFIED</span>
                  <span className="text-slate-600">{disqualified.length} DISQUALIFIED</span>
                  <span className="text-slate-600">{results.length} SCANNED</span>
                </div>
                <button onClick={downloadCSV} className="text-[10px] px-3 py-1.5 border border-slate-700 rounded hover:border-slate-500 transition-colors tracking-wider">↓ CSV</button>
              </div>
              {qualified.length > 0 && (
                <div>
                  <p className="text-[9px] text-emerald-600 tracking-widest mb-2">QUALIFIED</p>
                  <div className="space-y-2">{qualified.map(r => <ResultCard key={r.symbol} result={r} />)}</div>
                </div>
              )}
              {disqualified.length > 0 && (
                <div>
                  <p className="text-[9px] text-slate-700 tracking-widest mb-2">DISQUALIFIED</p>
                  <div className="space-y-2">{disqualified.map(r => <ResultCard key={r.symbol} result={r} />)}</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
