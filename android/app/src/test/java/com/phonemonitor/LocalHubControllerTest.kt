package com.phonemonitor

import com.google.gson.JsonObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

internal class HubMemoryStore:LocalHubStore {
    var value=LocalHubStoredState(emptyList(),null)
    var fail=false
    override fun load()=value
    override fun save(value:LocalHubStoredState) { if(fail) throw IOException("synthetic"); this.value=value }
}
internal class SyntheticLocalNetwork:LocalHubNetworkAccess {
    @Volatile var valid=true
    val lease=LocalHubLease(LocalHubInterface("synthetic-hotspot",42,"127.0.0.1"),"synthetic-identity")
    override fun valid(lease:LocalHubLease)=valid && lease===this.lease
    override fun bindAddress(lease:LocalHubLease)=InetSocketAddress("127.0.0.1",8787)
}
internal class LocalHubClock:HubClock {
    var now=0L
    override fun epochMs()=1_000_000L+now
    override fun monotonicMs()=now
}
internal fun hubJson(s:String)=StrictJson.parse(s).asJsonObject
internal fun hubState(timer:Int=0,bright:Int=75)=EspStateValue(true,"#12ABEF",bright,0,50,timer,true,24.5,55.0,1234).toJson()
internal fun pollBody()=hubJson("""{"v":1}""")
internal fun reportBody(command:JsonObject?=null,state:JsonObject=hubState()):JsonObject = jsonObject("v" to 1,"state" to state).also { o -> command?.let { o.add("ack",jsonObject("id" to it["id"],"generation" to it["generation"])) } }

class LocalHubControllerTest {
    private fun withHub(block:(LocalHubController,LocalHubClock,SyntheticLocalNetwork,HubMemoryStore)->Unit) {
        val network=SyntheticLocalNetwork(); val clock=LocalHubClock(); val store=HubMemoryStore()
        LocalHubController(store,clock,network).use { hub -> hub.resume(); hub.configure(network.lease); assertTrue(hub.start()); block(hub,clock,network,store) }
    }
    private fun fails(code:String,block:()->Unit) { try { block(); fail("expected $code") } catch(e:BridgeFailure) { assertEquals(code,e.code) } }
    private fun command(hub:LocalHubController,bearer:String):JsonObject? = hub.request("/v1/poll",bearer,pollBody()).body["command"].let{if(it.isJsonNull) null else it.asJsonObject}

    @Test fun credentialsAreIndependentDigestOnlyBoundedAndRevocable()=withHub { h,_,_,s ->
        val a=h.enroll("Synthetic A"); val b=h.enroll("Synthetic B")
        assertNotEquals(a.bearer,b.bearer); assertEquals(43,a.bearer.length)
        assertFalse(s.value.toString().contains(a.bearer)); assertNull(s.value.selectedDeviceId)
        assertEquals(401,h.request("/v1/poll","invalid",pollBody()).status)
        assertEquals(200,h.request("/v1/poll",a.bearer,pollBody()).status)
        repeat(6) { h.enroll("Synthetic $it") }; fails("QUEUE_FULL") { h.enroll("Ninth") }
        h.revoke(a.deviceId); assertEquals(401,h.request("/v1/poll",a.bearer,pollBody()).status)
        assertEquals(200,h.request("/v1/poll",b.bearer,pollBody()).status)
    }
    @Test fun persistenceFailureDoesNotEnrollOrRevokeInMemory()=withHub { h,_,_,s ->
        s.fail=true; fails("TOKEN_PERSIST_FAILED") { h.enroll("Synthetic") }; assertEquals(0,h.devices().size)
        s.fail=false; val a=h.enroll("Synthetic"); s.fail=true
        fails("TOKEN_PERSIST_FAILED") { h.revoke(a.deviceId) }
        assertEquals(200,h.request("/v1/poll",a.bearer,pollBody()).status)
    }
    @Test fun requiresExplicitSelectionAndCoalescesOnlyUnsentOrdinaryIntent()=withHub { h,_,_,_ ->
        val a=h.enroll("A"); fails("WIFI_UNAVAILABLE") { h.setLight(hubJson("""{"power":true}"""),1) }
        h.select(a.deviceId)
        h.setLight(hubJson("""{"power":true,"bright":10}"""),1)
        val reply=h.setLight(hubJson("""{"bright":75}"""),2); assertTrue(ProtocolValidator.response("esp.set",reply))
        val c=command(h,a.bearer)!!; assertEquals(2,c["generation"].asLong); assertEquals(hubJson("""{"power":true,"bright":75}"""),c["patch"])
        assertNull(command(h,a.bearer)); fails("BAD_GENERATION") { h.setLight(hubJson("""{"bright":4}"""),2) }
    }
    @Test fun foreignAndStaleAcknowledgmentsCannotConfirmOrInjectTelemetry()=withHub { h,_,_,_ ->
        val a=h.enroll("A"); val b=h.enroll("B"); h.select(a.deviceId)
        h.setLight(hubJson("""{"bright":75}"""),1); val c=command(h,a.bearer)!!
        assertNull(command(h,b.bearer)); assertEquals(409,h.request("/v1/report",b.bearer,reportBody(c)).status)
        assertTrue(h.snapshot()["data"].isJsonNull)
        val wrong=c.deepCopy().apply{addProperty("generation",2)}
        assertEquals(409,h.request("/v1/report",a.bearer,reportBody(wrong)).status)
        assertEquals(200,h.request("/v1/report",a.bearer,reportBody(c)).status)
        assertEquals("confirmed",h.snapshot()["commands"].asJsonObject["state"].asJsonObject["outcome"].asString)
        assertEquals(409,h.request("/v1/report",a.bearer,reportBody(c)).status)
    }
    @Test fun timerDeliveryIsOnceOnlyAndExpiryAndPauseNeverReplay()=withHub { h,c,_,_ ->
        val a=h.enroll("A"); h.select(a.deviceId); h.setLight(hubJson("""{"timerMinutes":5}"""),1)
        val served=command(h,a.bearer)!!; assertEquals(30000,served["expiresInMs"].asInt)
        assertNull(command(h,a.bearer)); c.now=30000
        assertEquals(409,h.request("/v1/report",a.bearer,reportBody(served,hubState(300))).status)
        assertEquals("unconfirmed",h.snapshot()["commands"].asJsonObject["timer"].asJsonObject["outcome"].asString)
        h.setLight(hubJson("""{"bright":4}"""),2); h.pause()
        assertEquals("cancelled",h.snapshot()["commands"].asJsonObject["state"].asJsonObject["outcome"].asString)
        h.resume(); assertEquals("ready",h.status()["state"].asString); assertTrue(h.start()); assertNull(command(h,a.bearer))
    }
    @Test fun expiredUnsentCommandIsCancelledAndPowerOffCancelsUnsentTimers()=withHub { h,c,_,_ ->
        val a=h.enroll("A"); h.select(a.deviceId); h.setLight(hubJson("""{"timerMinutes":5}"""),1)
        h.setLight(hubJson("""{"power":false}"""),2)
        assertEquals("cancelled",h.snapshot()["commands"].asJsonObject["timer"].asJsonObject["outcome"].asString)
        c.now=30000; assertNull(command(h,a.bearer))
        assertEquals("cancelled",h.snapshot()["commands"].asJsonObject["state"].asJsonObject["outcome"].asString)
    }
    @Test fun selectedDeviceIsolationAndMonotonicTelemetryAge()=withHub { h,c,_,_ ->
        val a=h.enroll("A"); val b=h.enroll("B"); h.select(a.deviceId)
        h.request("/v1/report",b.bearer,reportBody()); assertTrue(h.snapshot()["data"].isJsonNull)
        h.request("/v1/report",a.bearer,reportBody()); c.now=9001
        assertEquals(9001,h.snapshot()["ageMs"].asLong); assertTrue(h.snapshot()["stale"].asBoolean)
        assertTrue(ProtocolValidator.response("esp.state",h.snapshot())); assertTrue(ProtocolValidator.response("esp.history",h.history()))
        h.select(b.deviceId); assertEquals(9001,h.snapshot()["ageMs"].asLong)
    }
    @Test fun leaseLossClosesListenerAndInvalidatesQueuedWork()=withHub { h,_,n,_ ->
        val a=h.enroll("A"); h.select(a.deviceId); h.setLight(hubJson("""{"timerMinutes":5}"""),1)
        n.valid=false; assertEquals(503,h.request("/v1/poll",a.bearer,pollBody()).status)
        assertEquals("error",h.status()["state"].asString); assertFalse(h.start())
        n.valid=true; assertFalse(h.start()) // Lost lease needs explicit native reconfirmation.
        h.configure(n.lease); assertTrue(h.start()); assertNull(command(h,a.bearer))
    }
    @Test fun productionNetworkPolicyRejectsNonPrivateAndLoopbackAndWrongIdentity() {
        for(ip in listOf("127.0.0.1","0.0.0.0","8.8.8.8","169.254.1.1","100.64.0.1","172.32.0.1","::1","192.168.1.1.evil","010.0.0.1")) assertFalse(ip,LocalHubNetworks.isPrivateIpv4(ip))
        for(ip in listOf("10.0.0.1","172.16.0.1","172.31.255.255","192.168.5.1")) assertTrue(ip,LocalHubNetworks.isPrivateIpv4(ip))
        assertFalse(LocalHubNetworks.valid(LocalHubLease(LocalHubInterface("missing-synthetic",42,"192.168.5.1"),"synthetic")))
    }
    @Test fun strictBodiesRejectUnknownKeysMalformedStateAndDuplicateKeys()=withHub { h,_,_,_ ->
        val a=h.enroll("A")
        for(body in listOf("""{"v":1,"url":"http://example.invalid"}""","""{"v":"1"}""","""{"v":2}""")) assertEquals(400,h.request("/v1/poll",a.bearer,hubJson(body)).status)
        assertEquals(400,h.request("/v1/report",a.bearer,jsonObject("v" to 1,"state" to hubState().apply{addProperty("secret","no")})).status)
        assertEquals(404,h.request("/v1/enroll",a.bearer,pollBody()).status)
    }
    @Test fun concurrentPollsServeOneCommandOnly()=withHub { h,_,_,_ ->
        val a=h.enroll("A"); h.select(a.deviceId); h.setLight(hubJson("""{"timerMinutes":1}"""),1)
        val pool=Executors.newFixedThreadPool(4)
        try { val results=(1..4).map{pool.submit<Boolean>{command(h,a.bearer)!=null}}; assertEquals(1,results.count{it.get(2,TimeUnit.SECONDS)}) } finally { pool.shutdownNow() }
    }
}
