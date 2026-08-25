/** A PinePods account this client knows about. Several can coexist. */
export interface Account {
  id: string;
  /** Server base URL, no trailing slash, e.g. https://pods.example.com */
  serverUrl: string;
  apiKey: string;
  userId: number;
  username: string;
  fullname: string;
  addedAt: number;
}

/** Normalized episode shape. The server returns different key casings per
 * endpoint (episodetitle vs Episodetitle); everything is normalized to this. */
export interface Episode {
  episodeid: number;
  episodetitle: string;
  podcastid?: number;
  podcastname: string;
  episodepubdate: string;
  episodedescription: string;
  episodeartwork: string;
  episodeurl: string;
  /** seconds */
  episodeduration: number;
  /** seconds listened, from the server */
  listenduration?: number | null;
  /** when the server last saw this episode listened to (history rows only) */
  listendate?: string | null;
  completed: boolean;
  saved: boolean;
  queued: boolean;
  downloaded: boolean;
  is_youtube: boolean;
}

export interface Podcast {
  podcastid: number;
  podcastname: string;
  artworkurl?: string | null;
  description?: string | null;
  episodecount?: number | null;
  websiteurl?: string | null;
  feedurl: string;
  author?: string | null;
  categories?: Record<string, string> | null;
  explicit: boolean;
  podcastindexid?: number | null;
  is_youtube?: boolean;
}

/** A search hit from the Podcast Index (via the server's proxy_search). */
export interface SearchResult {
  indexId: number;
  title: string;
  feedUrl: string;
  description: string;
  author: string;
  artwork: string;
  website: string;
  explicit: boolean;
  episodeCount: number;
  categories: Record<string, string>;
}

/** Locally saved playback position, the offline source of truth for resume. */
export interface LocalPosition {
  /** `${accountId}:${episodeId}` */
  key: string;
  accountId: string;
  episodeId: number;
  seconds: number;
  duration: number;
  updatedAt: number;
  /** false while the server hasn't been told yet */
  synced: boolean;
}

/** Metadata for an episode whose audio is stored locally. */
export interface DownloadEntry {
  /** `${accountId}:${episodeId}` */
  key: string;
  accountId: string;
  episode: Episode;
  mimeType: string;
  size: number;
  downloadedAt: number;
}

/** A mutation made while offline, replayed when connectivity returns. */
export interface PendingOp {
  id?: number;
  accountId: string;
  createdAt: number;
  op:
    | { kind: 'save_episode'; episodeId: number }
    | { kind: 'unsave_episode'; episodeId: number }
    | { kind: 'mark_completed'; episodeId: number }
    | { kind: 'mark_uncompleted'; episodeId: number }
    | { kind: 'record_position'; episodeId: number; seconds: number };
}
