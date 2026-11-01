import type { PlayerEngine } from './types';
import { WebEngine } from './webEngine';

/** The playback engine for this platform. */
export function createEngine(): PlayerEngine {
  return new WebEngine();
}
