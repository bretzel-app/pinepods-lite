package app.bretzel.pinepodslite.player

import android.content.Context

/**
 * What the native player keeps across process death, in SharedPreferences
 * `player`: the report journal, the item to resume, and the settings the
 * playback service needs without the UI (sleep timer, auto-advance).
 * Writes use apply(); call from the main thread.
 */
class PlayerStore(context: Context) {
    private val prefs = context.getSharedPreferences("player", Context.MODE_PRIVATE)

    fun loadJournal(): ReportJournal = ReportJournal.fromJson(prefs.getString(JOURNAL, null))

    fun saveJournal(journal: ReportJournal) {
        prefs.edit().putString(JOURNAL, journal.toJson()).apply()
    }

    fun loadResume(): ResumeState? = ResumeState.fromJson(prefs.getString(RESUME, null))

    fun saveResume(resume: ResumeState) {
        prefs.edit().putString(RESUME, resume.toJson()).apply()
    }

    var sleepMinutes: Int?
        get() = if (prefs.contains(SLEEP_MINUTES)) prefs.getInt(SLEEP_MINUTES, 0) else null
        set(value) {
            val edit = prefs.edit()
            if (value == null) edit.remove(SLEEP_MINUTES) else edit.putInt(SLEEP_MINUTES, value)
            edit.apply()
        }

    var sleepRepeat: Boolean
        get() = prefs.getBoolean(SLEEP_REPEAT, false)
        set(value) = prefs.edit().putBoolean(SLEEP_REPEAT, value).apply()

    var autoAdvance: Boolean
        get() = prefs.getBoolean(AUTO_ADVANCE, false)
        set(value) = prefs.edit().putBoolean(AUTO_ADVANCE, value).apply()

    private companion object {
        const val JOURNAL = "journal"
        const val RESUME = "resume"
        const val SLEEP_MINUTES = "sleepMinutes"
        const val SLEEP_REPEAT = "sleepRepeat"
        const val AUTO_ADVANCE = "autoAdvance"
    }
}
