import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** One playlist entry as the native player gets it. Times are in seconds. */
export interface NativeItem {
  key: string;
  uri: string;
  title: string;
  artist: string;
  artworkUrl: string;
  startAt: number;
  duration: number;
  /** JSON `{ accountId, episode }`, handed back in state and reports. */
  payload: string;
}

export interface NativeState {
  currentKey: string | null;
  currentPayload: string | null;
  playing: boolean;
  position: number;
  duration: number;
  rate: number;
  sleepRemaining: number | null;
  sleepMinutes: number | null;
}

export interface NativeReport {
  seq: number;
  kind: 'position' | 'ended';
  key: string;
  payload: string;
  seconds: number;
  at: number;
}

/** The Media3 playback service on Android (NativePlayerPlugin.kt). */
export interface NativePlayerPlugin {
  load(o: { items: NativeItem[]; index: number; autoplay: boolean }): Promise<void>;
  updatePlaylist(o: { items: NativeItem[] }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(o: { seconds: number }): Promise<void>;
  setRate(o: { rate: number }): Promise<void>;
  setAutoAdvance(o: { on: boolean }): Promise<void>;
  setSleepTimer(o: { minutes: number | null }): Promise<void>;
  setSleepRepeat(o: { repeat: boolean }): Promise<void>;
  getState(): Promise<NativeState>;
  readReports(): Promise<{ reports: NativeReport[] }>;
  ackReports(o: { throughSeq: number }): Promise<void>;
  addListener(e: 'state', fn: (s: NativeState) => void): Promise<PluginListenerHandle>;
  addListener(e: 'reports', fn: () => void): Promise<PluginListenerHandle>;
}

export const NativePlayer = registerPlugin<NativePlayerPlugin>('NativePlayer');

/** True inside the Capacitor Android app, false in the browser. */
export const isNative = (): boolean => Capacitor.isNativePlatform();
