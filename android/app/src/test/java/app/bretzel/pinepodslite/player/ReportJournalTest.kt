package app.bretzel.pinepodslite.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReportJournalTest {
    @Test fun positionReplacesEarlierPositionForKey() {
        val j = ReportJournal()
        j.recordPosition("a", "{}", 10.0, 1)
        val second = j.recordPosition("a", "{}", 20.0, 2)
        val p = j.pending()
        assertEquals(1, p.size)
        assertEquals(second.seq, p[0].seq)
        assertEquals(20.0, p[0].seconds, 0.0)
    }

    @Test fun endedDropsPendingPosition() {
        val j = ReportJournal()
        j.recordPosition("a", "{}", 10.0, 1)
        j.recordPosition("b", "{}", 5.0, 1)
        j.recordEnded("a", "{}", 30.0, 2)
        val p = j.pending()
        assertEquals(listOf(ReportKind.POSITION, ReportKind.ENDED), p.map { it.kind })
        assertEquals(listOf("b", "a"), p.map { it.key })
    }

    @Test fun ackRemovesThroughSeq() {
        val j = ReportJournal()
        j.recordPosition("a", "{}", 1.0, 1)
        j.recordPosition("b", "{}", 1.0, 1)
        j.recordPosition("c", "{}", 1.0, 1)
        j.ack(2)
        assertEquals(listOf(3L), j.pending().map { it.seq })
    }

    @Test fun jsonRoundTripContinuesSeq() {
        val j = ReportJournal()
        j.recordPosition("a", "{\"x\":1}", 1.5, 100)
        val last = j.recordEnded("b", "p", 2.0, 200)
        val back = ReportJournal.fromJson(j.toJson())
        assertEquals(j.pending(), back.pending())
        val next = back.recordPosition("c", "{}", 0.0, 300)
        assertTrue(next.seq > last.seq)
    }

    @Test fun nextSeqSurvivesMissingOrSmallStoredValue() {
        val back = ReportJournal.fromJson(
            """{"nextSeq":1,"reports":[{"seq":7,"kind":"ENDED","key":"k","payload":"p","seconds":1.0,"at":1}]}"""
        )
        assertTrue(back.recordPosition("z", "{}", 0.0, 2).seq > 7)
    }

    @Test fun garbageGivesEmptyJournal() {
        assertTrue(ReportJournal.fromJson("{").pending().isEmpty())
        assertTrue(ReportJournal.fromJson(null).pending().isEmpty())
        assertEquals(1L, ReportJournal.fromJson("{").recordPosition("a", "", 0.0, 0).seq)
    }
}
