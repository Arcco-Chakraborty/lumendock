package com.phonemonitor

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Run only on an explicitly authorized device with the diagnostic APK. Needs no laptop: with no hub reachable
 * the phone must still answer hub.snapshot with a typed, credential-free LinkSnapshot, and app.setupHub must
 * acknowledge at once while the native code-entry dialog stays open.
 */
@RunWith(AndroidJUnit4::class)
class HubLinkInstrumentationTest {
    private fun js(scenario:ActivityScenario<MainActivity>,script:String):String {
        val result=AtomicReference<String>(); val done=CountDownLatch(1)
        scenario.onActivity { a -> a.dashboardView!!.evaluateJavascript(script) { result.set(it); done.countDown() } }
        assertTrue(done.await(5,TimeUnit.SECONDS)); return result.get()
    }
    private fun waitUntil(scenario:ActivityScenario<MainActivity>,expression:String,seconds:Long=8) {
        val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(seconds)
        while(System.nanoTime()<deadline) { if(js(scenario,expression)=="true") return; Thread.sleep(50) }
        fail("WebView condition did not become true: $expression")
    }
    /** The diagnostic page polls hub.snapshot itself; match our own id and retry a duplicate-live-op rejection. */
    private fun send(scenario:ActivityScenario<MainActivity>,op:String) {
        repeat(3) { attempt ->
            js(scenario,"window.testReply=null;phoneMonitor.onmessage=e=>{const r=JSON.parse(e.data);if(r.id==='instr-$op-$attempt')window.testReply=r};phoneMonitor.postMessage(JSON.stringify({v:1,id:'instr-$op-$attempt',op:'$op',args:{}}));")
            waitUntil(scenario,"window.testReply !== null",12)
            if(js(scenario,"testReply.ok || testReply.error.code !== 'BAD_PAYLOAD'")=="true") return
            Thread.sleep(300)
        }
    }
    @Test fun hubSnapshotIsTypedAndCredentialFreeWithoutALaptop() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            waitUntil(scenario,"document.readyState === 'complete' && typeof phoneMonitor !== 'undefined'")
            send(scenario,"hub.snapshot")
            assertEquals("true",js(scenario,"testReply.ok && ['connecting','connected','disconnected','error'].includes(testReply.data.state) && typeof testReply.data.stale === 'boolean'"))
            assertEquals("true",js(scenario,"testReply.data.data === null ? testReply.data.ageMs === null : typeof testReply.data.ageMs === 'number'"))
            assertEquals("false",js(scenario,"/bearer|token/i.test(JSON.stringify(testReply))"))
        }
    }
    @Test fun setupHubAcknowledgesImmediatelyAndOpensOneNativeDialog() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            waitUntil(scenario,"document.readyState === 'complete' && typeof phoneMonitor !== 'undefined'")
            val started=System.nanoTime()
            send(scenario,"app.setupHub")
            assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started)<3000)
            assertEquals("true",js(scenario,"testReply.ok && testReply.data.started === true"))
            send(scenario,"app.setupHub")
            assertEquals("Duplicate taps reuse the open flow","true",js(scenario,"testReply.ok && testReply.data.started === false"))
            send(scenario,"app.status")
            assertEquals("true",js(scenario,"testReply.data.setup.hub.state === 'in_progress'"))
        }
    }
}
