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

    @Test fun claudeUsageMayComeFromTheUsageService() {
        val hub=hubFixture()
        assertTrue(hub.contains("\"claude_statusline\"") && hub.contains("\"codex_app_server\""))
        assertTrue(valid(hub.replace("\"claude_statusline\"","\"claude_usage_api\"")))
        assertFalse(valid(hub.replace("\"claude_statusline\"","\"codex_app_server\"")))
        assertFalse(valid(hub.replace("\"codex_app_server\"","\"claude_usage_api\"")))
    }

    private fun withVitals(vitals:String)=withHost("{\"media\":null,\"volumePercent\":40,\"muted\":false,\"micMuted\":false,\"doNotDisturb\":false,\"vitals\":$vitals}")
    private val cpu="{\"name\":\"c\",\"usagePercent\":20.5,\"threadUsage\":[1,2.5,3],\"tempC\":61.3,\"clockMhz\":3900,\"powerW\":14.2}"
    private val power="{\"source\":\"battery\",\"batteryPercent\":76,\"charging\":false,\"watts\":18.4,\"minutesLeft\":161}"

    @Test fun laptopVitalsAreAcceptedWithMissingParts() {
        assertTrue(valid(withVitals("null")))
        assertTrue(valid(withVitals("{\"cpu\":$cpu,\"gpu\":null,\"igpu\":null,\"memory\":null,\"power\":$power,\"storageTempC\":null}")))
        assertTrue(valid(withVitals("{\"cpu\":null,\"gpu\":{\"name\":\"g\",\"state\":\"asleep\",\"usagePercent\":null,\"tempC\":null,\"hotspotC\":null,\"powerW\":null,\"memoryUsedMb\":null,\"memoryTotalMb\":4096,\"clockMhz\":null},\"igpu\":{\"usagePercent\":6,\"tempC\":49},\"memory\":{\"usedBytes\":1,\"totalBytes\":2,\"swapUsedBytes\":0,\"swapTotalBytes\":0},\"power\":null,\"storageTempC\":44.9}")))
    }

    @Test fun outOfRangeVitalsAreRejected() {
        val rest=",\"gpu\":null,\"igpu\":null,\"memory\":null,\"power\":null,\"storageTempC\":null}"
        for(v in listOf(
            "{\"cpu\":${cpu.replace("20.5","101")}$rest",
            "{\"cpu\":${cpu.replace("61.3","500")}$rest",
            "{\"cpu\":${cpu.replace("3900","3900.5")}$rest",
            "{\"cpu\":null,\"gpu\":null,\"igpu\":null,\"memory\":null,\"power\":${power.replace("battery","solar")},\"storageTempC\":null}",
            "{\"cpu\":null,\"gpu\":null,\"igpu\":null,\"memory\":null,\"power\":null}",
            "{\"cpu\":null,\"gpu\":null,\"igpu\":null,\"memory\":null,\"power\":null,\"storageTempC\":null,\"fans\":[]}"
        )) assertFalse(v, valid(withVitals(v)))
    }
}
