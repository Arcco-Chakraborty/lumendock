package com.phonemonitor

import org.junit.Assert.*
import org.junit.Test

class ActivityLifecycleRegressionTest {
    private val request="""{"v":1,"id":"x","op":"hub.snapshot","args":{}}"""

    @Test fun activeSetupWithNonApprovalStopAndNoLeaveHintEndsForegroundWork() {
        var releases=0
        val session=NativeSession(onBackground={releases++})
        val view=SessionLifecycle(session); view.enterForeground()
        session.startSetup("hub")
        var error:String?=null
        view.registerPending("x"){error=it}
        view.onActivityStopped(userLeaving=false)
        assertFalse(session.foreground)
        assertFalse(view.acceptsRequests)
        assertEquals("SESSION_ENDED",error)
        assertEquals(1,releases)
        assertEquals("cancelled",session.status().getAsJsonObject("setup").getAsJsonObject("hub").get("state").asString)
    }
    @Test fun onlyOutstandingMatchingOsApprovalPreservesSessionUntilResult() {
        var releases=0
        val session=NativeSession(onBackground={releases++})
        val view=SessionLifecycle(session); view.enterForeground()
        val id=session.startSetup("esp").get("setupId").asString
        session.beginOsApproval("esp",id)
        view.onActivityStopped(userLeaving=false)
        assertTrue(session.foreground); assertEquals(0,releases)
        assertEquals("in_progress",session.status().getAsJsonObject("setup").getAsJsonObject("esp").get("state").asString)
        session.endOsApproval(id)
        view.enterForeground()
        view.onActivityStopped(userLeaving=false)
        assertFalse(session.foreground); assertEquals(1,releases)
    }
    @Test fun homeWhileApprovalOutstandingStillEndsTheSession() {
        val session=NativeSession(); val view=SessionLifecycle(session); view.enterForeground()
        val id=session.startSetup("esp").get("setupId").asString
        session.beginOsApproval("esp",id)
        view.onActivityStopped(userLeaving=true)
        assertFalse(session.foreground)
    }
    @Test fun stoppedRendererReplacementRejectsRequestsUntilActualStart() {
        val session=NativeSession(); val old=SessionLifecycle(session); old.enterForeground()
        old.onActivityStopped(false); old.close()
        val replacement=SessionLifecycle(session)
        val router=BridgeRouter(UnavailableBridgeServices(),replacement)
        assertEquals("SESSION_ENDED",router.handle(request,TRUSTED_ORIGIN,true).errorCode)
        assertFalse(session.foreground)
        replacement.enterForeground()
        assertTrue(router.handle(request,TRUSTED_ORIGIN,true).ok)
    }
    @Test fun foregroundRendererReplacementKeepsSetupAndPairingButRequiresExplicitStart() {
        val session=NativeSession(); session.paired=true
        val old=SessionLifecycle(session); old.enterForeground()
        val id=session.startSetup("hub").get("setupId")
        old.close()
        val replacement=SessionLifecycle(session)
        assertFalse(replacement.acceptsRequests)
        replacement.enterForeground()
        assertTrue(session.paired)
        assertEquals(id,session.startSetup("hub").get("setupId"))
        assertFalse(session.startSetup("hub").get("started").asBoolean)
    }
}
