package app.bretzel.pinepodslite.player

import org.json.JSONObject
import kotlin.math.roundToLong

/**
 * An item's ad ranges, in ms. Each is `start..end`, the end being where
 * playback resumes. The web code sends them in the item's payload as
 * `skips: { uri, ranges: [[startSec, endSec], …] }`; they are only valid for
 * the audio at that uri (a copy with other ads has other times).
 */
object SkipRanges {
    /** The payload's ranges when they were found on [playingUri], else none. */
    fun parse(payload: String, playingUri: String): List<LongRange> {
        val skips = try {
            JSONObject(payload).optJSONObject("skips")
        } catch (e: Exception) {
            null
        }
        if (skips == null || skips.optString("uri") != playingUri) return emptyList()
        val ranges = skips.optJSONArray("ranges") ?: return emptyList()
        return (0 until ranges.length()).mapNotNull { i ->
            val range = ranges.optJSONArray(i) ?: return@mapNotNull null
            val start = range.optDouble(0)
            val end = range.optDouble(1)
            if (start.isNaN() || end.isNaN() || end <= start) null else ms(start)..ms(end)
        }
    }

    private fun ms(seconds: Double): Long = (seconds * 1000).roundToLong()
}

/**
 * Decides when playback has to jump over an ad range, as the web player's
 * AdSkipper (src/player/adSkip.ts) does, in ms. Pure: the service feeds it
 * positions and makes the jump itself.
 */
class AdSkipper {
    /** The ranges in force: those last given to [setRanges]. */
    val ranges: List<LongRange> get() = current

    private var current: List<LongRange> = emptyList()
    /** The range the user sought into; it plays until playback leaves it. */
    private var exempt: LongRange? = null

    fun setRanges(ranges: List<LongRange>) {
        current = ranges
        exempt = null
    }

    /** A manual seek: into a range plays it, anywhere else clears the exemption. */
    fun onUserSeek(positionMs: Long) {
        exempt = current.firstOrNull { it.first <= positionMs && positionMs < it.last }
    }

    /**
     * Where to jump from [positionMs], or null to keep playing. A range
     * reaching the end jumps to [durationMs], which ends the item; a
     * [durationMs] of 0 or less (C.TIME_UNSET) is unknown.
     */
    fun target(positionMs: Long, durationMs: Long): Long? {
        val sought = exempt
        if (sought != null) {
            if (sought.first <= positionMs && positionMs < sought.last) return null
            exempt = null
        }
        val range = current.firstOrNull { it.first <= positionMs && positionMs < it.last - END_SLACK_MS }
            ?: return null
        val end = range.last
        return if (durationMs > 0 && end >= durationMs - AT_END_MS) durationMs else end
    }

    private companion object {
        /** So close to a range's end that a seek isn't worth it. */
        const val END_SLACK_MS = 250L
        /** A range ending this close to the end of the item ends the item. */
        const val AT_END_MS = 1_000L
    }
}
