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
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [mockMode, setMockMode] = useState(false);

  const connectMock = () => {
    setIsLoggedIn(true);
    setMockMode(true);
    alert("✅ Mock TastyTrade connected! You can now run the screener in test mode.");
  };

  const runScreen = async () => {
    if (!isLoggedIn) {
      alert("Please connect (use Mock mode for testing)");
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
          token: 'mock-token-for-testing', 
          trends 
        }),
      });

      const data = await res.json();
      setResults(data.results || []);
    } catch (e) {
      console.error(e);
      alert("Screening error - check console");
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
              <button 
                onClick={connectMock}
                className="w-full bg-emerald-600 hover:bg-emerald-500 py-3 rounded font-medium mb-2"
              >
                Use Mock Mode (for testing)
              </button>
              <p className="text-[10px] text-slate-500">Real login coming soon</p>
            </>
          ) : (
            <div className="bg-emerald-900/30 border border-emerald-500/30 rounded p-3 text-emerald-400 text-sm">
              ✅ Connected (Mock Mode)
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
                <div className="flex justify-between">
                  <div className="text-2xl font-bold">{r.symbol}</div>
                  <div className={`px-3 py-1 rounded text-sm ${r.qualified ? 'bg-emerald-500 text-black' : 'bg-slate-700'}`}>
                    {r.strategy}
                  </div>
                </div>
                {r.bestCandidate && (
                  <div className="mt-4 text-lg">
                    {r.bestCandidate.shortStrike} / {r.bestCandidate.longStrike} — ${r.bestCandidate.credit.toFixed(2)} credit
                  </div>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  {Object.entries(r.checks).map(([k, v]) => (
                    <div key={k} className="flex items-center gap-1 text-xs">
                      {k.toUpperCase()}: <span className={v.status === 'pass' ? 'text-emerald-400' : 'text-red-400'}>{v.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="h-[70vh] flex items-center justify-center text-slate-500 text-lg">
            Enter tickers above and click RUN SCREENER
          </div>
        )}
      </div>
    </div>
  );
}
