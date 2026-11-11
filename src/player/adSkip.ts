/** Decides when playback has to jump over an ad range. Pure: the engine feeds
 * it positions and applies the jump itself. */
export class AdSkipper {
  private ranges: [number, number][] = [];
  /** The range the user sought into; it plays until playback leaves it. */
  private exempt: [number, number] | null = null;

  setRanges(ranges: [number, number][]): void {
    this.ranges = ranges;
    this.exempt = null;
  }

  /** A manual seek: into a range plays it, anywhere else clears the exemption. */
  onUserSeek(position: number): void {
    this.exempt = this.ranges.find(([s, e]) => s <= position && position < e) ?? null;
  }

  /** Where to jump from `position`, or null to keep playing. */
  target(position: number, duration: number): number | null {
    if (this.exempt) {
      const [s, e] = this.exempt;
      if (s <= position && position < e) return null;
      this.exempt = null;
    }
    const range = this.ranges.find(([s, e]) => s <= position && position < e - 0.25);
    if (!range) return null;
    const end = range[1];
    return duration > 0 && end >= duration - 1 ? duration : end;
  }
}
