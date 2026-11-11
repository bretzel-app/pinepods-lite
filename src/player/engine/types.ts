import type { Episode } from '../../lib/types';

/** Where an episode's audio comes from. */
export type PlaybackSource = { kind: 'download'; filePath?: string } | { kind: 'stream'; url: string; server?: boolean };

/** Ad ranges to skip, valid for the audio at `uri`. */
export interface Skips {
  uri: string;
  ranges: [number, number][];
}

export interface PlaybackItem {
  key: string; // `${accountId}:${episodeId}`
  accountId: string;
  episode: Episode;
  source: PlaybackSource;
  startAt: number;
  skips?: Skips;
}

export interface EngineSnapshot {
  currentKey: string | null;
  playing: boolean;
  position: number;
  duration: number;
  rate: number;
  sleepRemaining: number | null;
  sleepMinutes: number | null;
}

/** A journal entry the engine recorded while the UI may not have been alive. */
export interface PlaybackReport {
  seq: number;
  kind: 'position' | 'ended';
  key: string;
  accountId: string;
  episode: Episode;
  seconds: number;
  at: number;
}

export type EngineEvent = { type: 'state'; snapshot: EngineSnapshot } | { type: 'reports' };

export interface PlayerEngine {
  readonly kind: 'web' | 'native';
  init(): Promise<EngineSnapshot>; // web: idle snapshot; native: current native state
  load(items: PlaybackItem[], index: number, autoplay: boolean): Promise<void>;
  updatePlaylist(items: PlaybackItem[]): void; // current key must be in items; never interrupts playback
  current(): PlaybackItem | null;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setRate(rate: number): void;
  setAutoAdvance(on: boolean): void;
  setSleepTimer(minutes: number | null): void;
  setSleepRepeat(repeat: boolean): void;
  snapshot(): EngineSnapshot;
  readReports(): Promise<PlaybackReport[]>;
  ackReports(throughSeq: number): Promise<void>;
  subscribe(listener: (e: EngineEvent) => void): () => void;
}
