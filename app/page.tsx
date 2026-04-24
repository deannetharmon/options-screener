'use client';

import { useState, useRef, useCallback } from 'react';
import { ScreenResult } from '@/lib/screener';
import { BarchartRow } from '@/lib/csvParser';

const DEFAULT_TICKERS = 'MU, MRVL, ORCL, VRT, CRWD, AMD, NVDA, MSFT, AMZN, META';

type Mode = 'auto' | 'semi' | 'dashboard';
type Trend = 'uptrend' | 'downtrend' | 'sideways' | null;

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
        <button key={t} onClick={() => onChange(value === t ? null : t)}
          className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-all ${
            value === t
              ? t === 'uptrend' ? 'bg-emerald-500 text-white'
                : t === 'downtrend' ? 'bg-red-500 text-white'
                : 'bg-blue-500 text-white'
              : 'bg-slate-700 text-slate-400 hover:bg-slate-600 hover:text-slate-200'
          }`}>
          {t === 'uptrend' ? '↑ Up' : t === 'downtrend' ? '↓ Down' : '→ Flat'}
        </button>
      ))}
    </div>
  );
}

function FilterPanel({ filters, setFilters }: {
  filters: { minIVR: number; minIVx: number; minPrice: number; minOptVol: number };
  setFilters: (f: typeof filters) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] text-slate-500 uppercase tracking-wider">Pre-Filters</p>
      {([
        ['Min IVR %', 'minIVR', 5],
        ['Min IVx %', 'minIVx', 5],
        ['Min Price $', 'minPrice', 10],
        ['Min Opt Vol', 'minOptVol', 5000],
      ] as [string, keyof typeof filters, number][]).map(([label, key, step]) => (
        <div key={key} className="flex items-center justify-between gap-2">
          <label className="text-[10px] text-slate-400">{label}</label>
          <input type="number" value={filters[key]} step={step}
            onChange={(e) => setFilters({ ...filters, [key]: parseFloat(e.target.value) || 0 })}
            className="w-20 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-[10px] text-slate-200 text-right focus:outline-none focus:border-cyan-500" />
        </div>
      ))}
    </div>
  );
}

function CSVUpload({ filters, onLoad }: {
  filters: { minIVR: number; minIVx: number; minPrice: number; minOptVol: number };
  onLoad: (symbols: string[], rows: BarchartRow[]) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<{ total: number; filtered: number } | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const processFile = async (file: File) => {
    setLoading(true); setError(''); setSummary(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      Object.entries(filters).forEach(([k, v]) => fd.append(k.replace('min', 'min'), v.toString()));
      fd.append('minIVR', filters.minIVR.toString());
      fd.append('minIVx', filters.minIVx.toString());
      fd.append('minPrice', filters.minPrice.toString());
      fd.append('minOptVol', filters.minOptVol.toString());

      const res = await fetch('/api/csv', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSummary({ total: data.total, filtered: data.filtered });
      onLoad(data.rows.map((r: BarchartRow) => r.symbol), data.rows);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-[10px] text-slate-500 uppercase tracking-wider">Barchart CSV</p>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) processFile(f); }}
        onClick={() => fileRef.current?.click()}
        className={`border-2 border-dashed rounded-lg p-3 text-center cursor-pointer transition-colors ${dragging ? 'border-cyan-500 bg-cyan-950/20' : 'border-slate-700 hover:border-slate-600'}`}>
        <input ref={fileRef} type="file" accept=".csv" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) processFile(f); }} />
        {loading
          ? <div className="flex items-center justify-center gap-2 text-xs text-slate-400">
              <div className="w-3 h-3 border border-cyan-500 border-t-transparent rounded-full animate-spin" />
              Parsing...
            </div>
          : <div className="text-[10px] text-slate-500">
              <div className="text-slate-400 text-xs mb-0.5">Drop CSV here</div>
              click to browse
            </div>
        }
      </div>
      {summary && (
        <div className="flex justify-between text-[10px]">
          <span className="text-slate-500">{summary.total} total</span>
          <span className="text-cyan-400 font-medium">{summary.filtered} passed filters</span>
        </div>
      )}
      {error && <p className="text-[10px] text-red-400">{error}</p>}
      <p className="text-[10px] text-slate-600 leading-tight">
        barchart.com → Options → Highest IV Rank → Download CSV
      </p>
    </div>
  );
}

function ResultCard({ result, trends, setTrends, mode, csvRow }: {
  result: ScreenResult;
  trends: Record<string, Trend>;
  setTrends: React.Dispatch<React.SetStateAction<Record<string, Trend>>>;
  mode: Mode;
  csvRow?: BarchartRow;
}) {
  const [expanded, setExpanded] = useState(result.qualified);

  return (
    <div className={`border rounded-lg overflow-hidden ${result.qualified ? 'border-emerald-500/30 bg-emerald-950/10' : 'border-slate-700/40 bg-slate-800/20'}`}>
      <div className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-slate-700/10" onClick={() => setExpanded(!expanded)}>
        {/* Symbol */}
        <div className="flex items-center gap-2 w-28">
          <span className="text-sm font-bold text-white">{result.symbol}</span>
          {result.strategy !== 'UNKNOWN' && (
            <span className={`text-[9px] font-bold px-1 py-0.5 rounded ${
              result.strategy === 'BPS' ? 'bg-emerald-500/20 text-emerald-300' :
              result.strategy === 'BCS' ? 'bg-red-500/20 text-red-300' :
              'bg-blue-500/20 text-blue-300'}`}>
              {result.strategy}
            </span>
          )}
        </div>

        {/* CSV data */}
        {csvRow && (
          <div className="flex gap-3 text-[10px] w-36">
            <span className="text-slate-500">IVR <span className="text-slate-300">{csvRow.ivRank.toFixed(0)}%</span></span>
            <span className="text-slate-500">IVx <span className="text-slate-300">{csvRow.ivx.toFixed(0)}%</span></span>
          </div>
        )}

        {/* Badges */}
        <div className="flex items-center gap-1.5 flex-1">
          {Object.entries(result.checks).map(([key, check]) => (
            <div key={key} title={`${CHECK_LABELS[key]}: ${check.value} — ${check.reason}`} className="flex items-center gap-0.5">
              <span className="text-[9px] text-slate-600">{key === 'earnings' ? 'earn' : key}</span>
              <Badge status={check.status} />
            </div>
          ))}
        </div>

        {/* Result */}
        {result.bestCandidate ? (
          <div className="text-[10px] text-right w-40">
            <div className="text-emerald-400 font-semibold">${result.bestCandidate.shortStrike}/{result.bestCandidate.longStrike} · {result.bestCandidate.dte}d</div>
            <div className="text-slate-400">${result.bestCandidate.credit.toFixed(2)} cr · δ{result.bestCandidate.shortDelta.toFixed(2)}</div>
          </div>
        ) : result.failReasons[0] ? (
          <div className="text-[10px] text-red-400 text-right w-40 truncate">{result.failReasons[0]}</div>
        ) : null}

        {/* Trend picker inline for semi mode */}
        {mode === 'semi' && (
          <div onClick={(e) => e.stopPropagation()}>
            <TrendPicker value={trends[result.symbol] || null} onChange={(t) => setTrends((p) => ({ ...p, [result.symbol]: t }))} />
          </div>
        )}

        <span className="text-[10px] text-slate-700">{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className="border-t border-slate-700/40 px-4 py-3 space-y-3">
          {/* Check grid */}
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(result.checks).map(([key, check]) => (
              <div key={key} className="bg-slate-800/40 rounded p-2 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-slate-400">{CHECK_LABELS[key]}</span>
                  <Badge status={check.status} />
                </div>
                <div className="text-[11px] font-mono text-slate-200">{check.value}</div>
                <div className="text-[10px] text-slate-500 leading-tight">{check.reason}</div>
              </div>
            ))}
          </div>

          {/* Trade recommendation */}
          {result.bestCandidate && (
            <div className="bg-emerald-950/30 border border-emerald-500/20 rounded-lg p-3">
              <p className="text-[10px] text-emerald-400 font-bold uppercase tracking-widest mb-2">Recommended Trade</p>
              <div className="grid grid-cols-4 gap-x-4 gap-y-2 text-[10px]">
                {[
                  ['Strategy', result.bestCandidate.strategy],
                  ['Expiry', `${result.bestCandidate.expiration} (${result.bestCandidate.dte}d)`],
                  ['Short Strike', `$${result.bestCandidate.shortStrike}`],
                  ['Long Strike', `$${result.bestCandidate.longStrike}`],
                  ['Delta', result.bestCandidate.shortDelta.toFixed(2)],
                  ['Credit (MID)', `$${result.bestCandidate.credit.toFixed(2)}`],
                  ['Width', `$${result.bestCandidate.spreadWidth}`],
                  ['Credit Ratio', `${(result.bestCandidate.creditRatio * 100).toFixed(0)}%`],
                ].map(([l, v]) => (
                  <div key={l}>
                    <div className="text-slate-500">{l}</div>
                    <div className="text-white font-medium">{v}</div>
                  </div>
                ))}
              </div>
              <div className="mt-2 pt-2 border-t border-emerald-500/10 text-[10px] text-slate-500">
                GTC close at ${(result.bestCandidate.credit * 0.5).toFixed(2)} (50% profit) · Hard close at 21 DTE
              </div>
            </div>
          )}

          {/* Links */}
          <div className="flex gap-4 text-[10px]">
            <a href={`https://www.tradingview.com/chart/?symbol=${result.symbol}`} target="_blank" rel="noopener noreferrer"
              className="text-cyan-400 hover:text-cyan-300">📈 TradingView ↗</a>
            <a href={`https://earningswhispers.com/stocks/${result.symbol.toLowerCase()}`} target="_blank" rel="noopener noreferrer"
              className="text-slate-400 hover:text-slate-300">📅 Earnings Whispers ↗</a>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  const border: Record<string, string> = { emerald: 'border-l-emerald-500', amber: 'border-l-amber-500', red: 'border-l-red-500' };
  return (
    <div className="space-y-1.5">
      <h2 className={`text-[10px] font-bold uppercase tracking-widest text-slate-400 border-l-2 pl-2.5 ${border[accent]}`}>{title}</h2>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

export default function Home() {
  const [mode, setMode] = useState<Mode>('semi');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [tickerInput, setTickerInput] = useState(DEFAULT_TICKERS);
  const [csvRows, setCsvRows] = useState<BarchartRow[]>([]);
  const [trends, setTrends] = useState<Record<string, Trend>>({});
  const [results, setResults] = useState<ScreenResult[]>([]);
  const [screening, setScreening] = useState(false);
  const [screenError, setScreenError] = useState('');
  const [progress, setProgress] = useState('');
  const [filters, setFilters] = useState({ minIVR: 30, minIVx: 35, minPrice: 50, minOptVol: 10000 });

  const csvRowMap = Object.fromEntries(csvRows.map((r) => [r.symbol, r]));

  const handleLogin = async () => {
    setLoginLoading(true); setLoginError('');
    try {
      const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      setToken(data.token);
    } catch (e: any) { setLoginError(e.message); }
    finally { setLoginLoading(false); }
  };

  const handleCSVLoad = useCallback((symbols: string[], rows: BarchartRow[]) => {
    setCsvRows(rows);
    setTickerInput(symbols.join(', '));
  }, []);

  const handleScreen = async () => {
    setScreening(true); setScreenError(''); setResults([]);
    const symbols = tickerInput.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (!symbols.length) { setScreenError('No tickers'); setScreening(false); return; }
    setProgress(`Screening ${symbols.length} tickers...`);
    try {
      const res = await fetch('/api/screen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbols, token, trends }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResults(data.results);
    } catch (e: any) { setScreenError(e.message); }
    finally { setScreening(false); setProgress(''); }
  };

  const qualified = results.filter((r) => r.qualified);
  const needsReview = results.filter((r) => !r.qualified && r.checks.ivr.status === 'pass' && r.checks.ivx.status === 'pass' && r.checks.earnings.status === 'pass');
  const failed = results.filter((r) => !r.qualified && !needsReview.includes(r));

  return (
    <div className="min-h-screen bg-[#080c18] text-slate-100" style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
      <header className="h-12 border-b border-slate-800/80 flex items-center justify-between px-5 bg-[#080c18]/95 backdrop-blur sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="flex gap-0.5">
            {['bg-emerald-400', 'bg-cyan-400', 'bg-blue-400'].map((c) => <div key={c} className={`w-2 h-2 rounded-full ${c}`} />)}
          </div>
          <span className="text-xs font-bold tracking-widest text-white uppercase">Options Screener</span>
          <span className="text-[10px] text-slate-600">BPS · BCS · IC</span>
        </div>

        <div className="flex items-center gap-0.5 bg-slate-800/60 rounded-md p-0.5">
          {([['auto', '⚡ Auto'], ['semi', '🔍 Semi'], ['dashboard', '📊 Board']] as [Mode, string][]).map(([m, label]) => (
            <button key={m} onClick={() => setMode(m)} className={`px-3 py-1 rounded text-[10px] font-semibold transition-all ${mode === m ? 'bg-slate-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}>{label}</button>
          ))}
        </div>

        <div className={`flex items-center gap-1.5 text-[10px] ${token ? 'text-emerald-400' : 'text-slate-600'}`}>
          <div className={`w-1.5 h-1.5 rounded-full ${token ? 'bg-emerald-400 shadow-[0_0_4px_#34d399]' : 'bg-slate-700'}`} />
          {token ? 'TastyTrade Connected' : 'Not connected'}
        </div>
      </header>

      <div className="flex h-[calc(100vh-48px)]">
        <aside className="w-64 border-r border-slate-800/60 flex flex-col overflow-y-auto bg-[#090d19]">
          <div className="p-4 space-y-4">
            {!token ? (
              <div className="space-y-2">
                <p className="text-[10px] text-slate-500 uppercase tracking-wider">TastyTrade Login</p>
                <input type="text" placeholder="Email / Username" value={username} onChange={(e) => setUsername(e.target.value)}
                  className="w-full bg-slate-800/60 border border-slate-700/60 rounded px-2.5 py-1.5 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500/60" />
                <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                  className="w-full bg-slate-800/60 border border-slate-700/60 rounded px-2.5 py-1.5 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500/60" />
                {loginError && <p className="text-[10px] text-red-400">{loginError}</p>}
                <button onClick={handleLogin} disabled={loginLoading} className="w-full bg-cyan-600/80 hover:bg-cyan-500 disabled:bg-slate-700 text-white text-[11px] font-semibold py-1.5 rounded transition-colors">
                  {loginLoading ? 'Connecting...' : 'Connect'}
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-emerald-400">✓ Connected</span>
                <button onClick={() => setToken('')} className="text-[10px] text-slate-600 hover:text-slate-400">Disconnect</button>
              </div>
            )}

            <div className="border-t border-slate-800/60" />
            <CSVUpload filters={filters} onLoad={handleCSVLoad} />
            <div className="border-t border-slate-800/60" />

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[10px] text-slate-500 uppercase tracking-wider">Tickers</p>
                <span className="text-[10px] text-slate-600">{tickerInput.split(/[\s,]+/).filter(Boolean).length}</span>
              </div>
              <textarea value={tickerInput} onChange={(e) => setTickerInput(e.target.value)} rows={4} placeholder="MU, MRVL, ORCL..."
                className="w-full bg-slate-800/60 border border-slate-700/60 rounded px-2.5 py-2 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500/60 resize-none" />
            </div>

            <div className="border-t border-slate-800/60" />
            <FilterPanel filters={filters} setFilters={setFilters} />
            <div className="border-t border-slate-800/60" />

            <div className="space-y-1.5">
              <p className="text-[10px] text-slate-500 uppercase tracking-wider">Course Rules</p>
              {[['IVR','≥ 30% (spreads: no cap)'],['IVx','≥ 35%'],['OI','≥ 500 both legs'],['Delta','0.15 – 0.22'],['Credit','≥ ⅓ width'],['DTE','21 – 45 days'],['Earnings','Must clear expiry']].map(([l,r]) => (
                <div key={l} className="flex gap-2 text-[10px]"><span className="text-slate-600 w-12 shrink-0">{l}</span><span className="text-slate-500">{r}</span></div>
              ))}
            </div>
          </div>

          <div className="mt-auto p-4 border-t border-slate-800/60">
            <button onClick={handleScreen} disabled={!token || screening}
              className="w-full bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500 text-white text-[11px] font-bold py-2.5 rounded transition-all uppercase tracking-widest">
              {screening ? (progress || 'Running...') : '▶ Run Screener'}
            </button>
            {screenError && <p className="text-[10px] text-red-400 mt-2">{screenError}</p>}
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto p-5 space-y-5">
          {results.length === 0 && !screening && (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
              <div className="w-14 h-14 rounded-full bg-slate-800/60 flex items-center justify-center text-2xl">📡</div>
              <div>
                <p className="text-slate-300 text-sm font-medium">Ready to screen</p>
                <p className="text-slate-600 text-xs mt-1 max-w-xs">Connect TastyTrade, enter tickers or upload a Barchart CSV, then run.</p>
              </div>
              <div className="grid grid-cols-3 gap-3 mt-2 max-w-sm w-full">
                {[['1','Connect','Login with your TastyTrade account'],['2','Load Tickers','Type symbols or upload Barchart CSV'],['3','Run','Full checklist runs automatically']].map(([n,t,d]) => (
                  <div key={n} className="bg-slate-800/30 border border-slate-700/40 rounded-lg p-3 text-left">
                    <div className="text-[10px] text-cyan-400 font-bold mb-1">Step {n}</div>
                    <div className="text-[11px] text-slate-200 font-medium">{t}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">{d}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {screening && (
            <div className="flex items-center justify-center h-64 gap-3">
              <div className="w-5 h-5 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-slate-400 text-xs">{progress}</p>
            </div>
          )}

          {results.length > 0 && (
            <>
              <div className="flex items-center gap-3">
                {[
                  { label: 'Qualified', count: qualified.length, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
                  { label: 'Review Chart', count: needsReview.length, color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' },
                  { label: 'Failed', count: failed.length, color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20' },
                  { label: 'Total', count: results.length, color: 'text-slate-300', bg: 'bg-slate-700/30 border-slate-700/40' },
                ].map(({ label, count, color, bg }) => (
                  <div key={label} className={`border rounded-lg px-4 py-2 text-center ${bg}`}>
                    <div className={`text-lg font-bold ${color}`}>{count}</div>
                    <div className="text-[10px] text-slate-500">{label}</div>
                  </div>
                ))}
                <button onClick={handleScreen} disabled={screening} className="ml-auto text-[10px] text-slate-400 hover:text-slate-200 border border-slate-700 hover:border-slate-600 px-3 py-1.5 rounded transition-colors">↻ Re-run</button>
              </div>

              {qualified.length > 0 && <Section title="✅ Qualified Trades" accent="emerald">{qualified.map((r) => <ResultCard key={r.symbol} result={r} trends={trends} setTrends={setTrends} mode={mode} csvRow={csvRowMap[r.symbol]} />)}</Section>}
              {needsReview.length > 0 && <Section title={`🔍 Needs Chart Review${mode === 'semi' ? ' — set trend below' : ''}`} accent="amber">{needsReview.map((r) => <ResultCard key={r.symbol} result={r} trends={trends} setTrends={setTrends} mode={mode} csvRow={csvRowMap[r.symbol]} />)}</Section>}
              {failed.length > 0 && <Section title="❌ Failed Pre-Filters" accent="red">{failed.map((r) => <ResultCard key={r.symbol} result={r} trends={trends} setTrends={setTrends} mode={mode} csvRow={csvRowMap[r.symbol]} />)}</Section>}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
