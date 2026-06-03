// lib/theme.ts — shared theme + accent definitions for all pages
// Import this in every page: import { THEMES, ACCENTS, ... } from '@/lib/theme';

export const LS_THEME  = 'hunter-theme';
export const LS_ACCENT = 'hunter-accent';

export type Theme = 'dark' | 'medium' | 'light';

export const THEMES: Record<Theme, {
  bg: string; sidebar: string; card: string; cardQualified: string;
  border: string; borderLight: string; header: string;
  text: string; textMuted: string; textFaint: string;
  input: string; inputBorder: string; tag: string; label: string;
}> = {
  dark:   { bg: 'bg-[#0a0a0a]', sidebar: 'bg-[#0f0f0f]', card: 'bg-[#171717]', cardQualified: 'bg-[#1c1c1c]', border: 'border-[#2c2c2c]', borderLight: 'border-[#202020]', header: 'bg-[#0f0f0f]', text: 'text-white', textMuted: 'text-[#e0e0e0]', textFaint: 'text-[#808080]', input: 'bg-[#141414]', inputBorder: 'border-[#353535]', tag: 'bg-[#222222]', label: 'text-[#aaaaaa]' },
  medium: { bg: 'bg-[#141414]', sidebar: 'bg-[#1a1a1a]', card: 'bg-[#202020]', cardQualified: 'bg-[#252525]', border: 'border-[#333333]', borderLight: 'border-[#282828]', header: 'bg-[#1a1a1a]', text: 'text-white', textMuted: 'text-[#d8d8d8]', textFaint: 'text-[#777777]', input: 'bg-[#1e1e1e]', inputBorder: 'border-[#3a3a3a]', tag: 'bg-[#2a2a2a]', label: 'text-[#999999]' },
  light:  { bg: 'bg-[#f5f5f5]', sidebar: 'bg-white', card: 'bg-white', cardQualified: 'bg-white', border: 'border-[#e0e0e0]', borderLight: 'border-[#ebebeb]', header: 'bg-[#111111]', text: 'text-[#111111]', textMuted: 'text-[#1a1a1a]', textFaint: 'text-[#666666]', input: 'bg-white', inputBorder: 'border-[#cccccc]', tag: 'bg-[#f0f0f0]', label: 'text-[#444444]' },
};

export const ACCENTS = {
  electric: { hex: '#3b82f6', label: 'Electric' },
  emerald:  { hex: '#10b981', label: 'Emerald'  },
  amber:    { hex: '#f59e0b', label: 'Amber'    },
  violet:   { hex: '#8b5cf6', label: 'Violet'   },
  rose:     { hex: '#f43f5e', label: 'Rose'     },
  slate:    { hex: '#64748b', label: 'Slate'    },
} as const;
export type Accent = keyof typeof ACCENTS;

export function getSavedTheme(): Theme {
  try { const t = (typeof window !== 'undefined' ? localStorage : null)?.getItem(LS_THEME); return (t === 'dark' || t === 'medium' || t === 'light') ? t as Theme : 'dark'; }
  catch { return 'dark'; }
}

export function getSavedAccent(): Accent {
  try { const a = (typeof window !== 'undefined' ? localStorage : null)?.getItem(LS_ACCENT); return (a && a in ACCENTS) ? a as Accent : 'electric'; }
  catch { return 'electric'; }
}

export function applyAccent(accent: Accent) {
  const hex = ACCENTS[accent].hex;
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--accent', hex);
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  document.documentElement.style.setProperty('--accent-r', String(r));
  document.documentElement.style.setProperty('--accent-g', String(g));
  document.documentElement.style.setProperty('--accent-b', String(b));
}


export function injectAccentStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('hunter-accent-style')) return;
  const style = document.createElement('style');
  style.id = 'hunter-accent-style';
  style.textContent = `
    :root { --accent: #3b82f6; --accent-r: 59; --accent-g: 130; --accent-b: 246; }

    /* Text */
    .ac-text { color: var(--accent) !important; }

    /* Borders */
    .ac-border { border-color: var(--accent) !important; }
    .ac-border-faint { border-color: rgba(var(--accent-r),var(--accent-g),var(--accent-b),0.4) !important; }

    /* Backgrounds */
    .ac-bg { background-color: var(--accent) !important; }
    .ac-bg-10 { background-color: rgba(var(--accent-r),var(--accent-g),var(--accent-b),0.10) !important; }
    .ac-bg-20 { background-color: rgba(var(--accent-r),var(--accent-g),var(--accent-b),0.20) !important; }

    /* Hover states */
    .ac-hover-text:hover { color: var(--accent) !important; }
    .ac-hover-border:hover { border-color: var(--accent) !important; }
    .ac-hover-bg:hover { background-color: var(--accent) !important; }
    .ac-hover-bg-10:hover { background-color: rgba(var(--accent-r),var(--accent-g),var(--accent-b),0.10) !important; }

    /* Focus */
    .ac-focus:focus { border-color: var(--accent) !important; outline: none; }

    /* Combined common patterns */
    .ac-btn { border-color: var(--accent) !important; color: var(--accent) !important; }
    .ac-btn:hover { background-color: rgba(var(--accent-r),var(--accent-g),var(--accent-b),0.10) !important; }

    .ac-btn-solid { background-color: var(--accent) !important; border-color: var(--accent) !important; }
    .ac-btn-solid:hover { opacity: 0.85; }

    /* Active nav */
    .active-nav { background-color: rgba(var(--accent-r),var(--accent-g),var(--accent-b),0.25) !important; border-bottom: 2px solid var(--accent) !important; }
  `;
  document.head.appendChild(style);
}
