20:44:29.898 Running build in Washington, D.C., USA (East) – iad1
20:44:29.898 Build machine configuration: 2 cores, 8 GB
20:44:30.060 Cloning github.com/deannetharmon/options-screener (Branch: feature/portfolio-intelligence, Commit: d5ca071)
20:44:30.917 Cloning completed: 857.000ms
20:44:31.184 Restored build cache from previous deployment (6xXigLXgVtyYuUBcswZ84EF1hGgq)
20:44:31.451 Running "vercel build"
20:44:31.473 Vercel CLI 54.4.1
20:44:31.754 Installing dependencies...
20:44:32.727 
20:44:32.728 up to date in 831ms
20:44:32.729 
20:44:32.729 26 packages are looking for funding
20:44:32.729   run `npm fund` for details
20:44:32.773 Detected Next.js version: 14.2.35
20:44:32.777 Running "npm run build"
20:44:32.908 
20:44:32.909 > options-screener@0.1.0 build
20:44:32.909 > next build
20:44:32.909 
20:44:33.751   ▲ Next.js 14.2.35
20:44:33.752   - Environments: .env.local
20:44:33.752 
20:44:33.775    Creating an optimized production build ...
20:44:38.701 Failed to compile.
20:44:38.701 
20:44:38.701 ./app/portfolio/page.tsx
20:44:38.701 Error: 
20:44:38.701   x Expected ',', got '{'
20:44:38.701       ,-[/vercel/path0/app/portfolio/page.tsx:5027:1]
20:44:38.702  5027 |         </button>
20:44:38.702  5028 |       </div>
20:44:38.703  5029 | 
20:44:38.703  5030 |       {/* Expanded legs */}
20:44:38.703       :       ^
20:44:38.703  5031 |       {expanded && (
20:44:38.703  5032 |         <div className={`border-t ${th.border} px-4 py-3`}>
20:44:38.704  5033 |           <p className={`text-[9px] ${th.textFaint} uppercase tracking-widest mb-2`}>Legs</p>
20:44:38.704       `----
20:44:38.704 
20:44:38.704 Caused by:
20:44:38.705     Syntax Error
20:44:38.705 
20:44:38.705 Import trace for requested module:
20:44:38.705 ./app/portfolio/page.tsx
20:44:38.706 
20:44:38.716 
20:44:38.718 > Build failed because of webpack errors
20:44:38.756 Error: Command "npm run build" exited with 1
