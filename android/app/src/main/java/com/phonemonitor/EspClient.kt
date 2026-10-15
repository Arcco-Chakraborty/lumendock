package com.phonemonitor

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLEncoder
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.CountDownLatch
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

internal const val ESP_REPLY_BYTES=64*1024
internal const val ESP_STALE_MS=9000L
/** History is refreshed every 30 s while open; two missed refreshes make it stale. */
internal const val ESP_HISTORY_STALE_MS=60_000L
internal const val ESP_STATE_SPACING_MS=1000L
internal const val ESP_HISTORY_SPACING_MS=5000L
/** Bounded waits for the serialized controller channel; both stay below the ten-second bridge deadline. */
internal const val ESP_READ_CHANNEL_WAIT_MS=4500L
internal const val ESP_WRITE_CHANNEL_WAIT_MS=8000L
/** esp.set waits this long for its outcome, then returns `pending`; the outcome later arrives via esp.state. */
internal const val ESP_SET_WAIT_MS=7000L
internal const val ESP_ORIGIN="http://192.168.4.1"

/** A selected Wi-Fi network. Production wraps android.net.Network; every connection is opened through it. */
interface EspNetwork { val id:String; fun openConnection(url:URL):HttpURLConnection }
/**
 * The network a controller client may use. A new lease (new epoch) means a different selected Network handle or
 * none; WifiSession keeps the same lease across same-network link/capability changes, so they cancel nothing.
 */
class NetworkLease(val network:EspNetwork,val epoch:Long)

/** The only three controller endpoints of the existing firmware. There is no URL/path argument anywhere. */
enum class EspPath(val path:String) { STATE("/api/state"), HISTORY("/api/history"), SET("/api/set") }
internal class EspRequest private constructor(val path:EspPath,private val query:String?) {
    val url:String get()=ESP_ORIGIN+path.path+(query?.let{ "?$it" } ?: "")
    /** Never an Authorization header or cookie: the controller never receives laptop credentials. */
    fun headers():Map<String,String> = mapOf("Accept" to "application/json","Accept-Encoding" to "identity","Connection" to "close")
    override fun toString()="EspRequest(${path.name})"
    companion object {
        fun state()=EspRequest(EspPath.STATE,null)
        fun history()=EspRequest(EspPath.HISTORY,null)
        fun set(patch:LightPatch)=EspRequest(EspPath.SET,patch.toQuery())
    }
}
internal class EspResponse(val status:Int,val body:ByteArray)
/** Fixed protocol code only; the cause is dropped so no request detail can leak. */
internal class EspTransportException(val code:String):IOException(code)
internal interface EspCall { fun execute():EspResponse; fun cancel() }
internal interface EspTransport { fun newCall(network:EspNetwork,request:EspRequest):EspCall }

/**
 * Per-network controller HTTP: Network.openConnection(url, Proxy.NO_PROXY) on the selected Wi-Fi, never a process
 * binding. 1.5 s connect, 2 s read, total call budget, no redirects, 64 KiB reply budget, 200 only.
 */
internal class NetworkEspTransport(
    private val clock:HubClock=SystemHubClock,
    val connectTimeoutMs:Int=1500,
    val readTimeoutMs:Int=2000,
    private val callBudgetMs:Long=4000,
):EspTransport {
    override fun newCall(network:EspNetwork,request:EspRequest):EspCall = Call(network,request)
    private inner class Call(private val network:EspNetwork,private val request:EspRequest):EspCall {
        @Volatile private var connection:HttpURLConnection?=null
        @Volatile private var cancelled=false
        override fun cancel() { cancelled=true; try { connection?.disconnect() } catch(_:RuntimeException) { /* already closed */ } }
        private fun checkLive(started:Long) {
            if(cancelled || Thread.currentThread().isInterrupted) throw EspTransportException("SESSION_ENDED")
            if(clock.monotonicMs()-started>callBudgetMs) throw EspTransportException("REQUEST_TIMEOUT")
        }
        override fun execute():EspResponse {
            val started=clock.monotonicMs()
            checkLive(started)
            try {
                val c=network.openConnection(URL(request.url)); connection=c
                try {
                    checkLive(started)
                    c.connectTimeout=connectTimeoutMs; c.readTimeout=readTimeoutMs
                    c.instanceFollowRedirects=false; c.useCaches=false; c.allowUserInteraction=false
                    c.requestMethod="GET"
                    request.headers().forEach{ (k,v) -> c.setRequestProperty(k,v) }
                    val status=c.responseCode
                    checkLive(started)
                    if(status!=200) throw EspTransportException("BAD_PAYLOAD")
                    val declared=c.getHeaderField("Content-Length")?.trim()?.let{ it.toLongOrNull() ?: throw EspTransportException("BAD_PAYLOAD") }
                    if(declared!=null && (declared<0 || declared>ESP_REPLY_BYTES)) throw EspTransportException("BAD_PAYLOAD")
                    val out=ByteArrayOutputStream()
                    c.inputStream.use { input ->
                        val buffer=ByteArray(4096)
                        while(true) {
                            checkLive(started)
                            val n=input.read(buffer); if(n<0) break
                            if(out.size()+n>ESP_REPLY_BYTES) throw EspTransportException("BAD_PAYLOAD")
                            out.write(buffer,0,n)
                        }
                    }
                    checkLive(started)
                    if(declared!=null && declared!=out.size().toLong()) throw EspTransportException("BAD_PAYLOAD")
                    return EspResponse(status,out.toByteArray())
                } finally { connection=null; c.disconnect() }
            } catch(e:EspTransportException) { throw e }
            catch(_:SocketTimeoutException) { throw EspTransportException(if(cancelled) "SESSION_ENDED" else "REQUEST_TIMEOUT") }
            catch(_:Exception) { throw EspTransportException(if(cancelled || Thread.currentThread().isInterrupted) "SESSION_ENDED" else "WIFI_UNAVAILABLE") }
        }
    }
}

/** Validated light intent, mirroring LightPatchSchema. A timer patch carries timerMinutes only. */
data class LightPatch(val power:Boolean?=null,val hex:String?=null,val bright:Int?=null,val mode:Int?=null,val speed:Int?=null,val timerMinutes:Int?=null) {
    init {
        val present=listOfNotNull(power,hex,bright,mode,speed,timerMinutes).size
        val valid=present>0 && (timerMinutes==null || present==1) && (hex==null || HEX.matches(hex)) && (bright==null || bright in 1..100) &&
            (mode==null || mode in 0..8) && (speed==null || speed in 1..100) && (timerMinutes==null || timerMinutes in 0..720)
        if(!valid) throw BridgeFailure("BAD_PAYLOAD")
    }
    val isTimer:Boolean get()=timerMinutes!=null
    /** Latest value per touched ordinary field; untouched fields stay absent and are never resent. */
    internal fun mergedWith(newer:LightPatch):LightPatch {
        require(!isTimer && !newer.isTimer)
        return LightPatch(newer.power ?: power,newer.hex ?: hex,newer.bright ?: bright,newer.mode ?: mode,newer.speed ?: speed)
    }
    /** Compares only the ordinary fields this patch touched. */
    internal fun matches(s:EspStateValue):Boolean = (power==null || power==s.power) && (hex==null || hex.uppercase()==s.hex) &&
        (bright==null || bright==s.bright) && (mode==null || mode==s.mode) && (speed==null || speed==s.speed)
    /** Only allowlisted keys actually present in this validated patch, with explicit power values (never a toggle). */
    fun toQuery():String = buildList {
        power?.let{ add("power" to if(it) "1" else "0") }
        hex?.let{ add("hex" to it.substring(1).uppercase()) }
        bright?.let{ add("bright" to it.toString()) }
        mode?.let{ add("mode" to it.toString()) }
        speed?.let{ add("speed" to it.toString()) }
        timerMinutes?.let{ add("timer" to it.toString()) }
    }.joinToString("&") { (k,v) -> URLEncoder.encode(k,"UTF-8")+"="+URLEncoder.encode(v,"UTF-8") }
    companion object {
        private val HEX=Regex("#[0-9a-fA-F]{6}")
        fun fromJson(o:JsonObject):LightPatch {
            if(!ProtocolValidator.patch(o)) throw BridgeFailure("BAD_PAYLOAD")
            return LightPatch(o["power"]?.asBoolean,o["hex"]?.asString,o["bright"]?.asInt,o["mode"]?.asInt,o["speed"]?.asInt,o["timerMinutes"]?.asInt)
        }
    }
}

/** EspState after firmware conversion: 0/1 flags to booleans, RGB bytes to uppercase #RRGGBB. */
data class EspStateValue(val power:Boolean,val hex:String,val bright:Int,val mode:Int,val speed:Int,val timerSeconds:Int,val sensorOk:Boolean,
    val temperatureC:Double?,val humidityPercent:Double?,val uptimeSeconds:Long) {
    fun toJson():JsonObject=jsonObject("power" to power,"hex" to hex,"bright" to bright,"mode" to mode,"speed" to speed,"timerSeconds" to timerSeconds,
        "sensorOk" to sensorOk,"temperatureC" to temperatureC,"humidityPercent" to humidityPercent,"uptimeSeconds" to uptimeSeconds)
}
/** Firmware history: paired samples, oldest first, no absolute timestamps. */
class EspHistoryValue(val intervalSeconds:Double,val temperatureC:List<Double?>,val humidityPercent:List<Double?>) {
    /** Elapsed offsets relative to the newest sample (0 = newest); never invented wall-clock times. */
    fun sampleOffsetsSeconds():List<Double> = temperatureC.indices.map{ i -> (i-temperatureC.lastIndex)*intervalSeconds }
    fun toJson():JsonObject=jsonObject("intervalSeconds" to intervalSeconds,"temperatureC" to array(temperatureC),"humidityPercent" to array(humidityPercent))
    private fun array(values:List<Double?>)=JsonArray().also{ a -> values.forEach{ a.add(if(it==null) JsonNull.INSTANCE else JsonPrimitive(it)) } }
}

/** Strict parser for the existing firmware JSON. Everything it cannot vouch for is BAD_PAYLOAD. */
internal object EspParser {
    private val STATE_KEYS=setOf("power","r","g","b","bright","mode","speed","timer","ok","t","h","up")
    /** Known firmware fields that the dashboard does not use; anything else means this is not the controller. */
    private val IGNORED_KEYS=setOf("saved","hi","tmin","tmax","hmin","hmax","cl","favs")
    private fun bad():Nothing = throw EspTransportException("BAD_PAYLOAD")
    private fun parseObject(body:ByteArray):JsonObject {
        if(body.size>ESP_REPLY_BYTES) bad()
        return try {
            val text=Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(body)).toString()
            StrictJson.parse(text).takeIf{ it.isJsonObject }?.asJsonObject
        } catch(_:Exception) { null } ?: bad()
    }
    private fun number(e:JsonElement?):Double {
        if(e==null || !e.isJsonPrimitive || !e.asJsonPrimitive.isNumber) bad()
        return e.asDouble.takeIf{ it.isFinite() } ?: bad()
    }
    private fun integer(e:JsonElement?,min:Long,max:Long):Long {
        if(e==null || !e.isJsonPrimitive || !e.asJsonPrimitive.isNumber) bad()
        val d=e.asBigDecimal
        if(d.stripTrailingZeros().scale()>0 || d<min.toBigDecimal() || d>max.toBigDecimal()) bad()
        return d.toLong()
    }
    private fun nullableNumber(e:JsonElement?):Double? = if(e!=null && e.isJsonNull) null else number(e)
    private fun humidity(e:JsonElement?):Double? = nullableNumber(e)?.takeIf{ it in 0.0..100.0 }
    fun state(body:ByteArray):EspStateValue {
        val o=parseObject(body)
        if(!o.keySet().containsAll(STATE_KEYS) || !(STATE_KEYS+IGNORED_KEYS).containsAll(o.keySet())) bad()
        val r=integer(o["r"],0,255); val g=integer(o["g"],0,255); val b=integer(o["b"],0,255)
        // The firmware reports (deadline-now)/1000+1: 43201 right after a 720-minute set, briefly <=0 at expiry.
        val timer=integer(o["timer"],Int.MIN_VALUE.toLong(),Int.MAX_VALUE.toLong()).coerceIn(0,43200).toInt()
        return EspStateValue(power=integer(o["power"],0,1)==1L,hex="#%02X%02X%02X".format(r,g,b),bright=integer(o["bright"],1,100).toInt(),
            mode=integer(o["mode"],0,8).toInt(),speed=integer(o["speed"],1,100).toInt(),timerSeconds=timer,sensorOk=integer(o["ok"],0,1)==1L,
            temperatureC=nullableNumber(o["t"]),humidityPercent=humidity(o["h"]),uptimeSeconds=integer(o["up"],0,ProtocolValidator.MAX_SAFE))
    }
    fun history(body:ByteArray):EspHistoryValue {
        val o=parseObject(body)
        if(o.keySet()!=setOf("iv","t","h")) bad()
        val interval=number(o["iv"]).takeIf{ it>0 } ?: bad()
        val t=o["t"]; val h=o["h"]
        if(!t.isJsonArray || !h.isJsonArray) bad()
        val temps=t.asJsonArray; val hums=h.asJsonArray
        if(temps.size()!=hums.size() || temps.size()>120) bad()
        return EspHistoryValue(interval,temps.map{ nullableNumber(it) },hums.map{ humidity(it) })
    }
}

/** EspSnapshot: the link view plus the latest separate ordinary/timer outcomes. */
class EspSnapshot(val link:LinkSnapshot,val commands:Pair<CommandResult?,CommandResult?>) {
    fun toJson():JsonObject=link.toJson().also{ it.add("commands",jsonObject("state" to commands.first?.toJson(),"timer" to commands.second?.toJson())) }
}

/**
 * Activity-owned controller client. Its caches, receipt baselines and ControlQueue outlive every WebView renderer,
 * so renderer recreation keeps exact payload ages, command outcomes and the generation floor. All controller I/O
 * goes through one fair channel (the firmware serves one client at a time), always on the currently leased
 * network. A network change or pause cancels every live exchange and discards its result by epoch.
 */
class EspClient internal constructor(
    private val transport:EspTransport,
    private val clock:HubClock,
    scheduler:QueueScheduler,
    private val io:(Runnable)->Unit,
    private val onClose:()->Unit={},
):AutoCloseable {
    private class Flight(val epoch:Long) { val done=CountDownLatch(1) }
    private class Link(val staleMs:Long,val spacingMs:Long) {
        var data:JsonObject?=null; var receivedAt:Long?=null
        /** null: no result yet on this network/session; "OK": last attempt succeeded; else the last error code. */
        var outcome:String?=null
        var nextAttemptMs=Long.MIN_VALUE; var failures=0; var flight:Flight?=null
        fun resetBackoff() { nextAttemptMs=Long.MIN_VALUE; failures=0 }
    }
    private sealed interface Exchange { class Body(val bytes:ByteArray,val seq:Long):Exchange; class Failure(val code:String):Exchange; data object Busy:Exchange }

    private val lock=Any()
    private val channel=Semaphore(1,true)
    private var lease:NetworkLease?=null
    private var active=false
    private var closed=false
    private var epoch=0L
    private val calls=HashSet<EspCall>()
    private var exchangeSeq=0L
    private var stateSeq=0L
    private var lastUptime:Long?=null
    private val stateLink=Link(ESP_STALE_MS,ESP_STATE_SPACING_MS)
    private val historyLink=Link(ESP_HISTORY_STALE_MS,ESP_HISTORY_SPACING_MS)
    val queue=ControlQueue({ clock.monotonicMs() },scheduler,QueueIo())

    fun resume() { synchronized(lock) {
        if(closed || active) return
        active=true; epoch++
        for(link in listOf(stateLink,historyLink)) { link.resetBackoff(); link.outcome=if(lease==null) "WIFI_UNAVAILABLE" else null }
    } }
    /** Background/stop: cancel live exchanges, settle queued commands; nothing is replayed on resume. */
    fun pause() {
        val live=synchronized(lock) { active=false; epoch++; calls.toList() }
        live.forEach{ it.cancel() }
        queue.cancel()
    }
    override fun close() { synchronized(lock) { closed=true }; pause(); onClose() }

    /** WifiSession callback: a new selected network (or none). Old I/O is cancelled and its results discarded. */
    fun onNetworkChanged(next:NetworkLease?) {
        val live:List<EspCall>; val hadLease:Boolean
        synchronized(lock) {
            if(next===lease) return
            hadLease=lease!=null
            lease=next; epoch++
            live=calls.toList()
            for(link in listOf(stateLink,historyLink)) { link.resetBackoff(); link.outcome=if(next==null) "WIFI_UNAVAILABLE" else null }
        }
        live.forEach{ it.cancel() }
        if(hadLease) queue.onLinkLost("WIFI_UNAVAILABLE")
        if(next!=null) queue.onReconnect()
    }

    fun state():EspSnapshot = EspSnapshot(read(stateLink,EspRequest.state()) { body,seq,e -> recordState(EspParser.state(body),seq,e) },queue.latest("state") to queue.latest("timer"))
    fun history():LinkSnapshot = read(historyLink,EspRequest.history()) { body,_,e ->
        val data=EspParser.history(body).toJson()
        synchronized(lock) { if(epoch==e) recordLink(historyLink,data) }
    }
    internal fun submit(patch:LightPatch,generation:Long):CommandTicket {
        synchronized(lock) {
            if(closed || !active) throw BridgeFailure("SESSION_ENDED")
            if(lease==null) throw BridgeFailure("WIFI_UNAVAILABLE")
        }
        return queue.submit(patch,generation)
    }
    /** Bridge esp.set: wait a bounded time for the outcome; a still-pending result is reported as such. */
    fun set(patch:LightPatch,generation:Long,waitMs:Long=ESP_SET_WAIT_MS):CommandResult = submit(patch,generation).await(waitMs)

    /** Setup readiness: the controller answering on this exact network, never internet validation. */
    fun verify(target:NetworkLease,done:(Boolean)->Unit) {
        try {
            io(Runnable {
                var ok=false
                for(attempt in 0 until 3) {
                    val startedEpoch=synchronized(lock) { if(lease!==target || !active) null else epoch } ?: break
                    val result=exchange(target,EspRequest.state(),startedEpoch,ESP_READ_CHANNEL_WAIT_MS)
                    if(result is Exchange.Body && runCatching{ recordState(EspParser.state(result.bytes),result.seq,startedEpoch) }.isSuccess) { ok=true; break }
                    if(attempt<2) try { Thread.sleep(1000) } catch(_:InterruptedException) { Thread.currentThread().interrupt(); break }
                }
                done(ok)
            })
        } catch(_:RejectedExecutionException) { done(false) }
    }

    private fun view(link:Link):LinkSnapshot {
        val age=link.receivedAt?.let{ (clock.monotonicMs()-it).coerceAtLeast(0) }
        val error=when { link.outcome=="OK" -> null; link.outcome!=null -> link.outcome; lease==null -> "WIFI_UNAVAILABLE"; else -> null }
        val state=when { link.outcome=="OK" -> "connected"; error=="BAD_PAYLOAD" -> "error"; error!=null -> "disconnected"; else -> "connecting" }
        val stale=link.data==null || age==null || age>=link.staleMs
        return LinkSnapshot(state,if(link.data==null) null else age,stale,link.data,error)
    }
    private fun recordLink(link:Link,data:JsonObject) { link.data=data; link.receivedAt=clock.monotonicMs(); link.outcome="OK"; link.failures=0 }
    /** Records a state observation in wire order, only for the epoch (network/session) that produced it. */
    private fun recordState(value:EspStateValue,seq:Long,producedIn:Long) { synchronized(lock) {
        if(epoch!=producedIn || seq<=stateSeq) return // Stale epoch or an older observation never replaces a newer one.
        stateSeq=seq
        val previous=lastUptime
        if(previous!=null && value.uptimeSeconds<previous) {
            // Controller rebooted: history from the previous boot is no longer current.
            historyLink.data=null; historyLink.receivedAt=null; historyLink.resetBackoff()
        }
        lastUptime=value.uptimeSeconds
        recordLink(stateLink,value.toJson())
    } }
    private fun read(link:Link,request:EspRequest,record:(ByteArray,Long,Long)->Unit):LinkSnapshot {
        val flight:Flight; val target:NetworkLease; var joined:Flight?=null
        synchronized(lock) {
            if(closed || !active) return view(link)
            val current=link.flight
            if(current!=null) { joined=current; flight=current; target=lease ?: return view(link) }
            else {
                target=lease ?: return view(link)
                val now=clock.monotonicMs()
                if(now<link.nextAttemptMs) return view(link)
                flight=Flight(epoch); link.flight=flight; link.nextAttemptMs=now+link.spacingMs
            }
        }
        joined?.let {
            // Coalesce: a concurrent caller shares the single in-flight read of this operation (waits outside the lock).
            try { it.done.await(ESP_READ_CHANNEL_WAIT_MS+4000,TimeUnit.MILLISECONDS) } catch(_:InterruptedException) { Thread.currentThread().interrupt() }
            return synchronized(lock) { view(link) }
        }
        try {
            val result=exchange(target,request,flight.epoch,ESP_READ_CHANNEL_WAIT_MS)
            val failure:String?=when(result) {
                is Exchange.Body -> try { record(result.bytes,result.seq,flight.epoch); null } catch(e:EspTransportException) { e.code }
                is Exchange.Failure -> result.code
                Exchange.Busy -> null
            }
            synchronized(lock) {
                // A cancelled exchange (renderer teardown, pause, network change) says nothing about the link.
                if(failure!=null && failure!="SESSION_ENDED" && active && !closed && epoch==flight.epoch) {
                    link.outcome=failure; link.failures=(link.failures+1).coerceAtMost(BACKOFF_MS.size)
                    link.nextAttemptMs=clock.monotonicMs()+BACKOFF_MS[link.failures-1]
                }
                return view(link)
            }
        } finally {
            synchronized(lock) { if(link.flight===flight) link.flight=null }
            flight.done.countDown()
        }
    }
    /** One controller exchange on the serialized channel, valid only while its epoch and lease are current. */
    private fun exchange(target:NetworkLease,request:EspRequest,startedEpoch:Long,waitMs:Long):Exchange {
        try { if(!channel.tryAcquire(waitMs,TimeUnit.MILLISECONDS)) return Exchange.Busy }
        catch(_:InterruptedException) { Thread.currentThread().interrupt(); return Exchange.Failure("SESSION_ENDED") }
        try {
            val call:EspCall; val seq:Long
            synchronized(lock) {
                if(closed || !active || epoch!=startedEpoch || lease!==target) return Exchange.Failure("SESSION_ENDED")
                call=transport.newCall(target.network,request); calls.add(call); seq=++exchangeSeq
            }
            try {
                val body=call.execute().body
                synchronized(lock) { if(epoch!=startedEpoch) return Exchange.Failure("SESSION_ENDED") }
                return Exchange.Body(body,seq)
            } catch(e:EspTransportException) { return Exchange.Failure(e.code) }
            catch(_:Exception) { return Exchange.Failure("WIFI_UNAVAILABLE") }
            finally { synchronized(lock) { calls.remove(call) } }
        } finally { channel.release() }
    }
    private inner class QueueIo:ControlIo {
        private fun current():Pair<NetworkLease,Long>? = synchronized(lock) { lease?.takeIf{ active && !closed }?.let{ it to epoch } }
        override fun write(generation:Long,patch:LightPatch,done:(WriteResult)->Unit) {
            val (target,startedEpoch)=current() ?: return done(WriteResult.Failure("SESSION_ENDED"))
            try {
                io(Runnable {
                    val result=when(val r=exchange(target,EspRequest.set(patch),startedEpoch,ESP_WRITE_CHANNEL_WAIT_MS)) {
                        is Exchange.Body -> try { WriteResult.Response(EspParser.state(r.bytes).also{ recordState(it,r.seq,startedEpoch) }) } catch(e:EspTransportException) { WriteResult.Failure(e.code) }
                        is Exchange.Failure -> WriteResult.Failure(r.code)
                        Exchange.Busy -> WriteResult.Failure("REQUEST_TIMEOUT")
                    }
                    done(result)
                })
            } catch(_:RejectedExecutionException) { done(WriteResult.Failure("SESSION_ENDED")) }
        }
        override fun read(generation:Long,done:(EspStateValue?)->Unit) {
            val (target,startedEpoch)=current() ?: return done(null)
            try {
                io(Runnable {
                    val r=exchange(target,EspRequest.state(),startedEpoch,ESP_WRITE_CHANNEL_WAIT_MS)
                    done(if(r is Exchange.Body) runCatching{ EspParser.state(r.bytes).also{ recordState(it,r.seq,startedEpoch) } }.getOrNull() else null)
                })
            } catch(_:RejectedExecutionException) { done(null) }
        }
    }

    companion object {
        /** Production wiring: per-network transport, one scheduler thread and one I/O thread, both owned here. */
        fun create():EspClient {
            val timer=java.util.concurrent.ScheduledThreadPoolExecutor(1).apply{ removeOnCancelPolicy=true }
            val worker=java.util.concurrent.ThreadPoolExecutor(1,1,30,TimeUnit.SECONDS,java.util.concurrent.LinkedBlockingQueue(16)).apply{ allowCoreThreadTimeOut(true) }
            val scheduler=QueueScheduler { delay,task -> val f=timer.schedule({ task() },delay.coerceAtLeast(0),TimeUnit.MILLISECONDS); { f.cancel(false); Unit } }
            return EspClient(NetworkEspTransport(),SystemHubClock,scheduler,{ worker.execute(it) },{ timer.shutdownNow(); worker.shutdownNow() })
        }
    }
}
