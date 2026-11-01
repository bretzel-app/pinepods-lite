import type { Episode } from '../../lib/types';
import type { NativeItem, NativePlayerPlugin, NativeState } from '../../native/plugins';
import type { EngineEvent, EngineSnapshot, PlaybackItem, PlaybackReport, PlayerEngine } from './types';

interface Payload {
  accountId: string;
  episode: Episode;
}

const IDLE: NativeState = {
  currentKey: null,
  currentPayload: null,
  playing: false,
  position: 0,
  duration: 0,
  rate: 1,
  sleepRemaining: null,
  sleepMinutes: null,
};

function parsePayload(payload: string | null | undefined): Payload | null {
  if (!payload) return null;
  try {
    const p = JSON.parse(payload) as Partial<Payload> | null;
    if (typeof p?.accountId !== 'string' || typeof p.episode !== 'object' || p.episode == null) return null;
    return { accountId: p.accountId, episode: p.episode };
  } catch {
    return null;
  }
}

/** Until native downloads exist (or once a file is gone from the index), a
 * download item without a file streams its enclosure, and says so. */
function playable(item: PlaybackItem): PlaybackItem {
  if (item.source.kind !== 'download' || item.source.filePath) return item;
  return { ...item, source: { kind: 'stream', url: item.episode.episodeurl } };
}

function toNative(item: PlaybackItem): NativeItem {
  const ep = item.episode;
  return {
    key: item.key,
    uri: item.source.kind === 'download' ? `file://${item.source.filePath}` : item.source.url,
    title: ep.episodetitle ?? '',
    artist: ep.podcastname ?? '',
    artworkUrl: ep.episodeartwork ?? '',
    startAt: item.startAt,
    duration: ep.episodeduration || 0,
    payload: JSON.stringify({ accountId: item.accountId, episode: ep }),
  };
}

/** The native bridge can drop null fields; fill them back in. */
function normalize(s: Partial<NativeState> | null | undefined): NativeState {
  return {
    currentKey: s?.currentKey ?? null,
    currentPayload: s?.currentPayload ?? null,
    playing: s?.playing ?? false,
    position: s?.position ?? 0,
    duration: s?.duration ?? 0,
    rate: s?.rate ?? 1,
    sleepRemaining: s?.sleepRemaining ?? null,
    sleepMinutes: s?.sleepMinutes ?? null,
  };
}

const warn = (what: string) => (err: unknown) => console.warn(`Native player: ${what} failed`, err);

/**
 * The Android engine: a thin adapter over the NativePlayer plugin, which
 * drives a Media3 service that keeps playing (and keeps its journal) while
 * this page sleeps or is gone. The native side is the source of truth: the
 * current item is whatever its latest state names, rebuilt from the payload
 * it carries.
 */
export class NativeEngine implements PlayerEngine {
  readonly kind = 'native' as const;

  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private started: Promise<EngineSnapshot> | null = null;
  private state: NativeState = IDLE;
  /** Items handed over by this page; their sources back current(). */
  private items: PlaybackItem[] = [];
  private parsed: { payload: string; value: Payload | null } | null = null;

  constructor(private readonly plugin: NativePlayerPlugin) {}

  init(): Promise<EngineSnapshot> {
    this.started ??= this.start();
    return this.started;
  }

  private async start(): Promise<EngineSnapshot> {
    try {
      await this.plugin.addListener('state', (s) => {
        this.state = normalize(s);
        this.emit({ type: 'state', snapshot: this.snapshot() });
      });
      await this.plugin.addListener('reports', () => this.emit({ type: 'reports' }));
      this.state = normalize(await this.plugin.getState());
    } catch (err) {
      warn('init')(err);
    }
    return this.snapshot();
  }

  async load(items: PlaybackItem[], index: number, autoplay: boolean): Promise<void> {
    if (!items[index]) return;
    this.items = items.map(playable);
    await this.plugin.load({ items: this.items.map(toNative), index, autoplay }).catch(warn('load'));
  }

  updatePlaylist(items: PlaybackItem[]): void {
    const next = items.map(playable);
    // The native side keeps its current item as loaded; so do we.
    const kept = this.items.find((i) => i.key === this.state.currentKey);
    this.items = kept ? [kept, ...next.filter((i) => i.key !== kept.key)] : next;
    void this.plugin.updatePlaylist({ items: next.map(toNative) }).catch(warn('updatePlaylist'));
  }

  current(): PlaybackItem | null {
    const key = this.state.currentKey;
    if (key == null) return null;
    const known = this.items.find((i) => i.key === key);
    const meta = this.payload(this.state.currentPayload) ?? known;
    if (!meta) return null;
    return {
      key,
      accountId: meta.accountId,
      episode: meta.episode,
      // Started without this page (headphones after a restart): the native
      // side knows the source, the page doesn't need to.
      source: known?.source ?? { kind: 'stream', url: '' },
      startAt: known?.startAt ?? 0,
    };
  }

  async play(): Promise<void> {
    await this.plugin.play().catch(warn('play'));
  }

  pause(): void {
    void this.plugin.pause().catch(warn('pause'));
  }

  seek(seconds: number): void {
    // Show it now; a skip right after reads this position.
    this.state = { ...this.state, position: seconds };
    this.emit({ type: 'state', snapshot: this.snapshot() });
    void this.plugin.seek({ seconds }).catch(warn('seek'));
  }

  setRate(rate: number): void {
    this.state = { ...this.state, rate };
    this.emit({ type: 'state', snapshot: this.snapshot() });
    void this.plugin.setRate({ rate }).catch(warn('setRate'));
  }

  setAutoAdvance(on: boolean): void {
    void this.plugin.setAutoAdvance({ on }).catch(warn('setAutoAdvance'));
  }

  setSleepTimer(minutes: number | null): void {
    void this.plugin.setSleepTimer({ minutes }).catch(warn('setSleepTimer'));
  }

  setSleepRepeat(repeat: boolean): void {
    void this.plugin.setSleepRepeat({ repeat }).catch(warn('setSleepRepeat'));
  }

  snapshot(): EngineSnapshot {
    const { currentKey, playing, position, duration, rate, sleepRemaining, sleepMinutes } = this.state;
    return { currentKey, playing, position, duration, rate, sleepRemaining, sleepMinutes };
  }

  async readReports(): Promise<PlaybackReport[]> {
    const { reports } = await this.plugin.readReports();
    return reports.flatMap((r) => {
      const meta = parsePayload(r.payload);
      if (!meta) {
        console.warn('Native player: unreadable report payload', r.seq);
        return [];
      }
      return [{ seq: r.seq, kind: r.kind, key: r.key, ...meta, seconds: r.seconds, at: r.at }];
    });
  }

  async ackReports(throughSeq: number): Promise<void> {
    await this.plugin.ackReports({ throughSeq });
  }

  subscribe(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(e: EngineEvent): void {
    for (const listener of this.listeners) listener(e);
  }

  /** The current payload, parsed once per change (state arrives every second). */
  private payload(payload: string | null): Payload | null {
    if (payload == null) return null;
    if (this.parsed?.payload !== payload) this.parsed = { payload, value: parsePayload(payload) };
    return this.parsed.value;
  }
}
