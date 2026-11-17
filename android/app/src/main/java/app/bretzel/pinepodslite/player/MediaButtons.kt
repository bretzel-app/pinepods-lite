package app.bretzel.pinepodslite.player

import android.view.KeyEvent

/**
 * Media button handling on top of Media3's own.
 *
 * Bluetooth has no play/pause toggle: a headset sends either PLAY or PAUSE,
 * chosen from the playback state it believes the phone is in. Some headsets
 * (Pixel Buds with this app, the car head unit in androidx/media#159) send
 * PLAY for a tap while playing, which Media3 takes literally: nothing happens.
 * A press of play while playing can only mean pause, so it pauses.
 */
object MediaButtons {
    /** True when this key event is a press of play while [playing], to be handled as pause. */
    fun playMeansPause(keyCode: Int, action: Int, repeatCount: Int, playing: Boolean): Boolean =
        playing && keyCode == KeyEvent.KEYCODE_MEDIA_PLAY && action == KeyEvent.ACTION_DOWN && repeatCount == 0
}
