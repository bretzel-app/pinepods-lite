package app.bretzel.pinepodslite.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MissingDownloadTest {
    private val payload = """{"accountId":"a","episode":{"episodeid":7,"episodeurl":"https://cdn/7.mp3"}}"""

    @Test fun missingFileStreamsTheEnclosure() {
        var asked: String? = null
        val uri = MissingDownload.streamUri("file:///data/episodes/a_7", payload) { asked = it; false }
        assertEquals("https://cdn/7.mp3", uri)
        assertEquals("/data/episodes/a_7", asked)
    }

    @Test fun existingFilePlaysAsIs() {
        assertNull(MissingDownload.streamUri("file:///data/episodes/a_7", payload) { true })
    }

    @Test fun streamsAreLeftAlone() {
        assertNull(MissingDownload.streamUri("https://cdn/7.mp3", payload) { false })
    }

    @Test fun noUsableEnclosureMeansNoFallback() {
        val file = "file:///data/episodes/a_7"
        assertNull(MissingDownload.streamUri(file, "nope") { false })
        assertNull(MissingDownload.streamUri(file, """{"episode":{}}""") { false })
        assertNull(MissingDownload.streamUri(file, """{"episode":{"episodeurl":null}}""") { false })
        assertNull(MissingDownload.streamUri(file, """{"episode":{"episodeurl":"file:///x"}}""") { false })
    }
}
