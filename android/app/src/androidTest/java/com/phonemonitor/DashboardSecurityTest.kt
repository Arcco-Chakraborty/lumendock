package com.phonemonitor

import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Run only on an explicitly authorized device. These exercise the installed WebView. */
@RunWith(AndroidJUnit4::class)
class DashboardSecurityTest {
    private fun js(scenario: ActivityScenario<MainActivity>, script: String): String {
        val result=AtomicReference<String>(); val done=CountDownLatch(1)
        scenario.onActivity { a -> a.dashboardView!!.evaluateJavascript(script) { result.set(it); done.countDown() } }
        assertTrue(done.await(5,TimeUnit.SECONDS)); return result.get()
    }
    private fun waitUntil(scenario: ActivityScenario<MainActivity>, expression:String) {
        val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8)
        while(System.nanoTime()<deadline) { if(js(scenario,expression)=="true") return; Thread.sleep(50) }
        fail("WebView condition did not become true")
    }
    @Test fun trustedMainFrameGetsStructuredReplyAndDiagnosticTextStaysText() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            waitUntil(scenario,"document.readyState === 'complete' && typeof phoneMonitor !== 'undefined'")
            js(scenario,"window.diagnosticHandler=phoneMonitor.onmessage;window.testReply=null;phoneMonitor.onmessage=e=>window.testReply=JSON.parse(e.data);phoneMonitor.postMessage(JSON.stringify({v:1,id:'instrumentation',op:'app.status',args:{}}));")
            waitUntil(scenario,"window.testReply !== null")
            assertEquals("true",js(scenario,"testReply.ok && typeof testReply.data.paired === 'boolean'"))
            js(scenario,"window.diagnosticHandler({data:JSON.stringify({v:1,id:'synthetic-hostile',ok:true,data:{notifications:[{title:'<script>window.pwned=true</script>',body:'<a href=\"https://example.com\">test</a>'}]}})});")
            assertEquals("true",js(scenario,"!window.pwned && document.querySelector('#status').children.length === 0 && document.querySelector('#status').textContent.includes('<script>')"))
            assertEquals("true",js(scenario,"document.querySelectorAll('iframe').length===0"))
        }
    }
    @Test fun remoteFileDataAndSubframeLoadsAreDenied() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            waitUntil(scenario,"document.readyState === 'complete' && typeof phoneMonitor !== 'undefined'")
            for(url in listOf("https://example.com/", "file:///etc/passwd", "data:text/html,hostile")) {
                js(scenario,"location.href=${com.google.gson.Gson().toJson(url)}")
                assertEquals("\"$ENTRY_URL\"",js(scenario,"location.href"))
            }
            js(scenario,"window.childLoaded=false;var f=document.createElement('iframe');f.src='/assets/index.html';f.onload=()=>{try{window.childLoaded=!!f.contentWindow.phoneMonitor}catch(e){}};document.body.append(f);")
            Thread.sleep(200)
            assertEquals("false",js(scenario,"window.childLoaded"))
        }
    }
    @Test fun unsupportedFeatureShowsNativeGuidanceWithoutBridgeFallback() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.showUnsupportedWebView()
                assertNull(activity.dashboardView)
                assertTrue(activity.window.decorView.findViewWithTag<android.widget.TextView>("webview-guidance").text.contains("WebView"))
            }
        }
    }
}
