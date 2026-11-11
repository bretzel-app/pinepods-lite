// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { WebEngine } from './webEngine';
import type { PlaybackItem } from './types';
import type { Episode } from '../../lib/types';

class FakeAudio extends EventTarget {
  currentTime = 0;
  duration = 3600;
  src = '';
  preload = '';
  paused = true;
  error: unknown = null;
  playbackRate = 1;
  volume = 1;
  play = async () => {
    this.paused = false;
  };
  pause = () => {
    this.paused = true;
  };
}

const URL_A = 'https://pods.example.com/stream/7';

function item(over: Partial<PlaybackItem> = {}): PlaybackItem {
  return {
    key: 'a:7',
    accountId: 'a',
    episode: { episodeid: 7, episodeurl: 'http://cdn/7.mp3', episodeduration: 3600 } as Episode,
    source: { kind: 'stream', url: URL_A, server: true },
    startAt: 0,
    skips: { uri: URL_A, ranges: [[10, 40]] },
    ...over,
  };
}

function setup(loadBlob: (a: string, id: number) => Promise<Blob | undefined> = async () => undefined) {
  const audio = new FakeAudio();
  const engine = new WebEngine(audio as unknown as HTMLAudioElement, loadBlob as never);
  const tick = () => audio.dispatchEvent(new Event('timeupdate'));
  return { audio, engine, tick };
}

describe('WebEngine ad skipping', () => {
  it('skips a range on timeupdate when playing the analyzed copy', async () => {
    const { audio, engine, tick } = setup();
    await engine.load([item()], 0, true);
    audio.currentTime = 15;
    tick();
    expect(audio.currentTime).toBe(40);
  });

  it('does not skip when the blob is gone and the enclosure plays', async () => {
    const { audio, engine, tick } = setup(async () => undefined);
    const it = item({ source: { kind: 'download' }, skips: { uri: 'idb:a:7', ranges: [[10, 40]] } });
    await engine.load([it], 0, true);
    audio.currentTime = 15;
    tick();
    expect(audio.currentTime).toBe(15);
  });

  it('a seek() into a range is honoured', async () => {
    const { audio, engine, tick } = setup();
    await engine.load([item()], 0, true);
    engine.seek(20);
    audio.currentTime = 25;
    tick();
    expect(audio.currentTime).toBe(25);
  });

  it('the resume point is not a manual seek', async () => {
    const { audio, engine, tick } = setup();
    await engine.load([item({ startAt: 12 })], 0, true);
    audio.dispatchEvent(new Event('loadedmetadata'));
    expect(audio.currentTime).toBe(12);
    tick();
    expect(audio.currentTime).toBe(40);
  });

  it('ranges follow the current item when the playlist changes', async () => {
    const { audio, engine, tick } = setup();
    await engine.load([item({ skips: undefined })], 0, true);
    audio.currentTime = 15;
    tick();
    expect(audio.currentTime).toBe(15);
    engine.updatePlaylist([item()]);
    tick();
    expect(audio.currentTime).toBe(40);
  });
});
