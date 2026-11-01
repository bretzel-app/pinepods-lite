package app.bretzel.pinepodslite.downloads

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File

/**
 * Episode downloads through the system DownloadManager (NativeDownloadsPlugin in
 * src/native/plugins.ts). The manager keeps going when the app is closed; the
 * web side polls [status] while it runs and calls [finished] on startup to pick
 * up downloads that completed in the meantime. SharedPreferences "downloads"
 * maps key -> { downloadId, entry } until the web side has stored the metadata
 * and calls [forget].
 */
@CapacitorPlugin(name = "NativeDownloads")
class NativeDownloadsPlugin : Plugin() {
    private val prefs by lazy { context.getSharedPreferences("downloads", Context.MODE_PRIVATE) }
    private val manager by lazy { context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager }

    /** Keys look like "<accountId>:<episodeId>"; ':' is not safe in file names. */
    private fun file(key: String): File {
        val dir = context.getExternalFilesDir("episodes") ?: File(context.filesDir, "episodes")
        if (!dir.exists()) dir.mkdirs()
        return File(dir, key.replace(':', '_'))
    }

    private fun tracked(key: String): JSONObject? = prefs.getString(key, null)?.let { JSONObject(it) }

    private class Snapshot(val state: String, val fraction: Double?, val mimeType: String?)

    /**
     * Reads the manager's row for the download. DownloadManager reports
     * PAUSED/PENDING (e.g. waiting for network or a retry) as still running;
     * an empty cursor means the row is gone (user cancelled it from the
     * notification), which we report as "unknown".
     */
    private fun query(downloadId: Long): Snapshot {
        manager.query(DownloadManager.Query().setFilterById(downloadId)).use { c ->
            if (!c.moveToFirst()) return Snapshot("unknown", null, null)
            val status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
            val done = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
            val total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
            val mime = c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_MEDIA_TYPE))
            return when (status) {
                DownloadManager.STATUS_SUCCESSFUL -> Snapshot("done", 1.0, mime)
                DownloadManager.STATUS_FAILED -> Snapshot("failed", null, mime)
                // total is -1 until the server has told us the size.
                else -> Snapshot("running", if (total > 0) done.toDouble() / total else null, mime)
            }
        }
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key required")
        val url = call.getString("url") ?: return call.reject("url required")
        val title = call.getString("title") ?: ""
        val entry = call.getString("entry") ?: return call.reject("entry required")
        try {
            val target = file(key)
            // The manager would otherwise pick a new name when the file exists.
            if (target.exists()) target.delete()
            val request = DownloadManager.Request(Uri.parse(url))
                .setTitle(title)
                .setDestinationUri(Uri.fromFile(target))
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(true)
            val id = manager.enqueue(request)
            prefs.edit()
                .putString(key, JSONObject().put("downloadId", id).put("entry", entry).toString())
                .apply()
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message ?: "start failed")
        }
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key required")
        val t = tracked(key)
        val out = JSObject()
        if (t == null) {
            out.put("state", "unknown")
            return call.resolve(out)
        }
        try {
            val id = t.getLong("downloadId")
            val s = query(id)
            out.put("state", s.state)
            s.fraction?.let { out.put("fraction", it) }
            when (s.state) {
                "done" -> {
                    val f = file(key)
                    out.put("filePath", f.absolutePath)
                    out.put("mimeType", s.mimeType ?: "audio/mpeg")
                    out.put("size", f.length())
                }
                "failed" -> {
                    // A failed download can leave a partial file behind.
                    file(key).delete()
                    manager.remove(id)
                }
            }
            call.resolve(out)
        } catch (e: Exception) {
            call.reject(e.message ?: "status failed")
        }
    }

    @PluginMethod
    fun finished(call: PluginCall) {
        try {
            val list = JSArray()
            for (key in prefs.all.keys.toList()) {
                val t = tracked(key) ?: continue
                val s = query(t.getLong("downloadId"))
                if (s.state != "done") continue
                val f = file(key)
                list.put(
                    JSObject()
                        .put("key", key)
                        .put("entry", t.getString("entry"))
                        .put("filePath", f.absolutePath)
                        .put("mimeType", s.mimeType ?: "audio/mpeg")
                        .put("size", f.length()),
                )
            }
            call.resolve(JSObject().put("downloads", list))
        } catch (e: Exception) {
            call.reject(e.message ?: "finished failed")
        }
    }

    /** Drops the mapping only; the file stays. */
    @PluginMethod
    fun forget(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key required")
        prefs.edit().remove(key).apply()
        call.resolve()
    }

    private fun removeOne(key: String) {
        // Removing a finished row from the manager does not delete our file,
        // removing a running one cancels it.
        tracked(key)?.let { runCatching { manager.remove(it.getLong("downloadId")) } }
        file(key).delete()
        prefs.edit().remove(key).apply()
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key required")
        removeOne(key)
        call.resolve()
    }

    @PluginMethod
    fun removeByPrefix(call: PluginCall) {
        val prefix = call.getString("prefix") ?: return call.reject("prefix required")
        // Files are named with ':' replaced by '_', so match on that form.
        val dir = file("x").parentFile
        dir?.listFiles()?.filter { it.name.startsWith(prefix) }?.forEach { it.delete() }
        for (key in prefs.all.keys.toList()) {
            if (key.replace(':', '_').startsWith(prefix)) removeOne(key)
        }
        call.resolve()
    }
}
