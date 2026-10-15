package com.phonemonitor

import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.LinkAddress
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

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
    private companion object { const val FILE="native_wifi"; const val SSID="ssid"; const val PASSPHRASE="passphrase"; const val MODE="mode"; const val AUTO="auto_reconnect" }
}

interface WifiCallbacks {
    fun onAvailable(network:EspNetwork)
    /** The network's addresses changed: clients must be recreated. */
    fun onChanged(network:EspNetwork)
    fun onLost(network:EspNetwork)
    /** The OS could not or would not provide the requested network (including user rejection). */
    fun onUnavailable()
}
fun interface WifiRequestHandle { fun release() }
/** OS seam. Production: ConnectivityManager. JVM tests: a fake factory. Neither ever binds the process. */
interface WifiPlatform {
    /** App-specific, local-only request: TRANSPORT_WIFI, INTERNET removed, WifiNetworkSpecifier for the configured AP. */
    fun requestLocalNetwork(credentials:WifiCredentials,callbacks:WifiCallbacks):WifiRequestHandle
    /** Manual mode: observe Wi-Fi networks the user joined in Settings, without an INTERNET requirement. */
    fun observeWifi(callbacks:WifiCallbacks):WifiRequestHandle
}
interface WifiRequestListener { fun onAvailable(lease:NetworkLease); fun onUnavailable() }

/**
 * Activity-owned Wi-Fi selection. Holds at most one OS request/observer; every selected network becomes a new
 * NetworkLease for the controller client (nothing else uses it). Loss never re-requests; denial/unavailability
 * never re-prompts. Background releases the request; foreground return restores manual observation, and an app
 * request only if it previously reached the controller. Internet validation is never consulted.
 */
class WifiSession(
    private val platform:WifiPlatform,
    private val store:WifiStore,
    private val onLease:(NetworkLease?)->Unit,
    private val onMode:(String)->Unit={},
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
    var mode:String=store.mode.takeIf{ it in MODES } ?: "none"; private set

    init { onMode(mode) }

    fun current():NetworkLease?=synchronized(lock) { lease }

    /** Explicit user action: replace any request/observer with one app-specific request. False if not persisted. */
    fun connect(credentials:WifiCredentials,listener:WifiRequestListener?):Boolean { synchronized(lock) {
        if(closed || !store.saveCredentials(credentials)) return false
        releaseLocked()
        this.credentials=credentials; this.listener=listener
        setModeLocked("app_request"); store.autoReconnect=false
        requestLocked(credentials)
        return true
    } }
    /** The controller answered over HTTP on this request's network. */
    fun markVerified() { synchronized(lock) { if(mode=="app_request" && handle!=null) store.autoReconnect=true } }
    fun useManual() { synchronized(lock) {
        if(closed) return
        releaseLocked(); listener=null
        setModeLocked("manual"); store.autoReconnect=false
        observeLocked()
    } }
    fun disconnect() { synchronized(lock) { releaseLocked(); listener=null; setModeLocked("none"); store.autoReconnect=false } }
    /** Background/end of foreground session: release the OS request; the mode is remembered. */
    fun pause() { synchronized(lock) { releaseLocked(); listener=null } }
    fun resume() { synchronized(lock) {
        if(closed || handle!=null) return
        when(mode) {
            "manual" -> observeLocked()
            "app_request" -> if(store.autoReconnect) (credentials ?: store.credentials())?.let{ credentials=it; requestLocked(it) }
        }
    } }
    override fun close() { synchronized(lock) { closed=true; releaseLocked(); listener=null } }

    private fun setModeLocked(next:String) { mode=next; store.mode=next; onMode(next) }
    private fun requestLocked(c:WifiCredentials) { val t=++token; handle=platform.requestLocalNetwork(c,Callbacks(t)) }
    private fun observeLocked() { val t=++token; handle=platform.observeWifi(Callbacks(t)) }
    private fun releaseLocked() {
        handle?.release(); handle=null; token++
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
                available.remove(network.id); available[network.id]=network
                setLeaseLocked(network)
                notify=listener?.let{ l -> listener=null; l to lease!! }
            }
            notify?.let{ (l,current) -> l.onAvailable(current) }
        }
        override fun onChanged(network:EspNetwork) { synchronized(lock) {
            if(!live() || !available.containsKey(network.id)) return
            available[network.id]=network
            if(lease?.network?.id==network.id) setLeaseLocked(network)
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
                store.autoReconnect=false
                if(lease!=null) setLeaseLocked(null)
                notify=listener; listener=null
            }
            notify?.onUnavailable()
        }
    }
    private companion object { val MODES=setOf("none","app_request","manual") }
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
                    if(ok) { wifi.markVerified(); clear(a); session.finishSetup("esp",a.id,"succeeded"); ui.show(a.id,WifiSetupMessage.CONNECTED) }
                    else fail(a,WifiSetupMessage.CONTROLLER_UNREACHABLE)
                }
            }
            override fun onUnavailable() { session.endOsApproval(a.id); if(current(a)) fail(a,WifiSetupMessage.UNAVAILABLE) }
        })
        if(!started) { a.requested=false; session.endOsApproval(a.id); fail(a,WifiSetupMessage.SAVE_FAILED) }
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
    override fun requestLocalNetwork(credentials:WifiCredentials,callbacks:WifiCallbacks):WifiRequestHandle {
        val specifier=WifiNetworkSpecifier.Builder().setSsid(credentials.ssid).apply{ if(credentials.passphrase.isNotEmpty()) setWpa2Passphrase(credentials.passphrase) }.build()
        val request=NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .setNetworkSpecifier(specifier).build()
        val callback=Forwarder(callbacks)
        connectivity.requestNetwork(request,callback)
        return release(callback)
    }
    override fun observeWifi(callbacks:WifiCallbacks):WifiRequestHandle {
        val request=NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build()
        val callback=Forwarder(callbacks)
        connectivity.registerNetworkCallback(request,callback)
        return release(callback)
    }
    private fun release(callback:ConnectivityManager.NetworkCallback)=WifiRequestHandle {
        try { connectivity.unregisterNetworkCallback(callback) } catch(_:IllegalArgumentException) { /* already released */ }
    }
    /** Forwards OS callbacks; validation/capability changes are ignored, only address changes recreate clients. */
    private class Forwarder(private val target:WifiCallbacks):ConnectivityManager.NetworkCallback() {
        private val addresses=HashMap<Network,List<LinkAddress>>()
        override fun onAvailable(network:Network) = target.onAvailable(AndroidEspNetwork(network))
        override fun onLinkPropertiesChanged(network:Network,linkProperties:LinkProperties) {
            val now=linkProperties.linkAddresses.toList()
            val previous=synchronized(addresses) { addresses.put(network,now) }
            if(previous!=null && previous!=now) target.onChanged(AndroidEspNetwork(network))
        }
        override fun onLost(network:Network) { synchronized(addresses) { addresses.remove(network) }; target.onLost(AndroidEspNetwork(network)) }
        override fun onUnavailable() = target.onUnavailable()
    }
}
