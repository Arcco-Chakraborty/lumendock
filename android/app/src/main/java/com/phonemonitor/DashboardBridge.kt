package com.phonemonitor

import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Future
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** One bridge per renderer, with bounded work and callbacks; never owns the native setup session. */
class DashboardBridge(private val router:BridgeRouter) : AutoCloseable {
    private val main=Handler(Looper.getMainLooper())
    private val workers=ThreadPoolExecutor(2,2,0,TimeUnit.MILLISECONDS,ArrayBlockingQueue(30))
    private val deadlines=ScheduledThreadPoolExecutor(1).apply{removeOnCancelPolicy=true}
    private var webView:WebView?=null
    fun attach(view:WebView):Boolean {
        check(Looper.myLooper()==Looper.getMainLooper())
        check(webView==null)
        if(!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
        webView=view
        WebViewCompat.addWebMessageListener(view,"phoneMonitor",setOf(TRUSTED_ORIGIN)) { _,message,origin,mainFrame,proxy ->
            if(message.type!=WebMessageCompat.TYPE_STRING) {
                proxy.postMessage(BridgeReply.failure("invalid","BAD_PAYLOAD").toJson())
                return@addWebMessageListener
            }
            dispatch(message.data ?: "",origin.toString(),mainFrame) { proxy.postMessage(it.toJson()) }
        }
        return true
    }
    fun dispatch(json:String,origin:String,mainFrame:Boolean,reply:(BridgeReply)->Unit) {
        val request=try { router.prepare(json,origin,mainFrame) } catch(e:BridgeFailure) { postReply(reply,BridgeReply.failure(e.requestId,e.code)); return }
        val task=RequestTask(request,reply)
        if(!router.lifecycle.registerPending(request.id){task.cancel(it)}) { router.release(request); postReply(reply,BridgeReply.failure(request.id,"SESSION_ENDED")); return }
        // Local app operations cannot queue behind transport I/O or a human approval dialog.
        if(request.op.startsWith("app.")) { task.run(); return }
        try {
            task.deadline=deadlines.schedule({task.cancel("REQUEST_TIMEOUT")},10,TimeUnit.SECONDS)
            task.future=workers.submit(task)
        } catch(_:java.util.concurrent.RejectedExecutionException) { task.cancel("BRIDGE_UNAVAILABLE") }
    }
    private fun postReply(callback:(BridgeReply)->Unit,reply:BridgeReply) {
        main.post { try { callback(reply) } catch(_:RuntimeException) { /* renderer may already be gone */ } }
    }
    private inner class RequestTask(val request:PreparedRequest,val callback:(BridgeReply)->Unit):Runnable {
        private val state=AtomicInteger(0) // 0 queued, 1 executing, 2 finished/cancelled before execution
        private val settled=AtomicBoolean(false)
        @Volatile var future:Future<*>?=null
        @Volatile var deadline:Future<*>?=null
        override fun run() {
            if(!state.compareAndSet(0,1)) return
            try { settle(router.execute(request)) } finally { state.set(2); router.release(request) }
        }
        fun cancel(code:String) {
            if(state.compareAndSet(0,2)) router.release(request)
            future?.cancel(true)
            settle(BridgeReply.failure(request.id,code))
        }
        private fun settle(result:BridgeReply) {
            if(!settled.compareAndSet(false,true)) return
            deadline?.cancel(false); router.lifecycle.completePending(request.id); postReply(callback,result)
        }
    }
    fun dispose() {
        check(Looper.myLooper()==Looper.getMainLooper())
        router.lifecycle.close()
        workers.shutdownNow(); deadlines.shutdownNow()
        if(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            webView?.let { WebViewCompat.removeWebMessageListener(it,"phoneMonitor") }
        }
        webView=null
    }
    override fun close()=dispose()
}
