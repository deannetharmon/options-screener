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
