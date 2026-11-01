/** Where an episode's audio comes from. */
export type PlaybackSource = { kind: 'download'; filePath?: string } | { kind: 'stream'; url: string };
