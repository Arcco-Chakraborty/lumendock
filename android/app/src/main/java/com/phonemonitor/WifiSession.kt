package com.phonemonitor

import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.MacAddress
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import androidx.annotation.RequiresApi
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/** Controller AP credentials. Native-only: never in a bridge reply, AppStatus, log line or toString. */
class WifiCredentials private constructor(val ssid:String,val passphrase:String) {
    override fun toString()="WifiCredentials(redacted)"
    override fun equals(other:Any?)=other is WifiCredentials && other.ssid==ssid && other.passphrase==passphrase
    override fun hashCode()=31*ssid.hashCode()+passphrase.hashCode()
    companion object {
        /** SSID 1–32 UTF-8 bytes without control characters; WPA2 passphrase empty (open AP) or 8–63 printable ASCII. */
        fun validate(ssid:String,passphrase:String):WifiCredentials? {
            val bytes=ssid.toByteArray(Charsets.UTF_8).size
            if(bytes !in 1..32 || ssid.any{ it.isISOControl() }) return null
            if(passphrase.isNotEmpty() && (passphrase.length !in 8..63 || passphrase.any{ it.code !in 0x20..0x7e })) return null
            return WifiCredentials(ssid,passphrase)
        }
    }
}

/** Private persistence for the controller AP and the chosen Wi-Fi mode (survives process death). */
interface WifiStore {
    fun credentials():WifiCredentials?
    fun saveCredentials(credentials:WifiCredentials):Boolean
    var mode:String
    /** True only after an app request reached the controller over HTTP; enables re-request on foreground return. */
    var autoReconnect:Boolean
    /** BSSID of the AP an app request reached the controller through (normalized); native-only, like the passphrase. */
    var pinnedBssid:String?
    /** A request naming [pinnedBssid] was unavailable: the next explicit setup asks by SSID only, once. */
    var pinFailed:Boolean
}
/** Validates a BSSID for pinning. Redacted, all-zero, broadcast, multicast or malformed values are never pinned. */
object WifiBssid {
    private val MAC=Regex("[0-9a-f]{2}(:[0-9a-f]{2}){5}")
    private val REJECTED=setOf("02:00:00:00:00:00","00:00:00:00:00:00","ff:ff:ff:ff:ff:ff")
    fun normalize(raw:String?):String? {
        val value=raw?.trim()?.lowercase() ?: return null
        if(!MAC.matches(value) || value in REJECTED) return null
        return value.takeIf{ it.substring(0,2).toInt(16) and 1==0 } // unicast only
    }
}
class PrivateWifiStore(context:Context):WifiStore {
    private val preferences=context.applicationContext.getSharedPreferences(FILE,Context.MODE_PRIVATE)
    override fun credentials():WifiCredentials? {
        val ssid=preferences.getString(SSID,null) ?: return null
        return WifiCredentials.validate(ssid,preferences.getString(PASSPHRASE,"") ?: "")
    }
    // commit(): setup only proceeds once the credentials are durable.
    override fun saveCredentials(credentials:WifiCredentials)=preferences.edit().putString(SSID,credentials.ssid).putString(PASSPHRASE,credentials.passphrase).commit()
    override var mode:String
        get()=preferences.getString(MODE,"none") ?: "none"
        set(value) { preferences.edit().putString(MODE,value).apply() }
    override var autoReconnect:Boolean
        get()=preferences.getBoolean(AUTO,false)
        set(value) { preferences.edit().putBoolean(AUTO,value).apply() }
    override var pinnedBssid:String?
        get()=WifiBssid.normalize(preferences.getString(BSSID,null))
        set(value) { preferences.edit().apply{ if(value==null) remove(BSSID) else putString(BSSID,value) }.apply() }
    override var pinFailed:Boolean
        get()=preferences.getBoolean(PIN_FAILED,false)
        set(value) { preferences.edit().putBoolean(PIN_FAILED,value).apply() }
    private companion object { const val FILE="native_wifi"; const val SSID="ssid"; const val PASSPHRASE="passphrase"; const val MODE="mode"; const val AUTO="auto_reconnect"; const val BSSID="bssid"; const val PIN_FAILED="pin_failed" }
}

interface WifiCallbacks {
    fun onAvailable(network:EspNetwork)
    /** Link properties/capabilities changed on the same Network handle. Never ends or replaces the lease. */
    fun onChanged(network:EspNetwork)
    fun onLost(network:EspNetwork)
    /** The OS could not or would not provide the requested network (including user rejection). */
    fun onUnavailable()
}
fun interface WifiRequestHandle { fun release() }
/**
 * OS seam. Production: ConnectivityManager. JVM tests: a fake factory. Neither ever binds the process.
 * Request/observe may throw (SecurityException after a revoked permission, IllegalArgumentException, too many
 * requests); WifiSession catches every RuntimeException from this seam.
 */
interface WifiPlatform {
    /**
     * App-specific, local-only request: TRANSPORT_WIFI, INTERNET removed, WifiNetworkSpecifier for the configured AP.
     * A non-null [bssid] (already validated by [WifiBssid]) also names that exact AP, so Android can reuse the
     * user's earlier approval for a single access point instead of prompting again.
     */
    fun requestLocalNetwork(credentials:WifiCredentials,bssid:String?,callbacks:WifiCallbacks):WifiRequestHandle
    /** Manual mode: observe Wi-Fi networks the user joined in Settings, without an INTERNET requirement. */
    fun observeWifi(callbacks:WifiCallbacks):WifiRequestHandle
    /** BSSID of the AP behind this app-request network, or null when unknown or redacted. Never logged. */
    fun accessPoint(network:EspNetwork,ssid:String):String?
}
enum class WifiConnectResult { STARTED, NOT_SAVED, REQUEST_FAILED }
interface WifiRequestListener { fun onAvailable(lease:NetworkLease); fun onUnavailable() }

/**
 * Activity-owned Wi-Fi selection. Holds at most one OS request/observer; every newly selected Network handle becomes
 * a new NetworkLease for the controller client (nothing else uses it). Same-network link/capability changes keep
 * the lease. Loss never re-requests. Background releases the request; foreground return restores manual
 * observation, and an app request only if one previously reached the controller. Internet validation is never
 * consulted.
 *
 * Re-prompt bounds: an explicit setup that is denied/unavailable clears the automatic reconnect. An *automatic*
 * request that is unavailable (e.g. the controller was off) keeps it and is retried only on the next foreground
 * start, never while the Activity stays started. An automatic request interrupted by a stop within
 * [AUTO_INTERRUPT_MS] (for example a system approval screen we cannot tie to a setup) is not re-issued on the
 * immediately following start, which breaks any request/stop/start loop. After a verified setup the connected AP's
 * BSSID is pinned so later automatic requests name SSID + exact BSSID; a pinned failure never widens an automatic
 * request, and only the next explicit setup falls back to SSID-only (once).
 */
class WifiSession(
    private val platform:WifiPlatform,
    private val store:WifiStore,
    private val onLease:(NetworkLease?)->Unit,
    private val onMode:(String)->Unit={},
    private val now:()->Long={ System.nanoTime()/1_000_000 },
):AutoCloseable {
    private val lock=Any()
    private var handle:WifiRequestHandle?=null
    private var token=0L
    private var credentials:WifiCredentials?=null
    private var listener:WifiRequestListener?=null
    private var leaseEpoch=0L
    private var lease:NetworkLease?=null
    private val available=LinkedHashMap<String,EspNetwork>()
    private var closed=false
    /** Between resume() and pause(): the Activity is started; automatic requests are issued at most once per start. */
    private var started=false
    /** The current app request came from an explicit user setup (vs an automatic foreground reconnect). */
    private var requestExplicit=false
    private var requestPinned=false
    /** Monotonic time an automatic request was issued; cleared once it resolves (available/unavailable/release). */
    private var autoRequestedAt:Long?=null
    private var skipNextAuto=false
    var mode:String=store.mode.takeIf{ it in MODES } ?: "none"; private set

    init { onMode(mode) }

    fun current():NetworkLease?=synchronized(lock) { lease }

    /** Explicit user action: replace any request/observer with one app-specific request. */
    fun connect(credentials:WifiCredentials,listener:WifiRequestListener?):WifiConnectResult { synchronized(lock) {
        if(closed) return WifiConnectResult.NOT_SAVED
        val previous=store.credentials()
        if(!store.saveCredentials(credentials)) return WifiConnectResult.NOT_SAVED
        releaseLocked(); skipNextAuto=false
        // A different AP never inherits the pin; after a pinned failure this explicit setup asks by SSID once.
        if(previous!=credentials || store.pinFailed) { store.pinnedBssid=null; store.pinFailed=false }
        this.credentials=credentials; this.listener=listener
        setModeLocked("app_request"); store.autoReconnect=false
        if(requestLocked(credentials,explicit=true)) return WifiConnectResult.STARTED
        this.listener=null
        return WifiConnectResult.REQUEST_FAILED
    } }
    /** The controller answered over HTTP on [verified]; pins that lease's AP when Android reports a usable BSSID. */
    fun markVerified(verified:NetworkLease?=null) { synchronized(lock) {
        if(mode!="app_request" || handle==null) return
        store.autoReconnect=true
        val c=credentials ?: return
        if(verified==null || verified!==lease) return
        val bssid=try { WifiBssid.normalize(platform.accessPoint(verified.network,c.ssid)) } catch(_:RuntimeException) { null }
        if(bssid!=null) { store.pinnedBssid=bssid; store.pinFailed=false }
        else if(requestPinned) store.pinFailed=false // the pinned request itself just proved the pin
    } }
    fun useManual() { synchronized(lock) {
        if(closed) return
        releaseLocked(); listener=null; skipNextAuto=false
        setModeLocked("manual"); store.autoReconnect=false
        observeLocked()
    } }
    fun disconnect() { synchronized(lock) { releaseLocked(); listener=null; skipNextAuto=false; setModeLocked("none"); store.autoReconnect=false } }
    /** Background/end of foreground session: release the OS request; the mode is remembered. */
    fun pause() { synchronized(lock) {
        started=false
        val issued=autoRequestedAt
        if(issued!=null && now()-issued<AUTO_INTERRUPT_MS) skipNextAuto=true
        releaseLocked(); listener=null
    } }
    /** Foreground start. A second call while still started is a no-op, so nothing is re-requested in a loop. */
    fun resume() { synchronized(lock) {
        if(closed || started) return
        started=true
        if(handle!=null) return
        when(mode) {
            "manual" -> observeLocked()
            "app_request" -> if(store.autoReconnect) {
                if(skipNextAuto) { skipNextAuto=false; return }
                (credentials ?: store.credentials())?.let{ credentials=it; if(requestLocked(it,explicit=false)) autoRequestedAt=now() }
            }
        }
    } }
    override fun close() { synchronized(lock) { closed=true; releaseLocked(); listener=null } }

    private fun setModeLocked(next:String) { mode=next; store.mode=next; onMode(next) }
    /** False when the OS refused the request synchronously; nothing is held and no callback can arrive. */
    private fun requestLocked(c:WifiCredentials,explicit:Boolean):Boolean {
        val t=++token
        val bssid=WifiBssid.normalize(store.pinnedBssid)
        requestExplicit=explicit; requestPinned=bssid!=null
        return try { handle=platform.requestLocalNetwork(c,bssid,Callbacks(t)); true }
        catch(_:RuntimeException) { handle=null; token++; if(bssid!=null) store.pinFailed=true; false }
    }
    private fun observeLocked() {
        val t=++token
        try { handle=platform.observeWifi(Callbacks(t)) } catch(_:RuntimeException) { handle=null; token++ }
    }
    private fun releaseLocked() {
        handle?.release(); handle=null; token++
        autoRequestedAt=null
        available.clear()
        if(lease!=null) setLeaseLocked(null)
    }
    /** Lease notifications happen under this lock so a racing release can never be overtaken by a stale lease. */
    private fun setLeaseLocked(network:EspNetwork?) { lease=network?.let{ NetworkLease(it,++leaseEpoch) }; onLease(lease) }

    private inner class Callbacks(private val owner:Long):WifiCallbacks {
        private fun live()=!closed && owner==token && handle!=null
        override fun onAvailable(network:EspNetwork) {
            val notify:Pair<WifiRequestListener,NetworkLease>?
            synchronized(lock) {
                if(!live()) return
                autoRequestedAt=null
                available.remove(network.id); available[network.id]=network
                // The same Network handle delivered again keeps its lease and any in-flight controller I/O.
                if(lease?.network?.id!=network.id) setLeaseLocked(network)
                notify=listener?.let{ l -> listener=null; l to lease!! }
            }
            notify?.let{ (l,current) -> l.onAvailable(current) }
        }
        override fun onChanged(network:EspNetwork) { synchronized(lock) {
            if(!live() || !available.containsKey(network.id)) return
            available[network.id]=network
        } }
        override fun onLost(network:EspNetwork) { synchronized(lock) {
            if(!live()) return
            available.remove(network.id)
            if(lease?.network?.id==network.id) setLeaseLocked(available.values.lastOrNull())
        } }
        override fun onUnavailable() {
            val notify:WifiRequestListener?
            synchronized(lock) {
                if(!live()) return
                handle?.release(); handle=null; token++
                autoRequestedAt=null
                if(requestPinned) store.pinFailed=true
                // Only an explicit setup's denial/unavailability ends the opt-in; an automatic one retries next start.
                if(requestExplicit) store.autoReconnect=false
                if(lease!=null) setLeaseLocked(null)
                notify=listener; listener=null
            }
            notify?.onUnavailable()
        }
    }
    private companion object {
        val MODES=setOf("none","app_request","manual")
        /** A stop this soon after an automatic request most likely came from a system screen that request opened. */
        const val AUTO_INTERRUPT_MS=5000L
    }
}

/** Runtime permissions required for an app-specific Wi-Fi request, per API level (explicit branches, no fall-through). */
object WifiPermissionPolicy {
    const val FINE="android.permission.ACCESS_FINE_LOCATION"
    const val COARSE="android.permission.ACCESS_COARSE_LOCATION"
    const val NEARBY="android.permission.NEARBY_WIFI_DEVICES"
    fun required(sdk:Int):List<String> = when {
        sdk>=33 -> listOf(NEARBY)          // neverForLocation in the manifest
        sdk>=31 -> listOf(FINE,COARSE)     // API 31/32 ignore a fine-only request
        else -> listOf(FINE)               // API 29/30
    }
    /** Before NEARBY_WIFI_DEVICES, Wi-Fi network requests depend on location services being enabled. */
    fun needsLocationServices(sdk:Int)=sdk<=32
}
interface PermissionGate { val sdkInt:Int; fun granted(permission:String):Boolean; fun locationEnabled():Boolean }
class AndroidPermissionGate(private val context:Context):PermissionGate {
    override val sdkInt:Int get()=Build.VERSION.SDK_INT
    override fun granted(permission:String)=context.checkSelfPermission(permission)==PackageManager.PERMISSION_GRANTED
    override fun locationEnabled()=context.getSystemService(LocationManager::class.java)?.isLocationEnabled==true
}

enum class WifiSetupMessage { INVALID_INPUT, CONNECTING, CONNECTED, PERMISSION_DENIED, LOCATION_OFF, UNAVAILABLE, CONTROLLER_UNREACHABLE, SAVE_FAILED }
/** Native setup UI. Implementations post to the main thread and never echo credentials. */
interface WifiSetupUi { fun requestPermissions(setupId:String,permissions:List<String>); fun show(setupId:String,message:WifiSetupMessage) }

/**
 * The one native flow behind app.connectEsp (already acknowledged by NativeSession.startSetup). OS approval is
 * marked only around a real runtime-permission dialog or the system network-approval prompt, and ends with its
 * result. Success means the controller answered over HTTP on the approved network. Failures finish the setup
 * (no repeated prompting); a new attempt needs a new explicit tap.
 */
class WifiSetupFlow(
    private val session:NativeSession,
    private val wifi:WifiSession,
    private val store:WifiStore,
    private val gate:PermissionGate,
    private val verify:(NetworkLease,(Boolean)->Unit)->Unit,
    private val ui:WifiSetupUi,
) {
    private class Attempt(val id:String,val credentials:WifiCredentials) { @Volatile var requested=false }
    private val lock=Any()
    private var attempt:Attempt?=null

    private fun current(a:Attempt)=synchronized(lock) { attempt===a } && session.isSetupCurrent("esp",a.id)
    private fun clear(a:Attempt)=synchronized(lock) { if(attempt===a) { attempt=null; true } else false }

    /** Returns false when ignored (flow not current, or this attempt is already running). */
    fun submit(setupId:String,ssid:String,passphrase:String):Boolean {
        if(!session.isSetupCurrent("esp",setupId)) return false
        val credentials=WifiCredentials.validate(ssid,passphrase) ?: run { ui.show(setupId,WifiSetupMessage.INVALID_INPUT); return true }
        val a=Attempt(setupId,credentials)
        synchronized(lock) { if(attempt?.id==setupId) return false; attempt=a }
        val missing=WifiPermissionPolicy.required(gate.sdkInt).filterNot(gate::granted)
        if(missing.isNotEmpty()) { session.beginOsApproval("esp",setupId); ui.requestPermissions(setupId,missing); return true }
        proceed(a)
        return true
    }
    fun onPermissionsResult(setupId:String,granted:Boolean) {
        session.endOsApproval(setupId)
        val a=synchronized(lock) { attempt?.takeIf{ it.id==setupId } } ?: return
        if(!current(a)) { clear(a); return }
        if(!granted || WifiPermissionPolicy.required(gate.sdkInt).any{ !gate.granted(it) }) { fail(a,WifiSetupMessage.PERMISSION_DENIED); return }
        proceed(a)
    }
    private fun proceed(a:Attempt) {
        if(WifiPermissionPolicy.needsLocationServices(gate.sdkInt) && !gate.locationEnabled()) { fail(a,WifiSetupMessage.LOCATION_OFF); return }
        a.requested=true
        session.beginOsApproval("esp",a.id)
        ui.show(a.id,WifiSetupMessage.CONNECTING)
        val started=wifi.connect(a.credentials,object:WifiRequestListener {
            override fun onAvailable(lease:NetworkLease) {
                session.endOsApproval(a.id)
                if(!current(a)) return
                verify(lease) { ok ->
                    if(!current(a)) return@verify
                    if(ok) { wifi.markVerified(lease); clear(a); session.finishSetup("esp",a.id,"succeeded"); ui.show(a.id,WifiSetupMessage.CONNECTED) }
                    else fail(a,WifiSetupMessage.CONTROLLER_UNREACHABLE)
                }
            }
            override fun onUnavailable() { session.endOsApproval(a.id); if(current(a)) fail(a,WifiSetupMessage.UNAVAILABLE) }
        })
        when(started) {
            WifiConnectResult.STARTED -> {}
            WifiConnectResult.NOT_SAVED -> { a.requested=false; session.endOsApproval(a.id); fail(a,WifiSetupMessage.SAVE_FAILED) }
            // The OS threw instead of accepting the request (e.g. a revoked permission): fixed WIFI_UNAVAILABLE failure.
            WifiConnectResult.REQUEST_FAILED -> { session.endOsApproval(a.id); fail(a,WifiSetupMessage.UNAVAILABLE) }
        }
    }
    private fun fail(a:Attempt,message:WifiSetupMessage) {
        clear(a)
        session.endOsApproval(a.id)
        if(a.requested) wifi.disconnect()
        session.finishSetup("esp",a.id,"failed","WIFI_UNAVAILABLE")
        ui.show(a.id,message)
    }
    /** Manual fallback: observe Wi-Fi joined in Settings; the app-request flow ends as cancelled. */
    fun chooseManual(setupId:String) {
        if(!session.isSetupCurrent("esp",setupId)) return
        synchronized(lock) { if(attempt?.id==setupId) attempt=null }
        session.endOsApproval(setupId)
        wifi.useManual()
        session.finishSetup("esp",setupId,"cancelled")
    }
    /** Setup cancelled/expired/backgrounded: release a request that never reached the controller. */
    fun onSetupEnded(setupId:String) {
        val a=synchronized(lock) { attempt?.takeIf{ it.id==setupId }?.also{ attempt=null } } ?: return
        session.endOsApproval(setupId)
        if(a.requested) wifi.disconnect()
    }
}

/** Every controller connection is opened through the selected Network, never via a process default. */
class AndroidEspNetwork(private val network:Network):EspNetwork {
    override val id:String=network.networkHandle.toString()
    override fun openConnection(url:URL)=network.openConnection(url,Proxy.NO_PROXY) as HttpURLConnection
}
class AndroidWifiPlatform(context:Context):WifiPlatform {
    private val connectivity=context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private val wifiManager=context.applicationContext.getSystemService(WifiManager::class.java)
    /** Latest usable BSSID per Network handle, as reported to a live app request's callback. Never logged. */
    private val accessPoints=ConcurrentHashMap<String,String>()
    override fun requestLocalNetwork(credentials:WifiCredentials,bssid:String?,callbacks:WifiCallbacks):WifiRequestHandle {
        val specifier=WifiNetworkSpecifier.Builder().setSsid(credentials.ssid).apply{
            if(credentials.passphrase.isNotEmpty()) setWpa2Passphrase(credentials.passphrase)
            // SSID + exact BSSID of a previously approved AP: Android can reuse that approval without prompting.
            bssid?.let{ setBssid(MacAddress.fromString(it)) }
        }.build()
        val request=NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .setNetworkSpecifier(specifier).build()
        val relay=Relay(callbacks,accessPoints,recordAccessPoint=true)
        val callback=if(Build.VERSION.SDK_INT>=Build.VERSION_CODES.S) LocatingForwarder(relay) else Forwarder(relay)
        connectivity.requestNetwork(request,callback)
        return release(callback,relay)
    }
    override fun observeWifi(callbacks:WifiCallbacks):WifiRequestHandle {
        val request=NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build()
        val relay=Relay(callbacks,accessPoints,recordAccessPoint=false)
        val callback=Forwarder(relay)
        connectivity.registerNetworkCallback(request,callback)
        return release(callback,relay)
    }
    override fun accessPoint(network:EspNetwork,ssid:String):String? {
        accessPoints[network.id]?.let{ return it }
        return if(Build.VERSION.SDK_INT<Build.VERSION_CODES.S) legacyAccessPoint(ssid) else null
    }
    /**
     * API 29/30: the single client-mode connection is the app-requested controller AP. Its BSSID is readable with
     * the location permission the setup already required (redacted values are rejected by WifiBssid).
     */
    @Suppress("DEPRECATION") // WifiManager.getConnectionInfo is deprecated only from API 31; used below API 31 only.
    private fun legacyAccessPoint(ssid:String):String? {
        val info=wifiManager?.connectionInfo ?: return null
        return if(info.ssid=="\"$ssid\"") WifiBssid.normalize(info.bssid) else null
    }
    private fun release(callback:ConnectivityManager.NetworkCallback,relay:Relay)=WifiRequestHandle {
        relay.clear()
        try { connectivity.unregisterNetworkCallback(callback) } catch(_:RuntimeException) { /* already released */ }
    }
    /**
     * Forwards OS callbacks. Link-property/capability changes are reported as same-network changes (the lease is
     * kept); only onLost/onUnavailable or a different Network handle change what the controller client uses.
     */
    private class Relay(private val target:WifiCallbacks,private val accessPoints:MutableMap<String,String>,private val recordAccessPoint:Boolean) {
        private val recorded=ConcurrentHashMap.newKeySet<String>()
        fun available(network:Network)=target.onAvailable(AndroidEspNetwork(network))
        fun capabilities(network:Network,capabilities:NetworkCapabilities) {
            if(!recordAccessPoint) return
            val id=network.networkHandle.toString()
            WifiBssid.normalize((capabilities.transportInfo as? WifiInfo)?.bssid)?.let{ accessPoints[id]=it; recorded.add(id) }
        }
        fun linkProperties(network:Network)=target.onChanged(AndroidEspNetwork(network))
        fun lost(network:Network) { val id=network.networkHandle.toString(); if(recorded.remove(id)) accessPoints.remove(id); target.onLost(AndroidEspNetwork(network)) }
        fun unavailable()=target.onUnavailable()
        fun clear() { recorded.forEach{ accessPoints.remove(it) }; recorded.clear() }
    }
    private class Forwarder(private val relay:Relay):ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network:Network)=relay.available(network)
        override fun onCapabilitiesChanged(network:Network,capabilities:NetworkCapabilities)=relay.capabilities(network,capabilities)
        override fun onLinkPropertiesChanged(network:Network,linkProperties:LinkProperties)=relay.linkProperties(network)
        override fun onLost(network:Network)=relay.lost(network)
        override fun onUnavailable()=relay.unavailable()
    }
    /** API 31+: without FLAG_INCLUDE_LOCATION_INFO the callback's WifiInfo always has a redacted BSSID. */
    @RequiresApi(Build.VERSION_CODES.S)
    private class LocatingForwarder(private val relay:Relay):ConnectivityManager.NetworkCallback(FLAG_INCLUDE_LOCATION_INFO) {
        override fun onAvailable(network:Network)=relay.available(network)
        override fun onCapabilitiesChanged(network:Network,capabilities:NetworkCapabilities)=relay.capabilities(network,capabilities)
        override fun onLinkPropertiesChanged(network:Network,linkProperties:LinkProperties)=relay.linkProperties(network)
        override fun onLost(network:Network)=relay.lost(network)
        override fun onUnavailable()=relay.unavailable()
    }
}
