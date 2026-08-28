export type Theme = 'default' | 'bretzel';

const THEME_KEY = 'pinepods.theme';

/** Kept in sync with the inline FOUC-avoidance script in index.html and the
 *  `theme-color` meta default there. Update all three together. */
const THEME_COLOR: Record<Theme, string> = {
  default: '#1a1d28',
  bretzel: '#f0e6d3',
};

export function getTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === 'bretzel' ? 'bretzel' : 'default';
}

export function applyTheme(theme: Theme): void {
  if (theme === 'bretzel') {
    document.documentElement.setAttribute('data-theme', 'bretzel');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}
