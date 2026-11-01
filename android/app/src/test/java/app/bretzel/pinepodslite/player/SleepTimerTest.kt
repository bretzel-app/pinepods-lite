package app.bretzel.pinepodslite.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SleepTimerTest {
    private var t = 0L
    private val timer = SleepTimer { t }

    @Test fun countsDownWithCeil() {
        timer.arm(10)
        assertEquals(600, timer.remainingSeconds())
        t = 1_000
        assertEquals(599, timer.remainingSeconds())
        t = 1_500
        assertEquals(599, timer.remainingSeconds())
    }

    @Test fun tickFiresOnceAtDeadline() {
        timer.arm(10)
        t = 599_999
        assertFalse(timer.tick(true))
        t = 600_000
        assertTrue(timer.tick(true))
        assertFalse(timer.tick(true))
        assertNull(timer.remainingSeconds())
    }

    @Test fun expiryClearsMinutesUnlessRepeat() {
        timer.arm(10)
        t = 600_000
        timer.tick(true)
        assertNull(timer.minutes)

        val t2 = SleepTimer { t }
        t2.repeat = true
        t2.arm(10)
        t = 1_200_000
        assertTrue(t2.tick(true))
        assertEquals(10, t2.minutes)
    }

    @Test fun expiryWhilePausedDoesNotFireButClearsDeadline() {
        timer.arm(10)
        t = 700_000
        assertFalse(timer.tick(false))
        assertNull(timer.remainingSeconds())
        assertFalse(timer.tick(true))
    }

    @Test fun remainingNeverNegative() {
        timer.arm(1)
        t = 90_000
        assertEquals(0, timer.remainingSeconds())
    }

    @Test fun onUserPlayRearmsWithRepeat() {
        timer.repeat = true
        timer.arm(10)
        t = 300_000
        timer.onUserPlay()
        assertEquals(600, timer.remainingSeconds())
    }

    @Test fun onUserPlayWithoutRepeatChangesNothing() {
        timer.arm(10)
        t = 300_000
        timer.onUserPlay()
        assertEquals(300, timer.remainingSeconds())
    }

    @Test fun armNullCancels() {
        timer.arm(10)
        timer.arm(null)
        assertNull(timer.minutes)
        assertNull(timer.remainingSeconds())
        t = 1_000_000
        assertFalse(timer.tick(true))
    }
}
