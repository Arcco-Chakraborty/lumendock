package com.phonemonitor

import com.google.gson.JsonObject
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID
import java.util.concurrent.locks.ReentrantLock

/** Foreground repository. All upstream work runs synchronously on the caller's bounded bridge worker. */
class PhoneCalendarRepository(
    private val auth: PhoneCalendarAuth,
    private val transport: PhoneCalendarTransport = GoogleCalendarTransport(),
    private val clock: HubClock = SystemHubClock,
) : AutoCloseable {
    private data class Window(val events: List<JsonObject>, val state: String, val error: String?, val success: Long?)
    private data class RangeCache(val range: JsonObject, var revision: String = revision(), var windows: Map<String, Window> = emptyMap(), var attempted: Long = Long.MIN_VALUE, var receipt: Long? = null, var sampledWall: Long? = null, var success: Long? = null, var error: String? = null)
    private data class Cursor(val key: String, val revision: String, val selection: String, val offset: Int, val issued: Long)
    private class Budget { var bytes = 0; var events = 0 }
    companion object { private fun revision() = UUID.randomUUID().toString(); private const val MAX_BYTES = 20 * 1024 * 1024 }
    private val lock = Any()
    private val worker = ReentrantLock()
    private var active = false
    private var closed = false
    private var epoch = 0L
    private var selectionRevision = revision()
    private var metadataRevision = revision()
    private var applied = false
    private var discovered = emptyList<PhoneCalendarSource>()
    private var selected = emptySet<String>()
    private var metadataReceipt: Long? = null
    private var metadataWall: Long? = null
    private var metadataAttempt: Long? = null
    private var metadataError: String? = null
    private var backoffUntil = 0L
    private var failures = 0
    private var lastManual: Long? = null
    private val ranges = linkedMapOf<String, RangeCache>()
    private val cursors = linkedMapOf<String, Cursor>()
    private val calls = linkedSetOf<PhoneCalendarCall>()
    val generation: Long get() = auth.generation
    val authState: String get() = auth.status
    init { auth.onGenerationChanged { invalidateAccount() } }
    private fun invalidateAccount() {
        val cancelled = synchronized(lock) {
            epoch++; discovered = emptyList(); selected = emptySet(); applied = false
            selectionRevision = revision(); metadataRevision = revision(); ranges.clear(); cursors.clear()
            metadataReceipt = null; metadataWall = null; metadataAttempt = null; metadataError = null
            backoffUntil = 0; failures = 0; lastManual = null
            calls.toList().also { calls.clear() }
        }
        cancelled.forEach { it.cancel() }
    }
    fun resume() = synchronized(lock) { if(!closed) active = true }
    fun pause() {
        val cancelled = synchronized(lock) { active = false; epoch++; calls.toList().also { calls.clear() } }
        cancelled.forEach { it.cancel() }
    }
    override fun close() { synchronized(lock) { closed = true }; pause(); auth.disconnect() }
    fun disconnect() { auth.disconnect() }
    private fun valid(expected: Long, account: Long): Boolean = synchronized(lock) { active && !closed && epoch == expected && auth.generation == account }
    private fun check(expected: Long, account: Long) { if(!valid(expected, account)) throw PhoneCalendarFailure("SESSION_ENDED") }
    private fun get(kind: PhoneCalendarEndpoint, token: String, rawId: String?, query: Map<String,String>, expected: Long, account: Long, budget: Budget): JsonObject {
        check(expected, account)
        val call = transport.newCall(PhoneCalendarRequest(kind, token, rawId, query))
        synchronized(lock) { check(expected, account); calls.add(call) }
        try {
            val body = call.execute(); check(expected, account)
            val bytes = body.toString().toByteArray(Charsets.UTF_8)
            if(bytes.size > GoogleCalendarTransport.MAX_BYTES || budget.bytes.toLong() + bytes.size > MAX_BYTES) throw PhoneCalendarFailure("CALENDAR_CAPACITY")
            if(body.toString().contains(token)) throw PhoneCalendarFailure("CALENDAR_UNAVAILABLE")
            budget.bytes += bytes.size; return body
        } catch(e: PhoneCalendarFailure) { throw e }
        catch(_: Exception) { throw PhoneCalendarFailure("CALENDAR_UNAVAILABLE") }
        finally { synchronized(lock) { calls.remove(call) } }
    }
    private fun pages(kind: PhoneCalendarEndpoint, token: String, rawId: String?, query: Map<String,String>, expected: Long, account: Long, budget: Budget, consume: (JsonObject) -> Unit) {
        var pageToken: String? = null; val seen = mutableSetOf<String>(); var count = 0
        do {
            if(++count > 100) throw PhoneCalendarFailure("CALENDAR_CAPACITY")
            val body = get(kind, token, rawId, query + (pageToken?.let { mapOf("pageToken" to it) } ?: emptyMap()), expected, account, budget)
            consume(body)
            pageToken = body.text("nextPageToken")?.trim()?.takeIf { it.isNotEmpty() }
            if(pageToken != null && (!seen.add(pageToken) || pageToken.length > 4096)) throw PhoneCalendarFailure("CALENDAR_UNAVAILABLE")
        } while(pageToken != null)
    }
    private fun metadata(token: String, expected: Long, account: Long, budget: Budget) {
        synchronized(lock) { metadataAttempt = clock.monotonicMs() }
        val next = linkedMapOf<String, PhoneCalendarSource>()
        pages(PhoneCalendarEndpoint.SOURCES, token, null, mapOf("showHidden" to "true", "maxResults" to "250", "fields" to "nextPageToken,items(id,summary,summaryOverride,backgroundColor,accessRole,defaultReminders,timeZone,primary,deleted,hidden,selected)"), expected, account, budget) { body ->
            body.objects("items").forEach { raw -> PhoneCalendarSource.parse(raw)?.let { source ->
                next[source.id] = source
                if(next.size > 100) throw PhoneCalendarFailure("CALENDAR_CAPACITY")
            } }
        }
        next.values.filter { it.capability == "read" }.forEach { source ->
            try {
                val meta = get(PhoneCalendarEndpoint.METADATA, token, source.rawId, mapOf("fields" to "id,summary,timeZone,labelProperties"), expected, account, budget)
                source.zone = source.zone ?: phoneZone(meta.text("timeZone"))
                val labels = meta.objectValue("labelProperties")
                if(labels?.get("eventLabels")?.isJsonArray != true) source.metadataError = "CALENDAR_UNSUPPORTED"
                else labels.objects("eventLabels").forEach { label ->
                    label.text("id")?.trim()?.takeIf { it.isNotEmpty() }?.let { id -> source.labels[id] = jsonObject("name" to label.text("name")?.trim()?.takeIf { it.isNotEmpty() }?.let { phoneTrim(it, 50) }, "color" to (phoneColor(label.text("color")) ?: phoneColor(label.text("backgroundColor")) ?: source.color ?: "#64748B")) }
                }
            } catch(e: PhoneCalendarFailure) {
                if(e.code in setOf("SESSION_ENDED", "CALENDAR_AUTH_REQUIRED", "CALENDAR_CAPACITY")) throw e
                source.metadataError = "CALENDAR_UNAVAILABLE"
                recordBackoff(e)
            }
        }
        synchronized(lock) {
            check(expected, account)
            discovered = next.values.toList(); metadataReceipt = clock.monotonicMs(); metadataWall = clock.epochMs(); metadataError = null; metadataRevision = revision()
            // A metadata replacement also invalidates event revisions; labels are reapplied by a complete refresh.
            ranges.values.forEach { it.attempted = Long.MIN_VALUE; it.revision = revision() }
            cursors.clear()
        }
    }
    private fun events(token: String, source: PhoneCalendarSource, range: JsonObject, expected: Long, account: Long, budget: Budget): Window {
        val zone = ZoneId.of(range.text("timeZone")); val start = LocalDate.parse(range.text("startDate")); val end = start.plusDays(range["days"].asLong)
        val query = mapOf("singleEvents" to "true", "showHiddenInvitations" to "true", "showDeleted" to "false", "maxResults" to "250", "timeMin" to start.atStartOfDay(zone).toInstant().toString(), "timeMax" to end.atStartOfDay(zone).toInstant().toString())
        val items = linkedMapOf<String, JsonObject>(); var fallback = false
        fun fetch(withLabels: Boolean) {
            val fields = "nextPageToken,timeZone,items(id,status,summary,start,end,eventType," + (if(withLabels) "eventLabelId," else "") + "colorId,reminders,attendees(self,responseStatus))"
            pages(PhoneCalendarEndpoint.EVENTS, token, source.rawId, query + mapOf("fields" to fields) + if(withLabels) mapOf("eventLabelVersion" to "1") else emptyMap(), expected, account, budget) { body ->
                val eventZone = phoneZone(body.text("timeZone")) ?: source.zone ?: range.text("timeZone")!!
                body.objects("items").forEach { raw -> PhoneCalendarNormalization.event(raw, source, range, eventZone)?.let { event ->
                    if(!items.containsKey(event.text("id"))) {
                        budget.events++; if(budget.events > 5000) throw PhoneCalendarFailure("CALENDAR_CAPACITY")
                        items[event.text("id")!!] = event
                    }
                } }
            }
        }
        try { fetch(true) } catch(e: PhoneCalendarFailure) {
            if(e.statusCode != 400) throw e
            budget.events -= items.size; items.clear(); fallback = true; fetch(false)
        }
        val error = source.metadataError ?: if(fallback) "CALENDAR_UNSUPPORTED" else null
        return Window(items.values.toList(), if(error == null) "available" else "partial", error, clock.epochMs())
    }
    private fun recordBackoff(failure: PhoneCalendarFailure) = synchronized(lock) {
        if(failure.code == "SESSION_ENDED") return@synchronized
        failures = (failures + 1).coerceAtMost(7)
        val delay = maxOf(failure.retryAfterMs.coerceAtMost(3_600_000), (1000L shl failures).coerceAtMost(120_000))
        backoffUntil = maxOf(backoffUntil, clock.monotonicMs() + delay)
    }
    private fun sync(range: JsonObject?, refresh: Boolean) {
        if(!worker.tryLock()) return
        try {
            val expected: Long; val account: Long; val manual: Boolean
            synchronized(lock) {
                if(!active || closed || auth.status != "connected" || clock.monotonicMs() < backoffUntil) return
                expected = epoch; account = auth.generation
                manual = refresh && (lastManual == null || clock.monotonicMs() - lastManual!! >= 5000)
                if(manual) lastManual = clock.monotonicMs()
            }
            val budget = Budget()
            try {
                val token = auth.acquireToken(); check(expected, account)
                val needMetadata = synchronized(lock) { metadataAttempt == null || clock.monotonicMs() - metadataAttempt!! >= 900_000 || manual }
                if(needMetadata) metadata(token, expected, account, budget)
                val cache: RangeCache; val sources: List<PhoneCalendarSource>
                synchronized(lock) {
                    check(expected, account)
                    if(range == null || !applied || metadataError == "CALENDAR_CAPACITY") return
                    cache = ranges.getOrPut(range.toString()) { RangeCache(range.deepCopy()) }
                    while(ranges.size > 3) ranges.remove(ranges.keys.first())
                    if(!manual && cache.attempted != Long.MIN_VALUE && clock.monotonicMs() - cache.attempted < 120_000) return
                    cache.attempted = clock.monotonicMs()
                    sources = discovered.filter { it.id in selected && it.capability == "read" }
                }
                val proposed = linkedMapOf<String, Window>(); var anySuccess = sources.isEmpty()
                for(source in sources) {
                    try { proposed[source.id] = events(token, source, range, expected, account, budget); anySuccess = true }
                    catch(e: PhoneCalendarFailure) {
                        if(e.code in setOf("SESSION_ENDED", "CALENDAR_AUTH_REQUIRED", "CALENDAR_CAPACITY")) throw e
                        recordBackoff(e)
                        val previous = synchronized(lock) { cache.windows[source.id] }
                        proposed[source.id] = Window(previous?.events ?: emptyList(), "error", e.code, previous?.success)
                    }
                }
                synchronized(lock) {
                    check(expected, account)
                    if(proposed.values.sumOf { it.events.size } > 5000 || proposed.values.sumOf { w -> w.events.sumOf { it.toString().toByteArray(Charsets.UTF_8).size.toLong() } } > MAX_BYTES) throw PhoneCalendarFailure("CALENDAR_CAPACITY")
                    cache.windows = proposed; cache.revision = revision(); cache.error = null
                    if(anySuccess) { cache.receipt = clock.monotonicMs(); cache.sampledWall = clock.epochMs(); cache.success = clock.epochMs() }
                    // Account-wide aggregate memory budget; evict other ranges before the current one.
                    while(ranges.size > 1 && ranges.values.sumOf { r -> r.windows.values.sumOf { w -> w.events.sumOf { it.toString().toByteArray(Charsets.UTF_8).size.toLong() } } } > MAX_BYTES) ranges.remove(ranges.keys.first { it != range.toString() })
                    if(proposed.values.all { it.error == null }) { failures = 0; backoffUntil = 0 }
                }
            } catch(e: PhoneCalendarFailure) {
                if(e.code == "CALENDAR_AUTH_REQUIRED") { if(valid(expected, account)) auth.requireAuthorization(account); return }
                synchronized(lock) {
                    if(!valid(expected, account) || e.code == "SESSION_ENDED") return
                    recordBackoff(e)
                    if(range != null && applied) ranges.getOrPut(range.toString()) { RangeCache(range.deepCopy()) }.also { it.error = e.code; it.revision = revision() }
                    else metadataError = e.code
                }
            }
        } finally { worker.unlock() }
    }
    private fun link(data: JsonObject, receipt: Long?, error: String?, valid: Boolean): LinkSnapshot {
        if(!valid) return LinkSnapshot("error", null, true, null, "BAD_PAYLOAD")
        val age = receipt?.let { (clock.monotonicMs() - it).coerceAtLeast(0) }
        val stale = !active || age == null || age >= 120_000 || error != null
        return LinkSnapshot(if(error != null) "error" else if(active) "connected" else "disconnected", age, stale, data, error)
    }
    private fun cursorOffset(args: JsonObject, key: String, rev: String): Pair<Int,String?> {
        val token = args.text("cursor") ?: return 0 to null
        if(token.substringBefore('.').removePrefix("cur_") != selectionRevision) return 0 to "CALENDAR_SELECTION_CHANGED"
        val cursor = cursors[token] ?: return 0 to "CALENDAR_CURSOR_EXPIRED"
        if(cursor.selection != selectionRevision) return 0 to "CALENDAR_SELECTION_CHANGED"
        if(cursor.key != key || cursor.revision != rev || clock.monotonicMs() - cursor.issued > 600_000) return 0 to "CALENDAR_CURSOR_EXPIRED"
        return cursor.offset to null
    }
    private fun cursor(key: String, rev: String, offset: Int): String {
        val token = "cur_$selectionRevision.${revision()}"
        cursors[token] = Cursor(key, rev, selectionRevision, offset, clock.monotonicMs())
        while(cursors.size > 256) cursors.remove(cursors.keys.first())
        return token
    }
    private fun sourceProtocol(source: PhoneCalendarSource, cache: RangeCache? = null): JsonObject {
        val included = source.id in selected; val window = cache?.windows?.get(source.id)
        val error = if(included) window?.error ?: source.metadataError else null
        val state = when { source.capability != "read" -> "disabled"; !included -> "disabled"; window != null -> window.state; error != null -> "partial"; else -> "loading" }
        return source.protocol(included, state, window?.success ?: metadataWall, error)
    }
    fun sources(args: JsonObject = jsonObject()): LinkSnapshot {
        if(!CalendarValidator.sourcesRequest(args)) return LinkSnapshot("error",null,true,null,"BAD_PAYLOAD")
        sync(null,false)
        return synchronized(lock) {
            val (offset,cursorError) = cursorOffset(args,"sources",metadataRevision)
            val error = cursorError ?: if(auth.status != "connected") "CALENDAR_AUTH_REQUIRED" else metadataError
            val state = when { auth.status != "connected" -> "auth_required"; error == "CALENDAR_CAPACITY" -> "capacity"; error != null -> if(discovered.isEmpty()) "error" else "partial"; !applied -> "setup_required"; else -> "available" }
            val sources = if(cursorError != null || auth.status != "connected" || error == "CALENDAR_CAPACITY") emptyList() else discovered.drop(offset).take(50).map { sourceProtocol(it) }
            val next = if(sources.isNotEmpty() && offset + sources.size < discovered.size) cursor("sources",metadataRevision,offset + sources.size) else null
            val page = jsonObject("v" to 1, "state" to state, "errorCode" to error, "serverNowEpochMs" to (metadataWall ?: clock.epochMs()), "selectionRevision" to selectionRevision, "sources" to sources, "nextCursor" to next)
            link(page,metadataReceipt,error,CalendarValidator.sourcesPage(page))
        }
    }
    fun select(args: JsonObject): JsonObject {
        if(!CalendarValidator.selectRequest(args)) throw BridgeFailure("BAD_PAYLOAD")
        val cancelled: List<PhoneCalendarCall>; val result: JsonObject
        synchronized(lock) {
            if(!active || closed) throw BridgeFailure("SESSION_ENDED")
            if(auth.status != "connected") throw BridgeFailure("CALENDAR_AUTH_REQUIRED")
            if(metadataError == "CALENDAR_CAPACITY") throw BridgeFailure("CALENDAR_CAPACITY")
            if(args.text("expectedRevision") != selectionRevision) throw BridgeFailure("CALENDAR_SELECTION_CHANGED")
            val ids = args.getAsJsonArray("sourceIds").map { it.asString }.toSet()
            if(!discovered.filter { it.capability == "read" }.map { it.id }.containsAll(ids)) throw BridgeFailure("BAD_PAYLOAD")
            selected = ids; applied = true; selectionRevision = revision(); epoch++; ranges.clear(); cursors.clear()
            cancelled = calls.toList(); calls.clear(); result = jsonObject("selectionRevision" to selectionRevision)
        }
        cancelled.forEach { it.cancel() }; return result
    }
    fun read(args: JsonObject): LinkSnapshot {
        if(!CalendarValidator.rangeRequest(args)) return LinkSnapshot("error",null,true,null,"BAD_PAYLOAD")
        val range = jsonObject("startDate" to args.text("startDate"), "days" to args["days"].asInt, "timeZone" to args.text("timeZone"))
        sync(range,args.flag("refresh"))
        return synchronized(lock) {
            val cache = ranges[range.toString()]
            val rev = cache?.revision ?: metadataRevision
            val (offset,cursorError) = cursorOffset(args,range.toString(),rev)
            val allSources = discovered.filter { !applied || it.id in selected }.map { sourceProtocol(it,cache) }
            val allEvents = cache?.windows?.values?.flatMap { it.events }?.sortedWith(compareBy<JsonObject> { PhoneCalendarNormalization.startEpoch(it,range.text("timeZone")!!) }.thenBy { it.text("id") }) ?: emptyList()
            val receipt = cache?.receipt ?: metadataReceipt
            val sampled = cache?.sampledWall ?: metadataWall ?: clock.epochMs()
            val now = sampled + (receipt?.let { (clock.monotonicMs() - it).coerceAtLeast(0) } ?: 0)
            val nextEvent = allEvents.firstOrNull { it.getAsJsonObject("start").text("kind") == "time" && it.text("selfResponseStatus") != "declined" && it.getAsJsonObject("end")["epochMs"].asLong > now }
            val error = cursorError ?: if(auth.status != "connected") "CALENDAR_AUTH_REQUIRED" else metadataError ?: cache?.error ?: cache?.windows?.values?.firstOrNull { it.error != null }?.error
            val failed = allSources.count { it.text("state") in setOf("error","partial","capacity") }
            val state = when { auth.status != "connected" -> "auth_required"; error == "CALENDAR_CAPACITY" -> "capacity"; cursorError != null -> "error"; !applied && error == null -> "setup_required"; error != null -> if(cache?.success != null) "partial" else "error"; cache?.success == null && applied -> "loading"; else -> "available" }
            val items = if(cursorError != null || auth.status != "connected") mutableListOf() else allEvents.drop(offset).take(50).toMutableList()
            var page: JsonObject
            while(true) {
                val needed = items.map { it.text("sourceId") }.toSet()
                val pageSources = (allSources.filter { it.text("sourceId") in needed } + allSources.filter { it.text("sourceId") !in needed }).take(50)
                val hasMore = cursorError == null && items.isNotEmpty() && offset + items.size < allEvents.size
                page = jsonObject("v" to 1, "state" to state, "errorCode" to error, "serverNowEpochMs" to sampled, "range" to range, "revision" to rev, "selectionRevision" to selectionRevision, "lastSuccessAtEpochMs" to (cache?.success ?: metadataWall), "sourceCount" to allSources.size, "failedSourceCount" to failed, "sources" to pageSources, "items" to items, "nextEvent" to nextEvent, "nextCursor" to if(hasMore) "x".repeat(100) else null)
                if(page.toString().toByteArray(Charsets.UTF_8).size <= CalendarValidator.PAGE_BYTES || items.isEmpty()) {
                    page.add("nextCursor", com.google.gson.Gson().toJsonTree(if(hasMore) cursor(range.toString(),rev,offset + items.size) else null)); break
                }
                items.removeAt(items.lastIndex)
            }
            link(page,receipt,error,CalendarValidator.page(page))
        }
    }
}
