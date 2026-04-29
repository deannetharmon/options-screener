'use client';

import { useState, useRef, useCallback } from 'react';
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

// Keep your existing FilterPanel, CSVUpload, ResultCard components here...
// (Copy them from your previous working version if they are missing)

export default function Home() {
  // ... your existing state and logic ...

  return (
    <div className="..."> {/* your layout */}
      {/* Sidebar with updated COURSE RULES */}
      <div className="space-y-1 text-[10px] text-slate-300">
        <p className="uppercase tracking-wider text-slate-400">COURSE RULES</p>
        <div>IVR ≥ 30%</div>
        <div>IVx ≥ 35%</div>
        <div>OI ≥ 500 both legs</div>
        <div>Delta 0.15 – 0.22</div>
        <div>Credit ≥ ⅓ width</div>
        <div>DTE 21 – 45 days</div>
        <div>No earnings in window</div>
      </div>
    </div>
  );
}
