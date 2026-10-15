package com.phonemonitor

import org.junit.Assert.*
import org.junit.Test

/** Synthetic, recognisably fake credentials; never a real AP passphrase. */
internal const val SYNTHETIC_SSID="Synthetic_Controller"
internal const val SYNTHETIC_WIFI_PASS="synthetic-wifi-pass-0000"

/** RFC 7042 documentation-range MAC: recognisably synthetic, never a real controller's BSSID. */
internal const val SYNTHETIC_BSSID="00:00:5e:00:53:01"

internal class FakeWifiPlatform:WifiPlatform {
    val requests=mutableListOf<Pair<WifiCredentials,WifiCallbacks>>()
    /** The BSSID each app request named (null: SSID only), parallel to [requests]. */
    val bssids=mutableListOf<String?>()
    val observers=mutableListOf<WifiCallbacks>()
    var releases=0
    /** Thrown once by the next request/observe call, like ConnectivityManager after a revoked permission. */
    var failNext:RuntimeException?=null
    val accessPoints=HashMap<String,String?>()
    private fun maybeFail() { failNext?.let{ failNext=null; throw it } }
    override fun requestLocalNetwork(credentials:WifiCredentials,bssid:String?,callbacks:WifiCallbacks):WifiRequestHandle { maybeFail(); requests.add(credentials to callbacks); bssids.add(bssid); return WifiRequestHandle{ releases++ } }
    override fun observeWifi(callbacks:WifiCallbacks):WifiRequestHandle { maybeFail(); observers.add(callbacks); return WifiRequestHandle{ releases++ } }
    override fun accessPoint(network:EspNetwork,ssid:String):String?=accessPoints[network.id]
    val lastRequest get()=requests.last().second
}
internal class MemoryWifiStore:WifiStore {
    var saved:WifiCredentials?=null; var failSave=false
    override var mode="none"
    override var autoReconnect=false
    override var pinnedBssid:String?=null
    override var pinFailed=false
    override fun credentials()=saved
    override fun saveCredentials(credentials:WifiCredentials):Boolean { if(failSave) return false; saved=credentials; return true }
}
internal class FakeGate(override val sdkInt:Int,var granted:Set<String> =emptySet(),var location:Boolean=true):PermissionGate {
    override fun granted(permission:String)=permission in granted
    override fun locationEnabled()=location
}
internal class FakeSetupUi:WifiSetupUi {
    val permissionRequests=mutableListOf<List<String>>(); val messages=mutableListOf<WifiSetupMessage>()
    override fun requestPermissions(setupId:String,permissions:List<String>) { permissionRequests.add(permissions) }
    override fun show(setupId:String,message:WifiSetupMessage) { messages.add(message) }
}

class WifiSessionTest {
    private val platform=FakeWifiPlatform()
    private val store=MemoryWifiStore()
    private val leases=mutableListOf<NetworkLease?>()
    private val modes=mutableListOf<String>()
    private val wifi=WifiSession(platform,store,{ leases.add(it) },{ modes.add(it) })
    private val credentials=WifiCredentials.validate(SYNTHETIC_SSID,SYNTHETIC_WIFI_PASS)!!
    private val net1=FakeEspNetwork("wifi-1")

    @Test fun appRequestLeasesOnlyTheApprovedNetworkAndLossNeverRequestsAgain() {
        var available=0; var unavailable=0
        wifi.connect(credentials,object:WifiRequestListener { override fun onAvailable(lease:NetworkLease) { available++ }; override fun onUnavailable() { unavailable++ } })
        assertEquals(1,platform.requests.size); assertSame(credentials,platform.requests.single().first)
        assertEquals("app_request",wifi.mode); assertEquals("app_request",modes.last()); assertNull(wifi.current())
        platform.lastRequest.onAvailable(net1)
        val first=wifi.current()!!; assertSame(net1,first.network); assertSame(first,leases.last()); assertEquals(1,available)
        platform.lastRequest.onChanged(net1)
        assertSame("A same-network address change keeps the lease (final-review fix 3)",first,wifi.current())
        platform.lastRequest.onLost(net1)
        assertNull(wifi.current()); assertNull(leases.last())
        platform.lastRequest.onAvailable(net1)
        assertNotNull("The kept request may deliver the network again",wifi.current()); assertEquals(1,available)
        wifi.pause(); wifi.resume()
        assertEquals("Loss does not trigger a new OS request/prompt",1,platform.requests.size)
        assertEquals(0,unavailable)
    }
    @Test fun unavailableOrDeniedRequestIsNeverRepeatedWithoutAnExplicitTap() {
        var unavailable=0
        wifi.connect(credentials,object:WifiRequestListener { override fun onAvailable(lease:NetworkLease) {}; override fun onUnavailable() { unavailable++ } })
        wifi.markVerified()
        platform.lastRequest.onUnavailable()
        assertEquals(1,unavailable); assertEquals(1,platform.releases); assertFalse(store.autoReconnect)
        wifi.pause(); wifi.resume(); wifi.pause(); wifi.resume()
        assertEquals(1,platform.requests.size)
        wifi.connect(credentials,null); assertEquals("Only an explicit connect asks again",2,platform.requests.size)
    }
    @Test fun backgroundReleasesTheRequestAndOnlyAVerifiedRequestIsRestoredIncludingAfterProcessDeath() {
        wifi.connect(credentials,null); platform.lastRequest.onAvailable(net1)
        wifi.pause()
        assertEquals(1,platform.releases); assertNull(wifi.current()); assertNull(leases.last())
        wifi.resume(); assertEquals("Unverified request is not silently re-issued",1,platform.requests.size)
        wifi.connect(credentials,null); platform.lastRequest.onAvailable(net1); wifi.markVerified()
        wifi.pause(); wifi.resume()
        assertEquals(3,platform.requests.size); assertEquals(credentials,platform.requests.last().first)
        val stale=platform.requests[1].second
        stale.onAvailable(FakeEspNetwork("stale"))
        assertNull("Callbacks of a released request are ignored",wifi.current())
        val recreated=WifiSession(platform,store,{},{})
        assertEquals("app_request",recreated.mode)
        recreated.resume(); assertEquals(4,platform.requests.size)
        recreated.close(); assertEquals(3,platform.releases)
    }
    @Test fun manualModeObservesExistingWifiWithoutAnAppRequest() {
        wifi.connect(credentials,null)
        wifi.useManual()
        assertEquals("manual",wifi.mode); assertEquals(1,platform.releases); assertEquals(1,platform.observers.size)
        val net2=FakeEspNetwork("wifi-2")
        platform.observers.last().onAvailable(net1); platform.observers.last().onAvailable(net2)
        assertSame(net2,wifi.current()!!.network)
        platform.observers.last().onLost(net2)
        assertSame("Falls back to another joined Wi-Fi network",net1,wifi.current()!!.network)
        wifi.pause(); wifi.resume()
        assertEquals(2,platform.observers.size); assertEquals(1,platform.requests.size)
        wifi.disconnect()
        assertEquals("none",wifi.mode); assertNull(wifi.current()); assertFalse(store.autoReconnect)
        wifi.resume(); assertEquals(2,platform.observers.size); assertEquals(1,platform.requests.size)
    }
    @Test fun permissionPolicyPerApiLevel() {
        val fine="android.permission.ACCESS_FINE_LOCATION"; val coarse="android.permission.ACCESS_COARSE_LOCATION"; val nearby="android.permission.NEARBY_WIFI_DEVICES"
        assertEquals(listOf(fine),WifiPermissionPolicy.required(29)); assertEquals(listOf(fine),WifiPermissionPolicy.required(30))
        assertEquals(listOf(fine,coarse),WifiPermissionPolicy.required(31)); assertEquals(listOf(fine,coarse),WifiPermissionPolicy.required(32))
        assertEquals(listOf(nearby),WifiPermissionPolicy.required(33)); assertEquals(listOf(nearby),WifiPermissionPolicy.required(36))
        for(api in 29..32) assertTrue("$api",WifiPermissionPolicy.needsLocationServices(api))
        for(api in 33..36) assertFalse("$api",WifiPermissionPolicy.needsLocationServices(api))
    }

    private class Harness(api:Int,granted:Set<String> =emptySet(),location:Boolean=true) {
        val platform=FakeWifiPlatform(); val store=MemoryWifiStore(); val ui=FakeSetupUi()
        val gate=FakeGate(api,granted,location)
        lateinit var flow:WifiSetupFlow
        val session=NativeSession(onCancelSetup={ kind,id -> if(kind=="esp") flow.onSetupEnded(id) })
        val wifi=WifiSession(platform,store,{},{ session.wifiMode=it })
        val verifications=mutableListOf<(Boolean)->Unit>()
        init { flow=WifiSetupFlow(session,wifi,store,gate,{ _,done -> verifications.add(done) },ui) }
        val router=BridgeRouter(UnavailableBridgeServices(),SessionLifecycle(session).also{ it.enterForeground() })
        fun start():String {
            val reply=router.handle("""{"v":1,"id":"c","op":"app.connectEsp","args":{}}""",TRUSTED_ORIGIN,true)
            assertTrue(reply.data!!["started"].asBoolean)
            return reply.data!!["setupId"].asString
        }
        fun esp()=session.status().getAsJsonObject("setup").getAsJsonObject("esp")
        fun pausedForApproval()=session.activityStopReason(userLeaving=false)=="approval_pause"
    }
    @Test fun setupFlowOnEveryApiRequestsTheRightPermissionThenTheLocalNetworkAndSucceedsOnlyAfterControllerHttp() {
        for(api in 29..33) {
            val h=Harness(api)
            val id=h.start()
            assertTrue(h.flow.submit(id,SYNTHETIC_SSID,SYNTHETIC_WIFI_PASS))
            assertEquals("$api",listOf(WifiPermissionPolicy.required(api)),h.ui.permissionRequests)
            assertTrue("$api permission screen is a real OS approval",h.pausedForApproval())
            assertTrue(h.platform.requests.isEmpty())
            h.gate.granted=WifiPermissionPolicy.required(api).toSet(); h.flow.onPermissionsResult(id,true)
            assertEquals(1,h.platform.requests.size); assertTrue("$api network approval",h.pausedForApproval())
            h.platform.lastRequest.onAvailable(FakeEspNetwork("wifi-$api"))
            assertFalse("Approval ends with the system result",h.pausedForApproval())
            assertEquals("in_progress",h.esp()["state"].asString)
            assertEquals("Internet validation is never readiness; controller HTTP is",1,h.verifications.size)
            h.verifications.single()(true)
            assertEquals("succeeded",h.esp()["state"].asString); assertEquals("app_request",h.session.wifiMode)
            assertTrue(h.store.autoReconnect); assertEquals(SYNTHETIC_WIFI_PASS,h.store.saved!!.passphrase)
        }
    }
    @Test fun deniedPermissionFailsWithoutRequestingTheNetworkOrRepromptingAndOffersManualFallback() {
        for(api in listOf(29,31,33)) {
            val h=Harness(api); val id=h.start()
            h.flow.submit(id,SYNTHETIC_SSID,SYNTHETIC_WIFI_PASS)
            h.flow.onPermissionsResult(id,false)
            assertEquals("failed",h.esp()["state"].asString); assertEquals("WIFI_UNAVAILABLE",h.esp()["errorCode"].asString)
            assertTrue(h.platform.requests.isEmpty()); assertFalse(h.pausedForApproval())
            assertEquals(WifiSetupMessage.PERMISSION_DENIED,h.ui.messages.last())
            assertFalse("A finished flow cannot be resubmitted",h.flow.submit(id,SYNTHETIC_SSID,SYNTHETIC_WIFI_PASS))
            h.wifi.pause(); h.wifi.resume(); assertEquals(1,h.ui.permissionRequests.size)
        }
    }
    @Test fun locationServicesOffOnApi29To32StopsBeforeTheRequestButNotOn33() {
        for(api in 29..32) {
            val h=Harness(api,WifiPermissionPolicy.required(api).toSet(),location=false); val id=h.start()
            h.flow.submit(id,SYNTHETIC_SSID,SYNTHETIC_WIFI_PASS)
            assertTrue("$api: no fall-through to the network request",h.platform.requests.isEmpty())
            assertEquals("failed",h.esp()["state"].asString); assertEquals(WifiSetupMessage.LOCATION_OFF,h.ui.messages.last())
            assertFalse(h.pausedForApproval())
        }
        val h=Harness(33,WifiPermissionPolicy.required(33).toSet(),location=false); val id=h.start()
        h.flow.submit(id,SYNTHETIC_SSID,SYNTHETIC_WIFI_PASS)
        assertTrue("NEARBY_WIFI_DEVICES neverForLocation does not need location services",h.ui.permissionRequests.isEmpty())
        assertEquals(1,h.platform.requests.size)
    }
    @Test fun unavailableUnreachableControllerAndExpiryFailCleanly() {
        val h=Harness(33,WifiPermissionPolicy.required(33).toSet()); var id=h.start()
        h.flow.submit(id,SYNTHETIC_SSID,SYNTHETIC_WIFI_PASS); h.platform.lastRequest.onUnavailable()
        assertEquals("failed",h.esp()["state"].asString); assertFalse(h.pausedForApproval()); assertFalse(h.store.autoReconnect)
        id=h.start(); h.flow.submit(id,SYNTHETIC_SSID,SYNTHETIC_WIFI_PASS)
        h.platform.lastRequest.onAvailable(net1); h.verifications.last()(false)
        assertEquals("failed",h.esp()["state"].asString); assertEquals(WifiSetupMessage.CONTROLLER_UNREACHABLE,h.ui.messages.last())
        assertEquals("A wrong network is released",2,h.platform.releases)
        id=h.start(); h.flow.submit(id,SYNTHETIC_SSID,SYNTHETIC_WIFI_PASS)
        h.session.close()
        assertEquals("Ended session releases the pending request",3,h.platform.releases)
        h.platform.lastRequest.onAvailable(net1)
        assertEquals("No late verification for a cancelled flow",1,h.verifications.size)
    }
    @Test fun invalidInputKeepsTheFlowOpenAndManualChoiceObservesWifi() {
        val h=Harness(33,WifiPermissionPolicy.required(33).toSet()); val id=h.start()
        for((ssid,pass) in listOf(""  to SYNTHETIC_WIFI_PASS,"x".repeat(33) to SYNTHETIC_WIFI_PASS,SYNTHETIC_SSID to "short",SYNTHETIC_SSID to "p".repeat(64),SYNTHETIC_SSID to "pässwört-synthetic")) {
            assertTrue(h.flow.submit(id,ssid,pass)); assertEquals(WifiSetupMessage.INVALID_INPUT,h.ui.messages.last())
        }
        assertNull(h.store.saved); assertTrue(h.platform.requests.isEmpty()); assertEquals("in_progress",h.esp()["state"].asString)
        h.store.failSave=true; h.flow.submit(id,SYNTHETIC_SSID,SYNTHETIC_WIFI_PASS)
        assertEquals("failed",h.esp()["state"].asString); assertEquals(WifiSetupMessage.SAVE_FAILED,h.ui.messages.last())
        val next=h.start(); h.flow.chooseManual(next)
        assertEquals("manual",h.session.wifiMode); assertEquals(1,h.platform.observers.size); assertTrue(h.platform.requests.isEmpty())
        assertEquals("cancelled",h.esp()["state"].asString)
    }
    @Test fun credentialsStayNativeAndAreRedacted() {
        val h=Harness(33,WifiPermissionPolicy.required(33).toSet()); val id=h.start()
        h.flow.submit(id,SYNTHETIC_SSID,SYNTHETIC_WIFI_PASS)
        h.platform.lastRequest.onAvailable(net1); h.verifications.single()(true)
        assertFalse(credentials.toString().contains(SYNTHETIC_WIFI_PASS)); assertFalse(credentials.toString().contains(SYNTHETIC_SSID))
        val status=h.router.handle("""{"v":1,"id":"s","op":"app.status","args":{}}""",TRUSTED_ORIGIN,true).toJson()
        assertFalse(status.contains(SYNTHETIC_WIFI_PASS)); assertFalse(status.contains(SYNTHETIC_SSID))
        assertFalse(h.ui.messages.toString().contains(SYNTHETIC_WIFI_PASS))
        val esp=EspClient(FakeEspTransport(),TestClock(),ManualScheduler(TestClock()),{ it.run() }).also{ it.resume(); it.onNetworkChanged(h.wifi.current()) }
        val reply=esp.state().toJson().toString()
        assertFalse(reply.contains(SYNTHETIC_WIFI_PASS)); assertFalse(reply.contains(SYNTHETIC_SSID))
        assertFalse(EspRequest.set(LightPatch(power=true)).url.contains(SYNTHETIC_WIFI_PASS))
    }
}
