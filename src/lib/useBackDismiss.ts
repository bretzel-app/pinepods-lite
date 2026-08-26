import { useEffect, useRef } from 'react';

/**
 * Makes an overlay (full player, action sheet) respect the back button.
 * Opening pushes a history entry; the phone's back button then closes the
 * overlay instead of navigating the page underneath. Every close path goes
 * through history.back() so the entry is always consumed exactly once.
 */
export function useBackDismiss(
  open: boolean,
  setOpen: (value: boolean) => void,
): {
  openWithHistory: () => void;
  /** Close the overlay; `after` runs once it's closed (e.g. a navigation). */
  close: (after?: () => void) => void;
} {
  const pendingRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPop = () => {
      setOpen(false);
      const after = pendingRef.current;
      pendingRef.current = null;
      after?.();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [open, setOpen]);

  const openWithHistory = () => {
    window.history.pushState({ overlay: true }, '');
    setOpen(true);
  };

  const close = (after?: () => void) => {
    pendingRef.current = after ?? null;
    window.history.back();
  };

  return { openWithHistory, close };
}
