package app.bretzel.pinepodslite.player

import org.json.JSONObject

/**
 * A downloaded episode whose file is gone (download deleted, marked played,
 * swept as completed) streams its enclosure instead, as the browser does,
 * rather than leaving the player stuck on a dead file.
 */
object MissingDownload {
    private const val FILE = "file://"

    /**
     * The enclosure URL (the payload's episode.episodeurl) to play instead of
     * [uri] when [uri] is a local file that doesn't exist; null when [uri]
     * plays as is, or the payload names no http(s) enclosure.
     */
    fun streamUri(uri: String, payload: String, exists: (path: String) -> Boolean): String? {
        if (!uri.startsWith(FILE) || exists(uri.removePrefix(FILE))) return null
        val url = try {
            JSONObject(payload).optJSONObject("episode")?.optString("episodeurl")
        } catch (e: Exception) {
            null
        }
        return url?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
    }
}
