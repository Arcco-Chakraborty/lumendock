package com.phonemonitor

import android.app.Activity
import android.os.Build
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager

/** Owns only the dashboard window. Dialogs and OS approvals retain their own focus and IME policy. */
internal class DashboardWindow(
    private val activity:Activity,
    private val content:View,
    private val dialogShowing:()->Boolean,
) {
    private val policy=DashboardWindowPolicy()
    private val restoreAfterIme=Runnable { restore() }

    init {
        val window=activity.window
        window.attributes=window.attributes.apply {
            layoutInDisplayCutoutMode=WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        @Suppress("DEPRECATION") // Required resize contract on API29; newer APIs receive explicit IME insets.
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        content.fitsSystemWindows=false
        @Suppress("DEPRECATION") // API35+ already enforces edge-to-edge for our target SDK.
        if(Build.VERSION.SDK_INT in 30..34) window.setDecorFitsSystemWindows(false)
        else if(Build.VERSION.SDK_INT<30) configureLegacyLayout()
        content.setOnApplyWindowInsetsListener { _,insets ->
            val cutout=insets.displayCutout
            val safe=ContentInsets(cutout?.safeInsetLeft ?: 0,cutout?.safeInsetTop ?: 0,
                cutout?.safeInsetRight ?: 0,cutout?.safeInsetBottom ?: 0)
            val wasImeVisible=policy.imeVisible
            val imeBottom=if(Build.VERSION.SDK_INT>=30) {
                policy.imeVisible=insets.isVisible(WindowInsets.Type.ime())
                if(policy.imeVisible) insets.getInsets(WindowInsets.Type.ime()).bottom else 0
            } else {
                // API29's adjustResize owns keyboard space. This comparison only gates hiding bars;
                // copying the same keyboard height into padding would shrink the WebView twice.
                @Suppress("DEPRECATION")
                val keyboardVisible=insets.systemWindowInsetBottom>insets.stableInsetBottom
                policy.imeVisible=keyboardVisible
                0
            }
            val padding=policy.contentInsets(safe,imeBottom)
            if(content.paddingLeft!=padding.left || content.paddingTop!=padding.top ||
                content.paddingRight!=padding.right || content.paddingBottom!=padding.bottom) {
                content.setPadding(padding.left,padding.top,padding.right,padding.bottom)
            }
            if(wasImeVisible && !policy.imeVisible) {
                content.removeCallbacks(restoreAfterIme)
                content.post(restoreAfterIme)
            }
            // Never consume IME information needed by the platform/WebView.
            insets
        }
    }

    fun onResume() {
        policy.resumed=true
        policy.focused=activity.hasWindowFocus()
        content.requestApplyInsets()
        restore()
    }
    fun onPause() {
        policy.resumed=false
        content.removeCallbacks(restoreAfterIme)
    }
    fun onWindowFocusChanged(hasFocus:Boolean) {
        policy.focused=hasFocus
        if(hasFocus) { content.requestApplyInsets(); restore() }
    }
    fun onConfigurationChanged() { content.requestApplyInsets(); restore() }
    fun close() {
        policy.resumed=false
        content.removeCallbacks(restoreAfterIme)
        content.setOnApplyWindowInsetsListener(null)
    }
    private fun restore() {
        if(activity.isFinishing || activity.isDestroyed || !policy.shouldHideBars(dialogShowing())) return
        if(Build.VERSION.SDK_INT>=30) {
            activity.window.insetsController?.let {
                it.systemBarsBehavior=WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                it.hide(WindowInsets.Type.systemBars())
            }
        } else hideLegacyBars()
    }
    @Suppress("DEPRECATION")
    private fun configureLegacyLayout() {
        activity.window.decorView.systemUiVisibility=View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
    }
    @Suppress("DEPRECATION")
    private fun hideLegacyBars() {
        activity.window.decorView.systemUiVisibility=View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
    }
}
