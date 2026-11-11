import { describe, expect, it } from 'vitest';
import { nextStep } from './plan';
import type { SkipView, TranscriptInfo, TranscriptStatus } from './types';

const ep = { episodeId: 12, title: 'Ep', podcast: 'Pod', downloaded: true, isYoutube: false, durationSec: 3600 };
const t = (status: TranscriptStatus): TranscriptInfo => ({ status, segments: [] });
const sv = (p: Partial<SkipView> = {}): SkipView => ({ ads: [], scanned: false, download: null, ...p });

describe('nextStep', () => {
  it.each([
    ['YouTube items are skipped', { ...ep, isYoutube: true }, null, sv(), 'skip'],
    ['a scanned episode whose server copy expired is left alone', { ...ep, downloaded: false }, null, sv({ scanned: true }), 'done'],
    ['scanned is done', ep, t('complete'), sv({ scanned: true }), 'done'],
    ['not on the server → download', { ...ep, downloaded: false }, null, sv(), 'download'],
    ['no transcript → transcribe', ep, null, sv(), 'transcribe'],
    ['pending → wait', ep, t('pending'), sv(), 'wait'],
    ['running → wait', ep, t('running'), sv(), 'wait'],
    ['failed → failed', ep, t('failed'), sv(), 'failed'],
    ['complete → detect', ep, t('complete'), sv(), 'detect'],
  ] as const)('%s', (_, e, tr, s, kind) => expect(nextStep(e, tr, s).kind).toBe(kind));
});
