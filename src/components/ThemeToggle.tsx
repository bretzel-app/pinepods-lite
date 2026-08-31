import { useState } from 'react';
import { getTheme, setTheme, type Theme } from '../lib/theme';

export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(getTheme);

  const choose = (value: Theme) => {
    setTheme(value);
    setThemeState(value);
  };

  return (
    <div className="segmented">
      <button className={theme === 'bretzel' ? 'on' : ''} onClick={() => choose('bretzel')}>
        Bretzel
      </button>
      <button className={theme === 'pinepods' ? 'on' : ''} onClick={() => choose('pinepods')}>
        Pinepods
      </button>
    </div>
  );
}
