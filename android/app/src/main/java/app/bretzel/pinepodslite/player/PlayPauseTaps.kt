package app.bretzel.pinepodslite.player

/**
 * Play/pause presses from headsets and the apps relaying them (Pixel Buds taps
 * arrive through the Google app): a single press toggles play/pause once no
 * second press follows within the double-tap timeout, a double press skips to
 * the next episode. As Media3 does, but run on the player directly: Media3 runs
 * a single press through a connection for the relaying app, and Pixel Buds
 * taps were lost on the way (a double press, which it runs differently, worked).
 */
class PlayPauseTaps(
    private val timeoutMs: Long,
    private val post: (Runnable, Long) -> Unit,
    private val cancel: (Runnable) -> Unit,
    private val toggle: () -> Unit,
    private val next: () -> Unit,
) {
    private var pending: Runnable? = null

    fun onPress() {
        val first = pending
        if (first != null) {
            cancel(first)
            pending = null
            next()
            return
        }
        val single = Runnable {
            pending = null
            toggle()
        }
        pending = single
        post(single, timeoutMs)
    }

    /** Runs a pending single press now, so presses are handled in order. */
    fun flush() {
        val first = pending ?: return
        cancel(first)
        pending = null
        first.run()
    }
}
