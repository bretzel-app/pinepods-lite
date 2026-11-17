package app.bretzel.pinepodslite.player

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * TEMPORARY diagnostics for the headset tap: what reaches the player, kept as
 * the last [MAX_LINES] lines in a file (so it survives the process) for
 * Settings to show and copy. Main thread only.
 */
object DebugLog {
    private const val TAG = "PlaybackService"
    private const val MAX_LINES = 300
    private val time = SimpleDateFormat("HH:mm:ss.SSS", Locale.ROOT)
    private var lines: ArrayDeque<String>? = null

    private fun file(context: Context) = File(context.filesDir, "player-debug.log")

    private fun lines(context: Context): ArrayDeque<String> = lines ?: ArrayDeque<String>().also { loaded ->
        runCatching { loaded.addAll(file(context).readLines()) }
        while (loaded.size > MAX_LINES) loaded.removeFirst()
        lines = loaded
    }

    fun add(context: Context, text: String) {
        Log.i(TAG, text)
        val all = lines(context)
        all.addLast("${time.format(Date())} $text")
        while (all.size > MAX_LINES) all.removeFirst()
        runCatching { file(context).writeText(all.joinToString("\n")) }
    }

    fun read(context: Context): String = lines(context).joinToString("\n")

    fun clear(context: Context) {
        lines = ArrayDeque()
        runCatching { file(context).delete() }
    }
}
