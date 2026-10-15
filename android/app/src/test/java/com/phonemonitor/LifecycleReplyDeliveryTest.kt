package com.phonemonitor

import org.junit.Assert.*
import org.junit.Test
import java.util.ArrayDeque

class LifecycleReplyDeliveryTest {
    @Test fun queuedSuccessBecomesOneSessionEndedReplyAfterBackgroundReturn() {
        val lifecycle=SessionLifecycle(NativeSession()); lifecycle.enterForeground()
        val router=BridgeRouter(UnavailableBridgeServices(),lifecycle)
        val request=router.prepare("""{"v":1,"id":"x","op":"hub.snapshot","args":{}}""",TRUSTED_ORIGIN,true)
        val queue=ArrayDeque<()->Unit>(); val replies=mutableListOf<BridgeReply>()
        val delivery=LifecycleReplyDelivery(lifecycle,request.id,request.epoch,{queue.add(it)},{replies.add(it)})
        lifecycle.registerPending(request.id){delivery.submit(BridgeReply.failure(request.id,it))}
        assertTrue(delivery.submit(router.execute(request)))
        assertEquals(1,lifecycle.pendingCount)
        lifecycle.leaveForeground("background"); lifecycle.enterForeground()
        while(queue.isNotEmpty()) queue.removeFirst().invoke()
        assertEquals(1,replies.size)
        assertEquals("SESSION_ENDED",replies.single().errorCode)
        assertEquals(0,lifecycle.pendingCount)
    }
    @Test fun queuedSuccessCannotEscapeClosedRenderer() {
        val lifecycle=SessionLifecycle(NativeSession()); lifecycle.enterForeground()
        val queue=ArrayDeque<()->Unit>(); val replies=mutableListOf<BridgeReply>()
        val delivery=LifecycleReplyDelivery(lifecycle,"x",lifecycle.epoch,{queue.add(it)},{replies.add(it)})
        lifecycle.registerPending("x"){delivery.submit(BridgeReply.failure("x",it))}
        delivery.submit(BridgeReply("x",true,jsonObject("paired" to true)))
        lifecycle.close()
        while(queue.isNotEmpty()) queue.removeFirst().invoke()
        assertEquals(1,replies.size); assertEquals("SESSION_ENDED",replies.single().errorCode)
    }
    @Test fun currentSuccessDeliversOnceAndReleasesCallbackAtDelivery() {
        val lifecycle=SessionLifecycle(NativeSession()); lifecycle.enterForeground()
        val queue=ArrayDeque<()->Unit>(); val replies=mutableListOf<BridgeReply>()
        val delivery=LifecycleReplyDelivery(lifecycle,"x",lifecycle.epoch,{queue.add(it)},{replies.add(it)})
        lifecycle.registerPending("x"){delivery.submit(BridgeReply.failure("x",it))}
        assertTrue(delivery.submit(BridgeReply("x",true,jsonObject("paired" to true))))
        assertFalse(delivery.submit(BridgeReply.failure("x","REQUEST_TIMEOUT")))
        assertEquals(1,lifecycle.pendingCount)
        while(queue.isNotEmpty()) queue.removeFirst().invoke()
        assertEquals(1,replies.size); assertTrue(replies.single().ok); assertEquals(0,lifecycle.pendingCount)
    }
    @Test fun staleDeliveryCannotRemoveNewSameIdCancellationRegistration() {
        val lifecycle=SessionLifecycle(NativeSession()); lifecycle.enterForeground()
        val router=BridgeRouter(UnavailableBridgeServices(),lifecycle)
        val json="""{"v":1,"id":"reused","op":"hub.snapshot","args":{}}"""
        val oldRequest=router.prepare(json,TRUSTED_ORIGIN,true)
        val queue=ArrayDeque<()->Unit>(); val oldReplies=mutableListOf<BridgeReply>()
        val delivery=LifecycleReplyDelivery(lifecycle,oldRequest.id,oldRequest.epoch,{queue.add(it)},{oldReplies.add(it)})
        assertTrue(lifecycle.registerPending(oldRequest.id){delivery.submit(BridgeReply.failure(oldRequest.id,it))})
        assertTrue(delivery.submit(router.execute(oldRequest)))
        lifecycle.leaveForeground("background"); lifecycle.enterForeground()

        val newRequest=router.prepare(json,TRUSTED_ORIGIN,true)
        val cancellations=mutableListOf<String>()
        assertTrue(lifecycle.registerPending(newRequest.id){cancellations.add(it)})
        assertEquals(1,lifecycle.pendingCount)
        while(queue.isNotEmpty()) queue.removeFirst().invoke()
        assertEquals(listOf("SESSION_ENDED"),oldReplies.map{it.errorCode})
        assertEquals("Old delivery must retain the newer cancellation owner",1,lifecycle.pendingCount)
        assertTrue(cancellations.isEmpty())

        lifecycle.leaveForeground("background")
        assertEquals(listOf("SESSION_ENDED"),cancellations)
        assertEquals(0,lifecycle.pendingCount)
        router.release(newRequest)
    }

}
