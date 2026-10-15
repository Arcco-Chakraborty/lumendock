package com.phonemonitor

import org.junit.Assert.*
import org.junit.Test

/** Deterministic monotonic scheduler: tasks run only when the test advances time. */
internal class ManualScheduler(private val clock:TestClock):QueueScheduler {
    private class Task(val at:Long,val seq:Long,val run:()->Unit) { @Volatile var cancelled=false }
    private val tasks=mutableListOf<Task>()
    private var seq=0L
    @Synchronized override fun schedule(delayMs:Long,task:()->Unit):()->Unit {
        val t=Task(clock.mono+delayMs.coerceAtLeast(0),seq++,task); tasks.add(t)
        return { t.cancelled=true }
    }
    fun advance(ms:Long) {
        val end=clock.mono+ms
        while(true) {
            val next=synchronized(this) { tasks.filter{!it.cancelled && it.at<=end}.minWithOrNull(compareBy<Task>({it.at},{it.seq}))?.also{tasks.remove(it)} } ?: break
            if(next.at>clock.mono) clock.mono=next.at
            next.run()
        }
        clock.mono=end
    }
}

/** Records every dispatched controller write; completions are driven explicitly by the test. */
internal class FakeControlIo(private val clock:TestClock):ControlIo {
    class Write(val generation:Long,val patch:LightPatch,val at:Long,val done:(WriteResult)->Unit)
    val writes=mutableListOf<Write>()
    val reads=mutableListOf<Pair<Long,(EspStateValue?)->Unit>>()
    var auto:((LightPatch)->WriteResult)?=null
    override fun write(generation:Long,patch:LightPatch,done:(WriteResult)->Unit) {
        writes.add(Write(generation,patch,clock.mono,done)); auto?.let{ done(it(patch)) }
    }
    override fun read(generation:Long,done:(EspStateValue?)->Unit) { reads.add(generation to done) }
    val timerWriteCount get()=writes.count{ it.patch.isTimer }
    fun respond(state:EspStateValue) = writes.last().done(WriteResult.Response(state))
    fun completeWithTimeout() = writes.last().done(WriteResult.Failure("REQUEST_TIMEOUT"))
    fun answerRead(state:EspStateValue?) { reads.removeAt(0).second(state) }
}

internal fun stateWith(power:Boolean=true,hex:String="#12ABEF",bright:Int=75,mode:Int=0,speed:Int=50,timerSeconds:Int=0)=
    EspStateValue(power,hex,bright,mode,speed,timerSeconds,true,24.5,55.0,1234)
internal fun stateWithBrightness(b:Int)=stateWith(bright=b)
/** Applies a patch to the previous state the way the firmware does, for automatic fake responses. */
internal fun EspStateValue.applied(p:LightPatch)=copy(power=p.power ?: power,hex=p.hex?.uppercase() ?: hex,bright=p.bright ?: bright,mode=p.mode ?: mode,
    speed=p.speed ?: speed,timerSeconds=p.timerMinutes?.let{ it*60 } ?: if(p.power==false) 0 else timerSeconds)

class ControlQueueTest {
    private val clock=TestClock()
    private val scheduler=ManualScheduler(clock)
    private val transport=FakeControlIo(clock)
    private val queue=ControlQueue({ clock.mono },scheduler,transport)

    @Test fun timerIsNeverAutomaticallyReplayedAfterTimeout() {
        queue.submit(LightPatch(timerMinutes=30),generation=1)
        transport.completeWithTimeout()
        clock.advanceMonotonic(15000)
        queue.onReconnect()
        scheduler.advance(60_000)
        assertEquals(1,transport.timerWriteCount)
        assertEquals("COMMAND_UNCONFIRMED",queue.lastError)
        val timer=queue.latest("timer")!!
        assertEquals("unconfirmed",timer.outcome); assertEquals(1L,timer.generation)
        assertTrue("A timer without its response is never reconciled by a later read",transport.reads.isEmpty())
    }
    @Test fun olderAcknowledgementCannotReplaceNewerIntent() {
        queue.submit(LightPatch(bright=20),1)
        queue.submit(LightPatch(bright=80),2)
        queue.acknowledge(generation=1,state=stateWithBrightness(20))
        assertEquals(80,queue.desired.bright)
        assertTrue(queue.hasPendingIntent)
        assertEquals("pending",queue.latest("state")!!.outcome); assertEquals(2L,queue.latest("state")!!.generation)
    }
    @Test fun olderInFlightAcknowledgementSettlesOnlyItselfAndCannotLowerTheFloor() {
        val first=queue.submit(LightPatch(bright=20),1)
        scheduler.advance(150)
        assertEquals(1,transport.writes.size)
        queue.submit(LightPatch(bright=80),2)
        queue.acknowledge(1,stateWithBrightness(20))
        assertEquals("confirmed",first.await(0).outcome)
        val latest=queue.latest("state")!!
        assertEquals(2L,latest.generation); assertEquals("pending",latest.outcome)
        assertEquals(80,queue.desired.bright); assertTrue(queue.hasPendingIntent)
        scheduler.advance(250); transport.respond(stateWithBrightness(80))
        assertEquals("confirmed",queue.latest("state")!!.outcome)
        assertFalse(queue.hasPendingIntent)
    }
    @Test fun rapidDragCoalescesToAtMostFourWritesPerSecondAndRetainsFinalRelease() {
        var model=stateWith(bright=1)
        transport.auto={ p -> model=model.applied(p); WriteResult.Response(model) }
        var generation=1L
        val tickets=mutableListOf<CommandTicket>()
        for(i in 0 until 180) { tickets.add(queue.submit(LightPatch(bright=1+(i%100)),generation++)); scheduler.advance(16) }
        val release=queue.submit(LightPatch(bright=63),generation)
        scheduler.advance(5000)
        val times=transport.writes.map{it.at}
        for(t in times) assertTrue("window at $t",times.count{ it>=t && it<t+1000 }<=4)
        assertEquals("Final release value is always written",63,transport.writes.last().patch.bright)
        assertEquals("confirmed",release.await(0).outcome)
        assertTrue("Every merged-away callback is settled, never leaked",tickets.all{ it.settled })
        assertTrue(tickets.dropLast(1).any{ it.await(0).outcome=="superseded" })
        assertEquals(63,model.bright)
    }
    @Test fun brightnessThenModeMergeWhileAnEarlierWriteIsInFlight() {
        val first=queue.submit(LightPatch(power=true),1); scheduler.advance(150)
        assertEquals(1,transport.writes.size)
        val bright=queue.submit(LightPatch(bright=40),2)
        val mode=queue.submit(LightPatch(mode=3),3)
        assertEquals("superseded",bright.await(0).outcome); assertEquals(2L,bright.await(0).generation)
        assertEquals(1,queue.unsentCount)
        scheduler.advance(1000)
        assertEquals("Serialized: nothing else is dispatched while one write is in flight",1,transport.writes.size)
        transport.respond(stateWith(power=true)); assertEquals("confirmed",first.await(0).outcome)
        scheduler.advance(250)
        val merged=transport.writes.last()
        assertEquals(LightPatch(bright=40,mode=3),merged.patch); assertEquals(3L,merged.generation)
        transport.respond(stateWith(bright=40,mode=3))
        assertEquals("confirmed",mode.await(0).outcome)
    }
    @Test fun timerIsABarrierInBothOrders() {
        transport.auto={ WriteResult.Response(stateWith()) }
        queue.submit(LightPatch(timerMinutes=10),1)
        queue.submit(LightPatch(bright=10),2); queue.submit(LightPatch(bright=20),3)
        scheduler.advance(2000)
        assertEquals(listOf(LightPatch(timerMinutes=10),LightPatch(bright=20)),transport.writes.map{it.patch})
        transport.writes.clear()
        queue.submit(LightPatch(bright=30),4); queue.submit(LightPatch(timerMinutes=5),5); queue.submit(LightPatch(speed=9),6)
        scheduler.advance(2000)
        assertEquals("Ordinary fields never merge across a timer barrier",
            listOf(LightPatch(bright=30),LightPatch(timerMinutes=5),LightPatch(speed=9)),transport.writes.map{it.patch})
    }
    @Test fun mixedTimerAndStatePatchIsRejected() {
        for(build in listOf<()->LightPatch>({LightPatch(timerMinutes=5,power=true)},{LightPatch(timerMinutes=5,bright=10)},{LightPatch()},
                {LightPatch(bright=0)},{LightPatch(bright=101)},{LightPatch(mode=9)},{LightPatch(speed=0)},{LightPatch(timerMinutes=721)},{LightPatch(hex="12ABEF")},{LightPatch(hex="#12ABEG")})) {
            try { build(); fail("accepted invalid patch") } catch(e:BridgeFailure) { assertEquals("BAD_PAYLOAD",e.code) }
        }
        assertTrue(transport.writes.isEmpty())
        val router=BridgeRouter(UnavailableBridgeServices(),SessionLifecycle(NativeSession()).also{it.enterForeground()})
        val reply=router.handle("""{"v":1,"id":"m","op":"esp.set","args":{"patch":{"timerMinutes":5,"power":false},"generation":1}}""",TRUSTED_ORIGIN,true)
        assertEquals("BAD_PAYLOAD",reply.errorCode)
    }
    @Test fun powerOffCancelsUnsentTimersButNotOneAlreadyDispatched() {
        queue.submit(LightPatch(bright=50),1); scheduler.advance(150)
        val queuedTimer=queue.submit(LightPatch(timerMinutes=30),2)
        queue.submit(LightPatch(power=false),3)
        assertEquals("cancelled",queuedTimer.await(0).outcome)
        assertEquals("cancelled",queue.latest("timer")!!.outcome)
        transport.respond(stateWith(bright=50)); scheduler.advance(1000)
        assertEquals(0,transport.timerWriteCount)
        assertEquals(LightPatch(power=false),transport.writes.last().patch)
        // A dispatched timer is not pretended cancelled by a later power-off submission.
        transport.respond(stateWith(power=false))
        val inFlight=queue.submit(LightPatch(timerMinutes=15),4)
        assertEquals(1,transport.timerWriteCount)
        queue.submit(LightPatch(power=false),5)
        assertFalse(inFlight.settled)
        assertEquals("pending",queue.latest("timer")!!.outcome)
    }
    @Test fun confirmedPowerOffClearsAnUncertainTimerMarker() {
        queue.submit(LightPatch(timerMinutes=30),1); transport.completeWithTimeout()
        assertEquals("unconfirmed",queue.latest("timer")!!.outcome)
        queue.submit(LightPatch(power=false),2); scheduler.advance(300)
        transport.respond(stateWith(power=false))
        assertEquals("confirmed",queue.latest("state")!!.outcome)
        val timer=queue.latest("timer")!!
        assertEquals(1L,timer.generation); assertEquals("cancelled",timer.outcome); assertNull(timer.errorCode)
        assertEquals("Never replayed",1,transport.timerWriteCount)
    }
    @Test fun timeoutThenReadBegunAfterDispatchConfirmsOnlyMatchingTouchedFields() {
        val ticket=queue.submit(LightPatch(bright=42),1); scheduler.advance(150)
        transport.completeWithTimeout()
        assertEquals("Reconciliation read is begun after the write dispatch",1,transport.reads.size)
        assertEquals("pending",queue.latest("state")!!.outcome)
        // Untouched fields (mode/speed/colour) differ and are not compared.
        transport.answerRead(stateWith(bright=42,mode=7,speed=3,hex="#000000"))
        val result=ticket.await(0)
        assertEquals("confirmed",result.outcome); assertEquals(42,result.state!!.bright); assertNull(result.errorCode)
        assertEquals(1,transport.writes.size)
    }
    @Test fun timeoutThenMismatchOrReadFailureStaysUnconfirmedWithoutRetry() {
        val mismatch=queue.submit(LightPatch(bright=42),1); scheduler.advance(150)
        transport.completeWithTimeout(); transport.answerRead(stateWith(bright=41))
        assertEquals("unconfirmed",mismatch.await(0).outcome); assertEquals("COMMAND_UNCONFIRMED",mismatch.await(0).errorCode)
        assertEquals(41,mismatch.await(0).state!!.bright)
        val failed=queue.submit(LightPatch(mode=2),2); scheduler.advance(300)
        transport.completeWithTimeout(); transport.answerRead(null)
        assertEquals("unconfirmed",failed.await(0).outcome); assertNull(failed.await(0).state)
        scheduler.advance(60_000)
        assertEquals("No automatic resend; explicit retry is a new generation",2,transport.writes.size)
        assertEquals("COMMAND_UNCONFIRMED",queue.lastError)
        val retry=queue.submit(LightPatch(mode=2),3); scheduler.advance(300); transport.respond(stateWith(mode=2))
        assertEquals("confirmed",retry.await(0).outcome); assertEquals(3L,queue.latest("state")!!.generation)
    }
    @Test fun writeResponseMismatchIsUnconfirmed() {
        val t=queue.submit(LightPatch(hex="#a1b2c3"),1); scheduler.advance(150)
        transport.respond(stateWith(hex="#A1B2C3")); assertEquals("Hex compares case-insensitively","confirmed",t.await(0).outcome)
        val u=queue.submit(LightPatch(speed=70),2); scheduler.advance(300)
        transport.respond(stateWith(speed=69)); assertEquals("unconfirmed",u.await(0).outcome)
        val timer=queue.submit(LightPatch(timerMinutes=2),3); scheduler.advance(300); transport.respond(stateWith(timerSeconds=121))
        assertEquals("Timer responses confirm their own operation","confirmed",timer.await(0).outcome)
        val wrongTimer=queue.submit(LightPatch(timerMinutes=2),4); scheduler.advance(300); transport.respond(stateWith(timerSeconds=0))
        assertEquals("unconfirmed",wrongTimer.await(0).outcome)
    }
    @Test fun queueFullRejectsWithoutLosingAcceptedActions() {
        queue.submit(LightPatch(power=true),1); scheduler.advance(150)
        val accepted=listOf(queue.submit(LightPatch(timerMinutes=1),2),queue.submit(LightPatch(bright=5),3),queue.submit(LightPatch(timerMinutes=2),4),queue.submit(LightPatch(bright=6),5))
        assertEquals(4,queue.unsentCount)
        try { queue.submit(LightPatch(timerMinutes=3),6); fail("fifth unsent unit accepted") } catch(e:BridgeFailure) { assertEquals("QUEUE_FULL",e.code) }
        val merged=queue.submit(LightPatch(mode=1),7)
        assertEquals("Adjacent ordinary intent still merges into the tail",4,queue.unsentCount)
        assertEquals("superseded",accepted[3].await(0).outcome)
        var model=stateWith(power=true)
        transport.auto={ p -> model=model.applied(p); WriteResult.Response(model) }
        transport.respond(model); scheduler.advance(5000)
        assertEquals(listOf(LightPatch(power=true),LightPatch(timerMinutes=1),LightPatch(bright=5),LightPatch(timerMinutes=2),LightPatch(bright=6,mode=1)),transport.writes.map{it.patch})
        assertTrue(accepted.take(3).all{ it.await(0).outcome=="confirmed" }); assertEquals("confirmed",merged.await(0).outcome)
    }
    @Test fun linkLossAndTeardownCancelQueuedWorkAndNeverReplay() {
        val inFlight=queue.submit(LightPatch(bright=10),1); scheduler.advance(150)
        val queued=queue.submit(LightPatch(timerMinutes=9),2); val queuedState=queue.submit(LightPatch(mode=4),3)
        queue.onLinkLost()
        assertEquals("unconfirmed",inFlight.await(0).outcome); assertEquals("COMMAND_UNCONFIRMED",inFlight.await(0).errorCode)
        assertEquals("cancelled",queued.await(0).outcome); assertEquals("cancelled",queuedState.await(0).outcome)
        assertFalse(queue.hasPendingIntent); assertEquals(0,queue.unsentCount)
        transport.respond(stateWithBrightness(10))
        assertEquals("A late response after loss cannot rewrite the settled outcome","unconfirmed",inFlight.await(0).outcome)
        queue.onReconnect(); scheduler.advance(10_000)
        assertEquals(1,transport.writes.size)
        val later=queue.submit(LightPatch(power=true),4); queue.cancel()
        assertEquals("cancelled",later.await(0).outcome); assertEquals("SESSION_ENDED",later.await(0).errorCode)
        scheduler.advance(10_000); assertEquals(1,transport.writes.size)
    }
    @Test fun staleOrUnsafeGenerationsAreRejected() {
        queue.submit(LightPatch(power=true),5)
        for(g in listOf(5L,4L,0L,-1L,ProtocolValidator.MAX_SAFE+1)) {
            try { queue.submit(LightPatch(power=false),g); fail("accepted $g") } catch(e:BridgeFailure) { assertEquals("BAD_GENERATION",e.code) }
        }
        queue.submit(LightPatch(power=false),ProtocolValidator.MAX_SAFE)
    }
}
