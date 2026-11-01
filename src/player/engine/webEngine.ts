import { getDownloadBlob } from '../../lib/db';
import type { EngineEvent, EngineSnapshot, PlaybackItem, PlaybackReport, PlayerEngine } from './types';

/** Fade-out when the sleep timer expires: 25 steps × 200 ms ≈ 5 s. */
const FADE_STEPS = 25;
const FADE_STEP_MS = 200;

/**
 * The browser engine: an off-DOM `<audio>` element plus the Media Session,
 * the sleep timer and auto-advance through the playlist the UI hands over.
 * It only lives while the page does, so its report journal is in memory.
 */
export class WebEngine implements PlayerEngine {
  readonly kind = 'web' as const;

  private readonly audio: HTMLAudioElement;
  private readonly loadBlob: typeof getDownloadBlob;
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private started = false;

  private items: PlaybackItem[] = [];
  private index = -1;
  /** Bumped by every load so a superseded one doesn't switch the source. */
  private loadToken = 0;
  private blobUrl: string | null = null;
  /** Where to seek once metadata loads; setting currentTime earlier is ignored. */
  private pendingSeek: number | null = null;
  private playing = false;
  private rate = 1;
  private autoAdvance = false;
  // Set while auto-advancing so the play it causes isn't taken for a press.
  private autoAdvancing = false;

  private sleepMinutes: number | null = null;
  private sleepRepeat = false;
  private sleepUntil: number | null = null;
  private sleepRemaining: number | null = null;
  private sleepTick: number | null = null;

  private reports: PlaybackReport[] = [];
  private lastSeq = 0;

  constructor(audio: HTMLAudioElement = new Audio(), loadBlob = getDownloadBlob) {
    this.audio = audio;
    this.loadBlob = loadBlob;
    audio.preload = 'metadata';
    audio.addEventListener('timeupdate', this.emitState);
    audio.addEventListener('durationchange', this.emitState);
    audio.addEventListener('ratechange', this.emitState);
    audio.addEventListener('play', this.onPlay);
    audio.addEventListener('pause', this.onPause);
    audio.addEventListener('ended', this.onEnded);
    audio.addEventListener('loadedmetadata', this.onMetadata);
  }

  async init(): Promise<EngineSnapshot> {
    if (!this.started) {
      this.started = true;
      this.installMediaSession();
      this.updatePlaybackState();
    }
    return this.snapshot();
  }

  /** Point the audio element at `items[index]` and cue it at its start.
   * With autoplay=false this only loads (used to restore the last-played
   * episode on app start, so one tap on Play resumes). */
  async load(items: PlaybackItem[], index: number, autoplay: boolean): Promise<void> {
    const item = items[index];
    if (!item) return;
    const token = ++this.loadToken;

    let src = item.source.kind === 'stream' ? item.source.url : '';
    let blob: Blob | undefined;
    if (item.source.kind === 'download') {
      blob = await this.loadBlob(item.accountId, item.episode.episodeid);
      if (token !== this.loadToken) return;
      // The entry outlived its audio: play the enclosure instead.
      if (!blob) src = item.episode.episodeurl;
    }

    const audio = this.audio;
    if (!autoplay) {
      audio.pause();
      this.playing = false;
    }
    this.items = items;
    this.index = index;
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
    if (blob) {
      this.blobUrl = URL.createObjectURL(blob);
      src = this.blobUrl;
    }
    audio.src = src;
    // Loading resets the rate to the default one.
    audio.playbackRate = this.rate;
    // Applied on loadedmetadata; setting currentTime too early is ignored.
    this.pendingSeek = item.startAt > 3 ? item.startAt : null;
    this.updateMetadata(item);
    this.updateTrackActions();
    this.emitState();

    if (!autoplay) return;
    // Resolves once playback starts (after the 'play' event), or on failure.
    await audio.play().catch(() => {});
    // Switching sources pauses without a 'pause' event; if playback of the
    // new one was refused, say so instead of showing the old 'playing'.
    if (token === this.loadToken && audio.paused && this.playing) {
      this.playing = false;
      this.emitState();
    }
  }

  updatePlaylist(items: PlaybackItem[]): void {
    const current = this.current();
    if (!current) return;
    const at = items.findIndex((i) => i.key === current.key);
    if (at < 0) return;
    // Keep the cued item itself: only its neighbours change.
    this.items = items.map((item, i) => (i === at ? current : item));
    this.index = at;
    this.updateTrackActions();
  }

  current(): PlaybackItem | null {
    return this.items[this.index] ?? null;
  }

  async play(): Promise<void> {
    if (!this.current()) return;
    // A source that failed to load (e.g. restored while offline) is loaded
    // again rather than left dead.
    if (this.audio.error) return this.load(this.items, this.index, true);
    await this.audio.play().catch(() => {});
  }

  pause(): void {
    this.audio.pause();
  }

  seek(seconds: number): void {
    this.audio.currentTime = seconds;
    if (this.pendingSeek != null) this.pendingSeek = seconds;
    this.emitState();
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.audio.playbackRate = rate;
    this.emitState();
  }

  setAutoAdvance(on: boolean): void {
    this.autoAdvance = on;
  }

  setSleepTimer(minutes: number | null): void {
    this.sleepMinutes = minutes;
    if (minutes == null) {
      this.stopSleepTick();
      this.sleepUntil = null;
      this.sleepRemaining = null;
    } else {
      this.armSleep(minutes);
    }
    this.emitState();
  }

  setSleepRepeat(repeat: boolean): void {
    this.sleepRepeat = repeat;
  }

  snapshot(): EngineSnapshot {
    const item = this.current();
    return {
      currentKey: item?.key ?? null,
      playing: this.playing,
      position: this.pendingSeek ?? this.audio.currentTime,
      // The loaded file's length beats the feed's (ad insertion makes them differ).
      duration: this.audio.duration || item?.episode.episodeduration || 0,
      rate: this.rate,
      sleepRemaining: this.sleepRemaining,
      sleepMinutes: this.sleepMinutes,
    };
  }

  async readReports(): Promise<PlaybackReport[]> {
    return [...this.reports];
  }

  async ackReports(throughSeq: number): Promise<void> {
    this.reports = this.reports.filter((r) => r.seq > throughSeq);
  }

  subscribe(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- audio events ------------------------------------------------------

  private emit(e: EngineEvent): void {
    for (const listener of this.listeners) listener(e);
  }

  private emitState = (): void => {
    this.updatePlaybackState();
    this.emit({ type: 'state', snapshot: this.snapshot() });
  };

  private onMetadata = (): void => {
    if (this.pendingSeek == null) return;
    this.audio.currentTime = this.pendingSeek;
    this.pendingSeek = null;
  };

  private onPlay = (): void => {
    this.playing = true;
    // Check-in mode: every press of play re-arms the timer to its full
    // duration, so falling asleep costs at most one interval. Auto-advance
    // isn't a check-in: the timer keeps counting down.
    if (!this.autoAdvancing && this.sleepRepeat && this.sleepMinutes != null) {
      this.armSleep(this.sleepMinutes);
    }
    this.emitState();
  };

  private onPause = (): void => {
    this.playing = false;
    this.emitState();
  };

  private onEnded = (): void => {
    this.playing = false;
    this.emitState();
    // Playback reached the end: the UI marks it completed on the server and
    // drops the local offline copy.
    const item = this.current();
    if (item) {
      this.reports.push({
        seq: ++this.lastSeq,
        kind: 'ended',
        key: item.key,
        accountId: item.accountId,
        episode: item.episode,
        seconds: this.audio.duration || this.audio.currentTime,
        at: Date.now(),
      });
      this.emit({ type: 'reports' });
    }
    if (this.autoAdvance && this.items[this.index + 1]) {
      this.autoAdvancing = true;
      void this.load(this.items, this.index + 1, true).finally(() => {
        this.autoAdvancing = false;
      });
    }
  };

  // ---- sleep timer -------------------------------------------------------

  /** (Re)start the countdown from the full duration. */
  private armSleep(minutes: number): void {
    this.sleepUntil = Date.now() + minutes * 60_000;
    this.sleepRemaining = minutes * 60;
    this.stopSleepTick();
    this.sleepTick = window.setInterval(this.onSleepTick, 1000);
  }

  private stopSleepTick(): void {
    if (this.sleepTick != null) window.clearInterval(this.sleepTick);
    this.sleepTick = null;
  }

  /** Count down (even while paused), then fade out over ~5s and pause. */
  private onSleepTick = (): void => {
    if (this.sleepUntil == null) return;
    const remaining = Math.ceil((this.sleepUntil - Date.now()) / 1000);
    if (remaining > 0) {
      this.sleepRemaining = remaining;
      this.emitState();
      return;
    }
    this.stopSleepTick();
    this.sleepUntil = null;
    this.sleepRemaining = null;
    // One-shot timers disarm on expiry; check-in timers stay armed and
    // re-start the countdown on the next play.
    if (!this.sleepRepeat) this.sleepMinutes = null;
    this.emitState();
    const audio = this.audio;
    if (audio.paused) return; // expired while already paused
    const startVolume = audio.volume;
    let step = 0;
    const fade = window.setInterval(() => {
      step++;
      try {
        // Some platforms (iOS) expose a read-only volume; fading is
        // best-effort there and we still pause at the end.
        audio.volume = Math.max(0, startVolume * (1 - step / FADE_STEPS));
      } catch {
        /* ignore */
      }
      if (step >= FADE_STEPS) {
        window.clearInterval(fade);
        audio.pause();
        try {
          audio.volume = startVolume;
        } catch {
          /* ignore */
        }
      }
    }, FADE_STEP_MS);
  };

  // ---- media session -----------------------------------------------------

  private skip(delta: number): void {
    const { position, duration } = this.snapshot();
    this.seek(Math.max(0, Math.min(duration || Infinity, position + delta)));
  }

  /** Media session transport controls (lock screen / hardware keys). */
  private installMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    // Explicit play/pause (not toggle): the notification's idea of the state
    // can drift from ours after the tab was frozen in the background.
    navigator.mediaSession.setActionHandler('play', () => void this.play());
    navigator.mediaSession.setActionHandler('pause', () => this.pause());
    navigator.mediaSession.setActionHandler('seekbackward', () => this.skip(-15));
    navigator.mediaSession.setActionHandler('seekforward', () => this.skip(30));
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) this.seek(details.seekTime);
    });

    // Keep the media session's position current. Android uses it for the
    // notification's progress bar.
    if (!navigator.mediaSession.setPositionState) return;
    const audio = this.audio;
    const update = () => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
      try {
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          position: Math.min(audio.currentTime, audio.duration),
          playbackRate: audio.playbackRate,
        });
      } catch {
        // Invalid transient values (e.g. mid-load) — skip this update.
      }
    };
    audio.addEventListener('durationchange', update);
    audio.addEventListener('seeked', update);
    audio.addEventListener('ratechange', update);
    audio.addEventListener('play', update);
    audio.addEventListener('pause', update);
    window.setInterval(update, 5000);
  }

  /** Android uses the playback state to decide how long a paused session's
   * notification survives in the background. */
  private updatePlaybackState(): void {
    if (!('mediaSession' in navigator)) return;
    const state = this.current() ? (this.playing ? 'playing' : 'paused') : 'none';
    if (navigator.mediaSession.playbackState !== state) navigator.mediaSession.playbackState = state;
  }

  private updateMetadata(item: PlaybackItem): void {
    if (!('mediaSession' in navigator)) return;
    const ep = item.episode;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ep.episodetitle,
      artist: ep.podcastname,
      artwork: ep.episodeartwork ? [{ src: ep.episodeartwork }] : [],
    });
  }

  /** Lock-screen previous/next walk the playlist; a null handler hides the
   * button at its ends. */
  private updateTrackActions(): void {
    if (!('mediaSession' in navigator)) return;
    const go = (index: number) => () => void this.load(this.items, index, true);
    try {
      navigator.mediaSession.setActionHandler('previoustrack', this.index > 0 ? go(this.index - 1) : null);
      navigator.mediaSession.setActionHandler(
        'nexttrack',
        this.index + 1 < this.items.length ? go(this.index + 1) : null,
      );
    } catch {
      // Older browsers reject unknown actions.
    }
  }
}
