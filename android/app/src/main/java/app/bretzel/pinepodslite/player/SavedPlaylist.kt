package app.bretzel.pinepodslite.player

import org.json.JSONArray
import org.json.JSONObject

/** A playlist entry from the web code (NativeItem in plugins.ts), times in ms. */
data class PlayerItem(
    val key: String,
    val uri: String,
    val title: String,
    val artist: String,
    val artworkUrl: String,
    val startAtMs: Long,
    val durationMs: Long,
    val payload: String,
)

/**
 * The playlist the service last played from (the window of the web code's
 * list it was handed) and which item was current, so that playback resumed
 * after process death (headphones, the resume card) still auto-advances.
 */
data class SavedPlaylist(val items: List<PlayerItem>, val index: Int) {
    val current: PlayerItem get() = items[index]

    fun toJson(): String {
        val arr = JSONArray()
        for (item in items) {
            arr.put(
                JSONObject()
                    .put("key", item.key)
                    .put("uri", item.uri)
                    .put("title", item.title)
                    .put("artist", item.artist)
                    .put("artworkUrl", item.artworkUrl)
                    .put("startAtMs", item.startAtMs)
                    .put("durationMs", item.durationMs)
                    .put("payload", item.payload)
            )
        }
        return JSONObject().put("index", index).put("items", arr).toString()
    }

    companion object {
        /** Null for nothing stored, anything unreadable, or an index outside the items. */
        fun fromJson(json: String?): SavedPlaylist? {
            if (json == null) return null
            return try {
                val o = JSONObject(json)
                val arr = o.getJSONArray("items")
                val items = (0 until arr.length()).map { i ->
                    val r = arr.getJSONObject(i)
                    PlayerItem(
                        r.getString("key"),
                        r.getString("uri"),
                        r.getString("title"),
                        r.getString("artist"),
                        r.getString("artworkUrl"),
                        r.getLong("startAtMs"),
                        r.getLong("durationMs"),
                        r.getString("payload"),
                    )
                }
                val index = o.getInt("index")
                if (index in items.indices) SavedPlaylist(items, index) else null
            } catch (e: Exception) {
                null
            }
        }
    }
}
