package app.bretzel.pinepodslite.player

import android.view.KeyEvent
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaButtonsTest {
    private fun press(keyCode: Int, playing: Boolean, action: Int = KeyEvent.ACTION_DOWN, repeat: Int = 0) =
        MediaButtons.playMeansPause(keyCode, action, repeat, playing)

    @Test fun playWhilePlayingPauses() {
        assertTrue(press(KeyEvent.KEYCODE_MEDIA_PLAY, playing = true))
    }

    @Test fun playWhilePausedPlays() {
        assertFalse(press(KeyEvent.KEYCODE_MEDIA_PLAY, playing = false))
    }

    @Test fun onlyTheKeyDownCounts() {
        assertFalse(press(KeyEvent.KEYCODE_MEDIA_PLAY, playing = true, action = KeyEvent.ACTION_UP))
        assertFalse(press(KeyEvent.KEYCODE_MEDIA_PLAY, playing = true, repeat = 1))
    }

    @Test fun otherKeysAreLeftToMedia3() {
        assertFalse(press(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, playing = true))
        assertFalse(press(KeyEvent.KEYCODE_MEDIA_PAUSE, playing = true))
        assertFalse(press(KeyEvent.KEYCODE_MEDIA_NEXT, playing = true))
    }
}
