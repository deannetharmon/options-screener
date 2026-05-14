// app/login/page.tsx
'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const BASE = 'https://api.tastytrade.com';
const CLIENT_ID = '4d4c851b-bdaf-4ac9-b39b-811e604739f2';

// ── Debug logger ──────────────────────────────────────────────────────────────
// Shows in the UI as a collapsible panel AND in the browser console.
type LogEntry = { time: string; level: 'info' | 'warn' | 'error'; msg: string };
let _setLog: React.Dispatch<React.SetStateAction<LogEntry[]>> | null = null;
function dbg(level: LogEntry['level'], msg: string) {
  const entry: LogEntry = { time: new Date().toISOString().slice(11, 23), level, msg };
  console[level === 'info' ? 'log' : level]('[AuthDebug]', msg);
  _setLog?.(prev => [...prev.slice(-49), entry]); // keep last 50
}

async function loginWithPassword(
  username: string, password: string, clientSecret: string
): Promise<{ accessToken: string; refreshToken: string }> {
  dbg('info', `loginWithPassword → POST ${BASE}/oauth/token`);
  dbg('info', `Payload: grant_type=password, client_id=${CLIENT_ID}, username=${username}, secret_length=${clientSecret.length}`);
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      username,
      password,
      client_id: CLIENT_ID,
      client_secret: clientSecret,
    }),
  });
  const data = await res.json();
  dbg(res.ok ? 'info' : 'error', `Response ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  if (!res.ok) throw new Error(data?.error_description ?? data?.error ?? `HTTP ${res.status}`);
  if (!data.access_token) throw new Error('No access_token in response');
  if (!data.refresh_token) {
    dbg('warn', 'No refresh_token returned — app may be missing offline_access scope');
    throw new Error('No refresh_token returned — ensure your OAuth app has offline_access scope enabled in TastyTrade');
  }
  dbg('info', `Got access_token (${data.access_token.slice(0,8)}…) and refresh_token (${data.refresh_token.slice(0,8)}…)`);
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

async function refreshAccessToken(refreshToken: string, clientSecret: string): Promise<string> {
  dbg('info', `refreshAccessToken → POST ${BASE}/oauth/token`);
  dbg('info', `Payload: grant_type=refresh_token, client_id=${CLIENT_ID}, refresh_token=${refreshToken.slice(0,8)}…, secret_length=${clientSecret.length}`);
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: clientSecret,
    }),
  });
  const data = await res.json();
  dbg(res.ok ? 'info' : 'error', `Response ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  if (!res.ok) throw new Error(data?.error_description ?? data?.error ?? `HTTP ${res.status}`);
  if (!data.access_token) throw new Error('No access_token in response');
  dbg('info', `Got access_token (${data.access_token.slice(0,8)}…)`);
  return data.access_token;
}

// ── Eye icon ──────────────────────────────────────────────────────────────────
function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12C3.75 7.5 7.5 4.5 12 4.5s8.25 3 9.75 7.5c-1.5 4.5-5.25 7.5-9.75 7.5S3.75 16.5 2.25 12z" />
      <circle cx="12" cy="12" r="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 002.25 12c1.5 4.5 5.25 7.5 9.75 7.5 1.76 0 3.42-.44 4.865-1.22M6.53 6.53A9.77 9.77 0 0112 4.5c4.5 0 8.25 3 9.75 7.5a10.49 10.49 0 01-2.34 3.71M6.53 6.53L3 3m3.53 3.53l10.94 10.94M16.47 16.47L21 21" />
    </svg>
  );
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState(searchParams.get('error') ?? '');
  const [isLoading, setIsLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [isReauth, setIsReauth] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showDebug, setShowDebug] = useState(false);

  // Wire up the global logger to this component's state
  useEffect(() => { _setLog = setLogs; return () => { _setLog = null; }; }, []);

  useEffect(() => {
    const storedRefresh = localStorage.getItem('tt_refresh_token');
    const storedSecret = localStorage.getItem('tt_client_secret');
    dbg('info', `Stored refresh_token: ${storedRefresh ? storedRefresh.slice(0,8)+'…' : 'NONE'}`);
    dbg('info', `Stored client_secret: ${storedSecret ? `length ${storedSecret.length}` : 'NONE'}`);

    if (storedRefresh && storedSecret) {
      dbg('info', 'Attempting silent auto-login with stored tokens…');
      refreshAccessToken(storedRefresh, storedSecret)
        .then(accessToken => {
          sessionStorage.setItem('tt_access_token', accessToken);
          dbg('info', 'Auto-login success → redirecting to /portfolio');
          router.replace('/portfolio');
        })
        .catch((e: any) => {
          dbg('error', `Auto-login failed: ${e.message}`);
          setClientSecret(storedSecret);
          setIsReauth(true);
          setError("Session expired — sign in with your TastyTrade username and password to reconnect.");
          setShowForm(true);
          setShowDebug(true); // auto-open debug panel on failure so user can see what happened
        });
    } else {
      dbg('info', 'No stored tokens — showing first-time login form');
      setShowForm(true);
    }
  }, [router]);

  const handleLogin = async () => {
    if (!username.trim()) { setError('Please enter your TastyTrade username'); return; }
    if (!password.trim()) { setError('Please enter your password'); return; }
    if (!clientSecret.trim()) { setError('Please enter your Client Secret'); return; }
    setIsLoading(true);
    setError('');
    try {
      const { accessToken, refreshToken } = await loginWithPassword(
        username.trim(), password.trim(), clientSecret.trim()
      );
      localStorage.setItem('tt_refresh_token', refreshToken);
      localStorage.setItem('tt_client_secret', clientSecret.trim());
      sessionStorage.setItem('tt_access_token', accessToken);
      dbg('info', 'Login success → redirecting to /portfolio');
      router.push('/portfolio');
    } catch (e: any) {
      setError(e.message || 'Login failed');
      setShowDebug(true);
    }
    setIsLoading(false);
  };

  const onEnter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') handleLogin(); };

  const logColor = (l: LogEntry['level']) =>
    l === 'error' ? 'text-red-400' : l === 'warn' ? 'text-yellow-400' : 'text-emerald-400';

  if (!showForm) {
    return (
      <div className="flex flex-col items-center gap-3">
        <div className="text-white/40 text-xs tracking-widest" style={{ fontFamily: "'DM Mono', monospace" }}>
          CONNECTING...
        </div>
        {logs.length > 0 && (
          <button onClick={() => setShowDebug(v => !v)} className="text-[9px] text-white/20 hover:text-white/40 tracking-widest">
            {showDebug ? 'HIDE DEBUG' : 'SHOW DEBUG'}
          </button>
        )}
        {showDebug && <DebugPanel logs={logs} />}
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <div className="text-center mb-10">
        <h1 className="text-xl font-bold tracking-widest text-white" style={{ fontFamily: "'DM Mono', monospace" }}>
          OPTIONS HUNTER
        </h1>
        <p className="text-[10px] text-white/40 mt-1 tracking-wider" style={{ fontFamily: "'DM Mono', monospace" }}>
          BPS · BCS · IRON CONDOR
        </p>
      </div>

      <div className="bg-[#111] border border-[#222] rounded-2xl p-8">
        {isReauth ? (
          <>
            <h2 className="text-sm font-bold text-white tracking-wider mb-2">SESSION EXPIRED</h2>
            <p className="text-xs text-white/40 mb-6 leading-relaxed">
              Sign in with your TastyTrade credentials to reconnect. This happens every few months.
            </p>
          </>
        ) : (
          <>
            <h2 className="text-sm font-bold text-white tracking-wider mb-2">CONNECT YOUR ACCOUNT</h2>
            <p className="text-xs text-white/40 mb-6 leading-relaxed">
              Sign in once — token refresh is automatic from here.
            </p>
            <div className="mb-4 bg-white/5 border border-white/10 rounded-lg p-3">
              <p className="text-[10px] text-white/50 leading-relaxed">
                <span className="text-white/70 font-bold">One-time setup — Client Secret:</span><br />
                1. Log in to tastytrade.com<br />
                2. Settings → API / OAuth Applications → your app<br />
                3. Copy your <span className="text-white/70">Client Secret</span> and paste below
              </p>
            </div>
          </>
        )}

        <div className="space-y-3 mb-4">
          {/* Username */}
          <div>
            <label className="text-[10px] text-white/40 tracking-wider uppercase">TastyTrade Username</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              onKeyDown={onEnter}
              autoComplete="username"
              className="mt-1 w-full px-4 py-3 bg-[#0a0a0a] border border-[#2c2c2c] rounded-lg text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-white/30 transition-colors font-mono"
              placeholder="your username or email"
            />
          </div>

          {/* Password with eye toggle */}
          <div>
            <label className="text-[10px] text-white/40 tracking-wider uppercase">Password</label>
            <div className="relative mt-1">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={onEnter}
                autoComplete="current-password"
                className="w-full px-4 py-3 pr-11 bg-[#0a0a0a] border border-[#2c2c2c] rounded-lg text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-white/30 transition-colors font-mono"
                placeholder="your password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70 transition-colors"
                tabIndex={-1}
              >
                <EyeIcon open={showPassword} />
              </button>
            </div>
          </div>

          {/* Client Secret with eye toggle — hidden on re-auth */}
          {!isReauth && (
            <div>
              <label className="text-[10px] text-white/40 tracking-wider uppercase">Client Secret</label>
              <div className="relative mt-1">
                <input
                  type={showSecret ? 'text' : 'password'}
                  value={clientSecret}
                  onChange={e => setClientSecret(e.target.value)}
                  onKeyDown={onEnter}
                  className="w-full px-4 py-3 pr-11 bg-[#0a0a0a] border border-[#2c2c2c] rounded-lg text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-white/30 transition-colors font-mono"
                  placeholder="your OAuth client secret"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70 transition-colors"
                  tabIndex={-1}
                >
                  <EyeIcon open={showSecret} />
                </button>
              </div>
            </div>
          )}
        </div>

        {isReauth && (
          <p className="text-[10px] text-white/30 mb-4">
            Your Client Secret is already saved — only username and password needed.
          </p>
        )}

        {error && (
          <div className="mb-4 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 leading-relaxed">
            {error}
          </div>
        )}

        <button
          onClick={handleLogin}
          disabled={isLoading}
          className="w-full py-3 bg-white text-black rounded-lg text-xs font-bold tracking-widest hover:bg-white/90 transition-colors disabled:opacity-40">
          {isLoading ? 'CONNECTING...' : isReauth ? 'RECONNECT →' : 'CONNECT →'}
        </button>

        {/* Debug toggle */}
        <div className="mt-4 text-center">
          <button
            onClick={() => setShowDebug(v => !v)}
            className="text-[9px] text-white/20 hover:text-white/40 tracking-widest transition-colors"
          >
            {showDebug ? '▲ HIDE DEBUG LOG' : '▼ SHOW DEBUG LOG'}
          </button>
        </div>

        {showDebug && <DebugPanel logs={logs} />}

        <p className="text-[10px] text-white/20 text-center mt-4 leading-relaxed">
          Credentials stored locally. Never sent to our servers.
        </p>
      </div>
    </div>
  );
}

function DebugPanel({ logs }: { logs: LogEntry[] }) {
  const logColor = (l: LogEntry['level']) =>
    l === 'error' ? 'text-red-400' : l === 'warn' ? 'text-yellow-400' : 'text-emerald-400/80';
  return (
    <div className="mt-3 bg-black border border-white/10 rounded-lg p-3 max-h-48 overflow-auto">
      <p className="text-[9px] text-white/30 tracking-widest mb-2 font-bold">DEBUG LOG</p>
      {logs.length === 0
        ? <p className="text-[9px] text-white/20">No events yet — hit Connect to start.</p>
        : logs.map((l, i) => (
          <div key={i} className="flex gap-2 text-[9px] font-mono leading-relaxed">
            <span className="text-white/20 shrink-0">{l.time}</span>
            <span className={`${logColor(l.level)} break-all`}>{l.msg}</span>
          </div>
        ))
      }
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] p-4"
      style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');`}</style>
      <Suspense fallback={<div className="text-white/40 text-xs tracking-widest">LOADING...</div>}>
        <LoginContent />
      </Suspense>
    </div>
  );
}
