package com.phonemonitor

import android.annotation.SuppressLint
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.gson.JsonObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Test-only pages isolate WebView's real origin/frame attribution from the host's CSP frame denial. */
@RunWith(AndroidJUnit4::class)
class BridgeOriginInstrumentationTest {
    private val instrumentation=InstrumentationRegistry.getInstrumentation()
    private fun js(view:WebView,script:String):String {
        val result=AtomicReference<String>(); val done=CountDownLatch(1)
        instrumentation.runOnMainSync { view.evaluateJavascript(script){result.set(it);done.countDown()} }
        assertTrue(done.await(5,TimeUnit.SECONDS)); return result.get()
    }
    private fun waitFor(view:WebView,expression:String) {
        val end=System.nanoTime()+TimeUnit.SECONDS.toNanos(8)
        while(System.nanoTime()<end) { if(js(view,expression)=="true") return; Thread.sleep(50) }
        fail("Bridge condition timed out")
    }
    @SuppressLint("SetJavaScriptEnabled")
    @Test fun realListenerAllowsMainFrameRejectsSubframeAndIsAbsentAtWrongOrigin() {
        val calls=AtomicInteger()
        val services=object:UnavailableBridgeServices() { override fun hubSnapshot():JsonObject {calls.incrementAndGet();return super.hubSnapshot()} }
        val scope=SessionLifecycle(NativeSession()); val bridge=DashboardBridge(BridgeRouter(services,scope))
        lateinit var view:WebView
        instrumentation.runOnMainSync {
            view=WebView(instrumentation.targetContext)
            view.settings.javaScriptEnabled=true
            view.webViewClient=object:WebViewClient() {
                override fun shouldInterceptRequest(v:WebView,r:WebResourceRequest):WebResourceResponse {
                    val script=if(r.url.path=="/child") "phoneMonitor.onmessage=e=>parent.childReply=JSON.parse(e.data);phoneMonitor.postMessage(JSON.stringify({v:1,id:'child',op:'hub.snapshot',args:{}}));" else "window.mainReady=true;"
                    return WebResourceResponse("text/html","UTF-8",ByteArrayInputStream("<html><body><script>$script</script></body></html>".toByteArray()))
                }
            }
            assertTrue(bridge.attach(view))
            view.loadUrl("$TRUSTED_ORIGIN/test")
        }
        try {
            waitFor(view,"window.mainReady===true && typeof phoneMonitor!=='undefined'")
            js(view,"try{phoneMonitor.postMessage(new ArrayBuffer(16))}catch(e){}")
            js(view,"window.mainReply=null;phoneMonitor.onmessage=e=>window.mainReply=JSON.parse(e.data);phoneMonitor.postMessage(JSON.stringify({v:1,id:'main',op:'hub.snapshot',args:{}}));")
            waitFor(view,"window.mainReply!==null")
            assertEquals(1,calls.get()); assertEquals("true",js(view,"mainReply.ok"))
            js(view,"window.childReply=null;var child=document.createElement('iframe');child.src='/child';document.body.append(child)")
            waitFor(view,"window.childReply!==null")
            assertEquals("false",js(view,"childReply.ok")); assertEquals(1,calls.get())
            instrumentation.runOnMainSync { view.loadUrl("https://wrong-origin.invalid/test") }
            waitFor(view,"window.mainReady===true && location.hostname==='wrong-origin.invalid'")
            assertEquals("\"undefined\"",js(view,"typeof phoneMonitor")); assertEquals(1,calls.get())
        } finally { instrumentation.runOnMainSync { bridge.dispose(); view.destroy() } }
    }
}
