import { describe, expect, it } from 'vitest';
import { needsTranscript, nextStep } from './plan';
import type { SkipView, TranscriptInfo, TranscriptStatus } from './types';

const ep = { episodeId: 12, title: 'Ep', podcast: 'Pod', downloaded: true, isYoutube: false, durationSec: 3600 };
const t = (status: TranscriptStatus, segments = [{ start: 0, end: 5, text: 'hi' }]): TranscriptInfo => ({ status, segments });
const sv = (p: Partial<SkipView> = {}): SkipView => ({ ads: [], scanned: false, download: null, ...p });

describe('nextStep', () => {
  it.each([
    ['YouTube items are skipped', { ...ep, isYoutube: true }, sv(), null, 'skip'],
    ['a scanned episode whose server copy expired is left alone', { ...ep, downloaded: false }, sv({ scanned: true }), null, 'done'],
    ['scanned is done', ep, sv({ scanned: true }), null, 'done'],
    ['not on the server → download', { ...ep, downloaded: false }, sv(), null, 'download'],
    ['no transcript → transcribe', ep, sv(), null, 'transcribe'],
    ['pending → wait', ep, sv(), t('pending'), 'wait'],
    ['running → wait', ep, sv(), t('running'), 'wait'],
    ['failed → failed', ep, sv(), t('failed'), 'failed'],
    ['complete → detect', ep, sv(), t('complete'), 'detect'],
    ['complete without segments → empty', ep, sv(), t('complete', []), 'empty'],
  ] as const)('%s', (_, e, s, tr, kind) => expect(nextStep(e, s, tr).kind).toBe(kind));
});

describe('needsTranscript', () => {
  it.each([
    ['a downloaded, unscanned episode', ep, sv(), true],
    ['a scanned episode', ep, sv({ scanned: true }), false],
    ['an episode not on the server', { ...ep, downloaded: false }, sv(), false],
    ['a YouTube item', { ...ep, isYoutube: true }, sv(), false],
  ] as const)('%s', (_, e, s, needed) => expect(needsTranscript(e, s)).toBe(needed));

  it('agrees with nextStep: a step that needs no transcript ignores it', () => {
    for (const [e, s] of [[ep, sv({ scanned: true })], [{ ...ep, downloaded: false }, sv()], [{ ...ep, isYoutube: true }, sv()]] as const) {
      expect(needsTranscript(e, s)).toBe(false);
      expect(nextStep(e, s, null).kind).toBe(nextStep(e, s, t('complete')).kind);
    }
  });
});
