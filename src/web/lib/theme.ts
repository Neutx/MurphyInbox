import { useEffect, useState } from 'react';
import { storageGet, storageSet } from './utils';

export type Theme = 'light' | 'dark' | 'system';

// Accent colors, like macOS's accent picker. Values live in index.css as
// :root[data-accent=…]; each has a light value that keeps 4.5:1 against white text.
export const ACCENTS = [
  { id: 'murphy', label: 'Murphy Blue', swatch: '#1665c1' },
  { id: 'teal', label: 'Teal', swatch: '#0e7c86' },
  { id: 'green', label: 'Green', swatch: '#1f8a3a' },
  { id: 'orange', label: 'Orange', swatch: '#c2570c' },
  { id: 'red', label: 'Red', swatch: '#d12f2f' },
  { id: 'pink', label: 'Pink', swatch: '#c2185b' },
  { id: 'graphite', label: 'Graphite', swatch: '#636366' },
] as const;
export type Accent = (typeof ACCENTS)[number]['id'];
const DEFAULT_ACCENT: Accent = 'murphy';

const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && media().matches);
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#f2f2f7');
}

export function applyAccent(accent: Accent): void {
  const known = ACCENTS.some((a) => a.id === accent) ? accent : DEFAULT_ACCENT;
  document.documentElement.dataset.accent = known;
}

export function useAccent(): [Accent, (a: Accent) => void] {
  const [accent, setAccent] = useState<Accent>(() => storageGet<Accent>('oi.accent', DEFAULT_ACCENT));
  useEffect(() => {
    applyAccent(accent);
    storageSet('oi.accent', accent);
  }, [accent]);
  return [accent, setAccent];
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => storageGet<Theme>('oi.theme', 'system'));
  useEffect(() => {
    applyTheme(theme);
    storageSet('oi.theme', theme);
    if (theme !== 'system') return;
    const m = media();
    const onChange = () => applyTheme('system');
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, [theme]);
  return [theme, setTheme];
}

// Whether the dark theme is showing right now; follows theme changes and the system setting.
export function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => setDark(el.classList.contains('dark')));
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

// Applied before React renders, to avoid a flash of the wrong theme.
export function initTheme(): void {
  applyTheme(storageGet<Theme>('oi.theme', 'system'));
  applyAccent(storageGet<Accent>('oi.accent', DEFAULT_ACCENT));
}
