package app.bretzel.pinepodslite.player

import org.json.JSONArray
import org.json.JSONObject

enum class ReportKind { POSITION, ENDED }

data class Report(
    val seq: Long,
    val kind: ReportKind,
    val key: String,
    val payload: String,
    val seconds: Double,
    val at: Long,
)

class ReportJournal(reports: List<Report> = emptyList(), nextSeq: Long = 1) {
    private val reports = reports.toMutableList()
    private var nextSeq: Long = maxOf(nextSeq, (reports.maxOfOrNull { it.seq } ?: 0L) + 1)

    private fun add(kind: ReportKind, key: String, payload: String, seconds: Double, at: Long): Report {
        val r = Report(nextSeq++, kind, key, payload, seconds, at)
        reports.add(r)
        return r
    }

    fun recordPosition(key: String, payload: String, seconds: Double, at: Long): Report {
        reports.removeAll { it.kind == ReportKind.POSITION && it.key == key }
        return add(ReportKind.POSITION, key, payload, seconds, at)
    }

    fun recordEnded(key: String, payload: String, seconds: Double, at: Long): Report {
        reports.removeAll { it.kind == ReportKind.POSITION && it.key == key }
        return add(ReportKind.ENDED, key, payload, seconds, at)
    }

    fun pending(): List<Report> = reports.sortedBy { it.seq }

    fun ack(throughSeq: Long) {
        reports.removeAll { it.seq <= throughSeq }
    }

    fun toJson(): String {
        val arr = JSONArray()
        for (r in pending()) {
            arr.put(
                JSONObject()
                    .put("seq", r.seq)
                    .put("kind", r.kind.name)
                    .put("key", r.key)
                    .put("payload", r.payload)
                    .put("seconds", r.seconds)
                    .put("at", r.at)
            )
        }
        return JSONObject().put("nextSeq", nextSeq).put("reports", arr).toString()
    }

    companion object {
        fun fromJson(json: String?): ReportJournal {
            if (json == null) return ReportJournal()
            return try {
                val o = JSONObject(json)
                val arr = o.optJSONArray("reports") ?: JSONArray()
                var maxSeq = 0L
                // One unreadable entry is skipped; it must not cost the others.
                val list = (0 until arr.length()).mapNotNull { i ->
                    val r = arr.optJSONObject(i) ?: return@mapNotNull null
                    maxSeq = maxOf(maxSeq, r.optLong("seq", 0L))
                    try {
                        Report(
                            r.getLong("seq"),
                            ReportKind.valueOf(r.getString("kind")),
                            r.getString("key"),
                            r.getString("payload"),
                            r.getDouble("seconds"),
                            r.getLong("at"),
                        )
                    } catch (e: Exception) {
                        null
                    }
                }
                // Past every seq seen, skipped ones included, so none is reused.
                ReportJournal(list, maxOf(o.optLong("nextSeq", 1), maxSeq + 1))
            } catch (e: Exception) {
                ReportJournal()
            }
        }
    }
}
