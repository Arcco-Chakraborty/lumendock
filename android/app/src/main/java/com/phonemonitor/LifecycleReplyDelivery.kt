package com.phonemonitor

import java.util.concurrent.atomic.AtomicBoolean

/**
 * Settles a request exactly once. The pending lifecycle callback stays registered until the posted delivery
 * runs, and the epoch is rechecked there, so a result queued before a stop/close cannot reach a later epoch.
 */
class LifecycleReplyDelivery(
    private val lifecycle:SessionLifecycle,
    private val id:String,
    private val epoch:Long,
    private val post:(()->Unit)->Unit,
    private val callback:(BridgeReply)->Unit,
) {
    private val submitted=AtomicBoolean(false)
    fun submit(result:BridgeReply):Boolean {
        if(!submitted.compareAndSet(false,true)) return false
        post {
            val reply=if(lifecycle.isCurrent(epoch)) result else BridgeReply.failure(id,"SESSION_ENDED")
            lifecycle.completePending(id,epoch)
            callback(reply)
        }
        return true
    }
}
