'use client';
import { useState, useEffect } from 'react';

type Theme = 'dark' | 'medium' | 'light';
const LS_THEME = 'prosper-theme';

const THEMES = {
  dark: {
    bg: 'bg-[#080c14]', sidebar: 'bg-[#0d1117]',
    border: 'border-slate-700', header: 'bg-gradient-to-r from-[#0d1117] to-[#080c14]',
    text: 'text-white', textMuted: 'text-slate-200', textFaint: 'text-slate-400',
    input: 'bg-slate-800', card: 'bg-slate-900/60', label: 'text-slate-300',
  },
  medium: {
    bg: 'bg-[#1a1f2e]', sidebar: 'bg-[#1e2436]',
    border: 'border-slate-600', header: 'bg-gradient-to-r from-[#1e2436] to-[#1a1f2e]',
    text: 'text-white', textMuted: 'text-slate-200', textFaint: 'text-slate-400',
    input: 'bg-[#1a1f2e]', card: 'bg-[#222840]/80', label: 'text-slate-300',
  },
  light: {
    bg: 'bg-slate-50', sidebar: 'bg-white',
    border: 'border-slate-300', header: 'bg-gradient-to-r from-slate-800 to-slate-900',
    text: 'text-slate-950', textMuted: 'text-slate-900', textFaint: 'text-slate-700',
    input: 'bg-slate-50', card: 'bg-white', label: 'text-slate-800',
  },
};

function getSavedTheme(): Theme {
  try { const t = localStorage.getItem(LS_THEME); return (t === 'dark' || t === 'medium' || t === 'light') ? t : 'dark'; }
  catch { return 'dark'; }
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
  th: typeof THEMES[Theme];
}
function Section({ title, children, th }: SectionProps) {
  return (
    <div className={`border ${th.border} ${th.card} rounded-xl p-6 space-y-3`}>
      <h2 className={`text-xs font-bold tracking-widest ${th.textMuted} uppercase border-b ${th.border} pb-2`}>{title}</h2>
      {children}
    </div>
  );
}

interface RuleRowProps {
  label: string;
  value: string;
  desc: string;
  th: typeof THEMES[Theme];
}
function RuleRow({ label, value, desc, th }: RuleRowProps) {
  return (
    <div className={`flex gap-4 py-2 border-b ${th.border} last:border-0`}>
      <div className="w-40 shrink-0">
        <p className={`text-[10px] font-bold ${th.textMuted} uppercase tracking-wider`}>{label}</p>
        <p className="text-[10px] text-blue-400 font-medium mt-0.5">{value}</p>
      </div>
      <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>{desc}</p>
    </div>
  );
}

export default function HelpPage() {
  const [theme, setTheme] = useState<Theme>('dark');
  useEffect(() => { setTheme(getSavedTheme()); }, []);
  const th = THEMES[theme];

  return (
    <div className={`min-h-screen ${th.bg} font-mono transition-colors duration-200`}>
      {/* Header */}
      <div className={`${th.header} border-b ${th.border} px-6 py-4 flex items-center justify-between`}>
        <div>
          <a href="/" className={`text-[10px] ${th.textFaint} hover:text-blue-400 transition-colors tracking-wider`}>← Back to Screener</a>
          <h1 className="text-base font-bold tracking-widest text-white mt-1">OPTIONS HUNTER</h1>
          <p className="text-[10px] text-white/50 tracking-wider">Help & Reference Guide</p>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">

        {/* Overview */}
        <Section title="Overview" th={th}>
          <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>
            OPTIONS HUNTER helps you find qualifying options trades using the Prosper trading rules. It screens stocks for Bull Put Spreads (BPS), Bear Call Spreads (BCS), and Iron Condors (IC) using real-time data from TastyTrade.
          </p>
          <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>
            The screener applies your rules automatically — IVR check, earnings check, chain liquidity, delta, credit ratio, and ROC — and returns only qualifying setups.
          </p>
        </Section>

        {/* Workflow */}
        <Section title="Screening Workflow" th={th}>
          <div className="space-y-3">
            {[
              { step: '1', title: 'Finviz', desc: 'Run your Finviz screen (S&P 500, large cap, optionable, 500K+ avg volume). Upload a screenshot using the ↑ img button to automatically extract tickers via OCR.' },
              { step: '2', title: 'Add Tickers', desc: 'Paste tickers into the BPS, BCS, or IC scan list boxes based on your chart analysis. Or use AUTO TREND DETECT to let the screener determine the strategy for up to 5 tickers.' },
              { step: '3', title: 'Set Rules', desc: 'Click RUN SCREENER to open the rules modal. Verify your screening rules match your current market approach, then click RUN.' },
              { step: '4', title: 'Review Results', desc: 'Qualified results appear at the top with a color-coded left border. Expand any card to see the full checklist. Disqualified results show the failure reason.' },
              { step: '5', title: 'Take Action', desc: 'For qualified trades, click 📅 Enter Tomorrow to schedule a next-day entry reminder in Google Calendar. For earnings-blocked stocks, click 📅 Follow Up to schedule a re-screen after earnings.' },
            ].map(s => (
              <div key={s.step} className="flex gap-4">
                <div className={`w-6 h-6 rounded-full bg-blue-600/30 border border-blue-500 flex items-center justify-center shrink-0 mt-0.5`}>
                  <span className="text-[9px] text-blue-400 font-bold">{s.step}</span>
                </div>
                <div>
                  <p className={`text-xs font-bold ${th.textMuted}`}>{s.title}</p>
                  <p className={`text-[11px] ${th.textFaint} leading-relaxed mt-0.5`}>{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* Sidebar Sections */}
        <Section title="Sidebar — AUTO Trend Detect" th={th}>
          <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>
            Enter up to 5 tickers and the screener will automatically determine whether each stock is in an uptrend (BPS), downtrend (BCS), or sideways (IC) using 20MA and 50MA analysis via Polygon.io. Allow ~12 seconds per ticker due to API rate limits.
          </p>
          <p className={`text-[11px] text-yellow-500 leading-relaxed`}>
            ⚠ Auto detect counts against your Polygon free tier limit of 5 calls/minute. Use sparingly.
          </p>
        </Section>

        <Section title="Sidebar — Sessions" th={th}>
          <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>
            Sessions save the current state of all three scan list boxes (BPS, BCS, IC) together as a named snapshot stored in the cloud. Use this to save your Monday scan list and reload it throughout the week.
          </p>
          <div className="space-y-2 mt-2">
            <div className={`flex gap-3 text-[11px]`}>
              <span className={`${th.textMuted} font-medium w-24 shrink-0`}>💾 Save Session</span>
              <span className={th.textFaint}>Saves all three scan lists under a name you choose</span>
            </div>
            <div className={`flex gap-3 text-[11px]`}>
              <span className={`${th.textMuted} font-medium w-24 shrink-0`}>▼ Load Session</span>
              <span className={th.textFaint}>Loads a saved session — choose Replace or Merge</span>
            </div>
          </div>
        </Section>

        <Section title="Sidebar — Scan Lists" th={th}>
          <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>
            Three strategy boxes for manual ticker entry. Each box has its own save/load system for per-strategy filters stored in the cloud.
          </p>
          <div className="space-y-2 mt-2">
            {[
              { badge: 'BULLISH', color: 'text-emerald-500', strategy: 'BPS', desc: 'Stocks in an uptrend or holding steady at support' },
              { badge: 'BEARISH', color: 'text-red-500', strategy: 'BCS', desc: 'Stocks in a downtrend or at resistance' },
              { badge: 'NEUTRAL', color: 'text-blue-500', strategy: 'IC', desc: 'Stocks in a sideways range for 2+ weeks' },
            ].map(s => (
              <div key={s.strategy} className={`flex gap-3 text-[11px] py-1.5 border-b ${th.border} last:border-0`}>
                <span className={`font-bold w-20 shrink-0 ${s.color}`}>{s.badge} {s.strategy}</span>
                <span className={th.textFaint}>{s.desc}</span>
              </div>
            ))}
          </div>
          <div className="space-y-1 mt-3">
            {[
              { icon: '↑ img', desc: 'Upload a Finviz screenshot — OCR extracts tickers automatically and appends them to the box' },
              { icon: '💾', desc: 'Save the current tickers in this box as a named filter' },
              { icon: '▼', desc: 'Load a previously saved filter — choose Replace or Merge' },
            ].map(b => (
              <div key={b.icon} className={`flex gap-3 text-[11px]`}>
                <span className={`${th.textMuted} font-medium w-12 shrink-0 border ${th.border} rounded px-1 text-center`}>{b.icon}</span>
                <span className={th.textFaint}>{b.desc}</span>
              </div>
            ))}
          </div>
        </Section>

        {/* Strategies */}
        <Section title="Strategies" th={th}>
          <div className="space-y-4">
            {[
              { name: 'Bull Put Spread (BPS)', color: 'text-emerald-500', border: 'border-emerald-500', desc: 'Bullish to neutral. Sell a put above the stock price, buy a put below it. Collect a credit. Profit if the stock stays above your short strike at expiry.', when: 'Stock in a clear uptrend or holding at support.' },
              { name: 'Bear Call Spread (BCS)', color: 'text-red-500', border: 'border-red-500', desc: 'Bearish to neutral. Sell a call below resistance, buy a call above it. Collect a credit. Profit if the stock stays below your short strike.', when: 'Stock in a downtrend or at resistance.' },
              { name: 'Iron Condor (IC)', color: 'text-blue-500', border: 'border-blue-500', desc: 'Neutral. A BPS below the price plus a BCS above it on the same expiration. Collect premium from both sides. Profit if the stock stays in range.', when: 'Stock sideways for 2+ weeks — no higher highs, no lower lows.' },
            ].map(s => (
              <div key={s.name} className={`border-l-4 ${s.border} pl-3`}>
                <p className={`text-xs font-bold ${s.color} mb-1`}>{s.name}</p>
                <p className={`text-[11px] ${th.textFaint} leading-relaxed mb-1`}>{s.desc}</p>
                <p className={`text-[10px] ${th.textMuted} font-medium`}>When to use: {s.when}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* Screening Rules */}
        <Section title="Screening Rules" th={th}>
          <p className={`text-[11px] ${th.textFaint} leading-relaxed mb-3`}>
            Click RUN SCREENER to open the rules modal. Rules are grouped by category and persist between sessions.
          </p>
          <div className="space-y-1">
            <RuleRow label="IVR Min %" value="≥ 30%" desc="Implied Volatility Rank minimum. IVR ranks current IV on a 0–100 scale vs the past 52 weeks. Below 30 means premiums are cheap — not worth the risk." th={th} />
            <RuleRow label="IVR IC Max %" value="≤ 70%" desc="For Iron Condors, very high IVR (>70) may indicate a binary event. Above 70 on an IC warrants extra caution." th={th} />
            <RuleRow label="DTE Min / Max" value="30–45 days" desc="Days to expiration window. 30–45 DTE is the sweet spot for theta decay. The optimizer searches all expirations in this window." th={th} />
            <RuleRow label="Spread Delta" value="0.20–0.30" desc="Short strike delta range for BPS and BCS. Delta roughly equals the probability the option expires in the money. 0.20–0.30 = 70–80% probability of profit." th={th} />
            <RuleRow label="IC Delta" value="0.16–0.20" desc="Short strike delta for Iron Condor legs. Slightly tighter than spread delta to keep both sides balanced." th={th} />
            <RuleRow label="Max Bid-Ask $" value="≤ $0.10" desc="Maximum bid-ask spread per leg. Wide bid-ask means poor liquidity and slippage. Skip stocks where you can't get a fair fill." th={th} />
            <RuleRow label="Min Open Interest" value="≥ 0" desc="Minimum open interest on each leg. Higher OI means more liquidity. Set to 500 per Prosper rules for live trading." th={th} />
            <RuleRow label="Min Credit Ratio" value="≥ 15%" desc="Credit received as a percentage of spread width. Ensures you're collecting at least ⅓ of max risk as premium." th={th} />
            <RuleRow label="Max Spread Width" value="$50 (cap)" desc="The optimizer tries widths from the minimum up to this cap and returns the best ROC. Higher cap = more candidates found." th={th} />
            <RuleRow label="Min ROC Spread %" value="≥ 15%" desc="Minimum return on capital for BPS/BCS. ROC = credit / (spread width − credit). Target 30–50% per Prosper rules." th={th} />
            <RuleRow label="Min ROC IC %" value="≥ 30%" desc="Minimum return on capital for Iron Condors. IC targets 50–80% ROC per Prosper rules." th={th} />
          </div>
        </Section>

        {/* Reading Results */}
        <Section title="Reading Results" th={th}>
          <div className="space-y-3">
            <div className={`border-l-4 border-l-emerald-500 pl-3`}>
              <p className={`text-xs font-bold text-emerald-500 mb-1`}>QUALIFIED</p>
              <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>All checks passed. The optimizer found a spread that meets every rule. The card shows: expiration, strikes, spread width, credit, ROC, POP, and delta. Click to expand the full checklist.</p>
            </div>
            <div className={`border-l-4 border-l-slate-500 pl-3`}>
              <p className={`text-xs font-bold ${th.textMuted} mb-1`}>DISQUALIFIED</p>
              <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>One or more checks failed. The failure reason is shown on the card. Expand to see the full checklist. Use the Filter Suggestions panel to see what rule changes might qualify more stocks.</p>
            </div>
          </div>
          <div className="space-y-2 mt-3">
            <p className={`text-[10px] font-bold ${th.textMuted} uppercase tracking-wider`}>Result Card Fields</p>
            {[
              { field: 'IVR', desc: 'Current Implied Volatility Rank. Green = ≥ 30%, Red = below minimum.' },
              { field: 'Exp', desc: 'Expiration date and days to expiration (DTE). Yellow ≤ 25d, Red ≤ 21d.' },
              { field: 'Strikes', desc: 'Short strike / long strike · spread width ·' },
              { field: 'Credit', desc: 'Net credit collected per spread (× 100 shares = dollar value).' },
              { field: 'ROC', desc: 'Return on capital = credit / max loss.' },
              { field: 'POP', desc: 'Probability of profit based on short strike delta.' },
              { field: 'δ', desc: 'Short strike delta — probability the option expires in the money.' },
              { field: 'opt', desc: 'Width was found by the optimizer (tried multiple widths, returned best ROC).' },
            ].map(f => (
              <div key={f.field} className={`flex gap-3 text-[11px] py-1 border-b ${th.border} last:border-0`}>
                <span className={`${th.textMuted} font-bold w-16 shrink-0`}>{f.field}</span>
                <span className={th.textFaint}>{f.desc}</span>
              </div>
            ))}
          </div>
        </Section>

        {/* Calendar Features */}
        <Section title="Calendar Features" th={th}>
          <div className="space-y-4">
            <div>
              <p className={`text-xs font-bold text-blue-400 mb-1`}>📅 Enter Tomorrow</p>
              <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>Appears on qualified result cards. Opens Google Calendar pre-filled with the trade details — symbol, strategy, strikes, credit, ROC, delta, and a re-screen link — scheduled for the next business day. Use this when you find a trade late at night and want a reminder to enter it before market open.</p>
            </div>
            <div>
              <p className={`text-xs font-bold text-blue-400 mb-1`}>📅 Follow Up</p>
              <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>Appears on earnings-blocked disqualified cards. Opens Google Calendar with a re-screen reminder scheduled for 2 business days after the earnings date — giving the stock time for IV crush to settle and the chart to find its new level.</p>
            </div>
            <p className={`text-[10px] ${th.textFaint} italic`}>Both buttons turn ✓ green after clicking and persist across page reloads via localStorage.</p>
          </div>
        </Section>

        {/* DTE Alert */}
        <Section title="DTE Alert" th={th}>
          <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>
            A yellow banner appears at the top of results when any qualified trade has ≤ 25 days to expiration. This is your warning to prepare for the mandatory 21 DTE close.
          </p>
          <div className="space-y-1 mt-2">
            <p className={`text-[11px] text-yellow-500 font-medium`}>⚠ ≤ 25 DTE — approaching, start monitoring</p>
            <p className={`text-[11px] text-red-500 font-medium`}>⚠ ≤ 21 DTE — close the position, no exceptions</p>
          </div>
          <p className={`text-[11px] ${th.textFaint} leading-relaxed mt-2`}>
            The 21 DTE hard close is a core Prosper rule. Gamma risk increases sharply in the final 3 weeks — holding past 21 DTE is not worth the risk regardless of profit/loss.
          </p>
        </Section>

        {/* Filter Suggestions */}
        <Section title="Filter Suggestions" th={th}>
          <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>
            After a scan with disqualified results, the Filter Suggestions panel analyzes the failure reasons and suggests specific rule adjustments in priority order.
          </p>
          <div className="space-y-2 mt-2">
            {[
              { priority: '#1', label: 'Expand DTE window', desc: 'Most stocks only have monthly expirations. Widening from 30–45 to 30–55 DTE captures more chains with no quality tradeoff.' },
              { priority: '#2', label: 'Lower IVR minimum', desc: 'If market volatility is suppressed, fewer stocks will pass IVR ≥ 30%. Lowering to 20% finds more candidates but means less premium collected.' },
              { priority: '#3', label: 'Relax credit ratio', desc: 'Reduces the minimum credit requirement. Only advisable when IVR is elevated.' },
              { priority: '#4', label: 'Lower ROC minimum', desc: 'Accepts lower-return trades. Only accept if POP is strong (>70%).' },
            ].map(s => (
              <div key={s.priority} className={`flex gap-3 py-2 border-b ${th.border} last:border-0`}>
                <span className="text-[9px] bg-blue-500/20 text-blue-400 border border-blue-600 rounded px-1.5 py-0.5 font-medium h-fit shrink-0">{s.priority}</span>
                <div>
                  <p className={`text-[11px] font-bold ${th.textMuted}`}>{s.label}</p>
                  <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <p className={`text-[10px] text-red-400 mt-2 font-medium`}>⚠ Earnings failures are never suggested for rule changes — the earnings filter is a hard rule and should never be modified.</p>
        </Section>

        {/* Exit Rules */}
        <Section title="Exit Rules — Non-Negotiable" th={th}>
          <div className="space-y-3">
            <div className={`border border-emerald-600 bg-emerald-500/10 rounded-lg p-3`}>
              <p className="text-xs font-bold text-emerald-400 mb-1">50% PROFIT TARGET</p>
              <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>Place a GTC (Good Till Cancelled) order at 50% of max credit immediately after your order fills. If you collected $2.00, set GTC at $1.00. Do not wait — GTC orders can fire the same day in elevated IV environments.</p>
            </div>
            <div className={`border border-red-600 bg-red-500/10 rounded-lg p-3`}>
              <p className="text-xs font-bold text-red-400 mb-1">21 DTE HARD CLOSE</p>
              <p className={`text-[11px] ${th.textFaint} leading-relaxed`}>Close the position at 21 DTE regardless of profit or loss. Gamma risk increases sharply in the final 3 weeks. This rule applies to every strategy — BPS, BCS, and IC — with no exceptions.</p>
            </div>
          </div>
        </Section>

        {/* Footer */}
        <div className={`text-center text-[10px] ${th.textFaint} py-4 border-t ${th.border}`}>
          <p>OPTIONS HUNTER · Based on Prosper Trading course materials</p>
          <p className="mt-1">Paper trade before going live · Position size: max 5–10% of portfolio per trade</p>
        </div>

      </div>
    </div>
  );
}
