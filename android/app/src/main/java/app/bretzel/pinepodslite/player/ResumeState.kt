package app.bretzel.pinepodslite.player

import org.json.JSONObject

data class ResumeState(
    val key: String,
    val uri: String,
    val title: String,
    val artist: String,
    val artworkUrl: String,
    val positionMs: Long,
    val durationMs: Long,
    val payload: String,
) {
    fun toJson(): String = JSONObject()
        .put("key", key)
        .put("uri", uri)
        .put("title", title)
        .put("artist", artist)
        .put("artworkUrl", artworkUrl)
        .put("positionMs", positionMs)
        .put("durationMs", durationMs)
        .put("payload", payload)
        .toString()

    companion object {
        fun fromJson(json: String?): ResumeState? {
            if (json == null) return null
            return try {
                val o = JSONObject(json)
                ResumeState(
                    o.getString("key"),
                    o.getString("uri"),
                    o.getString("title"),
                    o.getString("artist"),
                    o.getString("artworkUrl"),
                    o.getLong("positionMs"),
                    o.getLong("durationMs"),
                    o.getString("payload"),
                )
            } catch (e: Exception) {
                null
            }
        }
    }
}
