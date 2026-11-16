package com.phonemonitor

import com.google.gson.JsonObject
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

private const val BRIDGE_REQUEST_BYTES = 16 * 1024
private const val MAX_CACHED_PAGES = 12
private const val MAX_CACHED_SOURCE_PAGES = 8

/**
 * Activity-owned calendar client. Uses the same unbound loopback transport and native bearer store as
 * LaptopClient while keeping calendar caches, receipt-age baselines, and failures isolated from hub.snapshot.
 */
class CalendarClient internal constructor(
    private val store: PairingStore,
    private val transport: HubTransport = LoopbackHubTransport(),
    private val clock: HubClock = SystemHubClock,
    private val onPairedChanged: (Boolean) -> Unit = {},
    private val laptop: LaptopClient? = null,
) : AutoCloseable {
    constructor(laptop: LaptopClient) : this(laptop.store, laptop.transport, laptop.clock, {}, laptop)
    constructor(store: PairingStore, onPairedChanged: (Boolean) -> Unit = {}) : this(
        store,
        LoopbackHubTransport(),
        SystemHubClock,
        onPairedChanged,
        null,
    )

    private data class PageKey(val startDate: String, val days: Int, val timeZone: String, val cursor: String?)
    private class CachedEntry(val data: JsonObject, val baselineMonoMs: Long)
    private sealed interface Outcome {
        data class Data(val data: JsonObject) : Outcome
        data object Rejected : Outcome
        data class Failure(val code: String) : Outcome
    }

    private val lock = Any()
    private var tokenLoaded = false
    private var token: String? = null
    private val pageCache = LinkedHashMap<PageKey, CachedEntry>(16, 0.75f, true)
    private val sourcesCache = LinkedHashMap<String, CachedEntry>(8, 0.75f, true)
    private var cachedSelectionRevision: String? = null
    private var readOutcome: String? = null
    private var sourcesOutcome: String? = null
    private var active = false
    private var closed = false
    private var epoch = 0L
    private var selectionEpoch = 0L
    private val activeCalls = LinkedHashSet<HubCall>()
    private val readAndSourceCalls = LinkedHashSet<HubCall>()

    val paired: Boolean
        get() = synchronized(lock) { loadBearer() != null }

    private fun loadBearer(): String? {
        if (laptop != null) return laptop.currentBearer()
        if (!tokenLoaded || token == null) {
            val stored = try {
                store.getToken()?.takeIf { LaptopClient.TOKEN_PATTERN.matches(it) }
            } catch (_: Exception) {
                null
            }
            if (!tokenLoaded || stored != null) {
                tokenLoaded = true
                token = stored
            }
        }
        return token
    }

    private fun revokeBearer(rejected: String): Boolean {
        if (laptop != null) return laptop.revokeBearer(rejected)
        val changed = synchronized(lock) {
            val current = loadBearer()
            if (current != rejected) false else {
                token = null
                tokenLoaded = true
                try {
                    store.clearToken()
                } catch (_: Exception) {
                    /* in-memory credential is already gone */
                }
                true
            }
        }
        if (changed) onPairedChanged(false)
        return changed
    }

    fun resume() = synchronized(lock) {
        if (closed || active) return@synchronized
        active = true
        if (readOutcome != "AUTH_REQUIRED") readOutcome = null
        if (sourcesOutcome != "AUTH_REQUIRED") sourcesOutcome = null
    }

    fun pause() {
        val calls = synchronized(lock) {
            active = false
            epoch++
            activeCalls.toList().also {
                activeCalls.clear()
                readAndSourceCalls.clear()
            }
        }
        calls.forEach { it.cancel() }
    }

    override fun close() {
        synchronized(lock) {
            closed = true
            pageCache.clear()
            sourcesCache.clear()
            cachedSelectionRevision = null
        }
        pause()
    }

    private fun linkFor(entry: CachedEntry?, outcome: String?, bearer: String?, overrideError: String? = null): LinkSnapshot {
        val cached = entry?.data
        val age = entry?.let { (clock.monotonicMs() - it.baselineMonoMs).coerceAtLeast(0L) }
        val error = when {
            overrideError != null -> overrideError
            outcome == "OK" -> null
            outcome != null -> outcome
            bearer == null -> "AUTH_REQUIRED"
            else -> null
        }
        val state = when {
            error == null && outcome == "OK" -> "connected"
            error == "AUTH_REQUIRED" || error == "BAD_PAYLOAD" || (error != null && error in CalendarValidator.errors) -> "error"
            error != null -> "disconnected"
            else -> "connecting"
        }
        val stale = cached == null ||
            age == null ||
            age >= LAPTOP_STALE_MS ||
            error == "AUTH_REQUIRED" ||
            (error != null && error in CalendarValidator.errors)
        return LinkSnapshot(state, if (cached == null) null else age, stale, cached, error)
    }

    private fun extractPageKey(args: JsonObject): PageKey? = try {
        val startDate = args["startDate"]?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString ?: return null
        val days = args["days"]?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asInt ?: return null
        val timeZone = args["timeZone"]?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString ?: return null
        val cursor = args["cursor"]?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
        PageKey(startDate, days, timeZone, cursor)
    } catch (_: Exception) {
        null
    }

    fun read(args: JsonObject): LinkSnapshot {
        val payloadBytes = args.toString().toByteArray(Charsets.UTF_8)
        if (payloadBytes.size > BRIDGE_REQUEST_BYTES || !CalendarValidator.rangeRequest(args)) {
            return synchronized(lock) {
                val bearer = loadBearer()
                val key = extractPageKey(args)
                linkFor(key?.let { pageCache[it] }, readOutcome, bearer, overrideError = "BAD_PAYLOAD")
            }
        }
        val key = extractPageKey(args)!!
        val call: HubCall
        val callEpoch: Long
        val callSelectionEpoch: Long
        val bearer: String
        synchronized(lock) {
            val currentBearer = loadBearer()
            if (currentBearer != null && readOutcome == "AUTH_REQUIRED") readOutcome = null
            if (closed || !active || currentBearer == null) {
                return linkFor(pageCache[key], readOutcome, currentBearer)
            }
            bearer = currentBearer
            callEpoch = epoch
            callSelectionEpoch = selectionEpoch
            call = transport.newCall(HubRequest(HubPath.CALENDAR_READ, bearer, payloadBytes))
            activeCalls.add(call)
            readAndSourceCalls.add(call)
        }
        var shouldRevoke = false
        try {
            val result: Outcome = try {
                interpretPage(call.execute(), bearer)
            } catch (e: HubTransportException) {
                Outcome.Failure(e.code)
            } catch (_: Exception) {
                Outcome.Failure(if (Thread.currentThread().isInterrupted) "SESSION_ENDED" else "USB_UNAVAILABLE")
            }
            val snapshot = synchronized(lock) {
                activeCalls.remove(call)
                readAndSourceCalls.remove(call)
                if (!closed && active && epoch == callEpoch) {
                    when (result) {
                        is Outcome.Data -> if (selectionEpoch == callSelectionEpoch) {
                            storePage(key, result.data)
                            readOutcome = "OK"
                        }
                        is Outcome.Rejected -> if (loadBearer() == bearer) {
                            readOutcome = "AUTH_REQUIRED"
                            sourcesOutcome = "AUTH_REQUIRED"
                            shouldRevoke = true
                        }
                        is Outcome.Failure -> if (result.code != "SESSION_ENDED" && selectionEpoch == callSelectionEpoch) {
                            readOutcome = result.code
                        }
                    }
                }
                linkFor(pageCache[key], readOutcome, if (shouldRevoke) null else loadBearer())
            }
            if (shouldRevoke) revokeBearer(bearer)
            return snapshot
        } finally {
            synchronized(lock) {
                activeCalls.remove(call)
                readAndSourceCalls.remove(call)
            }
        }
    }

    private fun storePage(key: PageKey, page: JsonObject) {
        val selRev = page["selectionRevision"].asString
        if (cachedSelectionRevision != null && cachedSelectionRevision != selRev) {
            pageCache.clear()
            sourcesCache.clear()
        }
        cachedSelectionRevision = selRev
        val pageState = page["state"].asString
        val items = page.getAsJsonArray("items")
        if (pageState in setOf("disabled", "setup_required", "auth_required") && items.size() == 0) {
            pageCache.clear()
        } else {
            val rev = page["revision"].asString
            val obsolete = pageCache.entries.filter { (k, v) ->
                k.startDate == key.startDate &&
                    k.days == key.days &&
                    k.timeZone == key.timeZone &&
                    v.data["revision"]?.asString != rev
            }.map { it.key }
            obsolete.forEach { pageCache.remove(it) }
        }
        // ageMs advances this response's serverNow sample, independently of Google sync age.
        // A validated domain error/partial page is still a newly received hub response.
        pageCache[key] = CachedEntry(page, clock.monotonicMs())
        while (pageCache.size > MAX_CACHED_PAGES) {
            val firstKey = pageCache.keys.firstOrNull() ?: break
            pageCache.remove(firstKey)
        }
    }

    fun sources(args: JsonObject = jsonObject()): LinkSnapshot {
        val payloadBytes = args.toString().toByteArray(Charsets.UTF_8)
        if (payloadBytes.size > BRIDGE_REQUEST_BYTES || !CalendarValidator.sourcesRequest(args)) {
            return synchronized(lock) {
                val bearer = loadBearer()
                linkFor(null, sourcesOutcome, bearer, overrideError = "BAD_PAYLOAD")
            }
        }
        val cursorKey = args["cursor"]?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString ?: ""
        val call: HubCall
        val callEpoch: Long
        val callSelectionEpoch: Long
        val bearer: String
        synchronized(lock) {
            val currentBearer = loadBearer()
            if (currentBearer != null && sourcesOutcome == "AUTH_REQUIRED") sourcesOutcome = null
            if (closed || !active || currentBearer == null) {
                return linkFor(sourcesCache[cursorKey], sourcesOutcome, currentBearer)
            }
            bearer = currentBearer
            callEpoch = epoch
            callSelectionEpoch = selectionEpoch
            call = transport.newCall(HubRequest(HubPath.CALENDAR_SOURCES, bearer, payloadBytes))
            activeCalls.add(call)
            readAndSourceCalls.add(call)
        }
        var shouldRevoke = false
        try {
            val result: Outcome = try {
                interpretSources(call.execute(), bearer)
            } catch (e: HubTransportException) {
                Outcome.Failure(e.code)
            } catch (_: Exception) {
                Outcome.Failure(if (Thread.currentThread().isInterrupted) "SESSION_ENDED" else "USB_UNAVAILABLE")
            }
            val snapshot = synchronized(lock) {
                activeCalls.remove(call)
                readAndSourceCalls.remove(call)
                if (!closed && active && epoch == callEpoch) {
                    when (result) {
                        is Outcome.Data -> if (selectionEpoch == callSelectionEpoch) {
                            storeSourcesPage(cursorKey, result.data)
                            sourcesOutcome = "OK"
                        }
                        is Outcome.Rejected -> if (loadBearer() == bearer) {
                            readOutcome = "AUTH_REQUIRED"
                            sourcesOutcome = "AUTH_REQUIRED"
                            shouldRevoke = true
                        }
                        is Outcome.Failure -> if (result.code != "SESSION_ENDED" && selectionEpoch == callSelectionEpoch) {
                            sourcesOutcome = result.code
                        }
                    }
                }
                linkFor(sourcesCache[cursorKey], sourcesOutcome, if (shouldRevoke) null else loadBearer())
            }
            if (shouldRevoke) revokeBearer(bearer)
            return snapshot
        } finally {
            synchronized(lock) {
                activeCalls.remove(call)
                readAndSourceCalls.remove(call)
            }
        }
    }

    private fun storeSourcesPage(cursorKey: String, page: JsonObject) {
        val selRev = page["selectionRevision"].asString
        if (cachedSelectionRevision != null && cachedSelectionRevision != selRev) {
            pageCache.clear()
            sourcesCache.clear()
        }
        cachedSelectionRevision = selRev
        // Source lastSuccessAtEpochMs describes Google freshness, never transport receipt age.
        sourcesCache[cursorKey] = CachedEntry(page, clock.monotonicMs())
        while (sourcesCache.size > MAX_CACHED_SOURCE_PAGES) {
            val firstKey = sourcesCache.keys.firstOrNull() ?: break
            sourcesCache.remove(firstKey)
        }
    }

    fun select(args: JsonObject): JsonObject {
        val payloadBytes = args.toString().toByteArray(Charsets.UTF_8)
        if (payloadBytes.size > BRIDGE_REQUEST_BYTES || !CalendarValidator.selectRequest(args)) {
            throw BridgeFailure("BAD_PAYLOAD")
        }
        val call: HubCall
        val callEpoch: Long
        val bearer: String
        synchronized(lock) {
            if (closed || !active) throw BridgeFailure("SESSION_ENDED")
            val currentBearer = loadBearer() ?: throw BridgeFailure("AUTH_REQUIRED")
            bearer = currentBearer
            callEpoch = epoch
            call = transport.newCall(HubRequest(HubPath.CALENDAR_SELECT, bearer, payloadBytes))
            activeCalls.add(call)
        }
        var shouldRevoke = false
        var callsToCancel: List<HubCall> = emptyList()
        try {
            val result: Outcome = try {
                interpretSelect(call.execute(), bearer)
            } catch (e: HubTransportException) {
                Outcome.Failure(e.code)
            } catch (_: Exception) {
                Outcome.Failure(if (Thread.currentThread().isInterrupted) "SESSION_ENDED" else "USB_UNAVAILABLE")
            }
            val reply = synchronized(lock) {
                activeCalls.remove(call)
                if (closed || !active || epoch != callEpoch) throw BridgeFailure("SESSION_ENDED")
                when (result) {
                    is Outcome.Data -> {
                        selectionEpoch++
                        cachedSelectionRevision = result.data["selectionRevision"].asString
                        pageCache.clear()
                        sourcesCache.clear()
                        callsToCancel = readAndSourceCalls.toList()
                        readAndSourceCalls.clear()
                        result.data.deepCopy()
                    }
                    is Outcome.Rejected -> {
                        if (loadBearer() == bearer) {
                            readOutcome = "AUTH_REQUIRED"
                            sourcesOutcome = "AUTH_REQUIRED"
                            shouldRevoke = true
                        }
                        null
                    }
                    is Outcome.Failure -> throw BridgeFailure(result.code)
                }
            }
            callsToCancel.forEach { it.cancel() }
            if (shouldRevoke) {
                revokeBearer(bearer)
                throw BridgeFailure("AUTH_REQUIRED")
            }
            return reply!!
        } finally {
            synchronized(lock) {
                activeCalls.remove(call)
            }
        }
    }

    private fun interpretNon200(response: HubResponse): Outcome {
        if (response.status == 404) return Outcome.Failure("CALENDAR_UNSUPPORTED")
        val code = hubErrorCode(response.body)
        if (response.status == 401) {
            if (code == "AUTH_REQUIRED") return Outcome.Rejected
            if (code != null && code in CalendarValidator.errors) return Outcome.Failure(code)
            return Outcome.Failure("BAD_PAYLOAD")
        }
        if (code != null && code in CalendarValidator.errors) return Outcome.Failure(code)
        if (response.status in 500..599) return Outcome.Failure("HUB_UNAVAILABLE")
        return Outcome.Failure("BAD_PAYLOAD")
    }

    private fun interpretPage(response: HubResponse, bearer: String): Outcome {
        if (response.status != 200) return interpretNon200(response)
        val raw = parseObject(response.body, CalendarValidator.PAGE_BYTES) ?: return Outcome.Failure("BAD_PAYLOAD")
        if (!CalendarValidator.page(raw)) return Outcome.Failure("BAD_PAYLOAD")
        val normalized = CalendarValidator.normalizePage(raw)
        if (!CalendarValidator.page(normalized)) return Outcome.Failure("BAD_PAYLOAD")
        if (LaptopClient.containsSecret(response.body, bearer) ||
            LaptopClient.containsSecret(normalized.toString().toByteArray(Charsets.UTF_8), bearer)
        ) {
            return Outcome.Failure("BAD_PAYLOAD")
        }
        return Outcome.Data(normalized)
    }

    private fun interpretSources(response: HubResponse, bearer: String): Outcome {
        if (response.status != 200) return interpretNon200(response)
        val raw = parseObject(response.body, CalendarValidator.PAGE_BYTES) ?: return Outcome.Failure("BAD_PAYLOAD")
        if (!CalendarValidator.sourcesPage(raw)) return Outcome.Failure("BAD_PAYLOAD")
        if (LaptopClient.containsSecret(response.body, bearer) ||
            LaptopClient.containsSecret(raw.toString().toByteArray(Charsets.UTF_8), bearer)
        ) {
            return Outcome.Failure("BAD_PAYLOAD")
        }
        return Outcome.Data(raw)
    }

    private fun interpretSelect(response: HubResponse, bearer: String): Outcome {
        if (response.status != 200) return interpretNon200(response)
        val raw = parseObject(response.body, CalendarValidator.PAGE_BYTES) ?: return Outcome.Failure("BAD_PAYLOAD")
        if (!CalendarValidator.selectReply(raw)) return Outcome.Failure("BAD_PAYLOAD")
        if (LaptopClient.containsSecret(response.body, bearer) ||
            LaptopClient.containsSecret(raw.toString().toByteArray(Charsets.UTF_8), bearer)
        ) {
            return Outcome.Failure("BAD_PAYLOAD")
        }
        return Outcome.Data(raw)
    }

    private fun parseObject(body: ByteArray, maxBytes: Int): JsonObject? = try {
        if (body.size > maxBytes) null
        else {
            val text = Charsets.UTF_8
                .newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(body))
                .toString()
            StrictJson.parse(text).takeIf { it.isJsonObject }?.asJsonObject
        }
    } catch (_: Exception) {
        null
    }

    private fun hubErrorCode(body: ByteArray): String? {
        val o = parseObject(body, HUB_REPLY_BYTES) ?: return null
        val e = o["error"] ?: return null
        if (o.keySet() != setOf("v", "error") || o["v"].toString() != "1" || !e.isJsonObject) return null
        val eo = e.asJsonObject
        if (eo.keySet() != setOf("code")) return null
        val code = eo["code"]
        return if (code != null && code.isJsonPrimitive && code.asJsonPrimitive.isString) code.asString else null
    }
}
