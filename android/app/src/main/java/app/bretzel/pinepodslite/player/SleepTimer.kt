package app.bretzel.pinepodslite.player

/** Sleep timer countdown. Runs while paused; fires only when playing. */
class SleepTimer(private val now: () -> Long) {
    var minutes: Int? = null
    var repeat: Boolean = false
    private var deadline: Long? = null

    fun arm(minutes: Int?) {
        this.minutes = minutes
        deadline = minutes?.let { now() + it * 60_000L }
    }

    fun onUserPlay() {
        val m = minutes
        if (repeat && m != null) arm(m)
    }

    fun remainingSeconds(): Int? {
        val d = deadline ?: return null
        val ms = d - now()
        if (ms <= 0) return 0
        return ((ms + 999) / 1000).toInt()
    }

    fun tick(isPlaying: Boolean): Boolean {
        val d = deadline ?: return false
        if (now() < d) return false
        deadline = null
        if (!repeat) minutes = null
        return isPlaying
    }
}
