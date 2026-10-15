package com.phonemonitor

import android.content.Context
import android.content.pm.ActivityInfo
import android.graphics.Insets
import android.graphics.Rect
import android.os.Build
import android.view.DisplayCutout
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.view.inspector.WindowInspector
import android.widget.EditText
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Compile by default; run only during coordinator-authorized device acceptance. No global device settings. */
@RunWith(AndroidJUnit4::class)
class DashboardWindowInstrumentationTest {
    private fun await(check:()->Boolean) {
        val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8)
        while(System.nanoTime()<deadline) { if(check()) return; Thread.sleep(50) }
        fail("Window condition did not become true")
    }
    private fun ActivityScenario<MainActivity>.check(block:(MainActivity)->Boolean):Boolean {
        var result=false
        onActivity { result=block(it) }
        return result
    }
    private fun root(a:MainActivity)=a.dashboardView!!.parent as ViewGroup
    @Suppress("DEPRECATION")
    private fun barsHidden(a:MainActivity):Boolean = if(Build.VERSION.SDK_INT>=30) {
        a.window.decorView.rootWindowInsets?.isVisible(WindowInsets.Type.systemBars())==false
    } else {
        val flags=a.window.decorView.systemUiVisibility
        flags and View.SYSTEM_UI_FLAG_FULLSCREEN != 0 && flags and View.SYSTEM_UI_FLAG_HIDE_NAVIGATION != 0
    }
    @Test fun coldStartAndForegroundReturnFillWindowAndRestoreHiddenBars() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            await { scenario.check { it.hasWindowFocus() && barsHidden(it) && root(it).height>0 } }
            scenario.onActivity { a ->
                val content=root(a)
                assertEquals(a.window.decorView.width,content.width)
                assertEquals(a.window.decorView.height,content.height)
                val cutout=a.window.decorView.rootWindowInsets.displayCutout
                assertEquals(cutout?.safeInsetLeft ?: 0,content.paddingLeft)
                assertEquals(cutout?.safeInsetTop ?: 0,content.paddingTop)
                assertEquals(cutout?.safeInsetRight ?: 0,content.paddingRight)
                assertEquals(content.width-content.paddingLeft-content.paddingRight,a.dashboardView!!.width)
            }
            scenario.moveToState(Lifecycle.State.CREATED)
            scenario.moveToState(Lifecycle.State.RESUMED)
            await { scenario.check { it.hasWindowFocus() && barsHidden(it) } }
        }
    }
    @Test fun rotationKeepsSameRendererAndUpdatesSafeBounds() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            var original:View?=null
            scenario.onActivity { a ->
                assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR,a.requestedOrientation)
                original=a.dashboardView
                a.requestedOrientation=ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            }
            await { scenario.check { root(it).width>root(it).height && barsHidden(it) } }
            scenario.onActivity { it.requestedOrientation=ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
            await { scenario.check { root(it).height>root(it).width && barsHidden(it) } }
            scenario.onActivity { a ->
                assertSame(original,a.dashboardView)
                val cutout=a.window.decorView.rootWindowInsets.displayCutout
                assertEquals(cutout?.safeInsetTop ?: 0,root(a).paddingTop)
                assertEquals(cutout?.safeInsetLeft ?: 0,root(a).paddingLeft)
            }
        }
    }
    @Suppress("DEPRECATION")
    @Test fun insetDeliveryReplacesCutoutEdgesAndNeverDoubleAddsKeyboardPadding() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { a ->
                val content=root(a)
                fun deliver(safe:Rect,ime:Int) {
                    val builder=WindowInsets.Builder().setDisplayCutout(DisplayCutout(safe,emptyList()))
                    if(Build.VERSION.SDK_INT>=30) builder.setInsets(WindowInsets.Type.ime(),Insets.of(0,0,0,ime)).setVisible(WindowInsets.Type.ime(),ime>0)
                    else builder.setSystemWindowInsets(Insets.of(0,0,0,ime)).setStableInsets(Insets.of(0,0,0,96))
                    content.dispatchApplyWindowInsets(builder.build())
                }
                deliver(Rect(0,56,0,0),0)
                assertEquals(56,content.paddingTop)
                deliver(Rect(56,0,0,20),480)
                assertEquals(56,content.paddingLeft)
                assertEquals(0,content.paddingTop)
                assertEquals(if(Build.VERSION.SDK_INT>=30) 480 else 20,content.paddingBottom)
                deliver(Rect(0,0,56,20),0)
                assertEquals(0,content.paddingLeft)
                assertEquals(56,content.paddingRight)
                assertEquals(20,content.paddingBottom)
                content.requestApplyInsets()
            }
        }
    }
    @Test fun webInputKeyboardReducesUsableHeightAndDismissRestoresFullscreen() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            await { scenario.check { it.dashboardView?.progress==100 && it.hasWindowFocus() } }
            var fullHeight=0
            val focused=CountDownLatch(1)
            scenario.onActivity { a ->
                val web=a.dashboardView!!
                fullHeight=web.height
                web.requestFocus()
                web.evaluateJavascript("var keyboardTest=document.createElement('input');keyboardTest.id='keyboard-test';keyboardTest.style.cssText='position:fixed;bottom:0;left:0;width:200px;height:44px;z-index:2147483647';document.body.append(keyboardTest);keyboardTest.focus();") {
                    (a.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(web,InputMethodManager.SHOW_IMPLICIT)
                    focused.countDown()
                }
            }
            assertTrue(focused.await(5,TimeUnit.SECONDS))
            await { scenario.check { it.dashboardView!!.height<fullHeight-100 } }
            val measured=CountDownLatch(1)
            var inputVisible=false
            scenario.onActivity { a ->
                a.dashboardView!!.evaluateJavascript("document.getElementById('keyboard-test').getBoundingClientRect().bottom <= window.visualViewport.height + 1") {
                    inputVisible=it=="true"; measured.countDown()
                }
            }
            assertTrue(measured.await(5,TimeUnit.SECONDS))
            assertTrue("Focused HTML field stays above the keyboard",inputVisible)
            scenario.onActivity { a ->
                a.dashboardView!!.evaluateJavascript("document.getElementById('keyboard-test').remove()",null)
                (a.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(a.dashboardView!!.windowToken,0)
            }
            await { scenario.check { it.dashboardView!!.height==fullHeight && barsHidden(it) } }
        }
    }
    @Test fun pairingDialogRemainsSecureFocusableAndDismissRestoresDashboard() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            await { scenario.check { it.dashboardView?.progress==100 && it.hasWindowFocus() } }
            val sent=CountDownLatch(1)
            scenario.onActivity { a ->
                a.dashboardView!!.evaluateJavascript("phoneMonitor.postMessage(JSON.stringify({v:1,id:'window-test',op:'app.setupHub',args:{}}))") { sent.countDown() }
            }
            assertTrue(sent.await(5,TimeUnit.SECONDS))
            var field:EditText?=null
            fun find(view:View):EditText? {
                if(view is EditText) return view
                if(view is ViewGroup) for(i in 0 until view.childCount) find(view.getChildAt(i))?.let { return it }
                return null
            }
            await {
                InstrumentationRegistry.getInstrumentation().runOnMainSync {
                    field=WindowInspector.getGlobalWindowViews().firstNotNullOfOrNull { find(it) }
                }
                field!=null
            }
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                val input=field!!
                val params=input.rootView.layoutParams as WindowManager.LayoutParams
                assertTrue(params.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                assertEquals(0,params.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
                assertEquals(0,params.flags and WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM)
                assertTrue(input.requestFocus())
                assertTrue(input.hasFocus())
                // Cancel via the dialog's actual button; never enter credentials or send a pair request.
                input.rootView.findViewById<View>(android.R.id.button2).performClick()
            }
            await { scenario.check { it.hasWindowFocus() && barsHidden(it) } }
        }
    }
}
