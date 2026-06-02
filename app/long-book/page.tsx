11:41:04.882 Running build in Washington, D.C., USA (East) – iad1
11:41:04.885 Build machine configuration: 2 cores, 8 GB
11:41:05.109 Cloning github.com/deannetharmon/options-screener (Branch: feature/portfolio-intelligence, Commit: 3fd8dbb)
11:41:07.011 Cloning completed: 1.901s
11:41:07.203 Restored build cache from previous deployment (9pHhHQHddoDGhd44r6dgnVVK8WYL)
11:41:07.688 Running "vercel build"
11:41:07.719 Vercel CLI 54.7.1
11:41:08.005 Installing dependencies...
11:41:09.094 
11:41:09.094 up to date in 903ms
11:41:09.095 
11:41:09.095 26 packages are looking for funding
11:41:09.096   run `npm fund` for details
11:41:09.129 Detected Next.js version: 14.2.35
11:41:09.132 Running "npm run build"
11:41:09.230 
11:41:09.231 > options-screener@0.1.0 build
11:41:09.231 > next build
11:41:09.231 
11:41:09.922   ▲ Next.js 14.2.35
11:41:09.922   - Environments: .env.local
11:41:09.923 
11:41:09.945    Creating an optimized production build ...
11:41:17.263  ✓ Compiled successfully
11:41:17.264    Linting and checking validity of types ...
11:41:21.142 Failed to compile.
11:41:21.143 
11:41:21.144 ./app/long-book/page.tsx:671:27
11:41:21.144 Type error: Type 'Set<string>' can only be iterated through when using the '--downlevelIteration' flag or with a '--target' of 'es2015' or higher.
11:41:21.144 
11:41:21.144   669 |   }, [symbol, optionType]);
11:41:21.144   670 |
11:41:21.144 > 671 |   const expirations = [...new Set(chain.map(s => s.expiration))].sort();
11:41:21.144       |                           ^
11:41:21.145   672 |   const filtered = chain.filter(s => {
11:41:21.145   673 |     if (filterExp !== 'all' && s.expiration !== filterExp) return false;
11:41:21.145   674 |     const absDelta = s.delta != null ? Math.abs(s.delta) : null;
11:41:21.169 Next.js build worker exited with code: 1 and signal: null
11:41:21.196 Error: Command "npm run build" exited with 1
