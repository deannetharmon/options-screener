'use client';

import { useState } from 'react';
import { ScreenResult, Trend } from '@/lib/screener';

const DEFAULT_TICKERS = 'MU, MRVL, ORCL, VRT, CRWD, AMD, NVDA, MSFT, AMZN, META';

type Mode = 'auto' | 'semi' | 'dashboard';

export default function Home() {
  const [mode, setMode] = useState<Mode>('semi');
  const [tickersInput, setTickersInput] = useState(DEFAULT_TICKERS);
  const [trends, setTrends] = useState<Record<string, Trend>>({});
  const [results, setResults] = useState<ScreenResult[]>([]);
  const [loading, setLoading] = useState(false);
  
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [useMock, setUseMock] = useState(false);

  const handleRealLogin = () => {
    if (username && password) {
      setIsLoggedIn(true);
      setUseMock(false);
      alert("Real login attempted. If it doesn't work, try Mock Mode or check TastyTrade token.");
    }
  };

  const handleMockLogin = () => {
    setIsLoggedIn(true);
    setUseMock(true);
  };

  const runScreen = async () => {
    if (!isLoggedIn) {
      alert("Please login first");
      return;
    }

    setLoading(true);
    try {
      const symbols = tickersInput.split(/[, ]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
      const token = useMock ? 'mock-token-for-testing' : 'real-token'; // real token would come from auth

      const res = await fetch('/api/screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols, token, trends }),
      });

      const data = await res.json();
      setResults(data.results || []);
    } catch (e) {
      console.error(e);
      alert("Screen failed - check console");
    }
    setLoading(false);
  };

  return (
    <div className="flex h-screen bg-[#0a0e1a] text-slate-200 overflow-hidden">
      <div className="w-80 border-r border-slate-800 p-4 overflow-auto">
        <h1 className="text-2xl font-bold mb-6">OPTIONS SCREENER</h1>

        <div className="mb-6">
          <p className="text-xs text-slate-400 mb-2">TASTYTRADE LOGIN</p>
          {!isLoggedIn ? (
            <>
              <input type="text" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 mb-2" />
              <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 mb-3" />
              <button onClick={handleRealLogin} className="w-full bg-cyan-600 py-2 rounded mb-2">Connect Real</button>
              <button onClick={handleMockLogin} className="w-full bg-emerald-600 py-2 rounded">Mock Mode</button>
            </>
          ) : (
            <div className="bg-emerald-900 border border-emerald-500 rounded p-3 text-emerald-400">
              Connected ({useMock ? 'Mock' : 'Real'})
            </div>
          )}
        </div>

        <div className="mb-6">
          <p className="text-xs text-slate-400 mb-2">TICKERS</p>
          <textarea value={tickersInput} onChange={(e) => setTickersInput(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded p-3 h-28" />
        </div>

        <div className="mb-6 text-[10px] space-y-1">
          <p className="uppercase text-slate-400">COURSE RULES</p>
          <div>IVR ≥ 30%</div>
          <div>IVx ≥ 35%</div>
          <div>OI ≥ 500</div>
          <div>Delta 0.15-0.22</div>
          <div>Credit ≥ 1/3 width</div>
          <div>DTE 21-45</div>
        </div>

        <button onClick={runScreen} disabled={loading || !isLoggedIn} className="w-full bg-emerald-600 py-3 rounded disabled:opacity-50">
          {loading ? 'Running...' : 'RUN SCREENER'}
        </button>
      </div>

      <div className="flex-1 p-6">
        {results.length > 0 ? results.map(r => (
          <div key={r.symbol} className="mb-6 p-4 border border-slate-700 rounded">
            <h2 className="text-xl font-bold">{r.symbol} - {r.strategy}</h2>
            {r.bestCandidate && <p>Credit: ${r.bestCandidate.credit.toFixed(2)}</p>}
          </div>
        )) : (
          <p className="text-slate-500">Run the screener to see results</p>
        )}
      </div>
    </div>
  );
}
