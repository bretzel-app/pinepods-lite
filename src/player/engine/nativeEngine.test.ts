import { describe, it, expect } from 'vitest';
import type { Episode } from '../../lib/types';
import type { NativeItem, NativePlayerPlugin, NativeReport, NativeState } from '../../native/plugins';
import type { EngineEvent, PlaybackItem } from './types';
import { NativeEngine } from './nativeEngine';

function ep(overrides: Partial<Episode> = {}): Episode {
  return {
    episodeid: 7,
    episodetitle: 'Seven',
    podcastname: 'Cast',
    episodepubdate: '',
    episodedescription: '',
    episodeartwork: 'http://img/7.jpg',
    episodeurl: 'http://cdn/7.mp3',
    episodeduration: 600,
    completed: false,
    saved: false,
    queued: false,
    downloaded: false,
    is_youtube: false,
    ...overrides,
  };
}

const idle: NativeState = {
  currentKey: null,
  currentPayload: null,
  playing: false,
  position: 0,
  duration: 0,
  rate: 1,
  sleepRemaining: null,
  sleepMinutes: null,
};

/** A plugin that records calls and lets the test fire its events. */
function fakePlugin(state: NativeState = idle, reports: NativeReport[] = []) {
  const calls: { method: string; args?: unknown }[] = [];
  const handlers = new Map<string, ((arg?: unknown) => void)[]>();
  const record = (method: string) => async (args?: unknown) => {
    calls.push({ method, args });
  };
  const plugin: NativePlayerPlugin = {
    load: record('load'),
    updatePlaylist: record('updatePlaylist'),
    play: record('play'),
    pause: record('pause'),
    seek: record('seek'),
    setRate: record('setRate'),
    setAutoAdvance: record('setAutoAdvance'),
    setSleepTimer: record('setSleepTimer'),
    setSleepRepeat: record('setSleepRepeat'),
    getState: async () => state,
    readReports: async () => ({ reports }),
    ackReports: record('ackReports'),
    addListener: (async (event: string, fn: (arg?: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return { remove: async () => {} };
    }) as NativePlayerPlugin['addListener'],
  };
  const fire = (event: string, arg?: unknown) => handlers.get(event)?.forEach((fn) => fn(arg));
  const loaded = () => calls.find((c) => c.method === 'load')?.args as { items: NativeItem[]; index: number; autoplay: boolean };
  return { plugin, calls, fire, loaded };
}

const downloaded: PlaybackItem = {
  key: 'a1:7',
  accountId: 'a1',
  episode: ep(),
  source: { kind: 'download', filePath: '/x/a1_7' },
  startAt: 42,
};
const streamed: PlaybackItem = {
  key: 'a1:8',
  accountId: 'a1',
  episode: ep({ episodeid: 8, episodetitle: 'Eight', episodeurl: 'http://cdn/8.mp3' }),
  source: { kind: 'stream', url: 'https://pods.example.com/stream/8' },
  startAt: 0,
};

describe('NativeEngine', () => {
  it('maps a download item to a file uri and a stream item to its url', async () => {
    const { plugin, loaded } = fakePlugin();
    const engine = new NativeEngine(plugin);
    await engine.load([downloaded, streamed], 1, true);

    const { items, index, autoplay } = loaded();
    expect(index).toBe(1);
    expect(autoplay).toBe(true);
    expect(items[0]).toEqual({
      key: 'a1:7',
      uri: 'file:///x/a1_7',
      title: 'Seven',
      artist: 'Cast',
      artworkUrl: 'http://img/7.jpg',
      startAt: 42,
      duration: 600,
      payload: JSON.stringify({ accountId: 'a1', episode: downloaded.episode }),
    });
    expect(items[1].uri).toBe('https://pods.example.com/stream/8');
  });

  it('streams the enclosure of a download item without a local file', async () => {
    const { plugin, loaded, fire } = fakePlugin();
    const engine = new NativeEngine(plugin);
    await engine.init();
    const missing: PlaybackItem = { ...downloaded, source: { kind: 'download' } };
    await engine.load([missing], 0, false);

    expect(loaded().items[0].uri).toBe('http://cdn/7.mp3');
    fire('state', { ...idle, currentKey: 'a1:7', currentPayload: loaded().items[0].payload });
    expect(engine.current()?.source).toEqual({ kind: 'stream', url: 'http://cdn/7.mp3' });
  });

  it('round-trips the payload: current() is rebuilt from the state event', async () => {
    const { plugin, loaded, fire } = fakePlugin();
    const engine = new NativeEngine(plugin);
    await engine.init();
    expect(engine.current()).toBeNull();
    await engine.load([downloaded, streamed], 0, true);

    fire('state', { ...idle, currentKey: 'a1:7', currentPayload: loaded().items[0].payload, playing: true });
    expect(engine.current()).toMatchObject({
      key: 'a1:7',
      accountId: 'a1',
      episode: downloaded.episode,
      source: downloaded.source,
    });
    expect(engine.snapshot()).toMatchObject({ currentKey: 'a1:7', playing: true });
  });

  it('adopts what the native player had before this UI loaded anything', async () => {
    const payload = JSON.stringify({ accountId: 'a2', episode: ep({ episodeid: 9 }) });
    const { plugin } = fakePlugin({ ...idle, currentKey: 'a2:9', currentPayload: payload, position: 125 });
    const engine = new NativeEngine(plugin);

    const snap = await engine.init();
    expect(snap).toEqual({
      currentKey: 'a2:9',
      playing: false,
      position: 125,
      duration: 0,
      rate: 1,
      sleepRemaining: null,
      sleepMinutes: null,
    });
    expect(engine.current()).toMatchObject({
      key: 'a2:9',
      accountId: 'a2',
      episode: { episodeid: 9 },
      source: { kind: 'stream', url: '' },
    });
  });

  it('emits state events to subscribers', async () => {
    const { plugin, fire } = fakePlugin();
    const engine = new NativeEngine(plugin);
    await engine.init();
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    fire('state', { ...idle, currentKey: 'a1:7', currentPayload: '{}', position: 3 });
    expect(events).toEqual([
      {
        type: 'state',
        snapshot: {
          currentKey: 'a1:7',
          playing: false,
          position: 3,
          duration: 0,
          rate: 1,
          sleepRemaining: null,
          sleepMinutes: null,
        },
      },
    ]);
  });

  it('emits a reports event when the plugin says reports are waiting', async () => {
    const { plugin, fire } = fakePlugin();
    const engine = new NativeEngine(plugin);
    await engine.init();
    const events: EngineEvent[] = [];
    const unsubscribe = engine.subscribe((e) => events.push(e));

    fire('reports');
    expect(events).toEqual([{ type: 'reports' }]);
    unsubscribe();
    fire('reports');
    expect(events).toHaveLength(1);
  });

  it('parses report payloads into account and episode', async () => {
    const episode = ep();
    const reports: NativeReport[] = [
      { seq: 3, kind: 'position', key: 'a1:7', payload: JSON.stringify({ accountId: 'a1', episode }), seconds: 61.5, at: 1000 },
      { seq: 4, kind: 'ended', key: 'a1:7', payload: JSON.stringify({ accountId: 'a1', episode }), seconds: 600, at: 2000 },
    ];
    const { plugin, calls } = fakePlugin(idle, reports);
    const engine = new NativeEngine(plugin);

    expect(await engine.readReports()).toEqual([
      { seq: 3, kind: 'position', key: 'a1:7', accountId: 'a1', episode, seconds: 61.5, at: 1000 },
      { seq: 4, kind: 'ended', key: 'a1:7', accountId: 'a1', episode, seconds: 600, at: 2000 },
    ]);
    await engine.ackReports(4);
    expect(calls).toContainEqual({ method: 'ackReports', args: { throughSeq: 4 } });
  });

  it('keeps the current item when the playlist around it is replaced', async () => {
    const { plugin, calls, loaded, fire } = fakePlugin();
    const engine = new NativeEngine(plugin);
    await engine.init();
    await engine.load([downloaded], 0, true);
    fire('state', { ...idle, currentKey: 'a1:7', currentPayload: loaded().items[0].payload });

    // The rebuilt list says the current one streams now; the loaded source stays.
    const restreamed: PlaybackItem = { ...downloaded, source: { kind: 'stream', url: 'http://cdn/7.mp3' } };
    engine.updatePlaylist([restreamed, streamed]);
    const sent = calls.find((c) => c.method === 'updatePlaylist')?.args as { items: NativeItem[] };
    expect(sent.items.map((i) => i.key)).toEqual(['a1:7', 'a1:8']);
    expect(engine.current()?.source).toEqual(downloaded.source);

    fire('state', { ...idle, currentKey: 'a1:8', currentPayload: sent.items[1].payload });
    expect(engine.current()).toMatchObject({ key: 'a1:8', source: streamed.source });
  });

  it('forwards transport and settings calls to the plugin', async () => {
    const { plugin, calls } = fakePlugin();
    const engine = new NativeEngine(plugin);
    await engine.play();
    engine.pause();
    engine.seek(90);
    engine.setRate(1.5);
    engine.setAutoAdvance(true);
    engine.setSleepTimer(15);
    engine.setSleepRepeat(true);
    await Promise.resolve();

    expect(calls).toEqual([
      { method: 'play', args: undefined },
      { method: 'pause', args: undefined },
      { method: 'seek', args: { seconds: 90 } },
      { method: 'setRate', args: { rate: 1.5 } },
      { method: 'setAutoAdvance', args: { on: true } },
      { method: 'setSleepTimer', args: { minutes: 15 } },
      { method: 'setSleepRepeat', args: { repeat: true } },
    ]);
    // A seek shows at once, before the native player reports it.
    expect(engine.snapshot().position).toBe(90);
  });
});
