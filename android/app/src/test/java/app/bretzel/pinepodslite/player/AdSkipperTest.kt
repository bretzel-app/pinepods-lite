package app.bretzel.pinepodslite.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AdSkipperTest {
    private val payload = """{"accountId":"a","episode":{},"skips":{"uri":"file:///d/a_7","ranges":[[10,40],[90.5,120]]}}"""

    private fun skipper() = AdSkipper().apply { setRanges(listOf(10_000L..40_000L, 90_000L..120_000L)) }

    @Test fun parsesRangesForThePlayingUri() =
        assertEquals(listOf(10_000L..40_000L, 90_500L..120_000L), SkipRanges.parse(payload, "file:///d/a_7"))

    @Test fun noRangesForAnotherUri() = assertEquals(emptyList<LongRange>(), SkipRanges.parse(payload, "https://cdn/7.mp3"))

    @Test fun noRangesWithoutSkipsOrValidJson() {
        assertEquals(emptyList<LongRange>(), SkipRanges.parse("""{"episode":{}}""", "x"))
        assertEquals(emptyList<LongRange>(), SkipRanges.parse("nope", "x"))
    }

    @Test fun malformedRangesAreLeftOut() {
        val odd = """{"skips":{"uri":"x","ranges":[[10,40],"no",[50],[70,60],[80,95]]}}"""
        assertEquals(listOf(10_000L..40_000L, 80_000L..95_000L), SkipRanges.parse(odd, "x"))
    }

    @Test fun jumpsToTheRangeEnd() {
        val k = AdSkipper().apply { setRanges(listOf(10_000L..40_000L)) }
        assertEquals(40_000L, k.target(15_000, 3_600_000))
    }

    @Test fun leavesOtherPositionsAlone() = assertNull(skipper().target(50_000, 3_600_000))

    @Test fun ignoresTheLastQuarterSecondOfARange() {
        assertNull(skipper().target(39_800, 3_600_000))
        assertEquals(40_000L, skipper().target(39_749, 3_600_000))
    }

    @Test fun rangeAtTheEndJumpsToDuration() {
        val k = AdSkipper().apply { setRanges(listOf(3_500_000L..3_599_500L)) }
        assertEquals(3_600_000L, k.target(3_550_000, 3_600_000))
    }

    @Test fun unknownDurationJumpsToTheRangeEnd() {
        val k = AdSkipper().apply { setRanges(listOf(3_500_000L..3_599_500L)) }
        assertEquals(3_599_500L, k.target(3_550_000, Long.MIN_VALUE + 1)) // C.TIME_UNSET
        assertEquals(3_599_500L, k.target(3_550_000, 0))
    }

    @Test fun manualSeekIntoRangePlaysIt() {
        val k = AdSkipper().apply { setRanges(listOf(10_000L..40_000L)) }
        k.onUserSeek(20_000)
        assertNull(k.target(25_000, 3_600_000))
    }

    @Test fun skippingResumesAtTheNextRange() {
        val k = skipper()
        k.onUserSeek(20_000)
        k.target(41_000, 3_600_000)
        assertEquals(120_000L, k.target(95_000, 3_600_000))
    }

    @Test fun seekOutsideAnyRangeClearsTheExemption() {
        val k = skipper()
        k.onUserSeek(20_000)
        k.onUserSeek(60_000)
        assertEquals(40_000L, k.target(25_000, 3_600_000))
    }

    @Test fun resumePointInsideAnAdIsSkipped() {
        val k = AdSkipper().apply { setRanges(listOf(10_000L..40_000L)) }
        assertEquals(40_000L, k.target(12_000, 3_600_000))
    }

    @Test fun setRangesClearsTheExemption() {
        val k = skipper()
        k.onUserSeek(20_000)
        k.setRanges(listOf(10_000L..40_000L))
        assertEquals(40_000L, k.target(25_000, 3_600_000))
        assertEquals(listOf(10_000L..40_000L), k.ranges)
    }
}
