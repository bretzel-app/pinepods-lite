export interface SavedEpisode { episodeId: number; title: string; podcast: string; downloaded: boolean; isYoutube: boolean; durationSec: number }
export interface Seg { start: number; end: number; text: string }
export type TranscriptStatus = 'pending' | 'running' | 'complete' | 'failed';
export interface TranscriptInfo { status: TranscriptStatus; segments: Seg[] }
export type CopyMatch = 'match' | 'mismatch' | 'unknown' | 'none';
export interface SkipView { ads: { start: number; end: number }[]; scanned: boolean; download: CopyMatch | null }
export interface AdRange { start: number; end: number; label: string }
export interface PinepodsApi {
  saved(): Promise<SavedEpisode[]>;
  download(episodeId: number): Promise<void>;
  transcribe(episodeId: number, force: boolean): Promise<void>;
  transcript(episodeId: number): Promise<TranscriptInfo | null>;
  skips(episodeId: number): Promise<SkipView>;
}
export interface AdskipDb { checkSchema(): Promise<void>; writeAds(episodeId: number, ranges: AdRange[]): Promise<void>; clearAds(episodeId: number): Promise<void> }
export interface Notifier { success(text: string): Promise<void>; error(key: string, text: string): Promise<void> }
