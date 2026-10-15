package com.phonemonitor

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.*
import android.widget.FrameLayout
import android.widget.TextView
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.lang.ref.WeakReference

class MainActivity : Activity() {
    var dashboardView:WebView?=null; private set
    private lateinit var root:FrameLayout
    private lateinit var nativeSession:NativeSession
    private var lifecycle:SessionLifecycle?=null
    private var bridge:DashboardBridge?=null
    private var setupDialog:AlertDialog?=null
    private val main=Handler(Looper.getMainLooper())
    private var userLeaving=false
    private var activityStarted=false

    override fun onCreate(savedInstanceState:Bundle?) {
        super.onCreate(savedInstanceState)
        root=FrameLayout(this).apply { setBackgroundColor(Color.rgb(18,22,26)); fitsSystemWindows=true }
        setContentView(root)
        // Session callbacks retain only a weak Activity reference and post bounded UI work.
        val owner=WeakReference(this)
        val ui=main
        nativeSession=NativeSession(
            onStartSetup={kind,id->ui.post { owner.get()?.showSetupGuidance(kind,id) }},
            onCancelSetup={_,_->ui.post { owner.get()?.setupDialog?.dismiss() }},
            onScreenChanged={_,_->ui.post { owner.get()?.applyScreenSettings() }},
        )
        createDashboard()
    }
    @SuppressLint("SetJavaScriptEnabled")
    private fun createDashboard() {
        if(isFinishing || isDestroyed) return
        val view=WebView(this)
        val assets=WebViewAssetLoader.Builder().addPathHandler("/assets/",WebViewAssetLoader.AssetsPathHandler(applicationContext)).build()
        view.settings.apply {
            javaScriptEnabled=true
            domStorageEnabled=true
            allowFileAccess=false; allowContentAccess=false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs=false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs=false
            mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically=false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture=true
            setGeolocationEnabled(false)
            cacheMode=WebSettings.LOAD_NO_CACHE
        }
        WebView.setWebContentsDebuggingEnabled(false)
        CookieManager.getInstance().setAcceptCookie(false)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view,false)
        view.setDownloadListener { _,_,_,_,_-> }
        view.webChromeClient=object:WebChromeClient() {
            override fun onCreateWindow(view:WebView?,isDialog:Boolean,isUserGesture:Boolean,resultMsg:android.os.Message?)=false
            override fun onPermissionRequest(request:PermissionRequest?) { request?.deny() }
            override fun onShowFileChooser(webView:WebView?,filePathCallback:ValueCallback<Array<Uri>>?,fileChooserParams:FileChooserParams?):Boolean { filePathCallback?.onReceiveValue(null); return true }
        }
        view.webViewClient=DashboardClient(assets)
        val scope=SessionLifecycle(nativeSession)
        lifecycle=scope
        // Requests stay closed until the Activity is actually started; a stopped replacement is also paused.
        if(activityStarted) scope.enterForeground() else view.onPause()
        val owner=WeakReference(this)
        val services=object:UnavailableBridgeServices() {
            override fun openWifiSettings():com.google.gson.JsonObject {
                val opened=try {
                    val activity=owner.get()
                    if(activity==null || activity.isFinishing) false else {
                        activity.startActivity(Intent(Settings.ACTION_WIFI_SETTINGS)); true
                    }
                } catch(_:RuntimeException) { false }
                return jsonObject("opened" to opened)
            }
        }
        val nextBridge=DashboardBridge(BridgeRouter(services,scope))
        if(!nextBridge.attach(view)) { nextBridge.dispose(); view.destroy(); showUnsupportedWebView(); return }
        nativeSession.webViewSupported=true
        bridge=nextBridge; dashboardView=view
        root.addView(view,FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT))
        view.loadUrl(ENTRY_URL)
    }
    private inner class DashboardClient(private val assets:WebViewAssetLoader):WebViewClient() {
            override fun shouldOverrideUrlLoading(view:WebView,request:WebResourceRequest)=!request.isForMainFrame || !AssetPolicy.allows(request.url.toString())
            @Deprecated("Legacy WebView callback")
            override fun shouldOverrideUrlLoading(view:WebView,url:String)=!AssetPolicy.allows(url)
            override fun shouldInterceptRequest(view:WebView,request:WebResourceRequest):WebResourceResponse {
                if(request.method!="GET" || !AssetPolicy.allows(request.url.toString())) return blocked()
                val result=assets.shouldInterceptRequest(request.url) ?: return blocked()
                result.responseHeaders=mapOf("Content-Security-Policy" to AssetPolicy.CSP,"X-Content-Type-Options" to "nosniff","Referrer-Policy" to "no-referrer","Cache-Control" to "no-store")
                return result
            }
            override fun onReceivedSslError(view:WebView,handler:SslErrorHandler,error:android.net.http.SslError) { handler.cancel() }
            override fun onRenderProcessGone(view:WebView,detail:RenderProcessGoneDetail):Boolean {
                if(view===dashboardView) { destroyDashboard(); main.post { createDashboard() } }
                return true
            }
        }
    private fun blocked()=WebResourceResponse("text/plain","UTF-8",403,"Blocked",mapOf("Content-Security-Policy" to AssetPolicy.CSP),ByteArrayInputStream(ByteArray(0)))
    fun showUnsupportedWebView() {
        destroyDashboard(); nativeSession.webViewSupported=false
        root.removeAllViews()
        root.addView(TextView(this).apply {
            tag="webview-guidance"
            setText(R.string.webview_guidance)
            setTextColor(Color.WHITE); textSize=20f; setPadding(32,32,32,32)
        })
    }
    private fun showSetupGuidance(kind:String,id:String) {
        if(isFinishing || isDestroyed || !nativeSession.isSetupActive()) return
        setupDialog=AlertDialog.Builder(this)
            .setTitle(if(kind=="hub") "Laptop pairing" else "Controller Wi-Fi")
            .setMessage(if(kind=="hub") "Native USB pairing is not installed in this diagnostic host yet." else "Native controller setup is not installed in this diagnostic host yet.")
            .setPositiveButton("Close") { _,_-> nativeSession.finishSetup(kind,id,"cancelled") }
            .setOnCancelListener { nativeSession.finishSetup(kind,id,"cancelled") }
            .create().also { it.show() }
    }
    private fun applyScreenSettings() {
        if(!::nativeSession.isInitialized) return
        val settings=nativeSession.screenSettings()
        if(activityStarted && settings["screenOn"].asBoolean) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.attributes=window.attributes.apply { screenBrightness=if(activityStarted) settings["brightness"].asFloat else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE }
    }
    private fun destroyDashboard() {
        bridge?.dispose(); bridge=null; lifecycle=null
        dashboardView?.let { root.removeView(it); it.stopLoading(); it.webChromeClient=null; it.destroy() }
        dashboardView=null
    }
    override fun onStart() { super.onStart(); activityStarted=true; userLeaving=false; lifecycle?.enterForeground(); dashboardView?.onResume(); applyScreenSettings() }
    override fun onUserLeaveHint() { userLeaving=true; super.onUserLeaveHint() }
    override fun onStop() {
        activityStarted=false
        // Permission/system approval can stop an Activity; genuine Home/background still ends work.
        lifecycle?.onActivityStopped(userLeaving); dashboardView?.onPause(); applyScreenSettings(); super.onStop()
    }
    override fun onDestroy() { setupDialog?.dismiss(); destroyDashboard(); nativeSession.close(); main.removeCallbacksAndMessages(null); super.onDestroy() }
}
