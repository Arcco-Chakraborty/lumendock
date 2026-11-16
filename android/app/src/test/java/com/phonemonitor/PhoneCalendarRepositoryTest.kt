package com.phonemonitor

import com.google.gson.JsonObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class PhoneCalendarRepositoryTest {
    class Clock : HubClock {
        var mono = 1000L
        var wall = Instant.parse("2026-10-28T12:00:00Z").toEpochMilli()
        override fun monotonicMs() = mono
        override fun epochMs() = wall
    }
    class Transport : PhoneCalendarTransport {
        val requests = mutableListOf<PhoneCalendarRequest>()
        var responder: (PhoneCalendarRequest) -> JsonObject = { req ->
            when (req.kind) {
                PhoneCalendarEndpoint.SOURCES -> jsonObject("items" to listOf(jsonObject("id" to "synthetic-calendar", "summary" to "Synthetic", "accessRole" to "reader", "timeZone" to "UTC")))
                PhoneCalendarEndpoint.METADATA -> jsonObject("labelProperties" to jsonObject("eventLabels" to listOf(jsonObject("id" to "synthetic-label", "name" to "Research", "color" to "#123456"))))
                PhoneCalendarEndpoint.EVENTS -> jsonObject("items" to emptyList<Any>())
            }
        }
        override fun newCall(request: PhoneCalendarRequest): PhoneCalendarCall = object : PhoneCalendarCall {
            override fun execute(): JsonObject { requests.add(request); return responder(request) }
            override fun cancel() {}
        }
    }
    private val range get() = jsonObject("startDate" to "2026-10-28", "days" to 7, "timeZone" to "UTC")
    private fun connected() = PhoneCalendarAuth().apply { accept(beginConnect(), "synthetic-token", PhoneCalendarAuth.SCOPES) }
    private fun apply(repo: PhoneCalendarRepository) {
        val page = repo.sources().data!!
        repo.select(jsonObject("sourceIds" to page.getAsJsonArray("sources").map { it.asJsonObject["sourceId"].asString }, "expectedRevision" to page["selectionRevision"].asString))
    }
    private fun event(id: String, start: String = "2026-10-28T13:00:00Z", end: String = "2026-10-28T14:00:00Z") = jsonObject("id" to id, "summary" to id, "start" to jsonObject("dateTime" to start), "end" to jsonObject("dateTime" to end), "eventLabelId" to "synthetic-label")
    @Test fun enumeratesSourcesButDoesNotReadEventsUntilHumanApplies() {
        val transport = Transport(); val repo = PhoneCalendarRepository(connected(), transport, Clock()); repo.resume()
        val initial = repo.read(range).data!!
        assertTrue(CalendarValidator.page(initial)); assertEquals("setup_required", initial["state"].asString)
        assertEquals(0, transport.requests.count { it.kind == PhoneCalendarEndpoint.EVENTS })
        apply(repo)
        assertEquals("available", repo.read(range).data!!["state"].asString)
        assertEquals(1, transport.requests.count { it.kind == PhoneCalendarEndpoint.EVENTS })
    }
    @Test fun collectsEveryPageAndComputesGlobalNextBeyondFirstFiftyRows() {
        val transport = Transport(); val base = transport.responder
        transport.responder = { req -> if(req.kind != PhoneCalendarEndpoint.EVENTS) base(req) else if(req.query["pageToken"] == null) jsonObject("items" to (1..50).map { event("synthetic-past-$it", "2026-10-28T08:00:00Z", "2026-10-28T09:00:00Z") }, "nextPageToken" to "synthetic-page2") else jsonObject("items" to listOf(event("synthetic-future"))) }
        val repo = PhoneCalendarRepository(connected(), transport, Clock()); repo.resume(); apply(repo)
        val first = repo.read(range).data!!
        assertTrue(CalendarValidator.page(first)); assertEquals(50, first.getAsJsonArray("items").size())
        assertEquals("synthetic-future", first["nextEvent"].asJsonObject["title"].asString)
        assertEquals("Research", first["nextEvent"].asJsonObject["label"].asJsonObject["name"].asString)
        val second = repo.read(range.apply { addProperty("cursor", first["nextCursor"].asString) }).data!!
        assertTrue(CalendarValidator.page(second)); assertEquals(1, second.getAsJsonArray("items").size())
        assertEquals(2, transport.requests.count { it.kind == PhoneCalendarEndpoint.EVENTS })
    }
    @Test fun disconnectDuringCompletionCannotPublishOldAccountData() {
        val auth = connected(); val transport = Transport(); val repo = PhoneCalendarRepository(auth, transport, Clock()); repo.resume(); apply(repo)
        transport.responder = { repo.disconnect(); jsonObject("items" to listOf(event("synthetic-old-account"))) }
        val result = repo.read(range)
        assertFalse(result.data?.toString()?.contains("synthetic-old-account") == true)
        assertEquals("disconnected", auth.status)
    }
    @Test fun offlineCacheAgeUsesMonotonicReceiptAndDoesNotResetOnReads() {
        val clock = Clock(); val repo = PhoneCalendarRepository(connected(), Transport(), clock); repo.resume(); apply(repo)
        repo.read(range); repo.pause(); clock.mono += 2000; clock.wall -= 600000
        assertEquals(2000L, repo.read(range).ageMs)
        clock.mono += 3000
        assertEquals(5000L, repo.read(range).ageMs)
    }
}
