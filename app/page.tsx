// app/page.tsx (key sections updated — replace the whole file if easier)
'use client';

import { useState } from 'react';
// ... (keep all your existing imports and components)

const DEFAULT_TICKERS = 'MU, MRVL, ORCL, VRT, CRWD, AMD, NVDA, MSFT, AMZN, META, JPM, XOM, KO, CAT';

function FilterPanel(...) { /* keep as is */ }

function ResultCard(...) { /* keep as is */ }

// In the sidebar COURSE RULES section:
<div className="space-y-1 text-[10px]">
  <p className="text-slate-400 uppercase">COURSE RULES</p>
  <div>IVR ≥ 30%</div>
  <div>IVx ≥ 35%</div>
  <div>OI ≥ 500 both legs</div>
  <div>Delta 0.15 – 0.22</div>
  <div>Credit ≥ ⅓ width</div>
  <div>DTE 21 – 45 days</div>
  <div>No earnings in window</div>
</div>
