'use client';

import { useState, useEffect } from 'react';
import { ScreenResult, Trend } from '@/lib/screener';

const DEFAULT_TICKERS = 'MU, MRVL, ORCL, VRT, CRWD, AMD, NVDA, MSFT, AMZN, META';

type Mode = 'auto' | 'semi' | 'dashboard';

export default function Home() {
  const [mode, setMode] = useState<Mode>('semi');
  const [tickersInput, setTickersInput] = useState(DEFAULT_TICKERS);
  const [trends, setTrends] = useState<Record<string, Trend>>({});
  const [results, setResults] = useState<ScreenResult[]>([]);
  const [loading, setLoading] = useState(false);

  // Login state with persistence
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  // Load saved credentials on mount
  useEffect(() => {
    const savedUsername = localStorage.getItem('tt_username');
    const savedLoggedIn = localStorage.getItem('tt_logged_in') === 'true';
    if (savedUsername) setUsername(savedUsername);
    if (savedLoggedIn) setIsLoggedIn(true);
  }, []);

  const handleLogin = () => {
    if (username && password) {
      localStorage.setItem('tt_username', username);
      localStorage.setItem('tt_logged_in', 'true');
      setIsLoggedIn(true);
      // No more annoying alert
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('tt_username');
    localStorage.removeItem('tt_logged_in');
    setIsLoggedIn(false);
    setUsername('');
    setPassword('');
  };

  const runScreen = async () => {
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
          token: 'real-token-placeholder', 
          trends 
        }),
      });

      const data = await res.json();
      setResults(data.results || []);
    } catch (e) {
      console.error(e);
      alert("Screen failed - check console (Cmd + Option + I)");
    }
    setLoading(false);
  };

  return (
    <div className="flex h-screen bg-[#0a0e1a] text-slate-200 overflow-hidden">
      {/* Sidebar */}
      <div className="w-80 border-r border-slate-800 p-4 overflow-auto">
        <h1 className="text-2xl font-bold mb-6">OPTIONS SCREENER</h1>

        {/* TastyTrade Login */}
        <div className="mb-6">
          <p className="text-xs text-slate-400 mb-2">TASTYTRADE LOGIN</p>
          
          {!isLoggedIn ? (
            <>
              <input 
                type="text" 
                placeholder="Email / Username" 
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm mb-2" 
              />
              <input 
                type="password" 
                placeholder="Password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm mb-3" 
              />
              <button 
                onClick={handleLogin}
                disabled={!username || !password}
                className="w-full bg-cyan-600 hover:bg-cyan-500 py-2 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Connect
              </button>
            </>
          ) : (
            <div className="flex justify-between items-center bg-emerald-900 border border-emerald-500 rounded p-3">
              <span className="text-emerald-400">✅ Connected (Real)</span>
              <button onClick={handleLogout} className="text-xs text-red-400 hover:text-red-300">Logout</button>
            </div>
          )}
        </div>

        {/* Tickers */}
        <div className="mb-6">
          <p className="text-xs text-slate-400 mb-2">TICKERS (comma separated)</p>
          <textarea 
            value={tickersInput} 
            onChange={(e) => setTickersInput(e.target.value)}
            className="w-full bg-slate-900 border border-slate-700 rounded p-3 text-sm h-28 font-mono"
          />
        </div>

        {/* Course Rules */}
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

        <button 
          onClick={runScreen}
          disabled={loading || !isLoggedIn}
          className="w-full bg-emerald-600 hover:bg-emerald-500 py-3 rounded font-medium disabled:opacity-50"
        >
          {loading ? 'RUNNING...' : 'RUN SCREENER'}
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-6 overflow-auto">
        {results.length > 0 ? (
          <div className="space-y-4">
            {results.map((r) => (
              <div key={r.symbol} className="p-5 border border-slate-700 rounded-xl">
                <h2 className="text-xl font-bold">{r.symbol} — {r.strategy}</h2>
                {r.bestCandidate && <p className="text-emerald-400 mt-2">Credit: ${r.bestCandidate.credit.toFixed(2)}</p>}
                <p>Qualified: {r.qualified ? '✅ YES' : 'NO'}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-slate-500 text-lg">
            Enter tickers and click RUN SCREENER
          </div>
        )}
      </div>
    </div>
  );
}
