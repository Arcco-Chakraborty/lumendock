package com.phonemonitor

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.ByteArrayOutputStream
import java.net.URL
import java.net.URLEncoder
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection

/** No user URL, redirects, platform default network binding, disk cache, or raw provider diagnostics. */
class GoogleCalendarTransport : PhoneCalendarTransport {
    companion object {
        const val MAX_BYTES = 2 * 1024 * 1024
        private val deadlines = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "calendar-deadline").apply { isDaemon = true } }
        internal fun url(request: PhoneCalendarRequest): URL {
            val path = when (request.kind) {
                PhoneCalendarEndpoint.SOURCES -> "/users/me/calendarList"
                PhoneCalendarEndpoint.METADATA -> "/calendars/${encode(requireNotNull(request.calendarId))}"
                PhoneCalendarEndpoint.EVENTS -> "/calendars/${encode(requireNotNull(request.calendarId))}/events"
            }
            return URL("https://www.googleapis.com/calendar/v3$path" + request.query.entries.joinToString("&", if(request.query.isEmpty()) "" else "?") { encode(it.key) + "=" + encode(it.value) })
        }
        private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
        internal fun retryAfter(value: String?, now: Long): Long {
            if(value == null) return 0
            return (value.toLongOrNull()?.takeIf { it >= 0 }?.let { it.coerceAtMost(3600) * 1000 }
                ?: runCatching { ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() - now }.getOrDefault(0)).coerceIn(0, 3_600_000)
        }
    }
    override fun newCall(request: PhoneCalendarRequest): PhoneCalendarCall = object : PhoneCalendarCall {
        @Volatile private var cancelled = false
        @Volatile private var connection: HttpsURLConnection? = null
        override fun cancel() { cancelled = true; connection?.disconnect() }
        override fun execute(): JsonObject {
            if(cancelled) throw PhoneCalendarFailure("SESSION_ENDED")
            val conn = url(request).openConnection() as HttpsURLConnection
            connection = conn
            val deadline = deadlines.schedule({ cancel() }, 15, TimeUnit.SECONDS)
            try {
                if(cancelled) throw PhoneCalendarFailure("SESSION_ENDED")
                conn.requestMethod = "GET"; conn.instanceFollowRedirects = false
                conn.connectTimeout = 10_000; conn.readTimeout = 10_000; conn.useCaches = false
                conn.setRequestProperty("Authorization", "Bearer ${request.token}")
                conn.setRequestProperty("Accept", "application/json")
                conn.setRequestProperty("Accept-Encoding", "identity")
                val status = conn.responseCode
                if(status != 200) throw PhoneCalendarFailure(if(status == 401) "CALENDAR_AUTH_REQUIRED" else "CALENDAR_UNAVAILABLE", status, retryAfter(conn.getHeaderField("Retry-After"), System.currentTimeMillis()))
                if(conn.contentLengthLong > MAX_BYTES) throw PhoneCalendarFailure("CALENDAR_CAPACITY")
                val bytes = conn.inputStream.use { input ->
                    val out = ByteArrayOutputStream(); val chunk = ByteArray(8192)
                    while(true) {
                        if(cancelled) throw PhoneCalendarFailure("SESSION_ENDED")
                        val n = input.read(chunk); if(n < 0) break
                        if(out.size() + n > MAX_BYTES) throw PhoneCalendarFailure("CALENDAR_CAPACITY")
                        out.write(chunk, 0, n)
                    }
                    out.toByteArray()
                }
                if(cancelled) throw PhoneCalendarFailure("SESSION_ENDED")
                val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
                // Even a reflected credential in a provider payload may never enter a bridge page.
                if(text.contains(request.token)) throw PhoneCalendarFailure("CALENDAR_UNAVAILABLE")
                val parsed = JsonParser.parseString(text)
                if(!parsed.isJsonObject) throw PhoneCalendarFailure("CALENDAR_UNAVAILABLE")
                return parsed.asJsonObject
            } catch(e: PhoneCalendarFailure) { throw e }
            catch(_: Exception) { throw PhoneCalendarFailure(if(cancelled) "SESSION_ENDED" else "CALENDAR_UNAVAILABLE") }
            finally { deadline.cancel(false); conn.disconnect(); connection = null }
        }
    }
}
