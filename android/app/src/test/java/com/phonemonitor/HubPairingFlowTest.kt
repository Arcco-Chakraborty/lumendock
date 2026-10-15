package com.phonemonitor

import org.junit.Assert.*
import org.junit.Test
import java.util.ArrayDeque

class HubPairingFlowTest {
    private var now=0L
    private val session=NativeSession(clock={now})
    private val lifecycle=SessionLifecycle(session).also{it.enterForeground()}
    private val clock=TestClock()
    private val transport=FakeHubTransport()
    private val store=MemoryStore()
    private val client=LaptopClient(store,transport,clock){session.paired=it}.also{it.resume()}
    private val work=ArrayDeque<Runnable>(); private val main=ArrayDeque<()->Unit>()
    private val flow=HubPairingFlow(session,client::pair,{work.add(it)},{main.add(it)})
    private val router=BridgeRouter(object:UnavailableBridgeServices(){ override fun hubSnapshot()=client.snapshot().toJson() },lifecycle)
    private fun call(op:String)=router.handle("""{"v":1,"id":"$op","op":"$op","args":{}}""",TRUSTED_ORIGIN,true)
    private fun hubSetup()=call("app.status").data!!.getAsJsonObject("setup").getAsJsonObject("hub")
    private fun drain() { while(work.isNotEmpty()) work.removeFirst().run(); while(main.isNotEmpty()) main.removeFirst().invoke() }
    private fun submit(id:String,code:String):PairingOutcome? { var outcome:PairingOutcome?=null; flow.submit(id,code){outcome=it}; drain(); return outcome }

    @Test fun setupAcknowledgesImmediatelyAndCodeEntryAfterThirtySecondsCompletesThroughStatus() {
        val ack=call("app.setupHub")
        assertTrue(ack.ok); assertTrue(ack.data!!["started"].asBoolean)
        val id=ack.data!!["setupId"].asString
        now=45_000
        assertEquals("in_progress",hubSetup()["state"].asString)
        transport.reply(200,"""{"token":"$SYNTHETIC_TOKEN"}""")
        assertEquals(PairingOutcome.Succeeded,submit(id,"01234567"))
        val status=call("app.status").data!!
        assertTrue(status["paired"].asBoolean)
        assertEquals("succeeded",hubSetup()["state"].asString)
        assertFalse(status.toString().contains(SYNTHETIC_TOKEN))
        assertEquals(SYNTHETIC_TOKEN,store.value)
        transport.succeed()
        assertEquals("connected",call("hub.snapshot").data!!["state"].asString)
    }
    @Test fun expiredCodeFailsCleanly() {
        val id=call("app.setupHub").data!!["setupId"].asString
        now=60_000
        transport.reply(403,"""{"v":1,"error":{"code":"PAIRING_EXPIRED"}}""")
        assertEquals(PairingOutcome.Failed("PAIRING_EXPIRED"),submit(id,"01234567"))
        val setup=hubSetup()
        assertEquals("failed",setup["state"].asString); assertEquals("PAIRING_EXPIRED",setup["errorCode"].asString)
        assertFalse(call("app.status").data!!["paired"].asBoolean); assertNull(store.value)
        assertTrue("A new explicit setup may start after failure",call("app.setupHub").data!!["started"].asBoolean)
    }
    @Test fun wrongCodeStaysRetryableUntilHubClosesPairing() {
        val id=call("app.setupHub").data!!["setupId"].asString
        assertEquals(PairingOutcome.Retry("BAD_PAIRING_CODE"),submit(id,"123"))
        assertTrue("Format errors never reach the hub",transport.requests.isEmpty())
        transport.reply(400,"""{"v":1,"error":{"code":"BAD_PAYLOAD"}}""")
        repeat(4) { assertEquals(PairingOutcome.Retry("BAD_PAIRING_CODE"),submit(id,"0000000$it")) }
        assertEquals("in_progress",hubSetup()["state"].asString)
        transport.reply(403,"""{"v":1,"error":{"code":"PAIRING_CLOSED"}}""")
        assertEquals(PairingOutcome.Failed("PAIRING_CLOSED"),submit(id,"00000009"))
        assertEquals("PAIRING_CLOSED",hubSetup()["errorCode"].asString)
        transport.failWith("USB_UNAVAILABLE")
        val next=call("app.setupHub").data!!["setupId"].asString
        assertEquals(PairingOutcome.Retry("USB_UNAVAILABLE"),submit(next,"01234567"))
    }
    @Test fun onlyOneSubmissionAtATimeAndStaleSetupIdsAreIgnored() {
        val id=call("app.setupHub").data!!["setupId"].asString
        transport.reply(200,"""{"token":"$SYNTHETIC_TOKEN"}""")
        assertTrue(flow.submit(id,"01234567"){})
        assertFalse("A second tap while pairing is ignored",flow.submit(id,"01234567"){})
        drain(); assertEquals(1,transport.requests.size)
        assertFalse("Completed setup cannot be resubmitted",flow.submit(id,"01234567"){})
        lifecycle.leaveForeground("background")
        assertFalse(flow.submit("unknown","01234567"){})
    }
    @Test fun nativeExpiryAtOneHundredTwentySecondsBeatsALateSubmission() {
        val id=call("app.setupHub").data!!["setupId"].asString
        now=120_000
        assertFalse(flow.submit(id,"01234567"){})
        assertEquals("PAIRING_EXPIRED",hubSetup()["errorCode"].asString)
        assertTrue(transport.requests.isEmpty())
    }
}
