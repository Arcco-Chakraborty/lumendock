package com.phonemonitor

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Final-review Wi-Fi fixes: BSSID pinning, automatic-reconnect recovery, same-network changes, throwing platform. */
class WifiFinalFixesTest {
    private val platform=FakeWifiPlatform()
    private val store=MemoryWifiStore()
    private val credentials=WifiCredentials.validate(SYNTHETIC_SSID,SYNTHETIC_WIFI_PASS)!!
    private val net1=FakeEspNetwork("wifi-1")
    private var now=0L
    private val leases=mutableListOf<NetworkLease?>()
    private fun session()=WifiSession(platform,store,{ leases.add(it) },{},now={ now })
    /** A previously HTTP-verified app request, as persisted before process death. */
    private fun verifiedStore(bssid:String?=null) { store.saved=credentials; store.mode="app_request"; store.autoReconnect=true; store.pinnedBssid=bssid }

    private class Flow(api:Int=29) {
        val platform=FakeWifiPlatform(); val store=MemoryWifiStore(); val ui=FakeSetupUi()
        lateinit var flow:WifiSetupFlow
        val session=NativeSession(onCancelSetup={ kind,id -> if(kind=="esp") flow.onSetupEnded(id) })
        val wifi=WifiSession(platform,store,{},{ session.wifiMode=it })
        val verifications=mutableListOf<(Boolean)->Unit>()
        init { flow=WifiSetupFlow(session,wifi,store,FakeGate(api,WifiPermissionPolicy.required(api).toSet()),{ _,done -> verifications.add(done) },ui) }
        val router=BridgeRouter(UnavailableBridgeServices(),SessionLifecycle(session).also{ it.enterForeground() })
        fun start():String = router.handle("""{"v":1,"id":"c","op":"app.connectEsp","args":{}}""",TRUSTED_ORIGIN,true).data!!["setupId"].asString
        fun esp()=session.status().getAsJsonObject("setup").getAsJsonObject("esp")
    }

    // Fix 1: pin the approved AP so Android 10/11 can reuse the user's approval on automatic reconnects.
    @Test fun verifiedSetupPinsTheConnectedBssidAndAutomaticReconnectsNameIt() {
        val h=Flow(29); val id=h.start()
        h.flow.submit(id,SYNTHETIC_SSID,SYNTHETIC_WIFI_PASS)
        assertNull("The first explicit request names only the SSID",h.platform.bssids.single())
        val net=FakeEspNetwork("wifi-pin"); h.platform.accessPoints[net.id]=SYNTHETIC_BSSID.uppercase()
        h.platform.lastRequest.onAvailable(net)
        assertNull("Nothing is pinned before the controller answered",h.store.pinnedBssid)
        h.verifications.single()(true)
        assertEquals("succeeded",h.esp()["state"].asString)
        assertEquals(SYNTHETIC_BSSID,h.store.pinnedBssid)
        h.wifi.pause(); h.wifi.resume()
        assertEquals(2,h.platform.requests.size)
        assertEquals("Automatic reconnect targets SSID + exact BSSID",SYNTHETIC_BSSID,h.platform.bssids.last())
        assertEquals(credentials,h.platform.requests.last().first)
        val status=h.router.handle("""{"v":1,"id":"s","op":"app.status","args":{}}""",TRUSTED_ORIGIN,true).toJson()
        assertFalse("The BSSID never reaches the renderer",status.lowercase().contains(SYNTHETIC_BSSID))
    }
    @Test fun redactedMissingOrInvalidBssidIsNeverPinned() {
        for(raw in listOf(null,"02:00:00:00:00:00","00:00:00:00:00:00","ff:ff:ff:ff:ff:ff","01:00:5e:00:00:01","not-a-mac","00:00:5e:00:53")) {
            val p=FakeWifiPlatform(); val s=MemoryWifiStore(); val w=WifiSession(p,s,{},{})
            w.connect(credentials,null); p.accessPoints[net1.id]=raw; p.lastRequest.onAvailable(net1)
            w.markVerified(w.current())
            assertNull("$raw",s.pinnedBssid); assertTrue(s.autoReconnect)
            w.pause(); w.resume(); assertNull("$raw: falls back to SSID-only",p.bssids.last())
        }
        assertEquals(SYNTHETIC_BSSID,WifiBssid.normalize(" ${SYNTHETIC_BSSID.uppercase()} "))
    }
    @Test fun pinIsTakenOnlyFromTheVerifiedLeaseAndIsDroppedWhenCredentialsChange() {
        val w=session()
        w.connect(credentials,null); platform.accessPoints[net1.id]=SYNTHETIC_BSSID; platform.lastRequest.onAvailable(net1)
        w.markVerified(NetworkLease(FakeEspNetwork("other"),99))
        assertNull("A stale/other lease cannot pin",store.pinnedBssid)
        w.markVerified(w.current()); assertEquals(SYNTHETIC_BSSID,store.pinnedBssid)
        w.connect(credentials,null)
        assertEquals("Same credentials: an explicit setup may reuse the proven pin",SYNTHETIC_BSSID,platform.bssids.last())
        w.connect(WifiCredentials.validate("Synthetic_Other_AP",SYNTHETIC_WIFI_PASS)!!,null)
        assertNull("A different AP never inherits the pin",platform.bssids.last()); assertNull(store.pinnedBssid)
    }
    @Test fun pinnedFailureFallsBackToSsidOnlyOnceOnTheNextExplicitSetupNeverInALoop() {
        verifiedStore(SYNTHETIC_BSSID); val w=session()
        w.resume(); assertEquals(SYNTHETIC_BSSID,platform.bssids.last())
        platform.lastRequest.onUnavailable()
        assertTrue(store.autoReconnect); assertTrue(store.pinFailed)
        now+=60_000; w.pause(); w.resume()
        assertEquals("Automatic retries stay pinned; they never widen to an SSID-only prompt",SYNTHETIC_BSSID,platform.bssids.last())
        assertEquals(2,platform.requests.size)
        w.connect(credentials,null)
        assertNull("The next explicit setup falls back to SSID-only",platform.bssids.last())
        assertNull(store.pinnedBssid); assertFalse(store.pinFailed)
        platform.lastRequest.onUnavailable()
        w.connect(credentials,null); assertNull(platform.bssids.last())
        assertEquals("No automatic widening/retry happened in between",4,platform.requests.size)
    }
    @Test fun automaticRequestInterruptedByAStopRightAwayIsNotReissuedInALoop() {
        verifiedStore(); val w=session()
        w.resume(); assertEquals(1,platform.requests.size)
        now+=300; w.pause()   // e.g. a system approval Activity stopped us without a matching setup approval
        now+=300; w.resume()
        assertEquals("No request/stop/start loop",1,platform.requests.size)
        assertTrue("The opt-in is kept",store.autoReconnect)
        now+=60_000; w.pause(); w.resume()
        assertEquals("The next genuine return retries",2,platform.requests.size)
        now+=10_000; w.pause(); w.resume()
        assertEquals("A request pending for longer than the window is an ordinary background",3,platform.requests.size)
        platform.lastRequest.onAvailable(net1); now+=100; w.pause(); w.resume()
        assertEquals("A delivered network is an ordinary background",4,platform.requests.size)
    }

    // Fix 2: a controller that was merely off recovers on a later foreground return.
    @Test fun unavailableOnAnAutomaticReconnectKeepsAutoReconnectAndRetriesOnlyOnTheNextStart() {
        verifiedStore(); val w=session()
        w.resume(); platform.lastRequest.onUnavailable()
        assertTrue(store.autoReconnect); assertEquals("app_request",w.mode); assertNull(w.current())
        w.resume()
        assertEquals("No repeated request while the Activity stays started",1,platform.requests.size)
        now+=60_000; w.pause(); w.resume()
        assertEquals("Retried once on the next start",2,platform.requests.size)
        platform.lastRequest.onAvailable(net1)
        assertSame("AP restored: the controller network is leased again",net1,w.current()!!.network)
    }
    @Test fun unavailableDuringAnExplicitSetupStillClearsAutoReconnect() {
        val h=Flow(33); val id=h.start()
        h.store.autoReconnect=true
        h.flow.submit(id,SYNTHETIC_SSID,SYNTHETIC_WIFI_PASS); h.platform.lastRequest.onUnavailable()
        assertEquals("failed",h.esp()["state"].asString); assertFalse(h.store.autoReconnect)
        h.wifi.pause(); h.wifi.resume(); assertEquals(1,h.platform.requests.size)
    }

    // Fix 3: only loss/unavailability or a different Network handle ends the lease.
    @Test fun sameNetworkLinkOrCapabilityChangeKeepsTheLeaseAndInFlightControllerIo() {
        val transport=FakeEspTransport(); val clock=TestClock()
        val esp=EspClient(transport,clock,ManualScheduler(clock),{ it.run() }).also{ it.resume() }
        val w=WifiSession(platform,store,{ esp.onNetworkChanged(it) })
        w.connect(credentials,null); platform.lastRequest.onAvailable(net1)
        val lease=w.current()!!
        transport.gate=CountDownLatch(1); transport.entered=CountDownLatch(1)
        var verified:Boolean?=null
        val worker=Thread{ esp.verify(lease) { verified=it } }; worker.start()
        assertTrue(transport.entered!!.await(2,TimeUnit.SECONDS))
        platform.lastRequest.onChanged(net1)          // e.g. an IPv6 link-local address appeared
        platform.lastRequest.onAvailable(net1)        // the same Network re-delivered
        assertSame(lease,w.current())
        transport.gate!!.countDown(); worker.join(3000)
        assertEquals("No in-flight controller call was cancelled",0,transport.cancels.get())
        assertEquals("Setup verification still succeeds",true,verified)
        val other=FakeEspNetwork("wifi-2"); platform.lastRequest.onAvailable(other)
        assertNotSame("A different Network handle is a new lease",lease,w.current()); assertSame(other,w.current()!!.network)
        platform.lastRequest.onLost(other); platform.lastRequest.onLost(net1); assertNull(w.current())
    }

    // Fix 5: ConnectivityManager throwing never crashes onStart and fails setup with a fixed code.
    @Test fun throwingPlatformNeverCrashesStartOrManualAndKeepsRecoveryBounded() {
        verifiedStore(SYNTHETIC_BSSID); val w=session()
        platform.failNext=SecurityException("synthetic: permission revoked")
        w.resume()
        assertNull(w.current()); assertTrue(store.autoReconnect); assertTrue(platform.requests.isEmpty())
        w.resume(); assertTrue("Not retried while started",platform.requests.isEmpty())
        now+=60_000; w.pause(); w.resume(); assertEquals(1,platform.requests.size)
        platform.failNext=IllegalArgumentException("synthetic: too many requests")
        w.useManual()
        assertEquals("manual",w.mode); assertNull(w.current()); assertTrue(platform.observers.isEmpty())
    }
    @Test fun throwingRequestDuringExplicitSetupFailsWithWifiUnavailable() {
        for(error in listOf<RuntimeException>(SecurityException("synthetic"),IllegalArgumentException("synthetic"),RuntimeException("synthetic: too many requests"))) {
            val h=Flow(33); val id=h.start()
            h.platform.failNext=error
            assertTrue(h.flow.submit(id,SYNTHETIC_SSID,SYNTHETIC_WIFI_PASS))
            assertEquals("failed",h.esp()["state"].asString); assertEquals("WIFI_UNAVAILABLE",h.esp()["errorCode"].asString)
            assertEquals(WifiSetupMessage.UNAVAILABLE,h.ui.messages.last())
            assertFalse(h.session.activityStopReason(userLeaving=false)=="approval_pause")
            assertFalse(h.store.autoReconnect); assertEquals("none",h.wifi.mode)
        }
    }
}
