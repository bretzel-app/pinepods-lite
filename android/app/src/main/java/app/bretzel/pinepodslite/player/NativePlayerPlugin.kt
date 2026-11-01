package app.bretzel.pinepodslite.player

import android.content.ComponentName
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject

/**
 * The web code's handle on [PlaybackService] (NativePlayerPlugin in
 * src/native/plugins.ts). Capacitor calls these methods off the main thread;
 * each one hops to the main thread, where the player lives, and resolves once
 * the work is done there. Times cross the bridge in seconds.
 */
@CapacitorPlugin(name = "NativePlayer")
class NativePlayerPlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var store: PlayerStore

    /** Connecting the controller starts and binds the service. Main thread only. */
    private var controller: ListenableFuture<MediaController>? = null

    private val events = object : PlaybackService.Listener {
        override fun onState(state: PlayerSnapshot) = emit("state", state.toJs())
        override fun onReports() = emit("reports", JSObject())
    }

    override fun load() {
        store = PlayerStore(context.applicationContext)
        main.post {
            PlaybackService.listener = events
            connect()
        }
    }

    override fun handleOnDestroy() {
        main.post {
            if (PlaybackService.listener === events) PlaybackService.listener = null
            controller?.let { MediaController.releaseFuture(it) }
            controller = null
        }
    }

    @PluginMethod
    fun load(call: PluginCall) {
        val items = items(call) ?: return call.reject("items must be a list of playlist items")
        val index = call.getInt("index") ?: 0
        val autoplay = call.getBoolean("autoplay") ?: false
        withService(call) { it.load(items, index, autoplay) }
    }

    @PluginMethod
    fun updatePlaylist(call: PluginCall) {
        val items = items(call) ?: return call.reject("items must be a list of playlist items")
        withService(call) { it.updatePlaylist(items) }
    }

    @PluginMethod
    fun play(call: PluginCall) = withService(call) { it.play() }

    @PluginMethod
    fun pause(call: PluginCall) = withService(call) { it.pause() }

    @PluginMethod
    fun seek(call: PluginCall) {
        val seconds = call.getDouble("seconds") ?: return call.reject("seconds is required")
        withService(call) { it.seek(seconds) }
    }

    @PluginMethod
    fun setRate(call: PluginCall) {
        val rate = call.getDouble("rate") ?: return call.reject("rate is required")
        withService(call) { it.setRate(rate) }
    }

    @PluginMethod
    fun setAutoAdvance(call: PluginCall) {
        val on = call.getBoolean("on") ?: return call.reject("on is required")
        withService(call) { it.setAutoAdvance(on) }
    }

    @PluginMethod
    fun setSleepTimer(call: PluginCall) {
        val minutes = (call.data.opt("minutes") as? Number)?.toInt() // null cancels
        withService(call) { it.setSleepTimer(minutes) }
    }

    @PluginMethod
    fun setSleepRepeat(call: PluginCall) {
        val repeat = call.getBoolean("repeat") ?: return call.reject("repeat is required")
        withService(call) { it.setSleepRepeat(repeat) }
    }

    /** The live state, or what is stored when the service isn't running. */
    @PluginMethod
    fun getState(call: PluginCall) {
        main.post {
            val state = PlaybackService.instance?.snapshot() ?: PlaybackService.storedSnapshot(store)
            call.resolve(state.toJs())
        }
    }

    /** Unacknowledged reports, live or as stored when the service isn't running. */
    @PluginMethod
    fun readReports(call: PluginCall) {
        main.post {
            val reports = PlaybackService.instance?.pendingReports() ?: store.loadJournal().pending()
            call.resolve(JSObject().put("reports", JSArray(reports.map { it.toJs() })))
        }
    }

    @PluginMethod
    fun ackReports(call: PluginCall) {
        val through = (call.data.opt("throughSeq") as? Number)?.toLong()
            ?: return call.reject("throughSeq is required")
        main.post {
            // On the main thread, so a service starting meanwhile reads the result.
            val service = PlaybackService.instance
            if (service != null) {
                service.ack(through)
            } else {
                val journal = store.loadJournal()
                journal.ack(through)
                store.saveJournal(journal)
            }
            call.resolve()
        }
    }

    // ---- helpers --------------------------------------------------------------

    private fun emit(event: String, data: JSObject) = notifyListeners(event, data)

    /** Main thread. Reuses the controller while it is connected or connecting. */
    private fun connect(): ListenableFuture<MediaController> {
        controller?.let { return it }
        val appContext = context.applicationContext
        val token = SessionToken(appContext, ComponentName(appContext, PlaybackService::class.java))
        val future = MediaController.Builder(appContext, token)
            .setApplicationLooper(Looper.getMainLooper())
            .setListener(object : MediaController.Listener {
                // The service went away (stopped while paused): connect again next time.
                override fun onDisconnected(disconnected: MediaController) {
                    val current = controller
                    if (current != null && current.isDone && runCatching { current.get() }.getOrNull() === disconnected) {
                        controller = null
                    }
                    disconnected.release()
                }
            })
            .buildAsync()
        controller = future
        return future
    }

    /**
     * Runs [block] on the main thread once the service is connected, then
     * resolves [call]. A connection that turns out dead is retried once.
     */
    private fun withService(call: PluginCall, retry: Boolean = true, block: (PlaybackService) -> Unit) {
        main.post {
            val future = connect()
            future.addListener({
                val service = runCatching { future.get() }.getOrNull()?.let { PlaybackService.instance }
                if (service == null) {
                    if (controller === future) {
                        MediaController.releaseFuture(future)
                        controller = null
                    }
                    if (retry) withService(call, false, block) else call.reject("The playback service is not available")
                    return@addListener
                }
                try {
                    block(service)
                    call.resolve()
                } catch (e: Exception) {
                    call.reject(e.message ?: "Native player call failed", e)
                }
            }, ContextCompat.getMainExecutor(context))
        }
    }

    /** The `items` option as playlist entries; null when missing or malformed. */
    private fun items(call: PluginCall): List<PlayerItem>? = try {
        val array = call.getArray("items")
        (0 until array.length()).map { i ->
            val o = array.getJSONObject(i)
            PlayerItem(
                key = o.getString("key"),
                uri = o.getString("uri"),
                title = o.optString("title"),
                artist = o.optString("artist"),
                artworkUrl = o.optString("artworkUrl"),
                startAtMs = (o.optDouble("startAt", 0.0) * 1000).toLong(),
                durationMs = (o.optDouble("duration", 0.0) * 1000).toLong(),
                payload = o.getString("payload"),
            )
        }
    } catch (e: Exception) {
        null
    }

    private fun PlayerSnapshot.toJs(): JSObject = JSObject()
        .put("currentKey", currentKey ?: JSONObject.NULL)
        .put("currentPayload", currentPayload ?: JSONObject.NULL)
        .put("playing", playing)
        .put("position", position)
        .put("duration", duration)
        .put("rate", rate)
        .put("sleepRemaining", sleepRemaining ?: JSONObject.NULL)
        .put("sleepMinutes", sleepMinutes ?: JSONObject.NULL)

    private fun Report.toJs(): JSObject = JSObject()
        .put("seq", seq)
        .put("kind", kind.name.lowercase()) // 'position' | 'ended'
        .put("key", key)
        .put("payload", payload)
        .put("seconds", seconds)
        .put("at", at)
}
