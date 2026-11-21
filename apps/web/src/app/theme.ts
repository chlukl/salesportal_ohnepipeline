/**
 * Appearance = design (color palette) × mode (light / dark / system).
 * Both are per-person conveniences stored in localStorage and applied on <html>:
 *   data-design="standard|kallysoft|graphit|sand"  – palette (tokens in theme.css)
 *   data-theme="light|dark"                        – resolved mode («system» follows the OS live)
 */
import { createStore, useStore } from './store';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type DesignId = 'standard' | 'kallysoft' | 'graphit' | 'sand';

export interface DesignInfo {
  id: DesignId;
  label: string;
  description: string;
  /** Static Tailwind classes for the menu swatch (primary color + surface). */
  swatch: string;
}

export const DESIGNS: DesignInfo[] = [
  { id: 'standard', label: 'Standard', description: 'Ruhiges Petrol', swatch: 'bg-[#0b5f73] ring-[#e2f1f4]' },
  { id: 'kallysoft', label: 'Kallysoft', description: 'Corporate Design', swatch: 'bg-[#475adf] ring-[#e3e7ff]' },
  { id: 'graphit', label: 'Graphit', description: 'Schwarz-weiss, sehr schlicht', swatch: 'bg-[#18181b] ring-[#e4e4e7]' },
  { id: 'sand', label: 'Sand', description: 'Warm mit Terrakotta', swatch: 'bg-[#b4532a] ring-[#f3ece3]' },
];

const THEME_KEY = 'sp.theme';
const DESIGN_KEY = 'sp.design';

function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function readDesign(): DesignId {
  try {
    const v = localStorage.getItem(DESIGN_KEY);
    return DESIGNS.some((d) => d.id === v) ? (v as DesignId) : 'standard';
  } catch {
    return 'standard';
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode – the choice just isn't remembered */
  }
}

export const themeStore = createStore<ThemeChoice>(readTheme());
export const designStore = createStore<DesignId>(readDesign());

const systemDark = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

/** Sets data-theme to the resolved mode, so «system» works for every design and for the `dark:` variant. */
export function applyTheme(choice: ThemeChoice): void {
  const dark = choice === 'dark' || (choice === 'system' && !!systemDark?.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

export function applyDesign(design: DesignId): void {
  document.documentElement.setAttribute('data-design', design);
}

systemDark?.addEventListener('change', () => {
  if (themeStore.get() === 'system') applyTheme('system');
});

export function setTheme(choice: ThemeChoice): void {
  themeStore.set(choice);
  store(THEME_KEY, choice === 'system' ? null : choice);
  applyTheme(choice);
}

export function setDesign(design: DesignId): void {
  designStore.set(design);
  store(DESIGN_KEY, design === 'standard' ? null : design);
  applyDesign(design);
}

export function useTheme(): ThemeChoice {
  return useStore(themeStore);
}

export function useDesign(): DesignId {
  return useStore(designStore);
}
