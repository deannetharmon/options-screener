'use client';

import { useState } from 'react';
import { ScreenResult, Trend } from '@/lib/screener';

const DEFAULT_TICKERS = 'MU, XOM';

type Mode = 'auto' | 'semi' | 'dashboard';

export default function Home() {
  const [mode, setMode] = useState<Mode>('semi');
  const [tickersInput, setTickersInput] = useState(DEFAULT_TICKERS);
  const [trends, setTrends] = useState<Record<string, Trend>>({});
  const [results, setResults] = useState<ScreenResult[]>([]);
  const [loading, setLoading] = useState(false);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  const handleLogin = () => {
    if (apiToken) {
      setIsLoggedIn(true);
      console.log("Using manual API token");
    } else if (username && password) {
      setIsLoggedIn(true);
      console.log("Using username/password login");
    }
  };

  const runScreen = async () => {
    console.log("RUN SCREENER CLICKED");
    if (!isLoggedIn) {
      alert("Please login first");
      return;
    }

    setLoading(true);
    try {
      const symbols = tickersInput.split(/[, ]+/).map(s => s.trim().toUpperCase()).filter(Boolean);

      const res = await fetch('/api/screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          symbols, 
          token: apiToken || 'real-token-placeholder', 
          trends 
        }),
      });

      const data = await res.json();
      console.log("Response data:", data);
      setResults(data.results || []);
    } catch (e) {
      console.error("Fetch error:", e);
      alert("Error - check console");
    }
    setLoading(false);
  };

  return (
    <div className="flex h-screen bg-[#0a0e1a] text-slate-200 overflow-hidden">
      <div className="w-80 border-r border-slate-800 p-4 overflow-auto">
        <h1 className="text-2xl font-bold mb-6">OPTIONS SCREENER</h1>

        <div className="mb-6">
          <p className="text-xs text-slate-400 mb-2">TASTYTRADE LOGIN</p>
          <input 
            type="text" 
            placeholder="API Token (paste here)" 
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm mb-3" 
          />
          <button 
            onClick={handleLogin}
            disabled={!apiToken}
            className="w-full bg-cyan-600 hover:bg-cyan-500 py-2 rounded text-sm font-medium disabled:opacity-50"
          >
            Connect with Token
          </button>
        </div>

        <div className="mb-6">
          <p className="text-xs text-slate-400 mb-2">TICKERS</p>
          <textarea value={tickersInput} onChange={(e) => setTickersInput(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded p-3 h-28 font-mono" />
        </div>

        <div className="mb-6 text-[10px] space-y-1 text-slate-300">
          <p className="uppercase tracking-wider text-slate-400 mb-2">COURSE RULES</p>
          <div>IVR ≥ 30%</div>
          <div>IVx ≥ 35%</div>
          <div>OI ≥ 500 both legs</div>
          <div>Delta 0.15 – 0.22</div>
          <div>Credit ≥ ⅓ width</div>
          <div>DTE 21 – 45 days</div>
          <div>No earnings in window</div>
        </div>

        <button onClick={runScreen} disabled={loading || !isLoggedIn} className="w-full bg-emerald-600 py-3 rounded font-medium disabled:opacity-50">
          {loading ? 'RUNNING...' : 'RUN SCREENER'}
        </button>
      </div>

      <div className="flex-1 p-6 overflow-auto">
        {results.length > 0 ? (
          <div className="space-y-4">
            {results.map((r) => (
              <div key={r.symbol} className="p-5 border border-slate-700 rounded-xl">
                <h2 className="text-xl font-bold">{r.symbol} — {r.strategy}</h2>
                {r.bestCandidate && <p className="text-emerald-400">Credit: ${r.bestCandidate.credit.toFixed(2)}</p>}
                <p>Qualified: {r.qualified ? 'YES' : 'NO'}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-slate-500">Run the screener to see results</div>
        )}
      </div>
    </div>
  );
}
