package com.phonemonitor

import com.google.gson.JsonObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** A selected-network stand-in: it records what was opened through it and has no sockets. */
internal class FakeEspNetwork(override val id:String):EspNetwork {
    val opened=CopyOnWriteArrayList<String>()
    override fun openConnection(url:URL):HttpURLConnection { opened.add(url.toString()); throw IOException("synthetic: no sockets in JVM tests") }
}
/** Synthetic firmware body using the real field names from the read-only controller sketch. */
internal fun firmwareState(power:Int=1,r:Int=0x12,g:Int=0xAB,b:Int=0xEF,bright:Any=75,mode:Int=0,speed:Int=50,timer:Any=0,ok:Int=1,t:String="24.5",h:String="55.0",up:Any=1234)=
    """{"power":$power,"r":$r,"g":$g,"b":$b,"bright":$bright,"mode":$mode,"speed":$speed,"timer":$timer,"saved":1,"ok":$ok,"t":$t,"h":$h,"hi":24.1,"tmin":20.0,"tmax":26.0,"hmin":40.0,"hmax":60.0,"up":$up,"cl":1,"favs":["","ff0000","","","",""]}"""
internal const val FIRMWARE_HISTORY="""{"iv":30,"t":[24.5,null,25.0],"h":[55,null,56]}"""

internal class FakeEspTransport:EspTransport {
    class Call(val networkId:String,val request:EspRequest)
    val calls=CopyOnWriteArrayList<Call>()
    @Volatile var respond:(EspRequest)->EspResponse={ r -> EspResponse(200,(if(r.path==EspPath.HISTORY) FIRMWARE_HISTORY else firmwareState()).toByteArray()) }
    @Volatile var gate:CountDownLatch?=null
    @Volatile var gatePath:EspPath?=null
    @Volatile var entered:CountDownLatch?=null
    /** Models a reply that was already complete when cancellation arrived. */
    @Volatile var ignoreCancel=false
    val cancels=AtomicInteger()
    private val active=AtomicInteger()
    @Volatile var maxConcurrent=0
    fun paths()=calls.map{ it.request.path }
    override fun newCall(network:EspNetwork,request:EspRequest):EspCall = object:EspCall {
        @Volatile var cancelled=false
        override fun execute():EspResponse {
            calls.add(Call(network.id,request))
            val now=active.incrementAndGet(); synchronized(this@FakeEspTransport) { if(now>maxConcurrent) maxConcurrent=now }
            try {
                // The reply is produced first, so a gated call models one already completed when cancellation arrives.
                val reply=runCatching{ respond(request) }
                if(gatePath==null || gatePath==request.path) { entered?.countDown(); gate?.await(5,TimeUnit.SECONDS) }
                if(cancelled && !ignoreCancel) throw EspTransportException("SESSION_ENDED")
                return reply.getOrThrow()
            } finally { active.decrementAndGet() }
        }
        override fun cancel() { cancelled=true; cancels.incrementAndGet() }
    }
}

class EspClientTest {
    private val clock=TestClock()
    private val scheduler=ManualScheduler(clock)
    private val transport=FakeEspTransport()
    private val wifi=FakeEspNetwork("wifi-1")
    private fun client(io:(Runnable)->Unit={ it.run() })=EspClient(transport,clock,scheduler,io).also{ it.resume(); it.onNetworkChanged(NetworkLease(wifi,1)) }
    private fun fixture(name:String)=StrictJson.parse(javaClass.getResource("/$name.json")!!.readText()).asJsonObject
    private fun body(text:String):(EspRequest)->EspResponse = { EspResponse(200,text.toByteArray()) }
    private fun req(op:String,args:String="{}",id:String="e")="""{"v":1,"id":"$id","op":"$op","args":$args}"""
    private fun services(esp:EspClient)=object:UnavailableBridgeServices() {
        override fun espState()=esp.state().toJson()
        override fun espHistory()=esp.history().toJson()
        override fun setLight(patch:JsonObject,generation:Long)=esp.set(LightPatch.fromJson(patch),generation,waitMs=0).toJson()
    }

    @Test fun controllerFactoryReceivesSelectedWifiWhileLaptopStaysUnbound() {
        val selected=FakeEspNetwork("wifi-selected")
        val esp=EspClient(NetworkEspTransport(clock),clock,scheduler,{ it.run() }).also{ it.resume(); it.onNetworkChanged(NetworkLease(selected,7)) }
        val link=esp.state().link
        assertEquals(listOf("http://192.168.4.1/api/state"),selected.opened)
        assertEquals("WIFI_UNAVAILABLE",link.errorCode)
        val hubUrls=CopyOnWriteArrayList<String>()
        val laptop=LaptopClient(MemoryStore(SYNTHETIC_TOKEN),LoopbackHubTransport(clock){ url -> hubUrls.add(url.toString()); throw IOException("synthetic") },clock).also{ it.resume() }
        laptop.snapshot()
        assertEquals(listOf("http://127.0.0.1:8765/v1/snapshot"),hubUrls)
        assertEquals("Laptop traffic never goes through the selected Wi-Fi network",1,selected.opened.size)
        esp.history(); esp.set(LightPatch(power=true),1,waitMs=0); scheduler.advance(200)
        assertTrue(selected.opened.toString(),selected.opened.size>=3 && selected.opened.all{ it.startsWith("http://192.168.4.1/api/") })
        assertTrue(selected.opened.contains("http://192.168.4.1/api/set?power=1"))
        assertTrue("Hub URLs never include the controller",hubUrls.none{ it.contains("192.168.4.1") })
    }
    @Test fun mainSourcesNeverBindTheProcessAndEveryConnectionBypassesProxies() {
        val sources=File("src/main/java").walk().filter{ it.isFile && it.extension=="kt" }.toList()
        assertTrue(sources.size>5)
        for(f in sources) {
            val text=f.readText()
            for(forbidden in listOf("bindProcessToNetwork","setProcessDefaultNetwork","setDefaultProxy","Log.","println(")) assertFalse("${f.name}: $forbidden",text.contains(forbidden))
            // The one seam call (EspNetwork) is allowed; its production implementation is itself checked by this rule.
            Regex("\\.openConnection\\(([^)]*)\\)").findAll(text).filterNot{ it.value==".openConnection(URL(request.url)" && text.contains("network.openConnection(URL(request.url))") }
                .forEach { assertTrue("${f.name}: ${it.value}",it.groupValues[1].contains("Proxy.NO_PROXY")) }
        }
        assertTrue(File("src/main/java/com/phonemonitor/WifiSession.kt").readText().contains("network.openConnection(url,Proxy.NO_PROXY)"))
    }
    @Test fun controllerRequestsCarryNoAuthorizationAndNoGenericUrl() {
        for(r in listOf(EspRequest.state(),EspRequest.history(),EspRequest.set(LightPatch(bright=5)))) {
            assertFalse(r.headers().keys.any{ it.equals("Authorization",true) || it.equals("Cookie",true) })
            assertTrue(r.url.startsWith("http://192.168.4.1/api/"))
            assertFalse(r.toString().contains("?"))
        }
        assertEquals("power=1&hex=12ABEF&bright=5&mode=8&speed=100",LightPatch(power=true,hex="#12abef",bright=5,mode=8,speed=100).toQuery())
        assertEquals("power=0",LightPatch(power=false).toQuery())
        assertEquals("timer=0",LightPatch(timerMinutes=0).toQuery())
        assertEquals("http://192.168.4.1/api/set?timer=720",EspRequest.set(LightPatch(timerMinutes=720)).url)
        for(bad in listOf("""{"bright":5,"url":"http://example.invalid"}""","""{"path":"/api/fav"}""","""{"power":"t"}""","""{"bright":5.5}""","{}")) {
            try { LightPatch.fromJson(StrictJson.parse(bad).asJsonObject); fail(bad) } catch(e:BridgeFailure) { assertEquals("BAD_PAYLOAD",e.code) }
        }
        assertEquals(LightPatch(hex="#12abef"),LightPatch.fromJson(StrictJson.parse("""{"hex":"#12abef"}""").asJsonObject))
    }
    @Test fun parsesReadyStateAndConvertsFirmwareEncodings() {
        val snapshot=client().state()
        assertEquals("connected",snapshot.link.state); assertFalse(snapshot.link.stale); assertEquals(0L,snapshot.link.ageMs)
        assertEquals(fixture("esp-ready"),snapshot.link.data)
        assertTrue(ProtocolValidator.response("esp.state",snapshot.toJson()))
        assertEquals(fixture("esp-link-ready"),snapshot.toJson())
        val off=EspParser.state(firmwareState(power=0,r=10,g=0,b=255).toByteArray())
        assertFalse(off.power); assertEquals("#0A00FF",off.hex)
        assertEquals("Firmware's 720-minute reply rounds up one second; clamped to the protocol range",43200,EspParser.state(firmwareState(timer=43201).toByteArray()).timerSeconds)
        assertEquals("A just-expired timer reads as zero",0,EspParser.state(firmwareState(timer=-1).toByteArray()).timerSeconds)
    }
    @Test fun sensorFailureAndNullClimateStaySeparateFromControllerReachability() {
        transport.respond=body(firmwareState(ok=0,t="null",h="null"))
        val snapshot=client().state()
        assertEquals("connected",snapshot.link.state); assertNull(snapshot.link.errorCode)
        val data=snapshot.link.data!!
        assertFalse(data["sensorOk"].asBoolean); assertTrue(data["temperatureC"].isJsonNull); assertTrue(data["humidityPercent"].isJsonNull)
        val retained=EspParser.state(firmwareState(ok=0,t="23.0",h="40.0").toByteArray())
        assertFalse(retained.sensorOk); assertEquals(23.0,retained.temperatureC!!,0.0)
        assertNull("Out-of-range humidity is a sensor glitch, not a controller failure",EspParser.state(firmwareState(h="101.0").toByteArray()).humidityPercent)
    }
    @Test fun malformedStateNeverReplacesTheGoodCache() {
        val good=firmwareState()
        val bodies=listOf(good.replace("\"bright\":75,",""),firmwareState(bright="\"75\""),firmwareState(bright=75.5),firmwareState(power=2),good.replace("\"power\":1","\"power\":true"),
            firmwareState(r=256),firmwareState(g=-1),firmwareState(mode=9),firmwareState(speed=0),firmwareState(bright=0),firmwareState(t="\"x\""),firmwareState(h="\"55\""),
            firmwareState(up=-1),firmwareState(up=1.5),firmwareState(ok=2),firmwareState(timer="\"5\""),firmwareState(t="1e999"),good.replaceFirst("{","{\"extra\":1,"),
            good.replaceFirst("{","{\"power\":1,"),"$good x","[]","","null",good.replace("\"up\":1234,",""),
            "{\"power\":1}"," ".repeat(ESP_REPLY_BYTES+1))
        for(text in bodies) {
            val t=FakeEspTransport(); var first=true
            t.respond={ if(first) { first=false; EspResponse(200,good.toByteArray()) } else EspResponse(200,text.toByteArray()) }
            val esp=EspClient(t,clock,scheduler,{ it.run() }).also{ it.resume(); it.onNetworkChanged(NetworkLease(wifi,1)) }
            val original=esp.state().link.data
            clock.advanceMonotonic(3000)
            val result=esp.state().link
            assertEquals(text.take(60),"BAD_PAYLOAD",result.errorCode); assertEquals("error",result.state)
            assertEquals(original,result.data); assertEquals(3000L,result.ageMs)
        }
        val invalidUtf8=FakeEspTransport().also{ it.respond={ EspResponse(200,byteArrayOf(0x7b,0xc3.toByte(),0x28,0x7d)) } }
        assertEquals("BAD_PAYLOAD",EspClient(invalidUtf8,clock,scheduler,{ it.run() }).also{ it.resume(); it.onNetworkChanged(NetworkLease(wifi,1)) }.state().link.errorCode)
    }
    @Test fun historyIsValidatedAndOffsetsAreRelativeToTheNewestSample() {
        val history=client().history()
        assertEquals("connected",history.state); assertEquals(fixture("esp-history"),history.data)
        assertTrue(ProtocolValidator.response("esp.history",history.toJson()))
        assertEquals(listOf(-60.0,-30.0,0.0),EspParser.history(FIRMWARE_HISTORY.toByteArray()).sampleOffsetsSeconds())
        val full="""{"iv":30,"t":[${List(120){"20.0"}.joinToString(",")}],"h":[${List(120){"50"}.joinToString(",")}]}"""
        assertEquals(120,EspParser.history(full.toByteArray()).temperatureC.size)
        assertNull(EspParser.history("""{"iv":30,"t":[20.0],"h":[101]}""".toByteArray()).humidityPercent.single())
        val bad=listOf("""{"iv":30,"t":[1.0,2.0],"h":[50]}""","""{"iv":30,"t":[${List(121){"20.0"}.joinToString(",")}],"h":[${List(121){"50"}.joinToString(",")}]}""",
            """{"iv":0,"t":[],"h":[]}""","""{"iv":-30,"t":[],"h":[]}""","""{"iv":"30","t":[],"h":[]}""","""{"iv":30,"t":["x"],"h":[1]}""","""{"iv":30,"t":[]}""",
            """{"iv":30,"t":[],"h":[],"x":1}""","""{"iv":30,"t":{},"h":[]}""","""{"iv":30,"t":[true],"h":[1]}""")
        for(text in bad) try { EspParser.history(text.toByteArray()); fail(text) } catch(e:EspTransportException) { assertEquals("BAD_PAYLOAD",e.code) }
    }
    @Test fun rebootedUptimeIsAcceptedAndDiscardsHistoryFromThePreviousBoot() {
        var up=5000
        transport.respond={ r -> EspResponse(200,(if(r.path==EspPath.HISTORY) FIRMWARE_HISTORY else firmwareState(up=up)).toByteArray()) }
        val esp=client()
        esp.state(); assertNotNull(esp.history().data)
        up=3; clock.advanceMonotonic(3000)
        val rebooted=esp.state().link
        assertEquals("connected",rebooted.state); assertEquals(3L,rebooted.data!!["uptimeSeconds"].asLong)
        val before=transport.paths().count{ it==EspPath.HISTORY }
        transport.respond={ r -> if(r.path==EspPath.HISTORY) throw EspTransportException("REQUEST_TIMEOUT") else EspResponse(200,firmwareState(up=up).toByteArray()) }
        val history=esp.history()
        assertEquals("History refetches at once after a reboot",before+1,transport.paths().count{ it==EspPath.HISTORY })
        assertNull("Samples from the previous boot are not presented as current",history.data)
    }
    @Test fun ageBelongsToTheExactPayloadAndNineSecondsMakesItStale() {
        val esp=client()
        val original=esp.state().link.data
        transport.respond={ throw EspTransportException("REQUEST_TIMEOUT") }
        val ages=mutableListOf<Long>()
        repeat(6) { clock.advanceMonotonic(1500); val link=esp.state().link; assertEquals(original,link.data); ages.add(link.ageMs!!) }
        assertEquals(listOf(1500L,3000L,4500L,6000L,7500L,9000L),ages)
        assertTrue(esp.state().link.stale)
        clock.shiftWall(-3_600_000); assertEquals(9000L,esp.state().link.ageMs)
        transport.respond=body(firmwareState())
        val fresh=client(); fresh.state(); transport.respond={ throw EspTransportException("WIFI_UNAVAILABLE") }
        clock.advanceMonotonic(8999); assertFalse(fresh.state().link.stale); clock.advanceMonotonic(1); assertTrue(fresh.state().link.stale)
        val empty=EspClient(transport,clock,scheduler,{ it.run() }).also{ it.resume() }.state()
        assertNull(empty.link.ageMs); assertNull(empty.link.data); assertTrue(empty.link.stale); assertEquals("WIFI_UNAVAILABLE",empty.link.errorCode)
        assertTrue(ProtocolValidator.response("esp.state",empty.toJson()))
    }
    @Test fun failedReadsBackOffAndHealthyPollsAreSpaced() {
        val esp=client(); esp.state()
        clock.advanceMonotonic(500); esp.state(); assertEquals(1,transport.calls.size)
        clock.advanceMonotonic(2500); transport.respond={ throw EspTransportException("REQUEST_TIMEOUT") }; esp.state()
        for(delay in listOf(1000L,2000L,4000L,8000L,15000L,15000L)) {
            val count=transport.calls.size
            clock.advanceMonotonic(delay-1); esp.state(); assertEquals("before $delay",count,transport.calls.size)
            clock.advanceMonotonic(1); esp.state(); assertEquals("at $delay",count+1,transport.calls.size)
        }
    }
    @Test fun onLostCancelsInFlightIoDiscardsTheLateResultAndUsesOnlyTheNewNetwork() {
        val esp=client(); esp.state()
        transport.gate=CountDownLatch(1); transport.entered=CountDownLatch(1); clock.advanceMonotonic(3000)
        var late:EspSnapshot?=null
        val worker=Thread{ late=esp.state() }; worker.start()
        assertTrue(transport.entered!!.await(2,TimeUnit.SECONDS))
        esp.onNetworkChanged(null)
        assertEquals(1,transport.cancels.get())
        transport.gate!!.countDown(); worker.join(3000)
        assertEquals("disconnected",late!!.link.state); assertEquals("WIFI_UNAVAILABLE",late!!.link.errorCode)
        val calls=transport.calls.size
        clock.advanceMonotonic(3000); assertEquals("WIFI_UNAVAILABLE",esp.state().link.errorCode); assertEquals(calls,transport.calls.size)
        try { esp.set(LightPatch(power=true),1,waitMs=0); fail("queued while no network") } catch(e:BridgeFailure) { assertEquals("WIFI_UNAVAILABLE",e.code) }
        transport.gate=null
        esp.onNetworkChanged(NetworkLease(FakeEspNetwork("wifi-2"),2))
        assertEquals("connected",esp.state().link.state); assertEquals("wifi-2",transport.calls.last().networkId)
    }
    @Test fun aReplyCompletedAcrossANetworkChangeIsDiscardedByEpoch() {
        val esp=client(); esp.state()
        transport.ignoreCancel=true; transport.gate=CountDownLatch(1); transport.entered=CountDownLatch(1)
        transport.respond=body(firmwareState(bright=99)); clock.advanceMonotonic(3000)
        var late:EspSnapshot?=null
        val worker=Thread{ late=esp.state() }; worker.start()
        assertTrue(transport.entered!!.await(2,TimeUnit.SECONDS))
        esp.onNetworkChanged(NetworkLease(FakeEspNetwork("wifi-2"),2))
        transport.gate!!.countDown(); worker.join(3000)
        val link=late!!.link
        assertEquals("The old network's reply is not recorded",75,link.data!!["bright"].asInt)
        assertEquals("connecting",link.state); assertEquals(3000L,link.ageMs)
    }
    @Test fun olderPollAfterNewIntentCannotConfirmOrEraseItAndTheOutcomeArrivesThroughEspState() {
        transport.respond=body(firmwareState(bright=20))
        val esp=client(); esp.state()
        val pending=esp.set(LightPatch(bright=80),1,waitMs=0)
        assertEquals("pending",pending.outcome)
        clock.advanceMonotonic(1000); esp.state()
        transport.respond=body(firmwareState(bright=80)); clock.advanceMonotonic(1000)
        val coincidental=esp.state()
        assertEquals("A poll before dispatch is not reconciliation evidence","pending",coincidental.commands.first!!.outcome)
        assertEquals(80,esp.queue.desired.bright); assertTrue(esp.queue.hasPendingIntent)
        transport.respond={ r -> if(r.path==EspPath.SET) throw EspTransportException("REQUEST_TIMEOUT") else EspResponse(200,firmwareState(bright=80).toByteArray()) }
        scheduler.advance(150)
        assertEquals(listOf(EspPath.STATE,EspPath.STATE,EspPath.STATE,EspPath.SET,EspPath.STATE),transport.paths())
        val outcome=esp.state().commands.first!!
        assertEquals("confirmed",outcome.outcome); assertEquals(1L,outcome.generation); assertEquals(80,outcome.state!!.bright)
        assertTrue(ProtocolValidator.response("esp.state",esp.state().toJson()))
    }
    @Test fun rendererRecreationRetainsCachedAgeOutcomesAndGenerationFloor() {
        val esp=client(); val session=NativeSession()
        val first=SessionLifecycle(session).also{ it.enterForeground() }
        val router=BridgeRouter(services(esp),first)
        assertEquals(0L,router.handle(req("esp.state"),TRUSTED_ORIGIN,true).data!!["ageMs"].asLong)
        val set=router.handle(req("esp.set","""{"patch":{"bright":30},"generation":5}"""),TRUSTED_ORIGIN,true)
        assertTrue(set.ok); assertEquals("pending",set.data!!["outcome"].asString); assertEquals("state",set.data!!["kind"].asString)
        transport.respond={ throw EspTransportException("REQUEST_TIMEOUT") }; clock.advanceMonotonic(4000)
        first.close()
        val second=SessionLifecycle(session).also{ it.enterForeground() }
        val replacement=BridgeRouter(services(esp),second)
        assertEquals(6L,replacement.handle(req("app.status"),TRUSTED_ORIGIN,true).data!!["nextCommandGeneration"].asLong)
        assertEquals("BAD_GENERATION",replacement.handle(req("esp.set","""{"patch":{"bright":31},"generation":5}"""),TRUSTED_ORIGIN,true).errorCode)
        clock.advanceMonotonic(1000)
        val state=replacement.handle(req("esp.state"),TRUSTED_ORIGIN,true).data!!
        assertEquals(5000L,state["ageMs"].asLong)
        assertEquals(5L,state.getAsJsonObject("commands").getAsJsonObject("state")["generation"].asLong)
        assertEquals("Unsafe integers fail validation before any service","BAD_PAYLOAD",replacement.handle(req("esp.set","""{"patch":{"bright":31},"generation":${ProtocolValidator.MAX_SAFE+1}}"""),TRUSTED_ORIGIN,true).errorCode)
        assertTrue(replacement.handle(req("esp.set","""{"patch":{"bright":31},"generation":6}"""),TRUSTED_ORIGIN,true).ok)
    }
    @Test fun laptopAndControllerLinksFailIndependently() {
        val hub=FakeHubTransport(); hub.failWith("USB_UNAVAILABLE")
        val laptop=LaptopClient(MemoryStore(SYNTHETIC_TOKEN),hub,clock).also{ it.resume() }
        val esp=client()
        assertEquals("disconnected",laptop.snapshot().state)
        assertEquals("Laptop failure leaves controller data live","connected",esp.state().link.state)
        hub.succeed(); esp.onNetworkChanged(null); clock.advanceMonotonic(2000)
        assertEquals("Controller loss leaves laptop data live","connected",laptop.snapshot().state)
        val lost=esp.state().link
        assertEquals("disconnected",lost.state); assertNotNull("Last controller reading stays, labelled by age",lost.data)
        assertTrue(hub.requests.isNotEmpty() && transport.calls.size==1)
    }
    @Test fun bridgeLanesKeepASlowControllerFromDelayingTheHubAndViceVersa() {
        val lanes=BridgeLanes(); val block=CountDownLatch(1)
        try {
            for(op in listOf("esp.state","esp.history","esp.set")) lanes.submit(op,Runnable{ block.await(5,TimeUnit.SECONDS) })
            val hubRan=CountDownLatch(1); lanes.submit("hub.snapshot",Runnable{ hubRan.countDown() })
            assertTrue(hubRan.await(500,TimeUnit.MILLISECONDS))
            block.countDown()
            val hubBlock=CountDownLatch(1); lanes.submit("hub.snapshot",Runnable{ hubBlock.await(5,TimeUnit.SECONDS) })
            val espRan=CountDownLatch(1); lanes.submit("esp.state",Runnable{ espRan.countDown() })
            assertTrue(espRan.await(500,TimeUnit.MILLISECONDS)); hubBlock.countDown()
        } finally { block.countDown(); lanes.shutdownNow() }
    }
    @Test fun lifecycleStopCancelsReadsQueuedAndInFlightWritesWithoutReplay() {
        val io=Executors.newSingleThreadExecutor()
        try {
            val esp=client{ io.execute(it) }; esp.state()
            val session=NativeSession(onBackground={ esp.pause() })
            val view=SessionLifecycle(session).also{ it.enterForeground() }
            transport.gatePath=EspPath.SET; transport.gate=CountDownLatch(1); transport.entered=CountDownLatch(1)
            val inFlight=esp.submit(LightPatch(bright=10),1); scheduler.advance(150)
            assertTrue(transport.entered!!.await(2,TimeUnit.SECONDS))
            esp.submit(LightPatch(timerMinutes=5),2); esp.submit(LightPatch(mode=3),3)
            view.onActivityStopped(userLeaving=true)
            assertTrue(transport.cancels.get()>=1)
            transport.gate!!.countDown()
            io.submit{}.get(2,TimeUnit.SECONDS)
            assertEquals("unconfirmed",inFlight.await(0).outcome); assertEquals("COMMAND_UNCONFIRMED",inFlight.await(0).errorCode)
            assertEquals(3L,esp.queue.latest("state")!!.generation); assertEquals("cancelled",esp.queue.latest("state")!!.outcome)
            assertEquals("cancelled",esp.queue.latest("timer")!!.outcome)
            assertFalse(esp.queue.hasPendingIntent)
            val setCalls=transport.paths().count{ it==EspPath.SET }
            esp.resume(); view.enterForeground(); scheduler.advance(10_000); io.submit{}.get(2,TimeUnit.SECONDS)
            assertEquals("Nothing is replayed after teardown",setCalls,transport.paths().count{ it==EspPath.SET })
            assertEquals(1,setCalls)
        } finally { io.shutdownNow() }
    }
    @Test fun concurrentPollsShareOneFlightAndTheControllerChannelIsSerialized() {
        val io=Executors.newSingleThreadExecutor()
        try {
            val esp=client{ io.execute(it) }
            transport.gatePath=EspPath.STATE; transport.gate=CountDownLatch(1); transport.entered=CountDownLatch(1)
            val results=CopyOnWriteArrayList<EspSnapshot>()
            val first=Thread{ results.add(esp.state()) }; first.start()
            assertTrue(transport.entered!!.await(2,TimeUnit.SECONDS))
            val joiners=(1..3).map{ Thread{ results.add(esp.state()) }.also{ it.start() } }
            esp.set(LightPatch(timerMinutes=1),1,waitMs=0)
            Thread.sleep(150)
            assertEquals("One state flight; the write waits for the channel",listOf(EspPath.STATE),transport.paths())
            transport.gate!!.countDown(); first.join(3000); joiners.forEach{ it.join(3000) }
            io.submit{}.get(3,TimeUnit.SECONDS)
            assertEquals(4,results.size); assertTrue(results.all{ it.link.state=="connected" })
            assertEquals(listOf(EspPath.STATE,EspPath.SET),transport.paths())
            assertEquals(1,transport.maxConcurrent)
        } finally { io.shutdownNow() }
    }
}
