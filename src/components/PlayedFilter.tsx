import { useState } from 'react';

const HIDE_PLAYED_KEY = 'pinepods.hidePlayed';

/** One persisted "hide played" preference shared by every episode list. */
export function useHidePlayed(): [boolean, (value: boolean) => void] {
  const [hide, setHide] = useState(() => localStorage.getItem(HIDE_PLAYED_KEY) === '1');
  const set = (value: boolean) => {
    localStorage.setItem(HIDE_PLAYED_KEY, value ? '1' : '0');
    setHide(value);
  };
  return [hide, set];
}

export function PlayedFilter({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="segmented">
      <button className={!value ? 'on' : ''} onClick={() => onChange(false)}>
        All
      </button>
      <button className={value ? 'on' : ''} onClick={() => onChange(true)}>
        Unplayed
      </button>
    </div>
  );
}
