package com.phonemonitor

import com.google.gson.JsonObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.SocketTimeoutException
import java.net.URL
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Clock seam: wall time is exposed for diagnostics only; every age, backoff and stale decision is monotonic. */
interface HubClock { fun epochMs():Long; fun monotonicMs():Long }
object SystemHubClock:HubClock {
    override fun epochMs()=System.currentTimeMillis()
    override fun monotonicMs()=android.os.SystemClock.elapsedRealtime()
}

internal const val HUB_REPLY_BYTES=256*1024
internal const val LAPTOP_STALE_MS=6000L
internal const val HEALTHY_SPACING_MS=1000L
internal val BACKOFF_MS=longArrayOf(1000,2000,4000,8000,15000)
/** A joining caller waits at most this long; below the ten-second bridge deadline. */
internal const val JOIN_WAIT_MS=6000L

/** The only two hub endpoints. Fixed loopback origin; there is no URL argument anywhere. */
enum class HubPath(val url:String,val method:String) {
    SNAPSHOT("http://127.0.0.1:8765/v1/snapshot","GET"),
    PAIR("http://127.0.0.1:8765/v1/pair","POST"),
    ACTION("http://127.0.0.1:8765/v1/action","POST"),
}
/** The bearer lives only here and in native storage. toString never renders it. */
internal class HubRequest(val path:HubPath,val bearer:String?,val body:ByteArray?=null) {
    fun headers():Map<String,String> = buildMap {
        put("Accept","application/json"); put("Accept-Encoding","identity")
        // No pooled connection: a stale pooled socket must never cause a silent POST retry that burns a pairing attempt.
        put("Connection","close")
        if(bearer!=null) put("Authorization","Bearer $bearer")
        if(body!=null) put("Content-Type","application/json")
    }
    override fun toString()="HubRequest(${path.name})"
}
internal class HubResponse(val status:Int,val body:ByteArray)
/** Carries only a fixed protocol code; underlying exceptions are dropped so no request detail can leak. */
internal class HubTransportException(val code:String):IOException(code)
internal interface HubCall { fun execute():HubResponse; fun cancel() }
internal interface HubTransport { fun newCall(request:HubRequest):HubCall }

/**
 * Ordinary, unbound loopback HTTP: no Network/socket factory, no process binding, and NO_PROXY so a system
 * proxy never sees the bearer. 2 s connect, 3 s read, total call budget, no redirects, 256 KiB reply budget.
 */
internal class LoopbackHubTransport(
    private val clock:HubClock=SystemHubClock,
    val connectTimeoutMs:Int=2000,
    val readTimeoutMs:Int=3000,
    private val callBudgetMs:Long=5000,
    private val open:(URL)->HttpURLConnection={ it.openConnection(Proxy.NO_PROXY) as HttpURLConnection },
):HubTransport {
    override fun newCall(request:HubRequest):HubCall = Call(request)
    private inner class Call(private val request:HubRequest):HubCall {
        @Volatile private var connection:HttpURLConnection?=null
        @Volatile private var cancelled=false
        override fun cancel() { cancelled=true; try { connection?.disconnect() } catch(_:RuntimeException) { /* already closed */ } }
        private fun checkLive(started:Long) {
            if(cancelled || Thread.currentThread().isInterrupted) throw HubTransportException("SESSION_ENDED")
            if(clock.monotonicMs()-started>callBudgetMs) throw HubTransportException("REQUEST_TIMEOUT")
        }
        override fun execute():HubResponse {
            val started=clock.monotonicMs()
            checkLive(started)
            try {
                val c=open(URL(request.path.url)); connection=c
                try {
                    checkLive(started)
                    c.connectTimeout=connectTimeoutMs; c.readTimeout=readTimeoutMs
                    c.instanceFollowRedirects=false; c.useCaches=false; c.allowUserInteraction=false
                    c.requestMethod=request.path.method
                    request.headers().forEach{ (k,v) -> c.setRequestProperty(k,v) }
                    request.body?.let { body -> c.doOutput=true; c.setFixedLengthStreamingMode(body.size); c.outputStream.use{ it.write(body) } }
                    val status=c.responseCode
                    checkLive(started)
                    if(status !in 100..599 || status in 300..399) throw HubTransportException("BAD_PAYLOAD")
                    val declared=c.getHeaderField("Content-Length")?.trim()?.let{ it.toLongOrNull() ?: throw HubTransportException("BAD_PAYLOAD") }
                    if(declared!=null && (declared<0 || declared>HUB_REPLY_BYTES)) throw HubTransportException("BAD_PAYLOAD")
                    val stream=if(status in 200..299) c.inputStream else c.errorStream
                    val out=ByteArrayOutputStream()
                    stream?.use { input ->
                        val buffer=ByteArray(8192)
                        while(true) {
                            checkLive(started)
                            val n=input.read(buffer); if(n<0) break
                            if(out.size()+n>HUB_REPLY_BYTES) throw HubTransportException("BAD_PAYLOAD")
                            out.write(buffer,0,n)
                        }
                    }
                    checkLive(started)
                    if(declared!=null && declared!=out.size().toLong()) throw HubTransportException("BAD_PAYLOAD")
                    return HubResponse(status,out.toByteArray())
                } finally { connection=null; c.disconnect() }
            } catch(e:HubTransportException) { throw e }
            catch(_:SocketTimeoutException) { throw HubTransportException(if(cancelled) "SESSION_ENDED" else "REQUEST_TIMEOUT") }
            catch(_:Exception) { throw HubTransportException(if(cancelled || Thread.currentThread().isInterrupted) "SESSION_ENDED" else "USB_UNAVAILABLE") }
        }
    }
}

/** Native-internal pairing outcome. Never carries the token; never crosses the bridge. */
data class PairResult(val paired:Boolean,val errorCode:String?=null)

/** LinkSnapshot<HubSnapshot>: data is a ProtocolValidator-checked HubSnapshot, defensively copied. */
class LinkSnapshot internal constructor(val state:String,val ageMs:Long?,val stale:Boolean,data:JsonObject?,val errorCode:String?) {
    private val payload=data?.deepCopy()
    val data:JsonObject? get()=payload?.deepCopy()
    fun toJson():JsonObject = jsonObject("state" to state,"ageMs" to ageMs,"stale" to stale,"data" to payload?.deepCopy(),"errorCode" to errorCode)
}

/**
 * Activity-owned hub client. Its cache and receipt baseline are independent of every WebView renderer, so
 * renderer recreation keeps the exact payload and its age. One snapshot and one pairing request at most.
 */
class LaptopClient internal constructor(
    private val store:PairingStore,
    private val transport:HubTransport,
    private val clock:HubClock,
    private val onPairedChanged:(Boolean)->Unit={},
):AutoCloseable {
    constructor(store:PairingStore,onPairedChanged:(Boolean)->Unit):this(store,LoopbackHubTransport(),SystemHubClock,onPairedChanged)

    private class Flight(val call:HubCall,val epoch:Long,val token:String) { val done=CountDownLatch(1) }
    private sealed interface Outcome { data class Data(val data:JsonObject):Outcome; data object Rejected:Outcome; data class Failure(val code:String):Outcome }

    private val lock=Any()
    private var tokenLoaded=false
    private var token:String?=null
    private var cached:JsonObject?=null
    private var receivedAtMs:Long?=null
    /** null: no result in this foreground session yet; "OK": last attempt succeeded; else the last error code. */
    private var outcome:String?=null
    private var active=false
    private var closed=false
    private var epoch=0L
    private var snapshotFlight:Flight?=null
    private var pairCall:HubCall?=null
    private var nextAttemptMs=Long.MIN_VALUE
    private var failures=0

    val paired:Boolean get()=synchronized(lock){ loadToken(); token!=null }

    private fun loadToken() {
        if(tokenLoaded) return
        tokenLoaded=true
        token=try { store.getToken()?.takeIf{ TOKEN_PATTERN.matches(it) } } catch(_:Exception) { null }
    }
    /** Foreground entry: polling is allowed again and the first poll goes out immediately. */
    fun resume() = synchronized(lock) {
        if(closed || active) return@synchronized
        active=true; nextAttemptMs=Long.MIN_VALUE; failures=0
        if(outcome!="AUTH_REQUIRED") outcome=null
    }
    /** Background/stop: cancel owned requests; late results of this epoch are discarded. */
    fun pause() {
        val calls=synchronized(lock) { active=false; epoch++; listOfNotNull(snapshotFlight?.call,pairCall) }
        calls.forEach{ it.cancel() }
    }
    override fun close() { synchronized(lock){ closed=true }; pause() }

    private fun view():LinkSnapshot {
        loadToken()
        val age=receivedAtMs?.let{ (clock.monotonicMs()-it).coerceAtLeast(0) }
        val error=when { outcome=="OK" -> null; outcome!=null -> outcome; token==null -> "AUTH_REQUIRED"; else -> null }
        val state=when {
            outcome=="OK" -> "connected"
            error=="AUTH_REQUIRED" || error=="BAD_PAYLOAD" -> "error"
            error!=null -> "disconnected"
            else -> "connecting"
        }
        val stale=cached==null || age==null || age>=LAPTOP_STALE_MS || error=="AUTH_REQUIRED"
        return LinkSnapshot(state,if(cached==null) null else age,stale,cached,error)
    }

    fun snapshot():LinkSnapshot {
        val flight:Flight; val owner:Boolean
        synchronized(lock) {
            loadToken()
            if(closed || !active) return view()
            val current=snapshotFlight
            if(current!=null) { flight=current; owner=false }
            else {
                val bearer=token ?: return view()
                val now=clock.monotonicMs()
                if(now<nextAttemptMs) return view()
                flight=Flight(transport.newCall(HubRequest(HubPath.SNAPSHOT,bearer)),epoch,bearer)
                snapshotFlight=flight; owner=true
                nextAttemptMs=now+HEALTHY_SPACING_MS
            }
        }
        if(!owner) {
            // Coalesce: a concurrent caller shares the single in-flight request instead of opening another.
            try { flight.done.await(JOIN_WAIT_MS,TimeUnit.MILLISECONDS) } catch(_:InterruptedException) { Thread.currentThread().interrupt() }
            return synchronized(lock){ view() }
        }
        return run(flight)
    }

    private fun run(flight:Flight):LinkSnapshot {
        var pairedChanged=false
        try {
            val result:Outcome=try { interpret(flight.call.execute(),flight.token) } catch(e:HubTransportException) { Outcome.Failure(e.code) } catch(_:Exception) { Outcome.Failure("USB_UNAVAILABLE") }
            return synchronized(lock) {
                if(snapshotFlight===flight) snapshotFlight=null
                if(!closed && active && epoch==flight.epoch) {
                    val now=clock.monotonicMs()
                    when(result) {
                        is Outcome.Data -> { cached=result.data; receivedAtMs=now; outcome="OK"; failures=0 }
                        is Outcome.Rejected -> if(token==flight.token) {
                            // The hub positively rejected this exact credential: drop it and stop polling until explicit re-pairing.
                            token=null; outcome="AUTH_REQUIRED"; pairedChanged=true
                            try { store.clearToken() } catch(_:Exception) { /* in-memory credential is already gone */ }
                        }
                        // A cancelled/interrupted request (renderer teardown, bridge deadline) says nothing about the link.
                        is Outcome.Failure -> if(result.code!="SESSION_ENDED") {
                            outcome=result.code; failures=(failures+1).coerceAtMost(BACKOFF_MS.size)
                            nextAttemptMs=now+BACKOFF_MS[failures-1]
                        }
                    }
                }
                view()
            }
        } finally {
            // Always free the single flight slot and release joiners, even on an unexpected Error.
            synchronized(lock) { if(snapshotFlight===flight) snapshotFlight=null }
            flight.done.countDown()
            if(pairedChanged) onPairedChanged(false)
        }
    }
    private fun interpret(response:HubResponse,bearer:String):Outcome {
        if(response.status==401) return if(isHubError(response.body,"AUTH_REQUIRED")) Outcome.Rejected else Outcome.Failure("BAD_PAYLOAD")
        if(response.status in 500..599) return Outcome.Failure("HUB_UNAVAILABLE")
        if(response.status!=200) return Outcome.Failure("BAD_PAYLOAD")
        val data=parseObject(response.body) ?: return Outcome.Failure("BAD_PAYLOAD")
        if(!ProtocolValidator.hubSnapshot(data)) return Outcome.Failure("BAD_PAYLOAD")
        // Byte-safe redaction: an echoed credential (raw, escaped or re-cased) rejects the whole payload.
        if(containsSecret(response.body,bearer) || containsSecret(data.toString().toByteArray(Charsets.UTF_8),bearer)) return Outcome.Failure("BAD_PAYLOAD")
        return Outcome.Data(data)
    }

    /** Called only from the native code-entry flow; JS never supplies the code or receives the token. */
    fun pair(code:String):PairResult {
        if(!PAIRING_CODE.matches(code)) return PairResult(false,"BAD_PAIRING_CODE")
        val call:HubCall; val started:Long
        synchronized(lock) {
            if(closed || !active) return PairResult(false,"SESSION_ENDED")
            if(pairCall!=null) return PairResult(false,"SETUP_BUSY")
            call=transport.newCall(HubRequest(HubPath.PAIR,null,"""{"code":"$code"}""".toByteArray(Charsets.UTF_8)))
            pairCall=call; started=epoch
        }
        val result=try { interpretPair(call.execute()) } catch(e:HubTransportException) { PairOutcome(null,e.code) } catch(_:Exception) { PairOutcome(null,"USB_UNAVAILABLE") }
            finally { synchronized(lock) { if(pairCall===call) pairCall=null } }
        val fresh=result.token
        val final=synchronized(lock) {
            if(fresh==null) return PairResult(false,if(result.error=="SESSION_ENDED" || epoch!=started) "SESSION_ENDED" else result.error)
            // The hub has already rotated to this token, so a fully received token is kept even if a stop raced it.
            try { store.setToken(fresh) } catch(_:Exception) { return PairResult(false,"TOKEN_PERSIST_FAILED") }
            tokenLoaded=true; token=fresh; outcome=null; failures=0; nextAttemptMs=Long.MIN_VALUE
            PairResult(true)
        }
        onPairedChanged(true)
        return final
    }
    private class PairOutcome(val token:String?,val error:String)
    private fun interpretPair(response:HubResponse):PairOutcome {
        if(response.status==200) {
            val o=parseObject(response.body) ?: return PairOutcome(null,"BAD_PAYLOAD")
            val t=o["token"]
            if(o.keySet()!=setOf("token") || !t.isJsonPrimitive || !t.asJsonPrimitive.isString || !TOKEN_PATTERN.matches(t.asString)) return PairOutcome(null,"BAD_PAYLOAD")
            return PairOutcome(t.asString,"")
        }
        val code=when {
            response.status==403 && isHubError(response.body,"PAIRING_EXPIRED") -> "PAIRING_EXPIRED"
            response.status==403 && isHubError(response.body,"PAIRING_CLOSED") -> "PAIRING_CLOSED"
            response.status==503 && isHubError(response.body,"TOKEN_PERSIST_FAILED") -> "TOKEN_PERSIST_FAILED"
            // The hub answers a wrong code with 400 BAD_PAYLOAD and counts the attempt.
            response.status==400 && isHubError(response.body,"BAD_PAYLOAD") -> "BAD_PAIRING_CODE"
            response.status in 500..599 -> "HUB_UNAVAILABLE"
            else -> "BAD_PAYLOAD"
        }
        return PairOutcome(null,code)
    }

    fun action(actionName:String):JsonObject {
        val bearer=store.getToken() ?: token ?: throw HubTransportException("AUTH_REQUIRED")
        val payload=jsonObject("action" to actionName).toString().toByteArray(Charsets.UTF_8)
        val request=HubRequest(HubPath.ACTION,bearer,payload)
        val call=transport.newCall(request)
        val response=try { call.execute() } catch(e:IOException) { throw HubTransportException("USB_UNAVAILABLE") }
        if(response.status==401) throw HubTransportException("AUTH_REQUIRED")
        if(response.status!=200) throw HubTransportException("BAD_PAYLOAD")
        val parsed=parseObject(response.body)
        return parsed?.getAsJsonObject("data") ?: jsonObject("success" to true)
    }

    private fun parseObject(body:ByteArray):JsonObject? = try {
        if(body.size>HUB_REPLY_BYTES) null else {
            val text=Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(body)).toString()
            StrictJson.parse(text).takeIf{ it.isJsonObject }?.asJsonObject
        }
    } catch(_:Exception) { null }
    private fun isHubError(body:ByteArray,code:String):Boolean {
        val o=parseObject(body) ?: return false
        val e=o["error"]
        return o.keySet()==setOf("v","error") && o["v"].toString()=="1" && e.isJsonObject && e.asJsonObject.keySet()==setOf("code") &&
            e.asJsonObject["code"].let{ it.isJsonPrimitive && it.asJsonPrimitive.isString && it.asString==code }
    }

    internal companion object {
        val TOKEN_PATTERN=Regex("[a-f0-9]{64}")
        val PAIRING_CODE=Regex("[0-9]{8}")
        /** Case-insensitive byte search, so the check does not depend on any charset decoding. */
        fun containsSecret(haystack:ByteArray,secret:String):Boolean {
            val needle=secret.lowercase().toByteArray(Charsets.US_ASCII)
            if(needle.isEmpty() || haystack.size<needle.size) return false
            outer@ for(i in 0..haystack.size-needle.size) {
                for(j in needle.indices) {
                    val b=haystack[i+j].toInt().let{ if(it in 'A'.code..'Z'.code) it+32 else it }
                    if(b!=needle[j].toInt()) continue@outer
                }
                return true
            }
            return false
        }
    }
}
