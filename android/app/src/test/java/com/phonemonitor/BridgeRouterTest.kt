package com.phonemonitor

import com.google.gson.JsonObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class BridgeRouterTest {
    private fun fixture(name: String) = StrictJson.parse(javaClass.getResource("/$name.json")!!.readText()).asJsonObject
    private fun req(op: String = "hub.snapshot", args: String = "{}", id: String = "x") = """{"v":1,"id":"$id","op":"$op","args":$args}"""
    private class Services : UnavailableBridgeServices() {
        var calls = 0
        var response = """{"state":"disconnected","ageMs":null,"stale":true,"data":null,"errorCode":"USB_UNAVAILABLE"}"""
        var gate: CountDownLatch? = null
        var entered: CountDownLatch? = null
        override fun hubSnapshot(): JsonObject { calls++; entered?.countDown(); gate?.await(2, TimeUnit.SECONDS); return StrictJson.parse(response).asJsonObject }
    }
    @Test fun rejectsUntrustedOriginsFramesAndMalformedRequestsBeforeServices() {
        val s = Services(); val router = BridgeRouter(s, SessionLifecycle(NativeSession()))
        val malformed = listOf(req().replace("\"v\":1", "\"v\":2"), req("shell.exec"), req(args="""{"url":"https://example.com"}"""), req("app.setBrightness", """{"value":NaN}"""), req("app.setBrightness", """{"value":1e999}"""), req().replace("\"args\":{}", "\"args\":{},\"token\":\"synthetic\""), req(id="x".repeat(17000)), req().replace("\"v\":1", "\"v\":1,\"v\":1"))
        malformed.forEach { assertFalse(it.take(90), router.handle(it, TRUSTED_ORIGIN, true).ok) }
        listOf("http://appassets.androidplatform.net", "$TRUSTED_ORIGIN:443", "$TRUSTED_ORIGIN.evil", "null").forEach { assertFalse(router.handle(req(), it, true).ok) }
        assertFalse(router.handle(req(), TRUSTED_ORIGIN, false).ok)
        assertEquals(0, s.calls)
    }
    @Test fun validatesEveryOperationAndSharedFixtures() {
        val s = Services(); val session = NativeSession(); val router = BridgeRouter(s, SessionLifecycle(session))
        assertTrue(router.handle(req(), TRUSTED_ORIGIN, true).ok)
        assertTrue(ProtocolValidator.response("app.status", fixture("app-status")))
        assertTrue(ProtocolValidator.response("hub.snapshot", StrictJson.parse("""{"state":"connected","ageMs":0,"stale":false,"data":${fixture("hub-ready")},"errorCode":null}""").asJsonObject))
        assertTrue(ProtocolValidator.response("esp.state", fixture("esp-link-ready")))
        assertTrue(ProtocolValidator.response("esp.history", StrictJson.parse("""{"state":"connected","ageMs":0,"stale":false,"data":${fixture("esp-history")},"errorCode":null}""").asJsonObject))
        assertFalse(router.handle(req("esp.set", """{"patch":{"timerMinutes":1,"power":true},"generation":1}"""),TRUSTED_ORIGIN,true).ok)
        assertFalse(router.handle(req("app.setScreenOn", """{"enabled":1}"""),TRUSTED_ORIGIN,true).ok)
        assertTrue(router.handle(req("app.setBrightness", """{"value":0.6}"""),TRUSTED_ORIGIN,true).ok)
    }
    @Test fun rejectsCredentialsAndWrongShapesReturnedByServices() {
        val s = Services(); val router = BridgeRouter(s, SessionLifecycle(NativeSession()))
        s.response = """{"state":"connected","ageMs":0,"stale":false,"data":null,"errorCode":null,"token":"SYNTHETIC_SECRET"}"""
        val reply = router.handle(req(), TRUSTED_ORIGIN,true)
        assertFalse(reply.ok); assertFalse(reply.toJson().contains("SYNTHETIC_SECRET"))
        s.response = """{"paired":true}"""
        assertFalse(router.handle(req(), TRUSTED_ORIGIN,true).ok)
        val hostile = fixture("hub-ready")
        hostile.getAsJsonObject("usage").getAsJsonObject("claude").addProperty("password", "SYNTHETIC_SECRET")
        assertFalse(ProtocolValidator.response("hub.snapshot", StrictJson.parse("""{"state":"connected","ageMs":0,"stale":false,"data":$hostile,"errorCode":null}""").asJsonObject))
    }
    @Test fun duplicateLiveIdAndOperationDoNotExecuteTwice() {
        val s=Services(); s.entered=CountDownLatch(1); s.gate=CountDownLatch(1)
        val router=BridgeRouter(s,SessionLifecycle(NativeSession()))
        val worker=Thread { router.handle(req(),TRUSTED_ORIGIN,true) }; worker.start()
        assertTrue(s.entered!!.await(1,TimeUnit.SECONDS))
        assertFalse(router.handle(req(),TRUSTED_ORIGIN,true).ok)
        assertFalse(router.handle(req(id="y"),TRUSTED_ORIGIN,true).ok)
        assertEquals(1,s.calls); s.gate!!.countDown(); worker.join()
    }
    @Test fun setupAckIsImmediateAndLongHumanApprovalIsNotRequestTimeout() {
        var now=0L; val session=NativeSession(clock={now}); val router=BridgeRouter(Services(),SessionLifecycle(session))
        val started=System.nanoTime(); val first=router.handle(req("app.setupHub"),TRUSTED_ORIGIN,true)
        assertTrue(first.ok); assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started)<1000)
        now=30000; val status=router.handle(req("app.status"),TRUSTED_ORIGIN,true)
        assertEquals("in_progress",status.data!!.getAsJsonObject("setup").getAsJsonObject("hub").get("state").asString)
        val duplicate=router.handle(req("app.setupHub"),TRUSTED_ORIGIN,true)
        assertEquals(first.data!!.get("setupId"), duplicate.data!!.get("setupId")); assertFalse(duplicate.data!!.get("started").asBoolean)
        assertEquals("SETUP_BUSY",router.handle(req("app.connectEsp"),TRUSTED_ORIGIN,true).errorCode)
        now=120001
        assertEquals("PAIRING_EXPIRED",router.handle(req("app.status"),TRUSTED_ORIGIN,true).data!!.getAsJsonObject("setup").getAsJsonObject("hub").get("errorCode").asString)
    }
    @Test fun backgroundReturnCannotMakeAnOldReplyCurrentAgain() {
        val s=Services(); s.entered=CountDownLatch(1); s.gate=CountDownLatch(1)
        val lifecycle=SessionLifecycle(NativeSession()); lifecycle.enterForeground()
        val router=BridgeRouter(s,lifecycle)
        var reply:BridgeReply?=null
        val worker=Thread { reply=router.handle(req(),TRUSTED_ORIGIN,true) }; worker.start()
        assertTrue(s.entered!!.await(1,TimeUnit.SECONDS))
        lifecycle.leaveForeground("background"); lifecycle.enterForeground()
        s.gate!!.countDown(); worker.join()
        assertEquals("SESSION_ENDED",reply!!.errorCode)
    }

}
