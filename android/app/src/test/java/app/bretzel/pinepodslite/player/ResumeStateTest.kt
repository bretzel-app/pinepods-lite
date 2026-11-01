package app.bretzel.pinepodslite.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ResumeStateTest {
    @Test fun roundTrip() {
        val s = ResumeState("k", "https://x/a.mp3", "Title", "Artist", "https://x/a.jpg", 12_345, 99_000, "{\"id\":1}")
        assertEquals(s, ResumeState.fromJson(s.toJson()))
    }

    @Test fun nullAndGarbageGiveNull() {
        assertNull(ResumeState.fromJson(null))
        assertNull(ResumeState.fromJson("nope"))
        assertNull(ResumeState.fromJson("{\"key\":\"k\"}"))
    }
}
