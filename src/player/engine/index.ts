import { NativePlayer, isNative } from '../../native/plugins';
import { NativeEngine } from './nativeEngine';
import type { PlayerEngine } from './types';
import { WebEngine } from './webEngine';

/** The playback engine for this platform: the native Media3 player in the
 * Android app, the `<audio>` element in the browser. */
export function createEngine(): PlayerEngine {
  return isNative() ? new NativeEngine(NativePlayer) : new WebEngine();
}
