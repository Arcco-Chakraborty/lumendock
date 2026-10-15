package com.phonemonitor
import org.junit.Assert.*
import org.junit.Test

class SessionLifecycleTest {
    @Test fun rendererCloseCancelsCallbacksButKeepsNativeSetupAndPairing() {
        val session=NativeSession(); session.paired=true
        val lifecycle=SessionLifecycle(session); lifecycle.enterForeground()
        val setup=session.startSetup("hub"); var error:String?=null
        lifecycle.registerPending("x") { error=it }
        lifecycle.close()
        assertEquals("SESSION_ENDED",error); assertEquals(0,lifecycle.pendingCount)
        assertTrue(session.paired); assertEquals("in_progress",session.status().getAsJsonObject("setup").getAsJsonObject("hub").get("state").asString)
        val recreated=SessionLifecycle(session)
        assertFalse(session.startSetup("hub").get("started").asBoolean)
        assertEquals(setup.get("setupId"),session.startSetup("hub").get("setupId"))
        assertTrue(recreated.isOpen)
        session.close()
        assertEquals("cancelled",session.status().getAsJsonObject("setup").getAsJsonObject("hub").get("state").asString)
    }
    @Test fun backgroundCancelsRequestsAndApprovalPauseKeepsSession() {
        var releases=0; val session=NativeSession(onBackground={releases++}); val view=SessionLifecycle(session)
        view.enterForeground(); session.startSetup("esp"); var error:String?=null
        view.registerPending("x") {error=it}; view.leaveForeground("approval_pause")
        assertNull(error); assertEquals(0,releases)
        view.leaveForeground("background")
        assertEquals("SESSION_ENDED",error); assertEquals(1,releases)
        assertEquals("cancelled",session.status().getAsJsonObject("setup").getAsJsonObject("esp").get("state").asString)
    }
    @Test fun staleSetupCompletionCannotOverwriteNewFlow() {
        val s=NativeSession(); val a=s.startSetup("hub").get("setupId").asString
        s.finishSetup("hub",a,"cancelled")
        val b=s.startSetup("hub").get("setupId").asString
        s.finishSetup("hub",a,"succeeded")
        assertFalse(s.paired); assertNotEquals(a,b)
        s.finishSetup("hub",b,"succeeded")
        assertTrue(s.paired)
    }
    @Test fun generationUsesEntireSafeIntegerRangeWithoutOverflowOrReuse() {
        val s=NativeSession()
        s.reserveGeneration(9007199254740991L)
        assertEquals(9007199254740991L,s.status().get("nextCommandGeneration").asLong)
        try { s.reserveGeneration(9007199254740991L); fail("Generation reused") } catch(e:BridgeFailure) { assertEquals("BAD_GENERATION",e.code) }
    }

}
