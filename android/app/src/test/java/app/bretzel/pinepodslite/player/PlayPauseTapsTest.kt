package app.bretzel.pinepodslite.player

import org.junit.Assert.assertEquals
import org.junit.Test

class PlayPauseTapsTest {
    private val log = mutableListOf<String>()
    private val scheduled = mutableListOf<Runnable>()
    private val taps = PlayPauseTaps(
        timeoutMs = 300,
        post = { r, delay -> assertEquals(300L, delay); scheduled += r },
        cancel = { scheduled -= it },
        toggle = { log += "toggle" },
        next = { log += "next" },
    )

    private fun timeout() = scheduled.toList().also { scheduled.clear() }.forEach { it.run() }

    @Test fun singlePressTogglesAfterTheTimeout() {
        taps.onPress()
        assertEquals(emptyList<String>(), log)
        timeout()
        assertEquals(listOf("toggle"), log)
    }

    @Test fun doublePressSkipsWithoutToggling() {
        taps.onPress()
        taps.onPress()
        timeout()
        assertEquals(listOf("next"), log)
    }

    @Test fun separatePressesToggleEachTime() {
        taps.onPress()
        timeout()
        taps.onPress()
        timeout()
        assertEquals(listOf("toggle", "toggle"), log)
    }

    @Test fun flushRunsAPendingPressOnce() {
        taps.onPress()
        taps.flush()
        timeout()
        taps.flush()
        assertEquals(listOf("toggle"), log)
    }
}
