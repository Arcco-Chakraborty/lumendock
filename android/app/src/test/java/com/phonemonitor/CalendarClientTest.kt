package com.phonemonitor

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.Proxy
import java.net.ServerSocket
import java.net.URL
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class CalendarClientTest {
    private val clock = TestClock()
    private val transport = FakeHubTransport()

    private fun rangeArgs(extra: String = ""): JsonObject =
        json("""{"startDate":"2026-03-08","days":7,"timeZone":"America/New_York"$extra}""")

    private fun selectArgs(ids: List<String> = listOf("synthetic_work"), rev: String = "synthetic_selection_1"): JsonObject =
        json("""{"sourceIds":[${ids.joinToString(",") { "\"$it\"" }}],"expectedRevision":"$rev"}""")

    private fun pairedSetup(
        store: MemoryStore = MemoryStore(SYNTHETIC_TOKEN),
        onPaired: (Boolean) -> Unit = {},
    ): Pair<LaptopClient, CalendarClient> {
        val laptop = LaptopClient(store, transport, clock, onPaired).also { it.resume() }
        val calendar = CalendarClient(laptop).also { it.resume() }
        return laptop to calendar
    }

    @Test fun usesFixedLoopbackPostPathsAndConfinesBearerToNativeStorage() {
        val store = MemoryStore(SYNTHETIC_TOKEN)
        val (_, calendar) = pairedSetup(store)

        transport.reply(200, calendarPageFixture().toString())
        val pageLink = calendar.read(rangeArgs())
        assertEquals("connected", pageLink.state)
        assertEquals(HubPath.CALENDAR_READ, transport.lastRequest.path)
        assertEquals("http://127.0.0.1:8765/v1/calendar/read", transport.lastRequest.path.url)
        assertEquals("POST", transport.lastRequest.path.method)
        assertEquals("Bearer $SYNTHETIC_TOKEN", transport.lastRequest.headers()["Authorization"])
        assertEquals("application/json", transport.lastRequest.headers()["Content-Type"])
        assertEquals(rangeArgs(), StrictJson.parse(transport.lastRequest.body!!.toString(Charsets.UTF_8)).asJsonObject)
        assertFalse(transport.lastRequest.toString().contains(SYNTHETIC_TOKEN))
        assertFalse(pageLink.toJson().toString().lowercase().contains(SYNTHETIC_TOKEN))

        transport.reply(200, calendarSourcesFixture().toString())
        val sourcesLink = calendar.sources(json("""{"cursor":"c_1"}"""))
        assertEquals("connected", sourcesLink.state)
        assertEquals(HubPath.CALENDAR_SOURCES, transport.lastRequest.path)
        assertEquals("http://127.0.0.1:8765/v1/calendar/sources", transport.lastRequest.path.url)
        assertEquals("POST", transport.lastRequest.path.method)
        assertEquals(json("""{"cursor":"c_1"}"""), StrictJson.parse(transport.lastRequest.body!!.toString(Charsets.UTF_8)).asJsonObject)
        assertFalse(sourcesLink.toJson().toString().lowercase().contains(SYNTHETIC_TOKEN))

        transport.reply(200, """{"selectionRevision":"synthetic_selection_2"}""")
        val selectReply = calendar.select(selectArgs())
        assertEquals("synthetic_selection_2", selectReply["selectionRevision"].asString)
        assertEquals(HubPath.CALENDAR_SELECT, transport.lastRequest.path)
        assertEquals("http://127.0.0.1:8765/v1/calendar/select", transport.lastRequest.path.url)
        assertEquals("POST", transport.lastRequest.path.method)
        assertEquals(selectArgs(), StrictJson.parse(transport.lastRequest.body!!.toString(Charsets.UTF_8)).asJsonObject)
        assertFalse(selectReply.toString().lowercase().contains(SYNTHETIC_TOKEN))
    }

    @Test fun echoedBearerOrExceptionDetailNeverEscapesCalendarClient() {
        val store = MemoryStore(SYNTHETIC_TOKEN)
        val (_, calendar) = pairedSetup(store)
        val escaped = SYNTHETIC_TOKEN.map { "\\u%04x".format(it.code) }.joinToString("")
        for (echo in listOf(SYNTHETIC_TOKEN, escaped, SYNTHETIC_TOKEN.uppercase())) {
            val poisoned = calendarPageFixture().with("title_poison", "none").without("title_poison").also {
                it.getAsJsonArray("items")[0].asJsonObject.addProperty("title", echo)
                it.getAsJsonObject("nextEvent").addProperty("title", echo)
            }
            transport.reply(200, poisoned.toString())
            val link = calendar.read(rangeArgs())
            assertEquals("BAD_PAYLOAD", link.errorCode)
            assertNull(link.data)
            assertFalse(link.toJson().toString().lowercase().contains(SYNTHETIC_TOKEN))
        }
        transport.respond = { throw IOException("failed Authorization: Bearer $SYNTHETIC_TOKEN") }
        val failed = calendar.read(rangeArgs())
        assertEquals("USB_UNAVAILABLE", failed.errorCode)
        assertFalse(failed.toJson().toString().lowercase().contains(SYNTHETIC_TOKEN))
    }

    @Test fun oldHub404MapsToCalendarUnsupportedWithoutInvalidatingSnapshotOrPairing() {
        var pairedState: Boolean? = true
        val store = MemoryStore(SYNTHETIC_TOKEN)
        val (laptop, calendar) = pairedSetup(store) { pairedState = it }

        // First populate a valid hub snapshot.
        transport.succeed()
        val snap1 = laptop.snapshot()
        assertEquals("connected", snap1.state)
        assertNotNull(snap1.data)

        // Old hub returns 404 with BAD_PAYLOAD on all three calendar endpoints.
        transport.reply(404, """{"v":1,"error":{"code":"BAD_PAYLOAD"}}""")
        val readLink = calendar.read(rangeArgs())
        assertEquals("error", readLink.state)
        assertEquals("CALENDAR_UNSUPPORTED", readLink.errorCode)
        assertTrue(readLink.stale)
        assertNull(readLink.data)
        assertNull(readLink.ageMs)
        assertTrue(ProtocolValidator.response("hub.calendar", readLink.toJson()))

        val sourcesLink = calendar.sources(json("{}"))
        assertEquals("error", sourcesLink.state)
        assertEquals("CALENDAR_UNSUPPORTED", sourcesLink.errorCode)
        assertTrue(sourcesLink.stale)
        assertNull(sourcesLink.data)
        assertTrue(ProtocolValidator.response("hub.calendarSources", sourcesLink.toJson()))

        val selectErr = try {
            calendar.select(selectArgs())
            fail("Expected BridgeFailure")
            null
        } catch (e: BridgeFailure) {
            e.code
        }
        assertEquals("CALENDAR_UNSUPPORTED", selectErr)

        // Pairing and ordinary hub snapshot cache remain completely intact.
        assertEquals(SYNTHETIC_TOKEN, store.value)
        assertEquals(0, store.clears)
        assertTrue(laptop.paired)
        assertEquals(true, pairedState)

        clock.advanceMonotonic(2000)
        transport.succeed()
        val snap2 = laptop.snapshot()
        assertEquals("connected", snap2.state)
        assertEquals(snap1.data, snap2.data)
    }

    @Test fun onlyValidatedHubBearerAuthRequiredRevokesPairingNeverGoogleGrantErrors() {
        var pairedState: Boolean? = true
        val store = MemoryStore(SYNTHETIC_TOKEN)
        val (laptop, calendar) = pairedSetup(store) { pairedState = it }

        // 1. Domain-level Google grant error in CalendarPage (HTTP 200) must NOT revoke laptop pairing.
        val googleAuthPage = calendarPageFixture().also {
            it.addProperty("state", "auth_required")
            it.addProperty("errorCode", "CALENDAR_AUTH_REQUIRED")
            it.add("items", JsonArray())
            it.add("sources", JsonArray())
            it.add("nextEvent", com.google.gson.JsonNull.INSTANCE)
        }
        transport.reply(200, googleAuthPage.toString())
        val domainAuthLink = calendar.read(rangeArgs())
        assertEquals("connected", domainAuthLink.state)
        assertEquals("auth_required", domainAuthLink.data!!["state"].asString)
        assertEquals("CALENDAR_AUTH_REQUIRED", domainAuthLink.data!!["errorCode"].asString)
        assertEquals(SYNTHETIC_TOKEN, store.value)
        assertEquals(0, store.clears)
        assertTrue(laptop.paired)
        assertEquals(true, pairedState)

        // 2. HTTP 401/403 with CALENDAR_AUTH_REQUIRED or unvalidated 401 body must NOT revoke laptop pairing.
        transport.reply(401, """{"v":1,"error":{"code":"CALENDAR_AUTH_REQUIRED"}}""")
        val calendar401 = calendar.read(rangeArgs())
        assertEquals("CALENDAR_AUTH_REQUIRED", calendar401.errorCode)
        assertEquals(SYNTHETIC_TOKEN, store.value)
        assertTrue(laptop.paired)

        transport.reply(401, """{"error":"upstream google token expired"}""")
        val unvalidated401 = calendar.read(rangeArgs())
        assertEquals("BAD_PAYLOAD", unvalidated401.errorCode)
        assertEquals(SYNTHETIC_TOKEN, store.value)
        assertTrue(laptop.paired)

        // 3. Validated hub bearer 401 AUTH_REQUIRED DOES revoke native laptop pairing.
        transport.reply(401, AUTH_REQUIRED_BODY)
        val rejected = calendar.read(rangeArgs())
        assertEquals("AUTH_REQUIRED", rejected.errorCode)
        assertEquals("error", rejected.state)
        assertTrue(rejected.stale)
        assertNull(store.value)
        assertEquals(1, store.clears)
        assertFalse(laptop.paired)
        assertFalse(calendar.paired)
        assertEquals(false, pairedState)

        // Subsequent calendar calls do not hit the network while unpaired.
        val countBefore = transport.requests.size
        assertEquals("AUTH_REQUIRED", calendar.read(rangeArgs()).errorCode)
        assertEquals("AUTH_REQUIRED", calendar.sources(json("{}")).errorCode)
        assertEquals(countBefore, transport.requests.size)
    }

    @Test fun staleCachedAgeAdvancesMonotonicallyAndIsNotRefreshedByFailedReads() {
        val (_, calendar) = pairedSetup()
        transport.reply(200, calendarPageFixture().toString())
        val initial = calendar.read(rangeArgs())
        assertEquals("connected", initial.state)
        assertEquals(0L, initial.ageMs)
        assertFalse(initial.stale)
        val expectedData = initial.data!!

        // Advance wall clock backwards and monotonic clock forwards; fail transport.
        transport.failWith("USB_UNAVAILABLE")
        clock.shiftWall(-120_000)
        val seenAges = mutableListOf<Long>()
        repeat(5) {
            clock.advanceMonotonic(1500)
            val link = calendar.read(rangeArgs())
            assertEquals(expectedData, link.data)
            assertEquals("disconnected", link.state)
            assertEquals("USB_UNAVAILABLE", link.errorCode)
            seenAges.add(link.ageMs!!)
        }
        assertEquals(listOf(1500L, 3000L, 4500L, 6000L, 7500L), seenAges)
        assertTrue(calendar.read(rangeArgs()).stale)

        // Even a manual refresh request that fails must retain the cached range and its age baseline.
        clock.advanceMonotonic(1000)
        val failedRefresh = calendar.read(rangeArgs(""","refresh":true"""))
        assertEquals(8500L, failedRefresh.ageMs)
        assertEquals(expectedData, failedRefresh.data)
        assertTrue(failedRefresh.stale)

        // Oversized (>128 KiB) or malformed 200 payload also fails without refreshing age or replacing data.
        clock.advanceMonotonic(500)
        transport.reply(200, " ".repeat(CalendarValidator.PAGE_BYTES + 10))
        val afterBadPayload = calendar.read(rangeArgs())
        assertEquals("error", afterBadPayload.state)
        assertEquals("BAD_PAYLOAD", afterBadPayload.errorCode)
        assertEquals(9000L, afterBadPayload.ageMs)
        assertEquals(expectedData, afterBadPayload.data)
    }

    @Test fun freshPageReceiptAgeExcludesSixtyAndOneHundredTwentySecondGoogleSyncAge() {
        val (_, calendar) = pairedSetup()
        for (upstreamAge in listOf(60_000L, 120_000L)) {
            clock.advanceMonotonic(7000)
            val page = calendarPageFixture().also {
                it.addProperty("lastSuccessAtEpochMs", it["serverNowEpochMs"].asLong - upstreamAge)
            }
            transport.reply(200, page.toString())
            val received = calendar.read(rangeArgs())
            assertEquals("connected", received.state)
            assertEquals(0L, received.ageMs)
            assertFalse(received.stale)
            assertEquals(page, received.data)

            // Repeated failed reads must age this exact server-time sample, not Google sync.
            transport.failWith("USB_UNAVAILABLE")
            clock.shiftWall(-120_000)
            clock.advanceMonotonic(1500)
            val cached = calendar.read(rangeArgs())
            assertEquals(1500L, cached.ageMs)
            assertEquals(page, cached.data)
            assertFalse(cached.stale)
            clock.advanceMonotonic(5000)
            val older = calendar.read(rangeArgs())
            assertEquals(6500L, older.ageMs)
            assertEquals(page, older.data)
            assertTrue(older.stale)
        }
    }

    @Test fun freshSourcesReceiptAgeExcludesOlderGoogleSyncAndSurvivesCachedFailures() {
        val (_, calendar) = pairedSetup()
        for (upstreamAge in listOf(60_000L, 120_000L)) {
            clock.advanceMonotonic(7000)
            val page = calendarSourcesFixture().also { page ->
                page.getAsJsonArray("sources").forEach {
                    it.asJsonObject.addProperty("lastSuccessAtEpochMs", page["serverNowEpochMs"].asLong - upstreamAge)
                }
            }
            transport.reply(200, page.toString())
            val received = calendar.sources()
            assertEquals("connected", received.state)
            assertEquals(0L, received.ageMs)
            assertFalse(received.stale)
            assertEquals(page, received.data)

            clock.advanceMonotonic(2000)
            transport.failWith("USB_UNAVAILABLE")
            val failed = calendar.sources()
            assertEquals(2000L, failed.ageMs)
            assertEquals(page, failed.data)
            assertEquals("USB_UNAVAILABLE", failed.errorCode)
            assertFalse(failed.stale)
            clock.advanceMonotonic(4500)
            transport.reply(200, "{}")
            val invalid = calendar.sources()
            assertEquals(6500L, invalid.ageMs)
            assertEquals(page, invalid.data)
            assertEquals("BAD_PAYLOAD", invalid.errorCode)
            assertTrue(invalid.stale)

            calendar.pause()
            clock.advanceMonotonic(1000)
            val paused = calendar.sources()
            assertEquals(7500L, paused.ageMs)
            assertEquals(page, paused.data)
            calendar.resume()
        }
    }

    @Test fun validatedPartialAndErrorPagesStartNewReceiptBaselineWithoutChangingGoogleSyncTime() {
        val (_, calendar) = pairedSetup()
        val page = calendarPageFixture()
        transport.reply(200, page.toString())
        assertEquals(0L, calendar.read(rangeArgs()).ageMs)
        for (state in listOf("partial", "error")) {
            clock.advanceMonotonic(120_000)
            page.addProperty("serverNowEpochMs", page["serverNowEpochMs"].asLong + 120_000)
            page.addProperty("state", state)
            page.addProperty("errorCode", "CALENDAR_UNAVAILABLE")
            page.addProperty("failedSourceCount", 1)
            transport.reply(200, page.toString())
            val fresh = calendar.read(rangeArgs())
            assertEquals(0L, fresh.ageMs)
            assertFalse(fresh.stale)
            assertEquals("connected", fresh.state)
            assertEquals(page, fresh.data)

            clock.advanceMonotonic(2000)
            transport.failWith("USB_UNAVAILABLE")
            val failed = calendar.read(rangeArgs())
            assertEquals(2000L, failed.ageMs)
            assertEquals(page, failed.data)
        }
    }

    @Test fun validatedPartialAndErrorSourcesStartNewReceiptBaselineWithoutChangingGoogleSyncTime() {
        val (_, calendar) = pairedSetup()
        val page = calendarSourcesFixture()
        transport.reply(200, page.toString())
        assertEquals(0L, calendar.sources().ageMs)
        for (state in listOf("partial", "error")) {
            clock.advanceMonotonic(120_000)
            page.addProperty("serverNowEpochMs", page["serverNowEpochMs"].asLong + 120_000)
            page.addProperty("state", state)
            page.addProperty("errorCode", "CALENDAR_UNAVAILABLE")
            transport.reply(200, page.toString())
            val fresh = calendar.sources()
            assertEquals(0L, fresh.ageMs)
            assertFalse(fresh.stale)
            assertEquals("connected", fresh.state)
            assertEquals(page, fresh.data)

            clock.advanceMonotonic(2000)
            transport.failWith("USB_UNAVAILABLE")
            val failed = calendar.sources()
            assertEquals(2000L, failed.ageMs)
            assertEquals(page, failed.data)
        }
    }

    @Test fun independentSnapshotAndCalendarCachesAndFailuresDoNotInterfere() {
        val (laptop, calendar) = pairedSetup()
        transport.respond = { req ->
            when (req.path) {
                HubPath.SNAPSHOT -> HubResponse(200, hubFixture().toByteArray())
                HubPath.CALENDAR_READ -> HubResponse(200, calendarPageFixture().toString().toByteArray())
                HubPath.CALENDAR_SOURCES -> HubResponse(200, calendarSourcesFixture().toString().toByteArray())
                else -> HubResponse(500, "err".toByteArray())
            }
        }
        assertEquals("connected", laptop.snapshot().state)
        assertEquals("connected", calendar.read(rangeArgs()).state)
        assertEquals("connected", calendar.sources(json("{}")).state)

        // Calendar fails with 503 while snapshot stays healthy.
        clock.advanceMonotonic(2000)
        transport.respond = { req ->
            when (req.path) {
                HubPath.SNAPSHOT -> HubResponse(200, hubFixture().toByteArray())
                else -> HubResponse(503, """{"v":1,"error":{"code":"CALENDAR_UNAVAILABLE"}}""".toByteArray())
            }
        }
        val snapOk = laptop.snapshot()
        val calFail = calendar.read(rangeArgs())
        assertEquals("connected", snapOk.state)
        assertNull(snapOk.errorCode)
        assertEquals("error", calFail.state)
        assertEquals("CALENDAR_UNAVAILABLE", calFail.errorCode)
        assertNotNull(calFail.data)
        assertEquals(2000L, calFail.ageMs)

        // Snapshot fails while calendar recovers.
        clock.advanceMonotonic(2000)
        transport.respond = { req ->
            when (req.path) {
                HubPath.SNAPSHOT -> throw HubTransportException("USB_UNAVAILABLE")
                HubPath.CALENDAR_READ -> HubResponse(200, calendarPageFixture().toString().toByteArray())
                else -> HubResponse(200, calendarSourcesFixture().toString().toByteArray())
            }
        }
        val snapFail = laptop.snapshot()
        val calRecovered = calendar.read(rangeArgs())
        assertEquals("disconnected", snapFail.state)
        assertEquals("USB_UNAVAILABLE", snapFail.errorCode)
        assertEquals("connected", calRecovered.state)
        assertNull(calRecovered.errorCode)
        assertEquals(0L, calRecovered.ageMs)
    }

    @Test fun selectSucceedsOnlyAfterAuthoritativeResponseAndInvalidatesCaches() {
        val (_, calendar) = pairedSetup()
        transport.reply(200, calendarPageFixture().toString())
        assertNotNull(calendar.read(rangeArgs()).data)
        transport.reply(200, calendarSourcesFixture().toString())
        assertNotNull(calendar.sources(json("{}")).data)

        // Failed selection (e.g. CALENDAR_SELECTION_CHANGED or USB_UNAVAILABLE) must NOT invalidate cache.
        transport.reply(409, """{"v":1,"error":{"code":"CALENDAR_SELECTION_CHANGED"}}""")
        val errCode = try {
            calendar.select(selectArgs())
            null
        } catch (e: BridgeFailure) {
            e.code
        }
        assertEquals("CALENDAR_SELECTION_CHANGED", errCode)

        // Verify cache is still present when a subsequent read fails.
        clock.advanceMonotonic(1000)
        transport.failWith("USB_UNAVAILABLE")
        assertNotNull("Failed select must not clear page cache", calendar.read(rangeArgs()).data)
        assertNotNull("Failed select must not clear sources cache", calendar.sources(json("{}")).data)

        // Authoritative selection success invalidates both caches.
        transport.reply(200, """{"selectionRevision":"synthetic_selection_2"}""")
        val reply = calendar.select(selectArgs())
        assertEquals("synthetic_selection_2", reply["selectionRevision"].asString)

        // Now a failed read sees an empty cache (null data and null ageMs), proving invalidation happened.
        transport.failWith("USB_UNAVAILABLE")
        val afterSelectRead = calendar.read(rangeArgs())
        assertNull(afterSelectRead.data)
        assertNull(afterSelectRead.ageMs)
        val afterSelectSources = calendar.sources(json("{}"))
        assertNull(afterSelectSources.data)
        assertNull(afterSelectSources.ageMs)
    }

    @Test fun lateReadFromBeforeSelectionCannotRepopulateInvalidatedCache() {
        val (_, calendar) = pairedSetup()
        val readEntered = CountDownLatch(1)
        val releaseRead = CountDownLatch(1)
        transport.respond = { req ->
            when (req.path) {
                HubPath.CALENDAR_READ -> {
                    readEntered.countDown()
                    releaseRead.await(5, TimeUnit.SECONDS)
                    HubResponse(200, calendarPageFixture().toString().toByteArray())
                }
                HubPath.CALENDAR_SELECT -> HubResponse(200, """{"selectionRevision":"synthetic_selection_2"}""".toByteArray())
                else -> HubResponse(500, ByteArray(0))
            }
        }
        var staleReadResult: LinkSnapshot? = null
        val reader = Thread { staleReadResult = calendar.read(rangeArgs()) }.also { it.start() }
        assertTrue(readEntered.await(2, TimeUnit.SECONDS))

        // Selection succeeds while old read is in flight.
        val selectReply = calendar.select(selectArgs())
        assertEquals("synthetic_selection_2", selectReply["selectionRevision"].asString)

        releaseRead.countDown()
        reader.join(3000)
        assertNull("Pre-selection read must not publish stale data", staleReadResult?.data)

        // Subsequent failed read confirms cache remained empty.
        transport.failWith("USB_UNAVAILABLE")
        assertNull(calendar.read(rangeArgs()).data)
    }

    @Test fun paginationSetupRequiredEmptyTitleNormalizationAndRequestRestrictionsWork() {
        val (_, calendar) = pairedSetup()

        // Empty title is normalized to "Untitled event".
        val untitledPage = calendarPageFixture().also { p ->
            p.getAsJsonArray("items")[0].asJsonObject.addProperty("title", "")
            p.getAsJsonObject("nextEvent").addProperty("title", "")
        }
        transport.reply(200, untitledPage.toString())
        val normalized = calendar.read(rangeArgs()).data!!
        assertEquals("Untitled event", normalized.getAsJsonArray("items")[0].asJsonObject["title"].asString)
        assertEquals("Untitled event", normalized.getAsJsonObject("nextEvent")["title"].asString)

        // Pagination caches cursor pages independently under the same revision.
        val page2 = calendarPageFixture().with("nextCursor", null).also { p ->
            p.getAsJsonArray("items")[0].asJsonObject.addProperty("id", "event_page_2")
        }
        transport.reply(200, page2.toString())
        val resPage2 = calendar.read(rangeArgs(",\"cursor\":\"synthetic-page.2_abc-123\""))
        assertEquals("event_page_2", resPage2.data!!.getAsJsonArray("items")[0].asJsonObject["id"].asString)

        // setup_required state clears old cached pages.
        val setupReq = calendarPageFixture().also { p ->
            p.addProperty("state", "setup_required")
            p.addProperty("selectionRevision", "synthetic_selection_setup")
            p.addProperty("sourceCount", 0)
            p.add("lastSuccessAtEpochMs", com.google.gson.JsonNull.INSTANCE)
            p.add("sources", JsonArray())
            p.add("items", JsonArray())
            p.add("nextEvent", com.google.gson.JsonNull.INSTANCE)
            p.add("nextCursor", com.google.gson.JsonNull.INSTANCE)
        }
        transport.reply(200, setupReq.toString())
        val setupLink = calendar.read(rangeArgs())
        assertEquals("setup_required", setupLink.data!!["state"].asString)
        transport.failWith("USB_UNAVAILABLE")
        assertNull("Old page 2 cursor cache was evicted on selectionRevision change", calendar.read(rangeArgs(",\"cursor\":\"synthetic-page.2_abc-123\"")).data)

        // Invalid args (e.g. refresh:true + cursor) never hit transport.
        val requestsBefore = transport.requests.size
        val badRange = calendar.read(rangeArgs(",\"refresh\":true,\"cursor\":\"c1\""))
        assertEquals("BAD_PAYLOAD", badRange.errorCode)
        assertEquals(requestsBefore, transport.requests.size)
    }

    @Test fun pauseAndCloseCancelInFlightRequestsAndBridgeRouterRoutesAllThreeOperations() {
        val (laptop, calendar) = pairedSetup()
        val session = NativeSession(onBackground = { laptop.pause(); calendar.pause() })
        val lifecycle = SessionLifecycle(session).also { it.enterForeground() }
        val services = object : UnavailableBridgeServices() {
            override fun hubSnapshot() = laptop.snapshot().toJson()
            override fun hubCalendar(args: JsonObject) = calendar.read(args).toJson()
            override fun hubCalendarSources(args: JsonObject) = calendar.sources(args).toJson()
            override fun hubCalendarSelect(args: JsonObject) = calendar.select(args)
        }
        val router = BridgeRouter(services, lifecycle)

        transport.respond = { req ->
            when (req.path) {
                HubPath.CALENDAR_READ -> HubResponse(200, calendarPageFixture().toString().toByteArray())
                HubPath.CALENDAR_SOURCES -> HubResponse(200, calendarSourcesFixture().toString().toByteArray())
                HubPath.CALENDAR_SELECT -> HubResponse(200, """{"selectionRevision":"synthetic_selection_2"}""".toByteArray())
                else -> HubResponse(200, hubFixture().toByteArray())
            }
        }
        val r1 = router.handle("""{"v":1,"id":"c1","op":"hub.calendar","args":${rangeArgs()}}""", TRUSTED_ORIGIN, true)
        assertTrue(r1.ok)
        assertEquals("available", r1.data!!.getAsJsonObject("data")["state"].asString)

        val r2 = router.handle("""{"v":1,"id":"c2","op":"hub.calendarSources","args":{}}""", TRUSTED_ORIGIN, true)
        assertTrue(r2.ok)
        assertEquals("available", r2.data!!.getAsJsonObject("data")["state"].asString)

        val r3 = router.handle("""{"v":1,"id":"c3","op":"hub.calendarSelect","args":${selectArgs()}}""", TRUSTED_ORIGIN, true)
        assertTrue(r3.ok)
        assertEquals("synthetic_selection_2", r3.data!!["selectionRevision"].asString)

        // In-flight cancellation on pause:
        transport.entered = CountDownLatch(1)
        transport.gate = CountDownLatch(1)
        var lateReply: BridgeReply? = null
        val worker = Thread {
            lateReply = router.handle("""{"v":1,"id":"c4","op":"hub.calendar","args":${rangeArgs()}}""", TRUSTED_ORIGIN, true)
        }.also { it.start() }
        assertTrue(transport.entered!!.await(2, TimeUnit.SECONDS))
        lifecycle.leaveForeground("background")
        assertEquals(1, transport.cancels.get())
        transport.gate!!.countDown()
        worker.join(3000)
        assertFalse(lateReply!!.ok)
        assertEquals("SESSION_ENDED", lateReply!!.errorCode)

        // Close clears cache and rejects further work.
        calendar.close()
        calendar.resume()
        val countBefore = transport.requests.size
        assertNull(calendar.read(rangeArgs()).data)
        assertEquals(countBefore, transport.requests.size)
    }

    @Test fun staleCalendarUnauthorizedReplyForOldTokenCannotEraseNewPairing() {
        val oldToken = "beef".repeat(16)
        val store = MemoryStore(oldToken)
        val (laptop, calendar) = pairedSetup(store)
        val readEntered = CountDownLatch(1)
        val releaseRead = CountDownLatch(1)
        transport.respond = { r ->
            if (r.path == HubPath.PAIR) {
                HubResponse(200, """{"token":"$SYNTHETIC_TOKEN"}""".toByteArray())
            } else {
                readEntered.countDown()
                releaseRead.await(5, TimeUnit.SECONDS)
                HubResponse(401, AUTH_REQUIRED_BODY.toByteArray())
            }
        }
        val worker = Thread { calendar.read(rangeArgs()) }.also { it.start() }
        assertTrue(readEntered.await(2, TimeUnit.SECONDS))
        assertTrue(laptop.pair("01234567").paired)
        releaseRead.countDown()
        worker.join(3000)

        assertEquals(SYNTHETIC_TOKEN, store.value)
        assertTrue(laptop.paired)
        assertTrue(calendar.paired)
        transport.reply(200, calendarPageFixture().toString())
        val after = calendar.read(rangeArgs())
        assertEquals("connected", after.state)
        assertEquals("Bearer $SYNTHETIC_TOKEN", transport.lastRequest.headers()["Authorization"])
    }

    @Test fun rendererRecreationRetainsCalendarCacheAndMonotonicAge() {
        val (_, calendar) = pairedSetup()
        val session = NativeSession()
        val services = object : UnavailableBridgeServices() {
            override fun hubCalendar(args: JsonObject) = calendar.read(args).toJson()
        }
        transport.reply(200, calendarPageFixture().toString())
        val firstLifecycle = SessionLifecycle(session).also { it.enterForeground() }
        val firstReply = BridgeRouter(services, firstLifecycle).handle(
            """{"v":1,"id":"r1","op":"hub.calendar","args":${rangeArgs()}}""",
            TRUSTED_ORIGIN,
            true,
        )
        assertTrue(firstReply.ok)
        assertEquals(0L, firstReply.data!!["ageMs"].asLong)

        transport.failWith("USB_UNAVAILABLE")
        clock.advanceMonotonic(4000)
        firstLifecycle.close()

        val secondLifecycle = SessionLifecycle(session).also { it.enterForeground() }
        clock.advanceMonotonic(3500)
        val secondReply = BridgeRouter(services, secondLifecycle).handle(
            """{"v":1,"id":"r2","op":"hub.calendar","args":${rangeArgs()}}""",
            TRUSTED_ORIGIN,
            true,
        )
        assertTrue(secondReply.ok)
        assertEquals(7500L, secondReply.data!!["ageMs"].asLong)
        assertTrue(secondReply.data!!["stale"].asBoolean)
        assertEquals(firstReply.data!!["data"], secondReply.data!!["data"])
    }

    @Test fun loopbackTransportExecutesReadOnlyCalendarPostWithoutQueryOrRedirects() {
        val capturedHeads = CopyOnWriteArrayList<String>()
        val capturedBodies = CopyOnWriteArrayList<String>()
        val server = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))
        val acceptor = Thread {
            while (!server.isClosed) {
                val s = try { server.accept() } catch (_: Exception) { break }
                s.use { sock ->
                    val input = sock.getInputStream()
                    val head = buildString {
                        while (!endsWith("\r\n\r\n")) {
                            val b = input.read(); if (b < 0) break; append(b.toChar())
                        }
                    }
                    val len = Regex("(?im)^content-length: *(\\d+)").find(head)?.groupValues?.get(1)?.toInt() ?: 0
                    val body = ByteArray(len).also {
                        var off = 0
                        while (off < len) {
                            val n = input.read(it, off, len - off); if (n < 0) break; off += n
                        }
                    }
                    capturedHeads.add(head)
                    capturedBodies.add(body.toString(Charsets.UTF_8))
                    val payload = calendarPageFixture().toString().toByteArray(Charsets.UTF_8)
                    val resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${payload.size}\r\nConnection: close\r\n\r\n"
                    sock.getOutputStream().write(resp.toByteArray(Charsets.ISO_8859_1) + payload)
                    sock.getOutputStream().flush()
                }
            }
        }.apply { isDaemon = true; start() }
        try {
            val realTransport = LoopbackHubTransport(clock) { url ->
                assertEquals("http://127.0.0.1:8765/v1/calendar/read", url.toString())
                URL("http", "127.0.0.1", server.localPort, url.file).openConnection(Proxy.NO_PROXY) as HttpURLConnection
            }
            val client = CalendarClient(MemoryStore(SYNTHETIC_TOKEN), realTransport, clock).also { it.resume() }
            val result = client.read(rangeArgs())
            assertEquals("connected", result.state)
            assertEquals(1, capturedHeads.size)
            assertTrue(capturedHeads[0].startsWith("POST /v1/calendar/read HTTP/1.1\r\n"))
            assertTrue(capturedHeads[0].contains("Authorization: Bearer $SYNTHETIC_TOKEN\r\n"))
            assertEquals(rangeArgs(), StrictJson.parse(capturedBodies[0]).asJsonObject)
        } finally {
            server.close()
            acceptor.join(1000)
        }
    }
}
