'use client';

import { useState } from 'react';
import { ScreenResult, Trend } from '@/lib/screener';
import { BarchartRow } from '@/lib/csvParser';

const DEFAULT_TICKERS = 'MU, MRVL, ORCL, VRT, CRWD, AMD, NVDA, MSFT, AMZN, META';

type Mode = 'auto' | 'semi' | 'dashboard';

const CHECK_LABELS: Record<string, string> = {
  ivr: 'IVR', ivx: 'IVx', earnings: 'Earnings', oi: 'OI', delta: 'Delta', credit: 'Credit',
};

function Badge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    pass: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
    fail: 'bg-red-500/15 text-red-300 border-red-500/25',
    warn: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
    pending: 'bg-slate-700/40 text-slate-500 border-slate-600/25',
  };
  const icon: Record<string, string> = { pass: '✓', fail: '✗', warn: '⚠', pending: '—' };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold border ${cls[status] || cls.pending}`}>
      {icon[status] || '—'}
    </span>
  );
}

function TrendPicker({ value, onChange }: { value: Trend; onChange: (t: Trend) => void }) {
  return (
    <div className="flex gap-1">
      {(['uptrend', 'downtrend', 'sideways'] as const).map((t) => (
        <button
          key={t}
          onClick={() => onChange(value === t ? null : t)}
          className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-all ${
            value === t
              ? t === 'uptrend' ? 'bg-emerald-500 text-white' : t === 'downtrend' ? 'bg-red-500 text-white' : 'bg-blue-500 text-white'
              : 'bg-slate-700 text-slate-400 hover:bg-slate-600 hover:text-slate-200'
          }`}
        >
          {t === 'uptrend' ? '↑ Up' : t === 'downtrend' ? '↓ Down' : '→ Flat'}
        </button>
      ))}
    </div>
  );
}

export default function Home() {
  const [mode, setMode] = useState<Mode>('semi');
  const [tickersInput, setTickersInput] = useState(DEFAULT_TICKERS);
  const [trends, setTrends] = useState<Record<string, Trend>>({});
  const [results, setResults] = useState<ScreenResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState('');

  const runScreen = async () => {
    if (!token) {
      alert("Please login to TastyTrade first");
      return;
    }
    setLoading(true);
    try {
      const symbols = tickersInput.split(/[, ]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
      const res = await fetch('/api/screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols, token, trends }),
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
        <h1 className="text-xl font-bold mb-6">OPTIONS SCREENER</h1>

        {/* TastyTrade Login */}
        <div className="mb-6">
          <p className="text-xs text-slate-400 mb-2">TASTYTRADE LOGIN</p>
          <input 
            type="text" 
            placeholder="Email / Username" 
            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm mb-2" 
            onChange={(e) => {/* handle username */}}
          />
          <input 
            type="password" 
            placeholder="Password" 
            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm mb-2" 
          />
          <button 
            onClick={() => alert("Login logic not implemented yet - use your real login")}
            className="w-full bg-cyan-600 hover:bg-cyan-500 py-2 rounded text-sm font-medium"
          >
            Connect
          </button>
        </div>

        {/* Tickers */}
        <div className="mb-6">
          <p className="text-xs text-slate-400 mb-2">TICKERS</p>
          <textarea 
            value={tickersInput} 
            onChange={(e) => setTickersInput(e.target.value)}
            className="w-full bg-slate-900 border border-slate-700 rounded p-3 text-sm h-24 font-mono"
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
          disabled={loading}
          className="w-full bg-emerald-600 hover:bg-emerald-500 py-3 rounded font-medium disabled:opacity-50"
        >
          {loading ? 'Running Screener...' : 'RUN SCREENER'}
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-6 overflow-auto">
        <div className="flex gap-4 mb-6 border-b border-slate-800 pb-4">
          <button onClick={() => setMode('auto')} className={`px-6 py-2 rounded ${mode === 'auto' ? 'bg-white text-black' : 'bg-slate-800'}`}>Full Auto</button>
          <button onClick={() => setMode('semi')} className={`px-6 py-2 rounded ${mode === 'semi' ? 'bg-white text-black' : 'bg-slate-800'}`}>Semi-Manual</button>
          <button onClick={() => setMode('dashboard')} className={`px-6 py-2 rounded ${mode === 'dashboard' ? 'bg-white text-black' : 'bg-slate-800'}`}>Dashboard</button>
        </div>

        {results.length > 0 ? (
          <div className="space-y-4">
            {results.map((result) => (
              <div key={result.symbol} className={`border rounded-lg p-4 ${result.qualified ? 'border-emerald-500/30 bg-emerald-950/10' : 'border-slate-700'}`}>
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-xl font-bold">{result.symbol}</span>
                    <span className="ml-3 text-sm px-2 py-1 rounded bg-slate-700">{result.strategy}</span>
                  </div>
                  {result.qualified && <span className="text-emerald-400 font-medium">✅ QUALIFIED</span>}
                </div>

                {result.bestCandidate && (
                  <div className="mt-3 text-sm">
                    <div>Short: {result.bestCandidate.shortStrike} | Long: {result.bestCandidate.longStrike}</div>
                    <div>Credit: ${result.bestCandidate.credit.toFixed(2)} ({(result.bestCandidate.creditRatio * 100).toFixed(0)}% of width)</div>
                  </div>
                )}

                <div className="mt-4 flex gap-2 flex-wrap">
                  {Object.entries(result.checks).map(([key, check]) => (
                    <div key={key} className="flex items-center gap-1 text-xs">
                      <span className="text-slate-500">{CHECK_LABELS[key] || key}</span>
                      <Badge status={check.status} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-slate-500">
            Enter tickers and click RUN SCREENER
          </div>
        )}
      </div>
    </div>
  );
}
