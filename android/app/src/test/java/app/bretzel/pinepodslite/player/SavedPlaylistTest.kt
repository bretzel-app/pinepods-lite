package app.bretzel.pinepodslite.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SavedPlaylistTest {
    private fun item(n: Int) = PlayerItem(
        "a:$n", "file:///e/a_$n", "Title \"$n\"", "Cast", "https://img/$n.jpg", n * 1_000L, 600_000L,
        """{"accountId":"a","episode":{"episodeid":$n,"episodetitle":"é\n$n"}}""",
    )

    @Test fun roundTrip() {
        val p = SavedPlaylist(listOf(item(1), item(2), item(3)), 1)
        assertEquals(p, SavedPlaylist.fromJson(p.toJson()))
    }

    @Test fun currentIsTheItemAtIndex() {
        assertEquals("a:3", SavedPlaylist(listOf(item(1), item(2), item(3)), 2).current.key)
    }

    @Test fun nullGarbageAndBadIndexGiveNull() {
        assertNull(SavedPlaylist.fromJson(null))
        assertNull(SavedPlaylist.fromJson("{"))
        assertNull(SavedPlaylist.fromJson("""{"index":0}"""))
        assertNull(SavedPlaylist.fromJson(SavedPlaylist(listOf(item(1)), 0).toJson().replace("\"index\":0", "\"index\":1")))
        assertNull(SavedPlaylist.fromJson("""{"index":0,"items":[]}"""))
        assertNull(SavedPlaylist.fromJson("""{"index":0,"items":[{"key":"a:1"}]}"""))
    }
}
