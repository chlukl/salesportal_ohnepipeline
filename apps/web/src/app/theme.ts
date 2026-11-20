/** Light / dark / system theme (stored in localStorage, applied as data-theme on <html>). */
import { createStore, useStore } from './store';

export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'sp.theme';

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export const themeStore = createStore<ThemeChoice>(read());

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function setTheme(choice: ThemeChoice): void {
  themeStore.set(choice);
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* private mode */
  }
  applyTheme(choice);
}

export function useTheme(): ThemeChoice {
  return useStore(themeStore);
}
