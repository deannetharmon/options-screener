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
  
  // Login states
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [useMock, setUseMock] = useState(false);

  const handleRealLogin = () => {
    if (username && password) {
      setIsLoggedIn(true);
      setUseMock(false);
      alert("✅ Real TastyTrade login attempted. If it fails, use Mock Mode.");
    } else {
      alert("Please enter username and password");
    }
  };

  const handleMockLogin = () => {
    setIsLoggedIn(true);
    setUseMock(true);
    alert("✅ Mock Mode Activated - You can now run the screener without real login.");
  };

  const runScreen = async () => {
    if (!isLoggedIn) {
      alert("Please connect using Real Login or Mock Mode first");
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
          token: useMock ? 'mock-token-for-testing' : 'real-token-placeholder', 
          trends 
        }),
      });

      const data = await res.json();
      setResults(data.results || []);
    } catch (e) {
      console.error(e);
      alert("Error running screen");
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
                onClick={handleRealLogin}
                className="w-full bg-cyan-600 hover:bg-cyan-500 py-2 rounded text-sm font-medium mb-2"
              >
                Connect Real Account
              </button>
              <button 
                onClick={handleMockLogin}
                className="w-full bg-emerald-600 hover:bg-emerald-500 py-2 rounded text-sm font-medium"
              >
                Use Mock Mode (Testing)
              </button>
            </>
          ) : (
            <div className="bg-emerald-900/30 border border-emerald-500/30 rounded p-3 text-emerald-400">
              ✅ {useMock ? 'Connected (Mock Mode)' : 'Connected (Real)'}
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
        <div className="flex gap-4 mb-6">
          <button onClick={() => setMode('semi')} className={`px-6 py-2 rounded ${mode === 'semi' ? 'bg-white text-black' : 'bg-slate-800'}`}>Semi-Manual</button>
          <button onClick={() => setMode('auto')} className={`px-6 py-2 rounded ${mode === 'auto' ? 'bg-white text-black' : 'bg-slate-800'}`}>Full Auto</button>
        </div>

        {results.length > 0 ? (
          <div className="space-y-6">
            {results.map((r) => (
              <div key={r.symbol} className={`p-5 border rounded-xl ${r.qualified ? 'border-emerald-500/50 bg-emerald-950/20' : 'border-slate-700'}`}>
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-2xl font-bold">{r.symbol}</span>
                    <span className="ml-3 px-3 py-1 rounded text-sm bg-slate-700">{r.strategy}</span>
                  </div>
                  {r.qualified && <span className="text-emerald-400 font-bold">QUALIFIED</span>}
                </div>
                
                {r.bestCandidate && (
                  <div className="mt-3 text-lg font-medium">
                    {r.bestCandidate.shortStrike} / {r.bestCandidate.longStrike} — ${r.bestCandidate.credit.toFixed(2)} credit
                  </div>
                )}

                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {Object.entries(r.checks).map(([key, check]) => (
                    <span key={key}>
                      {key.toUpperCase()}: <span className={check.status === 'pass' ? 'text-emerald-400' : 'text-red-400'}>{check.status}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="h-[70vh] flex items-center justify-center text-slate-500">
            Select mode, enter tickers, and click RUN SCREENER
          </div>
        )}
      </div>
    </div>
  );
}
