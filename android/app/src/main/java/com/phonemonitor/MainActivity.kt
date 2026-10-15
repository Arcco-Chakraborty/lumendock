package com.phonemonitor

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.InputFilter
import android.text.InputType
import android.view.OrientationEventListener
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.*
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.lang.ref.WeakReference
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

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
    /** Activity-owned: its cache/age baseline outlives every renderer; native process death re-fetches. */
    private lateinit var laptop:LaptopClient
    private lateinit var pairingFlow:HubPairingFlow
    /** Pairing I/O only; the thread exits when idle, and onDestroy shuts the pool down. */
    private val pairingWorker=ThreadPoolExecutor(0,1,1,TimeUnit.SECONDS,LinkedBlockingQueue(1))
    private val orientationPolicy=OrientationPolicy()
    private var orientationListener:OrientationEventListener?=null

    override fun onCreate(savedInstanceState:Bundle?) {
        super.onCreate(savedInstanceState)
        root=FrameLayout(this).apply { setBackgroundColor(Color.rgb(18,22,26)); fitsSystemWindows=true }
        setContentView(root)
        // Session callbacks retain only a weak Activity reference and post bounded UI work.
        val owner=WeakReference(this)
        val ui=main
        laptop=LaptopClient(PrivatePairingStore(this)) { paired -> owner.get()?.let { if(it::nativeSession.isInitialized) it.nativeSession.paired=paired } }
        val client=laptop
        nativeSession=NativeSession(
            onBackground={ client.pause() },
            onStartSetup={kind,id->ui.post { owner.get()?.showSetupGuidance(kind,id) }},
            onCancelSetup={_,_->ui.post { owner.get()?.setupDialog?.dismiss() }},
            onScreenChanged={_,_->ui.post { owner.get()?.applyScreenSettings() }},
        )
        nativeSession.paired=laptop.paired
        pairingFlow=HubPairingFlow(nativeSession,client::pair,{ pairingWorker.execute(it) },{ action -> ui.post { if(owner.get()?.isDestroyed==false) action() } })
        orientationListener=object:OrientationEventListener(this) {
            override fun onOrientationChanged(degrees:Int) {
                val reading=if(degrees==ORIENTATION_UNKNOWN) OrientationPolicy.UNKNOWN else degrees
                if(orientationPolicy.onReading(reading,SystemClock.elapsedRealtime())!=null) applyOrientationPolicy()
            }
        }
        createDashboard()
    }
    /** Manifest starts in sensorLandscape (landscape default); a deliberate portrait hold unlocks full rotation. */
    private fun applyOrientationPolicy() {
        requestedOrientation=if(orientationPolicy.mode==OrientationPolicy.Mode.LANDSCAPE_DEFAULT) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            else ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
        if(!orientationPolicy.needsSensor) orientationListener?.disable()
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
        val client=laptop
        // hub.snapshot is real (A2); esp.* remain explicit unavailable seams until A3.
        val services=object:UnavailableBridgeServices() {
            override fun hubSnapshot()=client.snapshot().toJson()
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
        setupDialog?.dismiss()
        if(kind=="hub") { showPairingDialog(id); return }
        setupDialog=AlertDialog.Builder(this)
            .setTitle("Controller Wi-Fi")
            .setMessage("Native controller setup is not installed in this diagnostic host yet.")
            .setPositiveButton("Close") { _,_-> nativeSession.finishSetup(kind,id,"cancelled") }
            .setOnCancelListener { nativeSession.finishSetup(kind,id,"cancelled") }
            .create().also { it.show() }
    }
    /** The one native code-entry dialog for app.setupHub. The code and token never touch the WebView. */
    private fun showPairingDialog(id:String) {
        val pad=(16*resources.displayMetrics.density).toInt()
        val message=TextView(this).apply { setText(R.string.pairing_instructions); setPadding(0,0,0,pad/2) }
        val input=EditText(this).apply {
            inputType=InputType.TYPE_CLASS_NUMBER
            filters=arrayOf(InputFilter.LengthFilter(8))
            setHint(R.string.pairing_hint)
            isSaveEnabled=false
            importantForAutofill=View.IMPORTANT_FOR_AUTOFILL_NO
        }
        val content=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; setPadding(pad,pad/2,pad,0); addView(message); addView(input) }
        val dialog=AlertDialog.Builder(this)
            .setTitle(R.string.pairing_title)
            .setView(content)
            .setPositiveButton(R.string.pairing_submit,null)
            .setNegativeButton(R.string.pairing_cancel) { _,_-> nativeSession.finishSetup("hub",id,"cancelled") }
            .setOnCancelListener { nativeSession.finishSetup("hub",id,"cancelled") }
            .create()
        dialog.setCanceledOnTouchOutside(false)
        // The short-lived code stays out of screenshots and the recents thumbnail.
        dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        dialog.setOnShowListener {
            val button:Button=dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            button.setOnClickListener {
                button.isEnabled=false; message.setText(R.string.pairing_progress)
                val accepted=pairingFlow.submit(id,input.text.toString()) { outcome ->
                    when(outcome) {
                        is PairingOutcome.Retry -> { button.isEnabled=true; input.text.clear(); message.setText(pairingMessage(outcome.code)) }
                        else -> dialog.dismiss()
                    }
                }
                if(!accepted) { if(nativeSession.isSetupCurrent("hub",id)) button.isEnabled=true else dialog.dismiss() }
            }
        }
        setupDialog=dialog
        dialog.show()
        // Native expiry also closes the dialog when no renderer is polling app.status.
        main.postDelayed({ if(!isDestroyed) nativeSession.isSetupActive() },120_500)
    }
    private fun pairingMessage(code:String)=when(code) {
        "BAD_PAIRING_CODE" -> R.string.pairing_bad_code
        "USB_UNAVAILABLE","REQUEST_TIMEOUT","HUB_UNAVAILABLE" -> R.string.pairing_unreachable
        else -> R.string.pairing_retry
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
    override fun onStart() {
        super.onStart(); activityStarted=true; userLeaving=false
        laptop.resume(); lifecycle?.enterForeground(); dashboardView?.onResume(); applyScreenSettings()
        orientationListener?.let { if(orientationPolicy.needsSensor && it.canDetectOrientation()) it.enable() }
    }
    override fun onUserLeaveHint() { userLeaving=true; super.onUserLeaveHint() }
    override fun onStop() {
        activityStarted=false
        // Permission/system approval can stop an Activity; genuine Home/background still ends work.
        lifecycle?.onActivityStopped(userLeaving); dashboardView?.onPause(); applyScreenSettings()
        // Only a matching OS approval pause keeps the foreground session; anything else releases hub requests.
        if(!nativeSession.foreground) laptop.pause()
        orientationListener?.disable()
        super.onStop()
    }
    override fun onDestroy() {
        setupDialog?.dismiss(); destroyDashboard(); nativeSession.close(); laptop.close()
        pairingWorker.shutdownNow(); orientationListener?.disable()
        main.removeCallbacksAndMessages(null); super.onDestroy()
    }
}
