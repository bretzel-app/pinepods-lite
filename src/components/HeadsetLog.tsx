import { useCallback, useEffect, useState } from 'react';
import { NativePlayer } from '../native/plugins';

/**
 * TEMPORARY diagnostics for the headset tap: the native player's log of the
 * media buttons and player commands it received, to copy into a bug report.
 * Android app only.
 */
export function HeadsetLog() {
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setText((await NativePlayer.getDebugLog()).text);
    } catch (err) {
      setText(`Could not read the log: ${String(err)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard access: select the text for a manual copy.
      const area = document.getElementById('headset-log') as HTMLTextAreaElement | null;
      area?.select();
    }
  };

  const clear = async () => {
    await NativePlayer.clearDebugLog().catch(() => {});
    await refresh();
  };

  return (
    <div className="settings-section">
      <h2 className="settings-heading">Headset diagnostics</h2>
      <p className="notice" style={{ marginTop: 0 }}>
        What the player received from headphones and other controls, newest last. Clear it,
        play an episode, tap your earbuds, then Refresh and Copy.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '8px 0' }}>
        <button className="btn secondary" onClick={() => void refresh()}>
          Refresh
        </button>
        <button className="btn secondary" onClick={() => void copy()} disabled={!text}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="btn secondary" onClick={() => void clear()}>
          Clear
        </button>
      </div>
      <textarea
        id="headset-log"
        readOnly
        value={text || '(empty)'}
        rows={12}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          fontFamily: 'ui-monospace, monospace',
          fontSize: 11,
          background: 'var(--bg-hover)',
          color: 'inherit',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 8,
        }}
      />
    </div>
  );
}
