package app.bretzel.pinepodslite.player

import android.app.PendingIntent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.CommandButton
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionError
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

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

/** What the web code sees (NativeState in plugins.ts), times in seconds. */
data class PlayerSnapshot(
    val currentKey: String?,
    val currentPayload: String?,
    val playing: Boolean,
    val position: Double,
    val duration: Double,
    val rate: Double,
    val sleepRemaining: Int?,
    val sleepMinutes: Int?,
)

/**
 * Plays the playlist the web code hands over, keeps the media session (and so
 * the headphone buttons) while paused, and journals positions and endings for
 * the web code to sync when it next runs. All methods run on the main thread.
 *
 * Its current item is the player's, or with nothing loaded (a fresh process)
 * the stored resume item, which play/seek/updatePlaylist then cue.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaLibraryService() {
    interface Listener {
        fun onState(state: PlayerSnapshot)
        fun onReports()
    }

    companion object {
        /** The running service: set in onCreate, cleared in onDestroy. Main thread only. */
        var instance: PlaybackService? = null
            private set

        /** Gets state and report events (the plugin); outlives service instances. */
        var listener: Listener? = null

        private const val ROOT_ID = "root"
        private const val EXTRA_PAYLOAD = "payload"
        private const val EXTRA_DURATION_MS = "durationMs"
        private const val EXTRA_START_AT_MS = "startAtMs"
        private const val CHECKPOINT_MS = 10_000L
        private const val FADE_STEPS = 25
        private const val FADE_STEP_MS = 200L

        /** The state with no service running: the stored resume item, paused. */
        fun storedSnapshot(store: PlayerStore): PlayerSnapshot {
            val resume = store.loadResume()
            return PlayerSnapshot(
                resume?.key, resume?.payload, false,
                (resume?.positionMs ?: 0L) / 1000.0, (resume?.durationMs ?: 0L) / 1000.0, 1.0,
                null, restoredSleepMinutes(store),
            )
        }

        /** A one-shot timer dies with the process; a check-in timer re-arms on the next play. */
        private fun restoredSleepMinutes(store: PlayerStore): Int? =
            if (store.sleepRepeat) store.sleepMinutes else null

        private fun mediaItem(
            key: String, uri: String, title: String, artist: String, artworkUrl: String,
            durationMs: Long, payload: String, startAtMs: Long,
        ): MediaItem {
            val extras = Bundle().apply {
                putString(EXTRA_PAYLOAD, payload)
                putLong(EXTRA_DURATION_MS, durationMs)
                putLong(EXTRA_START_AT_MS, startAtMs)
            }
            val metadata = MediaMetadata.Builder()
                .setTitle(title)
                .setArtist(artist)
                .setArtworkUri(artworkUrl.takeIf { it.isNotEmpty() }?.let(Uri::parse))
                .setDurationMs(durationMs.takeIf { it > 0 })
                .setMediaType(MediaMetadata.MEDIA_TYPE_PODCAST_EPISODE)
                .setIsBrowsable(false)
                .setIsPlayable(true)
                .setExtras(extras)
                .build()
            return MediaItem.Builder().setMediaId(key).setUri(uri).setMediaMetadata(metadata).build()
        }

        private fun PlayerItem.toMediaItem() =
            mediaItem(key, uri, title, artist, artworkUrl, durationMs, payload, startAtMs)

        private fun ResumeState.toMediaItem() =
            mediaItem(key, uri, title, artist, artworkUrl, durationMs, payload, positionMs)

        private fun MediaItem.payload(): String = mediaMetadata.extras?.getString(EXTRA_PAYLOAD) ?: ""
    }

    /** An item's last known position, kept for when it stops being current. */
    private class Tracked(val item: MediaItem, val positionMs: Long, val durationMs: Long)

    private val main = Handler(Looper.getMainLooper())
    private val sleepTimer = SleepTimer { SystemClock.elapsedRealtime() }
    private lateinit var store: PlayerStore
    private lateinit var journal: ReportJournal
    private lateinit var player: ExoPlayer
    private lateinit var session: MediaLibrarySession

    private var tracked: Tracked? = null
    /** The item whose ending was reported, so each ending is reported once. */
    private var endedKey: String? = null
    private var lastCheckpointAt = 0L
    private var fade: Runnable? = null
    private var tickPending = false
    private val tick = Runnable {
        tickPending = false
        onTick()
    }

    override fun onCreate() {
        super.onCreate()
        store = PlayerStore(this)
        journal = store.loadJournal()
        sleepTimer.repeat = store.sleepRepeat
        sleepTimer.minutes = restoredSleepMinutes(store)

        val http = DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setUserAgent("PinePodsLite/" + versionName())
        val speech = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
            .build()
        player = ExoPlayer.Builder(this)
            .setAudioAttributes(speech, /* handleAudioFocus= */ true)
            .setHandleAudioBecomingNoisy(true)
            .setSeekBackIncrementMs(15_000)
            .setSeekForwardIncrementMs(30_000)
            // "Previous" always means the previous episode when there is one.
            .setMaxSeekToPreviousPositionMs(Long.MAX_VALUE)
            .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(this, http)))
            .build()
        player.setPauseAtEndOfMediaItems(!store.autoAdvance)
        player.addListener(playerListener)

        val builder = MediaLibrarySession.Builder(this, player, sessionCallback)
        launchAppIntent()?.let { builder.setSessionActivity(it) }
        session = builder.build()
        instance = this
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession = session

    // onTaskRemoved keeps the Media3 default: keep running while playing, else stop.
    // A headphone press brings the service back through playback resumption.

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        tickPending = false
        checkpoint()
        instance = null
        session.release()
        player.release()
        super.onDestroy()
    }

    // ---- API for the plugin (main thread) ----------------------------------

    fun load(items: List<PlayerItem>, index: Int, autoplay: Boolean) {
        val first = items.getOrNull(index) ?: return
        if (!autoplay) player.pause() // checkpoints the outgoing item if it was playing
        tracked = currentTracked()
        player.setMediaItems(items.map { it.toMediaItem() }, index, first.startAtMs)
        endedKey = null
        player.prepare()
        if (autoplay) {
            // A press of play even when already playing; re-arms a check-in timer.
            sleepTimer.onUserPlay()
            player.play()
        }
        persistResume()
        emitState()
    }

    /**
     * Replaces the items before and after the current one with those around
     * its key in [items], without touching the current item, so playback goes
     * on uninterrupted. A list without the current key is not this playlist
     * (any more) and is ignored.
     */
    fun updatePlaylist(items: List<PlayerItem>) {
        val key = player.currentMediaItem?.mediaId ?: store.loadResume()?.key ?: return
        val at = items.indexOfFirst { it.key == key }
        if (at < 0 || !ensureCued()) return
        val current = player.currentMediaItemIndex
        // The tail first: the current index is still valid for the head.
        player.replaceMediaItems(current + 1, player.mediaItemCount, items.drop(at + 1).map { it.toMediaItem() })
        player.replaceMediaItems(0, current, items.take(at).map { it.toMediaItem() })
    }

    fun play() {
        if (!ensureCued()) return
        // Prepares again after an error (at the current position) or when only
        // cued, and restarts an ended item.
        Util.handlePlayButtonAction(player)
    }

    fun pause() = player.pause()

    fun seek(seconds: Double) {
        if (!ensureCued()) return
        player.seekTo((seconds * 1000).toLong().coerceAtLeast(0L))
    }

    fun setRate(rate: Double) = player.setPlaybackSpeed(rate.toFloat())

    fun setAutoAdvance(on: Boolean) {
        player.setPauseAtEndOfMediaItems(!on)
        store.autoAdvance = on
    }

    fun setSleepTimer(minutes: Int?) {
        sleepTimer.arm(minutes)
        store.sleepMinutes = minutes
        scheduleTick()
        emitState()
    }

    fun setSleepRepeat(repeat: Boolean) {
        sleepTimer.repeat = repeat
        store.sleepRepeat = repeat
    }

    fun snapshot(): PlayerSnapshot {
        val rate = player.playbackParameters.speed.toDouble()
        val now = currentTracked()
            ?: return storedSnapshot(store).copy(
                rate = rate, sleepRemaining = sleepTimer.remainingSeconds(), sleepMinutes = sleepTimer.minutes,
            )
        return PlayerSnapshot(
            now.item.mediaId, now.item.payload(), !Util.shouldShowPlayButton(player),
            now.positionMs / 1000.0, now.durationMs / 1000.0, rate,
            sleepTimer.remainingSeconds(), sleepTimer.minutes,
        )
    }

    fun pendingReports(): List<Report> = journal.pending()

    fun ack(throughSeq: Long) {
        journal.ack(throughSeq)
        store.saveJournal(journal)
    }

    // ---- player events ------------------------------------------------------

    private val playerListener = object : Player.Listener {
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            // `tracked` still describes the outgoing item, as of its last tick.
            tracked?.let { out ->
                // AUTO: the previous item played to its end.
                if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) reportEnded(out)
                else if (out.item.mediaId != endedKey) reportPosition(out)
            }
            endedKey = null
            if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO || reason == Player.MEDIA_ITEM_TRANSITION_REASON_SEEK) {
                startAtResumePoint(mediaItem)
            }
            tracked = currentTracked()
            persistResume()
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            when {
                // Auto-advance off: paused at the end of an item, which ended.
                reason == Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM -> currentTracked()?.let { reportEnded(it) }
                !playWhenReady -> checkpoint()
                // A press of play (UI, notification, headphones, resumption). Not a
                // rebuffer or the end of a call, which only flip isPlaying, and
                // not auto-advance, which keeps playWhenReady.
                reason == Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST -> sleepTimer.onUserPlay()
            }
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            // The last item played to its end (or auto-advance had nowhere to go).
            if (playbackState == Player.STATE_ENDED) currentTracked()?.let { reportEnded(it) }
        }

        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int,
        ) {
            if (reason != Player.DISCONTINUITY_REASON_SEEK) return
            endedKey = null // sought back into an ended item: its next ending counts
            persistResume()
        }

        override fun onPlayerError(error: PlaybackException) = checkpoint()

        override fun onEvents(player: Player, events: Player.Events) {
            tracked = currentTracked() ?: tracked
            scheduleTick()
            emitState()
        }
    }

    /** Every second while playing or while the sleep timer runs. Player events
     * don't postpone a pending tick, or frequent ones would starve it. */
    private fun scheduleTick() {
        if (tickPending || !(player.isPlaying || sleepTimer.remainingSeconds() != null)) return
        tickPending = true
        main.postDelayed(tick, 1000)
    }

    private fun onTick() {
        val minutes = sleepTimer.minutes
        // playWhenReady, not isPlaying: expiring while buffering must still pause.
        if (sleepTimer.tick(player.playWhenReady)) fadeOutThenPause()
        if (sleepTimer.minutes != minutes) store.sleepMinutes = sleepTimer.minutes
        if (player.isPlaying && SystemClock.elapsedRealtime() - lastCheckpointAt >= CHECKPOINT_MS) checkpoint()
        tracked = currentTracked() ?: tracked
        emitState()
        scheduleTick()
    }

    /** Sleep timer expiry: fade out over ~5 s, pause, then restore the volume. */
    private fun fadeOutThenPause() {
        fade?.let { main.removeCallbacks(it) }
        val volume = player.volume
        var step = 0
        fade = object : Runnable {
            override fun run() {
                step++
                player.volume = (volume * (1f - step.toFloat() / FADE_STEPS)).coerceAtLeast(0f)
                if (step < FADE_STEPS) {
                    main.postDelayed(this, FADE_STEP_MS)
                    return
                }
                player.pause()
                player.volume = volume
                fade = null
            }
        }.also { main.postDelayed(it, FADE_STEP_MS) }
    }

    // ---- journal and resume state -------------------------------------------

    private fun currentTracked(): Tracked? {
        val item = player.currentMediaItem ?: return null
        val loaded = player.duration
        val duration = if (loaded != C.TIME_UNSET && loaded > 0) loaded
        else item.mediaMetadata.extras?.getLong(EXTRA_DURATION_MS) ?: 0L
        return Tracked(item, player.currentPosition, duration)
    }

    /** Journal the current position and save the resume state. */
    private fun checkpoint() {
        lastCheckpointAt = SystemClock.elapsedRealtime()
        val now = currentTracked() ?: return
        tracked = now
        if (now.item.mediaId != endedKey) reportPosition(now)
        persistResume()
    }

    private fun reportPosition(t: Tracked) {
        // Nothing to sync, and it would replace an unsent position for the item.
        if (t.positionMs <= 0) return
        journal.recordPosition(t.item.mediaId, t.item.payload(), t.positionMs / 1000.0, System.currentTimeMillis())
        journalChanged()
    }

    private fun reportEnded(t: Tracked) {
        if (endedKey == t.item.mediaId) return
        endedKey = t.item.mediaId
        val seconds = maxOf(t.durationMs, t.positionMs) / 1000.0
        journal.recordEnded(t.item.mediaId, t.item.payload(), seconds, System.currentTimeMillis())
        journalChanged()
    }

    private fun journalChanged() {
        store.saveJournal(journal)
        listener?.onReports()
    }

    private fun persistResume() {
        val now = currentTracked() ?: return
        val uri = now.item.localConfiguration?.uri?.toString() ?: return
        val metadata = now.item.mediaMetadata
        // An ended item resumes from its start, not from its last second.
        val position = if (now.item.mediaId == endedKey) 0L else now.positionMs
        store.saveResume(
            ResumeState(
                now.item.mediaId, uri, metadata.title?.toString() ?: "", metadata.artist?.toString() ?: "",
                metadata.artworkUri?.toString() ?: "", position, now.durationMs, now.item.payload(),
            )
        )
    }

    /** With nothing loaded, cue the stored resume item (paused). False if there is none. */
    private fun ensureCued(): Boolean {
        if (player.mediaItemCount > 0) return true
        val resume = store.loadResume() ?: return false
        player.setMediaItem(resume.toMediaItem(), resume.positionMs)
        tracked = currentTracked()
        return true
    }

    /** Auto-advance and next/previous start an item where it was left, as a load does. */
    private fun startAtResumePoint(item: MediaItem?) {
        val startAt = item?.mediaMetadata?.extras?.getLong(EXTRA_START_AT_MS) ?: return
        if (startAt > 3_000 && player.currentPosition < 1_000) player.seekTo(startAt)
    }

    private fun emitState() {
        listener?.onState(snapshot())
    }

    // ---- session --------------------------------------------------------------

    private val sessionCallback = object : MediaLibrarySession.Callback {
        override fun onConnectAsync(
            session: MediaSession, controller: MediaSession.ControllerInfo,
        ): ListenableFuture<MediaSession.ConnectionResult> {
            val result = MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller)
            // The notification (and through it the lock screen and quick settings)
            // gets back 15 s / forward 30 s around play/pause. Media3 places them in
            // the back/forward slots by default; previous/next stay available as
            // commands (headphones, Bluetooth).
            if (session.isMediaNotificationController(controller)) {
                result.setMediaButtonPreferences(
                    listOf(
                        CommandButton.Builder(CommandButton.ICON_SKIP_BACK_15)
                            .setPlayerCommand(Player.COMMAND_SEEK_BACK)
                            .setDisplayName("Back 15 seconds")
                            .build(),
                        CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD_30)
                            .setPlayerCommand(Player.COMMAND_SEEK_FORWARD)
                            .setDisplayName("Forward 30 seconds")
                            .build(),
                    )
                )
            }
            return Futures.immediateFuture(result.build())
        }

        override fun onGetLibraryRoot(
            session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?,
        ): ListenableFuture<LibraryResult<MediaItem>> {
            // A "recent" root is a promise of something to resume.
            if (params?.isRecent == true && store.loadResume() == null) {
                return Futures.immediateFuture(LibraryResult.ofError<MediaItem>(SessionError.ERROR_NOT_SUPPORTED))
            }
            val root = MediaItem.Builder()
                .setMediaId(ROOT_ID)
                .setMediaMetadata(MediaMetadata.Builder().setIsBrowsable(true).setIsPlayable(false).build())
                .build()
            return Futures.immediateFuture(LibraryResult.ofItem(root, params))
        }

        override fun onGetChildren(
            session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String,
            page: Int, pageSize: Int, params: LibraryParams?,
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
            val resume = if (parentId == ROOT_ID && page == 0) store.loadResume() else null
            val items = listOfNotNull(resume?.toMediaItem())
            return Futures.immediateFuture(LibraryResult.ofItemList(items, params))
        }

        // A play with nothing loaded (headphones or the resume card after the
        // process died): the stored item at its stored position. Stored fields
        // only, so no network is needed, also when isForPlayback is false (boot).
        override fun onPlaybackResumption(
            mediaSession: MediaSession, controller: MediaSession.ControllerInfo, isForPlayback: Boolean,
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
            val resume = store.loadResume()
                ?: return Futures.immediateFailedFuture(UnsupportedOperationException("Nothing to resume"))
            return Futures.immediateFuture(
                MediaSession.MediaItemsWithStartPosition(listOf(resume.toMediaItem()), 0, resume.positionMs)
            )
        }
    }

    private fun launchAppIntent(): PendingIntent? {
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
        return PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun versionName(): String = try {
        @Suppress("DEPRECATION")
        packageManager.getPackageInfo(packageName, 0).versionName ?: "0"
    } catch (e: Exception) {
        "0"
    }
}
