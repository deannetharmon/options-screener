# Options Screener

A Next.js web app that runs your full BPS/BCS/IC screening checklist automatically using the TastyTrade API.

## What it checks
- ✅ IVR ≥ 30% (no upper cap for spreads)
- ✅ IVx ≥ 35% (real premium check)
- ✅ Earnings clear of expiry window
- ✅ Open Interest ≥ 500 on both legs
- ✅ Delta 0.15–0.22 on short leg
- ✅ Credit ≥ ⅓ of spread width
- ✅ DTE 21–45 days

## Setup

### 1. Clone and install

```bash
git clone <your-repo>
cd options-screener
npm install
```

### 2. Run locally

```bash
npm run dev
```

Open http://localhost:3000

### 3. Deploy to Vercel

```bash
# Install Vercel CLI if needed
npm i -g vercel

# Deploy
vercel
```

Or connect your GitHub repo to Vercel for automatic deployments.

## Usage

1. Login with your TastyTrade credentials (same as the app)
2. Enter tickers (comma or space separated)
3. Choose mode:
   - **Full Auto** — runs everything, shows qualified trades
   - **Semi-Manual** — you set chart trends manually, app handles the rest
   - **Dashboard** — full table view of all checks
4. Click **Run Screener**

## Modes

### Full Auto
Runs all 6 checklist items automatically. Chart trend is inferred from price momentum (last 30 days vs prior 30 days). Best for quick Monday morning scans.

### Semi-Manual  
App handles IVR, IVx, earnings, OI, delta, credit checks automatically. You set the chart trend for each ticker manually after reviewing TradingView. Closest to your current workflow.

### Dashboard
Shows all candidates in a sortable table with color-coded pass/fail status for every check.

## Updating Rules

All course rules are in `lib/screener.ts` under the `RULES` object:

```ts
export const RULES = {
  IVR_MIN: 30,
  IVX_MIN: 35,
  OI_MIN: 500,
  CREDIT_RATIO: 1 / 3,
  DELTA_MIN: 0.15,
  DELTA_MAX: 0.22,
  DTE_MIN: 21,
  DTE_MAX: 45,
  EARNINGS_BUFFER_DAYS: 21,
};
```

## Tech Stack

- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS
- TastyTrade API (your existing account)
- Vercel hosting

