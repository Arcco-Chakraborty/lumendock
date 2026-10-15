package com.phonemonitor

import com.google.gson.JsonObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Ordinary patches coalesce for this long after their unit is created; timer barriers dispatch at once. */
internal const val COALESCE_MS=150L
/** Spacing between dispatch starts: never more than four dispatched writes in any one-second window. */
internal const val WRITE_SPACING_MS=250L
/** At most four unsent units plus the single in-flight write. */
internal const val MAX_UNSENT_UNITS=4
/** A timer reply this many seconds below the requested duration still confirms it (reply latency). */
internal const val TIMER_SLACK_SECONDS=5

/** Monotonic scheduler seam. Production uses one scheduled thread; JVM tests advance a fake clock. */
fun interface QueueScheduler { fun schedule(delayMs:Long,task:()->Unit):()->Unit }

/** The controller I/O the queue drives. Each callback must be invoked at most once, on any thread. */
interface ControlIo {
    fun write(generation:Long,patch:LightPatch,done:(WriteResult)->Unit)
    /** A state read begun now, i.e. after the write it reconciles was dispatched. null: the read failed. */
    fun read(generation:Long,done:(EspStateValue?)->Unit)
}
sealed interface WriteResult {
    class Response(val state:EspStateValue):WriteResult
    class Failure(val code:String):WriteResult
}

/** Mirrors CommandResultSchema: a confirmed outcome always carries the observed state. */
class CommandResult(val generation:Long,val kind:String,val outcome:String,val state:EspStateValue?,val errorCode:String?) {
    init { require(outcome!="confirmed" || state!=null) }
    fun toJson():JsonObject=jsonObject("generation" to generation,"kind" to kind,"outcome" to outcome,"state" to state?.toJson(),"errorCode" to errorCode)
}

/** One accepted command's callback. Settles exactly once; await returns the current (possibly pending) result. */
class CommandTicket internal constructor(initial:CommandResult) {
    private val done=CountDownLatch(1)
    @Volatile private var result=initial
    val settled:Boolean get()=done.count==0L
    internal fun settle(value:CommandResult) { synchronized(this) { if(settled) return; result=value; done.countDown() } }
    fun await(ms:Long):CommandResult {
        if(ms>0) try { done.await(ms,TimeUnit.MILLISECONDS) } catch(_:InterruptedException) { Thread.currentThread().interrupt() }
        return result
    }
}

/** Latest user intent per ordinary field. Observations (polls, acknowledgements) never erase it. */
class DesiredLight(val power:Boolean?,val hex:String?,val bright:Int?,val mode:Int?,val speed:Int?)

/**
 * Native owner of light-command ordering and reconciliation. One write is in flight at a time; adjacent unsent
 * ordinary patches merge per field (never across a timer barrier); timers are once-only barriers. Nothing is ever
 * resent automatically: link loss/teardown cancels unsent units, and an uncertain write stays unconfirmed until the
 * user explicitly retries with a new generation. The newest generation of each kind is the reporting floor, so an
 * older acknowledgement cannot replace newer intent.
 */
class ControlQueue(private val clock:()->Long,private val scheduler:QueueScheduler,private val io:ControlIo) {
    private class Pending(var patch:LightPatch,var generation:Long,var ticket:CommandTicket,val createdAt:Long) {
        val kind get()=if(patch.isTimer) "timer" else "state"
    }
    private val lock=Any()
    private val unsent=ArrayDeque<Pending>()
    private var inflight:Pending?=null
    private var dispatchToken=0L
    private var awaitingRead=false
    private var lastDispatchAt:Long?=null
    private var maxGeneration=0L
    private val latest=HashMap<String,CommandResult>()
    private val desiredFields=HashMap<String,Any>()
    private var error:String?=null
    private var wakeCancel:(()->Unit)?=null
    private var wakeAt=Long.MAX_VALUE
    private var wakeSeq=0L

    val desired:DesiredLight get()=synchronized(lock) {
        DesiredLight(desiredFields["power"] as Boolean?,desiredFields["hex"] as String?,desiredFields["bright"] as Int?,desiredFields["mode"] as Int?,desiredFields["speed"] as Int?)
    }
    val hasPendingIntent:Boolean get()=synchronized(lock) { inflight!=null || unsent.isNotEmpty() }
    val lastError:String? get()=synchronized(lock) { error }
    val unsentCount:Int get()=synchronized(lock) { unsent.size }
    fun latest(kind:String):CommandResult?=synchronized(lock) { latest[kind] }

    fun submit(patch:LightPatch,generation:Long):CommandTicket {
        val actions:List<()->Unit>
        val ticket:CommandTicket
        synchronized(lock) {
            if(generation<1 || generation>ProtocolValidator.MAX_SAFE || generation<=maxGeneration) throw BridgeFailure("BAD_GENERATION")
            val kind=if(patch.isTimer) "timer" else "state"
            val powerOff=patch.power==false
            val remaining=if(powerOff) unsent.filter{ it.kind!="timer" } else unsent.toList()
            val tail=remaining.lastOrNull()
            val merge=kind=="state" && tail!=null && tail.kind=="state"
            // Rejection happens before any mutation, so a refused action never disturbs accepted ones.
            if(!merge && remaining.size>=MAX_UNSENT_UNITS) throw BridgeFailure("QUEUE_FULL")
            maxGeneration=generation
            if(powerOff) unsent.filter{ it.kind=="timer" }.forEach { t -> unsent.remove(t); settleUnsent(t,"cancelled",null) }
            ticket=CommandTicket(CommandResult(generation,kind,"pending",null,null))
            if(kind=="state") {
                patch.power?.let{ desiredFields["power"]=it }; patch.hex?.let{ desiredFields["hex"]=it.uppercase() }
                patch.bright?.let{ desiredFields["bright"]=it }; patch.mode?.let{ desiredFields["mode"]=it }; patch.speed?.let{ desiredFields["speed"]=it }
            }
            if(merge) {
                tail!!.ticket.settle(CommandResult(tail.generation,"state","superseded",null,null))
                tail.patch=tail.patch.mergedWith(patch); tail.generation=generation; tail.ticket=ticket
            } else unsent.addLast(Pending(patch,generation,ticket,clock()))
            latest[kind]=CommandResult(generation,kind,"pending",null,null)
            actions=pumpLocked()
        }
        actions.forEach{ it() }
        return ticket
    }

    /** A post-dispatch observation for the in-flight generation; anything else (older/superseded) is ignored. */
    fun acknowledge(generation:Long,state:EspStateValue) {
        val token=synchronized(lock) { if(inflight?.generation==generation) dispatchToken else return }
        onWrite(token,WriteResult.Response(state))
    }
    /** Selected network lost: in-flight becomes unconfirmed, unsent units are cancelled, nothing is replayed. */
    fun onLinkLost(code:String="WIFI_UNAVAILABLE") { synchronized(lock) {
        wakeCancel?.invoke(); wakeCancel=null; wakeAt=Long.MAX_VALUE
        inflight?.let{ settleInflight(it,unconfirmed(it,null)) }
        unsent.toList().forEach{ settleUnsent(it,"cancelled",code) }
        unsent.clear(); desiredFields.clear()
    } }
    /** A new network or foreground session starts clean. Deliberately does not resend anything. */
    fun onReconnect() { /* No replay: an explicit user retry is a new generation. */ }
    /** Lifecycle teardown (background/end session). */
    fun cancel() { onLinkLost("SESSION_ENDED") }

    private fun settleUnsent(u:Pending,outcome:String,code:String?) {
        val result=CommandResult(u.generation,u.kind,outcome,null,code)
        u.ticket.settle(result)
        if(latest[u.kind]?.generation==u.generation) latest[u.kind]=result
    }
    private fun unconfirmed(u:Pending,state:EspStateValue?)=CommandResult(u.generation,u.kind,"unconfirmed",state,"COMMAND_UNCONFIRMED")
    private fun evaluate(u:Pending,state:EspStateValue):CommandResult {
        val ok=if(u.patch.isTimer) {
            val minutes=u.patch.timerMinutes!!
            if(minutes==0) state.timerSeconds==0 else state.timerSeconds in (minutes*60-TIMER_SLACK_SECONDS)..(minutes*60+1)
        } else u.patch.matches(state)
        return if(ok) CommandResult(u.generation,u.kind,"confirmed",state,null) else unconfirmed(u,state)
    }
    private fun settleInflight(u:Pending,result:CommandResult) {
        u.ticket.settle(result)
        inflight=null; awaitingRead=false; dispatchToken++
        error=result.errorCode
        if(latest[u.kind]?.generation==u.generation) latest[u.kind]=result
        // The firmware clears its sleep timer on power-off, so a confirmed later power-off resolves an uncertain timer.
        if(result.outcome=="confirmed" && u.kind=="state" && u.patch.power==false) {
            val timer=latest["timer"]
            if(timer!=null && timer.outcome=="unconfirmed" && timer.generation<u.generation) latest["timer"]=CommandResult(timer.generation,"timer","cancelled",null,null)
        }
    }
    private fun onWrite(token:Long,result:WriteResult) {
        val actions=mutableListOf<()->Unit>()
        synchronized(lock) {
            val u=inflight
            if(u==null || token!=dispatchToken || awaitingRead) return
            when(result) {
                is WriteResult.Response -> settleInflight(u,evaluate(u,result.state))
                is WriteResult.Failure -> if(u.kind=="state" && result.code!="SESSION_ENDED") {
                    // Reconcile with a read begun after this dispatch; only touched ordinary fields are compared.
                    awaitingRead=true
                    val generation=u.generation
                    actions.add { io.read(generation) { state -> onRead(token,state) } }
                } else settleInflight(u,unconfirmed(u,null)) // A timer without its reply stays uncertain.
            }
            if(!awaitingRead) actions.addAll(pumpLocked())
        }
        actions.forEach{ it() }
    }
    private fun onRead(token:Long,state:EspStateValue?) {
        val actions:List<()->Unit>
        synchronized(lock) {
            val u=inflight
            if(u==null || token!=dispatchToken || !awaitingRead) return
            settleInflight(u,if(state!=null && u.patch.matches(state)) CommandResult(u.generation,u.kind,"confirmed",state,null) else unconfirmed(u,state))
            actions=pumpLocked()
        }
        actions.forEach{ it() }
    }
    /** Must hold the lock. Returns I/O to run after releasing it. */
    private fun pumpLocked():List<()->Unit> {
        if(inflight!=null) return emptyList()
        val head=unsent.firstOrNull() ?: return emptyList()
        val now=clock()
        val readyAt=maxOf(if(head.kind=="timer") head.createdAt else head.createdAt+COALESCE_MS,lastDispatchAt?.plus(WRITE_SPACING_MS) ?: Long.MIN_VALUE)
        if(now<readyAt) { scheduleWakeLocked(readyAt,now); return emptyList() }
        unsent.removeFirst(); inflight=head; lastDispatchAt=now
        val token=++dispatchToken
        val generation=head.generation; val patch=head.patch
        return listOf { io.write(generation,patch) { result -> onWrite(token,result) } }
    }
    private fun scheduleWakeLocked(at:Long,now:Long) {
        if(wakeCancel!=null && wakeAt<=at) return
        wakeCancel?.invoke()
        val seq=++wakeSeq; wakeAt=at
        wakeCancel=scheduler.schedule(at-now) { onWake(seq) }
    }
    private fun onWake(seq:Long) {
        val actions=synchronized(lock) {
            if(seq!=wakeSeq) return
            wakeCancel=null; wakeAt=Long.MAX_VALUE
            pumpLocked()
        }
        actions.forEach{ it() }
    }
}
