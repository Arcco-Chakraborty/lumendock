package com.phonemonitor

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Synthetic values only. The token is recognisably fake but matches the hub's 64-hex contract. */
internal val SYNTHETIC_TOKEN="feed".repeat(16)

internal class TestClock(var mono:Long=0, var wall:Long=1_791_993_600_000):HubClock {
    override fun monotonicMs()=mono
    override fun epochMs()=wall
    fun advanceMonotonic(ms:Long) { mono+=ms }
    fun shiftWall(ms:Long) { wall+=ms }
}
internal class MemoryStore(var value:String?=null):PairingStore {
    var failWrites=false; var clears=0
    override fun getToken()=value
    override fun setToken(value:String) { if(failWrites) throw IOException("synthetic persist failure"); this.value=value }
    override fun clearToken() { clears++; value=null }
}
internal class FakeHubTransport:HubTransport {
    val requests=CopyOnWriteArrayList<HubRequest>()
    @Volatile var respond:(HubRequest)->HubResponse={ HubResponse(200,hubFixture().toByteArray()) }
    @Volatile var gate:CountDownLatch?=null
    @Volatile var entered:CountDownLatch?=null
    val cancels=AtomicInteger()
    val lastRequest get()=requests.last()
    fun failWith(code:String) { respond={ throw HubTransportException(code) } }
    fun succeed() { respond={ HubResponse(200,hubFixture().toByteArray()) } }
    fun reply(status:Int,body:String) { respond={ HubResponse(status,body.toByteArray()) } }
    override fun newCall(request:HubRequest):HubCall {
        requests.add(request)
        return object:HubCall {
            @Volatile var cancelled=false
            override fun execute():HubResponse {
                entered?.countDown()
                gate?.await(5,TimeUnit.SECONDS)
                if(cancelled) throw HubTransportException("SESSION_ENDED")
                return respond(request)
            }
            override fun cancel() { cancelled=true; cancels.incrementAndGet() }
        }
    }
}
internal fun hubFixture()=LaptopClientTest::class.java.getResource("/hub-ready.json")!!.readText()
internal const val AUTH_REQUIRED_BODY="""{"v":1,"error":{"code":"AUTH_REQUIRED"}}"""

class LaptopClientTest {
    private val clock=TestClock()
    private val transport=FakeHubTransport()
    private fun pairedClient(store:MemoryStore=MemoryStore(SYNTHETIC_TOKEN),onPaired:(Boolean)->Unit={})=
        LaptopClient(store,transport,clock,onPaired).also { it.resume() }
    private fun hubRequests()=transport.requests.filter{it.path==HubPath.SNAPSHOT}

    @Test fun keepsTokenOutsideJavascriptAndUrls() {
        val store=MemoryStore(); val client=LaptopClient(store,transport,clock); client.resume()
        transport.reply(200,"""{"token":"$SYNTHETIC_TOKEN"}""")
        assertTrue(client.pair("01234567").paired)
        val pairRequest=transport.lastRequest
        assertEquals(HubPath.PAIR,pairRequest.path); assertNull(pairRequest.bearer)
        assertEquals("""{"code":"01234567"}""",pairRequest.body!!.toString(Charsets.UTF_8))
        assertEquals(SYNTHETIC_TOKEN,store.value)
        transport.succeed()
        val snapshot=client.snapshot()
        assertEquals("Bearer $SYNTHETIC_TOKEN",transport.lastRequest.headers()["Authorization"])
        assertFalse(snapshot.toJson().toString().contains(SYNTHETIC_TOKEN))
        assertFalse(transport.lastRequest.path.url.contains("token"))
        assertFalse(transport.lastRequest.path.url.contains("?"))
        assertEquals("http://127.0.0.1:8765/v1/snapshot",transport.lastRequest.path.url)
        assertFalse(transport.lastRequest.toString().contains(SYNTHETIC_TOKEN))
        assertEquals("connected",snapshot.state)
    }
    @Test fun wallClockJumpDoesNotMakeOldSnapshotFresh() {
        val client=pairedClient()
        client.snapshot()
        clock.advanceMonotonic(7000)
        clock.shiftWall(-60000)
        transport.failWith("USB_UNAVAILABLE")
        val link=client.snapshot()
        assertTrue(link.stale); assertEquals(7000L,link.ageMs)
        clock.shiftWall(3_600_000)
        assertEquals(7000L,client.snapshot().ageMs)
    }
    @Test fun ageBelongsToExactPayloadThroughRepeatedFailures() {
        val client=pairedClient()
        val original=client.snapshot().data!!
        assertEquals(0L,client.snapshot().ageMs)
        transport.failWith("USB_UNAVAILABLE")
        val ages=mutableListOf<Long>()
        repeat(6) { clock.advanceMonotonic(1500); val link=client.snapshot(); assertEquals(original,link.data); ages.add(link.ageMs!!) }
        assertEquals(listOf(1500L,3000L,4500L,6000L,7500L,9000L),ages)
        assertTrue(ages.zipWithNext().all{(a,b)->b>a})
        val stale=client.snapshot()
        assertEquals("disconnected",stale.state); assertEquals("USB_UNAVAILABLE",stale.errorCode); assertTrue(stale.stale)
    }
    @Test fun sixSecondsWithoutSuccessMakesLinkStale() {
        val client=pairedClient(); client.snapshot()
        transport.failWith("REQUEST_TIMEOUT")
        clock.advanceMonotonic(5999); val before=client.snapshot()
        assertFalse(before.stale); assertEquals("disconnected",before.state)
        clock.advanceMonotonic(1); assertTrue(client.snapshot().stale)
    }
    @Test fun emptyCacheHasNullAgeAndDataAndCannotInventBaseline() {
        val unpaired=LaptopClient(MemoryStore(),transport,clock).also{it.resume()}
        val none=unpaired.snapshot()
        assertNull(none.ageMs); assertNull(none.data); assertTrue(none.stale)
        assertEquals("AUTH_REQUIRED",none.errorCode); assertEquals("error",none.state); assertTrue(transport.requests.isEmpty())
        val idle=LaptopClient(MemoryStore(SYNTHETIC_TOKEN),transport,clock)
        assertEquals("connecting",idle.snapshot().state); assertNull(idle.snapshot().ageMs)
        val failing=pairedClient(); transport.failWith("USB_UNAVAILABLE")
        clock.advanceMonotonic(30000)
        val failed=failing.snapshot()
        assertNull(failed.ageMs); assertNull(failed.data); assertTrue(failed.stale); assertEquals("USB_UNAVAILABLE",failed.errorCode)
        assertTrue(ProtocolValidator.response("hub.snapshot",failed.toJson()))
        assertTrue(ProtocolValidator.response("hub.snapshot",none.toJson()))
    }
    @Test fun failedRequestsBackOffOneTwoFourEightCappedAtFifteenSecondsAndHealthyPollsEveryTwo() {
        val client=pairedClient()
        client.snapshot(); clock.advanceMonotonic(2000); client.snapshot(); clock.advanceMonotonic(2000); client.snapshot()
        assertEquals(3,hubRequests().size)
        clock.advanceMonotonic(500); client.snapshot()
        assertEquals("No more than one request per second while healthy",3,hubRequests().size)
        clock.advanceMonotonic(1500); transport.failWith("USB_UNAVAILABLE"); client.snapshot()
        assertEquals(4,hubRequests().size)
        for(delay in listOf(1000L,2000L,4000L,8000L,15000L,15000L,15000L)) {
            val count=hubRequests().size
            clock.advanceMonotonic(delay-1); client.snapshot(); assertEquals("before $delay",count,hubRequests().size)
            clock.advanceMonotonic(1); client.snapshot(); assertEquals("at $delay",count+1,hubRequests().size)
        }
        transport.succeed(); clock.advanceMonotonic(15000); assertEquals("connected",client.snapshot().state)
        transport.failWith("USB_UNAVAILABLE"); clock.advanceMonotonic(2000); client.snapshot()
        val count=hubRequests().size; clock.advanceMonotonic(1000); client.snapshot()
        assertEquals("Backoff restarts at one second after a success",count+1,hubRequests().size)
    }
    @Test fun wrongTokenYieldsAuthRequiredWithoutEndlessRetry() {
        var paired:Boolean?=null
        val store=MemoryStore(SYNTHETIC_TOKEN); val client=pairedClient(store){paired=it}
        val data=client.snapshot().data
        transport.reply(401,AUTH_REQUIRED_BODY); clock.advanceMonotonic(2000)
        val rejected=client.snapshot()
        assertEquals("AUTH_REQUIRED",rejected.errorCode); assertEquals("error",rejected.state)
        assertTrue(rejected.stale); assertEquals(data,rejected.data); assertEquals(2000L,rejected.ageMs)
        assertNull(store.value); assertFalse(client.paired); assertEquals(false,paired)
        repeat(60) { clock.advanceMonotonic(1000); client.snapshot() }
        assertEquals(2,hubRequests().size)
        client.pause(); client.resume(); client.snapshot()
        assertEquals("Re-pair only on explicit setup",2,hubRequests().size)
    }
    @Test fun unexpected401BodyOrTransientHubRestartNeverErasesValidToken() {
        val store=MemoryStore(SYNTHETIC_TOKEN); val client=pairedClient(store)
        client.snapshot()
        for(failure in listOf<()->Unit>({transport.reply(401,"""{"error":"other service"}""")},{transport.failWith("USB_UNAVAILABLE")},
                {transport.failWith("REQUEST_TIMEOUT")},{transport.reply(503,"""{"v":1,"error":{"code":"BAD_PAYLOAD"}}""")},{transport.reply(403,"""{"v":1,"error":{"code":"BAD_PAYLOAD"}}""")})) {
            failure(); clock.advanceMonotonic(15000); assertNotEquals("connected",client.snapshot().state)
            assertEquals(SYNTHETIC_TOKEN,store.value); assertTrue(client.paired)
        }
        assertEquals(0,store.clears)
        transport.succeed(); clock.advanceMonotonic(15000)
        assertEquals("connected",client.snapshot().state)
        assertEquals("Bearer $SYNTHETIC_TOKEN",transport.lastRequest.headers()["Authorization"])
        assertEquals("Hub restart reconnects without re-pairing",0,transport.requests.count{it.path==HubPath.PAIR})
    }
    @Test fun malformedOversizedAndTruncatedResponsesNeverReplaceGoodCache() {
        val wrongVersion=hubFixture().replaceFirst("\"v\": 1","\"v\": 2")
        val unknownField=hubFixture().replaceFirst("{","{\"extra\":true,")
        val bodies=listOf("{}".toByteArray(),"".toByteArray(),hubFixture().take(200).toByteArray(),
            " ".repeat(HUB_REPLY_BYTES+1).toByteArray(),byteArrayOf(0xc3.toByte(),0x28),"""{"v":1,"v":1}""".toByteArray(),
            wrongVersion.toByteArray(),unknownField.toByteArray(),"[]".toByteArray(),(hubFixture()+"x").toByteArray())
        for(body in bodies) {
            val client=LaptopClient(MemoryStore(SYNTHETIC_TOKEN),FakeHubTransport().also{t->
                var first=true; t.respond={ if(first) { first=false; HubResponse(200,hubFixture().toByteArray()) } else HubResponse(200,body) } },clock).also{it.resume()}
            val original=client.snapshot().data
            clock.advanceMonotonic(2000)
            val result=client.snapshot()
            assertEquals(original,result.data); assertEquals("BAD_PAYLOAD",result.errorCode); assertEquals("error",result.state)
            assertEquals(2000L,result.ageMs)
        }
    }
    @Test fun echoedTokenInPayloadOrExceptionNeverReachesBridgeReply() {
        val store=MemoryStore(SYNTHETIC_TOKEN); val client=pairedClient(store)
        val escaped=SYNTHETIC_TOKEN.map{"\\u%04x".format(it.code)}.joinToString("")
        for(echo in listOf(SYNTHETIC_TOKEN,escaped,SYNTHETIC_TOKEN.uppercase())) {
            transport.reply(200,hubFixture().replace("Synthetic body",echo)); clock.advanceMonotonic(15000)
            val link=client.snapshot()
            assertEquals("BAD_PAYLOAD",link.errorCode)
            assertFalse(link.toJson().toString().lowercase().contains(SYNTHETIC_TOKEN))
        }
        transport.respond={ throw IOException("connect failed Authorization: Bearer $SYNTHETIC_TOKEN") }
        clock.advanceMonotonic(15000)
        val session=NativeSession(); val lifecycle=SessionLifecycle(session).also{it.enterForeground()}
        val services=object:UnavailableBridgeServices(){ override fun hubSnapshot()=client.snapshot().toJson() }
        val reply=BridgeRouter(services,lifecycle).handle("""{"v":1,"id":"h","op":"hub.snapshot","args":{}}""",TRUSTED_ORIGIN,true)
        assertTrue(reply.ok); assertEquals("USB_UNAVAILABLE",reply.data!!["errorCode"].asString)
        val bytes=reply.toJson().toByteArray(Charsets.UTF_8)
        assertFalse(String(bytes,Charsets.UTF_8).lowercase().contains(SYNTHETIC_TOKEN))
        assertFalse(session.status().toString().contains(SYNTHETIC_TOKEN))
        assertEquals(SYNTHETIC_TOKEN,store.value)
    }
    @Test fun concurrentSnapshotCallsCoalesceToOneInFlightRequest() {
        val client=pairedClient()
        transport.gate=CountDownLatch(1); transport.entered=CountDownLatch(1)
        val results=CopyOnWriteArrayList<LinkSnapshot>()
        val first=Thread{ results.add(client.snapshot()) }; first.start()
        assertTrue(transport.entered!!.await(2,TimeUnit.SECONDS))
        val joiners=(1..3).map{ Thread{ results.add(client.snapshot()) }.also{it.start()} }
        Thread.sleep(100)
        assertEquals(1,hubRequests().size)
        transport.gate!!.countDown(); first.join(3000); joiners.forEach{it.join(3000)}
        assertEquals(4,results.size); assertTrue(results.all{it.state=="connected" && it.data!=null})
        assertEquals(1,hubRequests().size)
    }
    @Test fun pauseCancelsInFlightRequestDiscardsLateResponseAndCloseStopsWork() {
        val client=LaptopClient(MemoryStore(SYNTHETIC_TOKEN),transport,clock)
        client.snapshot(); assertTrue("Hidden/stopped: no polling",transport.requests.isEmpty())
        client.resume(); transport.gate=CountDownLatch(1); transport.entered=CountDownLatch(1)
        var late:LinkSnapshot?=null
        val worker=Thread{ late=client.snapshot() }; worker.start()
        assertTrue(transport.entered!!.await(2,TimeUnit.SECONDS))
        client.pause()
        assertEquals(1,transport.cancels.get())
        transport.gate!!.countDown(); worker.join(3000)
        assertNull("A cancelled response is never cached",late!!.data)
        assertNull(client.snapshot().data)
        client.resume(); client.snapshot(); assertEquals(2,hubRequests().size)
        client.close(); client.resume(); clock.advanceMonotonic(60000); client.snapshot()
        assertEquals(2,hubRequests().size)
    }
    @Test fun rendererTeardownInterruptIsNotALinkFailure() {
        val client=pairedClient(); client.snapshot()
        transport.failWith("SESSION_ENDED"); clock.advanceMonotonic(2000)
        val link=client.snapshot()
        assertEquals("connected",link.state); assertNull(link.errorCode); assertEquals(2000L,link.ageMs)
        transport.succeed(); clock.advanceMonotonic(1000); client.snapshot()
        assertEquals("No backoff is imposed by a cancelled renderer request",3,hubRequests().size)
    }
    @Test fun pairingResultsAreSanitizedAndOnlyValidTokensPersist() {
        val store=MemoryStore(); val client=LaptopClient(store,transport,clock); client.resume()
        assertEquals("BAD_PAIRING_CODE",client.pair("1234567").errorCode)
        assertEquals("BAD_PAIRING_CODE",client.pair("0123456a").errorCode)
        assertEquals("BAD_PAIRING_CODE",client.pair("０１２３４５６７").errorCode)
        assertTrue("Malformed codes never consume a hub attempt",transport.requests.isEmpty())
        val cases=listOf(
            Triple(403,"""{"v":1,"error":{"code":"PAIRING_EXPIRED"}}""","PAIRING_EXPIRED"),
            Triple(403,"""{"v":1,"error":{"code":"PAIRING_CLOSED"}}""","PAIRING_CLOSED"),
            Triple(400,"""{"v":1,"error":{"code":"BAD_PAYLOAD"}}""","BAD_PAIRING_CODE"),
            Triple(503,"""{"v":1,"error":{"code":"TOKEN_PERSIST_FAILED"}}""","TOKEN_PERSIST_FAILED"),
            Triple(415,"""{"v":1,"error":{"code":"BAD_PAYLOAD"}}""","BAD_PAYLOAD"),
            Triple(200,"""{"token":"$SYNTHETIC_TOKEN","extra":true}""","BAD_PAYLOAD"),
            Triple(200,"""{"token":"${SYNTHETIC_TOKEN.uppercase()}"}""","BAD_PAYLOAD"),
            Triple(200,"""{"token":"short"}""","BAD_PAYLOAD"),
            Triple(500,"oops","HUB_UNAVAILABLE"))
        for((status,body,code) in cases) {
            transport.reply(status,body); val result=client.pair("01234567")
            assertFalse(result.paired); assertEquals(body,code,result.errorCode); assertNull(store.value)
        }
        transport.failWith("USB_UNAVAILABLE"); assertEquals("USB_UNAVAILABLE",client.pair("01234567").errorCode)
        transport.reply(200,"""{"token":"$SYNTHETIC_TOKEN"}"""); store.failWrites=true
        val failed=client.pair("01234567")
        assertEquals("TOKEN_PERSIST_FAILED",failed.errorCode); assertNull(store.value); assertFalse(client.paired)
        assertFalse(failed.toString().contains(SYNTHETIC_TOKEN))
        store.failWrites=false
        val ok=client.pair("01234567"); assertTrue(ok.paired); assertFalse(ok.toString().contains(SYNTHETIC_TOKEN))
    }
    @Test fun staleUnauthorizedReplyForOldTokenCannotEraseNewPairing() {
        val oldToken="beef".repeat(16)
        val store=MemoryStore(oldToken); val client=pairedClient(store)
        val snapshotEntered=CountDownLatch(1); val releaseSnapshot=CountDownLatch(1)
        transport.respond={ r -> if(r.path==HubPath.PAIR) HubResponse(200,"""{"token":"$SYNTHETIC_TOKEN"}""".toByteArray())
            else { snapshotEntered.countDown(); releaseSnapshot.await(5,TimeUnit.SECONDS); HubResponse(401,AUTH_REQUIRED_BODY.toByteArray()) } }
        val worker=Thread{ client.snapshot() }; worker.start()
        assertTrue(snapshotEntered.await(2,TimeUnit.SECONDS))
        assertTrue("Pairing is not blocked by an in-flight snapshot",client.pair("01234567").paired)
        releaseSnapshot.countDown(); worker.join(3000)
        assertEquals("Bearer $oldToken",hubRequests().first().headers()["Authorization"])
        assertEquals(SYNTHETIC_TOKEN,store.value); assertTrue(client.paired)
        transport.succeed(); assertEquals("connected",client.snapshot().state)
        assertEquals("Bearer $SYNTHETIC_TOKEN",transport.lastRequest.headers()["Authorization"])
    }
    @Test fun backgroundReleasesPairingConnectionAndAPairingAttemptWhileStoppedIsRejected() {
        val store=MemoryStore(); val client=LaptopClient(store,transport,clock); client.resume()
        transport.reply(200,"""{"token":"$SYNTHETIC_TOKEN"}""")
        transport.gate=CountDownLatch(1); transport.entered=CountDownLatch(1)
        var result:PairResult?=null
        val worker=Thread{ result=client.pair("01234567") }; worker.start()
        assertTrue(transport.entered!!.await(2,TimeUnit.SECONDS))
        client.pause()
        assertEquals("Background releases the in-flight pairing connection",1,transport.cancels.get())
        transport.gate!!.countDown(); worker.join(3000)
        assertNull("A cancelled exchange never yields a token",store.value)
        assertEquals("SESSION_ENDED",result!!.errorCode)
        assertEquals("SESSION_ENDED",client.pair("01234567").errorCode)
    }
    @Test fun pairingResponseAlreadyReceivedIsPersistedEvenWhenBackgroundRacesIt() {
        val store=MemoryStore(); val client=LaptopClient(store,transport,clock); client.resume()
        val inside=CountDownLatch(1); val release=CountDownLatch(1)
        transport.respond={ inside.countDown(); release.await(5,TimeUnit.SECONDS); HubResponse(200,"""{"token":"$SYNTHETIC_TOKEN"}""".toByteArray()) }
        var result:PairResult?=null
        val worker=Thread{ result=client.pair("01234567") }; worker.start()
        assertTrue(inside.await(2,TimeUnit.SECONDS))
        client.pause(); release.countDown(); worker.join(3000)
        assertTrue("The hub has already rotated to this token; discarding it would orphan pairing",result!!.paired)
        assertEquals(SYNTHETIC_TOKEN,store.value); assertTrue(client.paired)
    }
    @Test fun rendererRecreationRetainsCacheAgeBecauseCacheIsActivityOwned() {
        val client=pairedClient()
        val session=NativeSession()
        val services=object:UnavailableBridgeServices(){ override fun hubSnapshot()=client.snapshot().toJson() }
        val first=SessionLifecycle(session).also{it.enterForeground()}
        val firstReply=BridgeRouter(services,first).handle("""{"v":1,"id":"a","op":"hub.snapshot","args":{}}""",TRUSTED_ORIGIN,true)
        assertTrue(firstReply.ok); assertEquals(0L,firstReply.data!!["ageMs"].asLong)
        transport.failWith("USB_UNAVAILABLE"); clock.advanceMonotonic(4000)
        first.close()
        val replacement=SessionLifecycle(session).also{it.enterForeground()}
        clock.advanceMonotonic(4000)
        val reply=BridgeRouter(services,replacement).handle("""{"v":1,"id":"a","op":"hub.snapshot","args":{}}""",TRUSTED_ORIGIN,true)
        assertTrue(reply.ok)
        assertEquals(8000L,reply.data!!["ageMs"].asLong); assertTrue(reply.data!!["stale"].asBoolean)
        assertEquals(firstReply.data!!["data"],reply.data!!["data"])
    }
}
