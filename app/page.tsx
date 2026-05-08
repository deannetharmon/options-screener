22:06:31.694 Running build in Washington, D.C., USA (East) – iad1
22:06:31.694 Build machine configuration: 2 cores, 8 GB
22:06:31.907 Cloning github.com/deannetharmon/options-screener (Branch: main, Commit: c203b83)
22:06:33.503 Cloning completed: 1.595s
22:06:33.659 Restored build cache from previous deployment (9zggGHuin9GwzSgREEuHuLdCJ6ZS)
22:06:33.961 Running "vercel build"
22:06:34.916 Vercel CLI 53.2.0
22:06:35.383 Installing dependencies...
22:06:38.321 
22:06:38.322 up to date in 3s
22:06:38.322 
22:06:38.322 26 packages are looking for funding
22:06:38.323   run `npm fund` for details
22:06:38.375 Detected Next.js version: 14.2.3
22:06:38.380 Running "npm run build"
22:06:38.878 
22:06:38.878 > options-screener@0.1.0 build
22:06:38.879 > next build
22:06:38.879 
22:06:39.873   ▲ Next.js 14.2.3
22:06:39.874 
22:06:39.899    Creating an optimized production build ...
22:06:42.950 Failed to compile.
22:06:42.951 
22:06:42.951 ./app/page.tsx
22:06:42.951 Error: 
22:06:42.952   x Unexpected token `div`. Expected jsx identifier
22:06:42.952       ,-[/vercel/path0/app/page.tsx:1349:1]
22:06:42.952  1349 |   const disqualified = results.filter(r => !r.qualified);
22:06:42.952  1350 | 
22:06:42.953  1351 |   return (
22:06:42.953  1352 |     <div className={`min-h-screen ${th.bg} text-slate-100 font-mono transition-colors duration-200`}>
22:06:42.954       :      ^^^
22:06:42.954  1353 |       {/* Header */}
22:06:42.954  1354 |       <div className={`${th.header} border-b ${th.border} px-6 py-4 flex items-center justify-between`}>
22:06:42.954  1355 |         <div>
22:06:42.955       `----
22:06:42.955 
22:06:42.955 Caused by:
22:06:42.955     Syntax Error
22:06:42.955 
22:06:42.955 Import trace for requested module:
22:06:42.956 ./app/page.tsx
22:06:42.956 
22:06:42.975 
22:06:42.975 > Build failed because of webpack errors
22:06:43.015 Error: Command "npm run build" exited with 1
