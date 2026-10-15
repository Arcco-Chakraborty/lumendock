package com.phonemonitor

import com.google.gson.JsonParser
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolHostTest {
    private fun valid(json:String)=ProtocolValidator.hubSnapshot(JsonParser.parseString(json))
    private fun withHost(host:String)=hubFixture().trimEnd().removeSuffix("}")+",\"host\":$host}"

    @Test fun hostStateIsOptional() {
        assertTrue(valid(hubFixture()))
        assertTrue(valid(hubHostFixture()))
        assertTrue(valid(withHost("{\"media\":null,\"volumePercent\":null,\"muted\":null,\"micMuted\":null,\"doNotDisturb\":null}")))
    }

    @Test fun malformedHostStateIsRejected() {
        val media="{\"player\":\"p\",\"status\":\"playing\",\"title\":\"t\",\"artist\":\"a\"}"
        for(host in listOf(
            "{\"media\":$media,\"volumePercent\":151,\"muted\":false,\"micMuted\":false,\"doNotDisturb\":false}",
            "{\"media\":$media,\"volumePercent\":4.5,\"muted\":false,\"micMuted\":false,\"doNotDisturb\":false}",
            "{\"media\":$media,\"volumePercent\":40,\"muted\":\"no\",\"micMuted\":false,\"doNotDisturb\":false}",
            "{\"media\":{\"player\":\"p\",\"status\":\"buffering\",\"title\":\"t\",\"artist\":\"a\"},\"volumePercent\":40,\"muted\":false,\"micMuted\":false,\"doNotDisturb\":false}",
            "{\"media\":$media,\"volumePercent\":40,\"muted\":false,\"micMuted\":false}",
            "{\"media\":$media,\"volumePercent\":40,\"muted\":false,\"micMuted\":false,\"doNotDisturb\":false,\"extra\":1}",
            "[]"
        )) assertFalse(host, valid(withHost(host)))
    }
}
