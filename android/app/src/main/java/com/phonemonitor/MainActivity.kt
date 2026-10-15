package com.phonemonitor

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.res.Configuration
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputFilter
import android.text.InputType
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
    private lateinit var dashboardWindow:DashboardWindow
    /** Activity-owned controller client and Wi-Fi selection: caches, outcomes and the request outlive renderers. */
    private lateinit var esp:EspClient
    private lateinit var wifi:WifiSession
    private lateinit var wifiStore:WifiStore
    private lateinit var wifiFlow:WifiSetupFlow
    private var permissionSetupId:String?=null
    private var wifiStatus:TextView?=null

    override fun onCreate(savedInstanceState:Bundle?) {
        super.onCreate(savedInstanceState)
        window.setBackgroundDrawable(ColorDrawable(Color.rgb(42,40,35)))
        root=FrameLayout(this).apply { setBackgroundColor(Color.rgb(42,40,35)) }
        setContentView(root)
        dashboardWindow=DashboardWindow(this,root) { setupDialog?.isShowing==true }
        // Session callbacks retain only a weak Activity reference and post bounded UI work.
        val owner=WeakReference(this)
        val ui=main
        laptop=LaptopClient(PrivatePairingStore(this)) { paired -> owner.get()?.let { if(it::nativeSession.isInitialized) it.nativeSession.paired=paired } }
        val client=laptop
        esp=EspClient.create()
        val controller=esp
        nativeSession=NativeSession(
            // A genuine background/end releases hub requests, controller I/O, queued commands and the Wi-Fi request.
            onBackground={ client.pause(); controller.pause(); owner.get()?.let{ if(it::wifi.isInitialized) it.wifi.pause() } },
            onStartSetup={kind,id->ui.post { owner.get()?.showSetupGuidance(kind,id) }},
            onCancelSetup={kind,id->ui.post { owner.get()?.let { it.setupDialog?.dismiss(); if(kind=="esp") it.wifiFlow.onSetupEnded(id) } }},
            onScreenChanged={_,_->ui.post { owner.get()?.applyScreenSettings() }},
        )
        nativeSession.paired=laptop.paired
        wifiStore=PrivateWifiStore(this)
        val session=nativeSession
        wifi=WifiSession(AndroidWifiPlatform(this),wifiStore,{ lease -> controller.onNetworkChanged(lease) },{ mode -> session.wifiMode=mode })
        wifiFlow=WifiSetupFlow(nativeSession,wifi,wifiStore,AndroidPermissionGate(applicationContext),
            { lease,done -> controller.verify(lease) { ok -> ui.post { done(ok) } } },
            object:WifiSetupUi {
                override fun requestPermissions(setupId:String,permissions:List<String>) { ui.post { owner.get()?.requestWifiPermissions(setupId,permissions) } }
                override fun show(setupId:String,message:WifiSetupMessage) { ui.post { owner.get()?.showWifiMessage(setupId,message) } }
            })
        pairingFlow=HubPairingFlow(nativeSession,client::pair,{ pairingWorker.execute(it) },{ action -> ui.post { if(owner.get()?.isDestroyed==false) action() } })
        createDashboard()
    }
    @SuppressLint("SetJavaScriptEnabled")
    private fun createDashboard() {
        if(isFinishing || isDestroyed) return
        val view=WebView(this).apply { setBackgroundColor(Color.rgb(42,40,35)) }
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
        val controller=esp
        val selection=wifi
        // hub.snapshot (A2, unbound loopback) and esp.* (A3, selected Wi-Fi network) are independent clients.
        val services=object:UnavailableBridgeServices() {
            override fun hubSnapshot()=client.snapshot().toJson()
            override fun espState()=controller.state().toJson()
            override fun espHistory()=controller.history().toJson()
            override fun setLight(patch:com.google.gson.JsonObject,generation:Long)=controller.set(LightPatch.fromJson(patch),generation).toJson()
            override fun hubAction(action:String)=client.action(action)
            override fun openWifiSettings():com.google.gson.JsonObject {
                // Manual fallback: observe the Wi-Fi the user joins, unless a working app request already exists.
                if(selection.mode!="app_request" || selection.current()==null) selection.useManual()
                return jsonObject("opened" to (owner.get()?.openSettings(Settings.ACTION_WIFI_SETTINGS)==true))
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
        if(kind=="hub") showPairingDialog(id) else showWifiDialog(id)
    }
    private fun openSettings(action:String):Boolean = try {
        if(isFinishing || isDestroyed) false else { startActivity(Intent(action)); true }
    } catch(_:RuntimeException) { false }
    /** The one native dialog for app.connectEsp. SSID/passphrase stay native; the passphrase is never prefilled. */
    private fun showWifiDialog(id:String) {
        val pad=(16*resources.displayMetrics.density).toInt()
        val message=TextView(this).apply { setText(R.string.wifi_instructions); setPadding(0,0,0,pad/2) }
        val ssid=EditText(this).apply {
            inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setHint(R.string.wifi_ssid_hint); setText(wifiStore.credentials()?.ssid ?: "")
            isSaveEnabled=false; importantForAutofill=View.IMPORTANT_FOR_AUTOFILL_NO
        }
        val passphrase=EditText(this).apply {
            inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            filters=arrayOf(InputFilter.LengthFilter(63))
            setHint(R.string.wifi_password_hint)
            isSaveEnabled=false; importantForAutofill=View.IMPORTANT_FOR_AUTOFILL_NO
        }
        val content=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; setPadding(pad,pad/2,pad,0); addView(message); addView(ssid); addView(passphrase) }
        wifiStatus=message
        val dialog=AlertDialog.Builder(this)
            .setTitle(R.string.wifi_title)
            .setView(content)
            .setPositiveButton(R.string.wifi_connect,null)
            .setNeutralButton(R.string.wifi_manual) { _,_-> wifiFlow.chooseManual(id); openSettings(Settings.ACTION_WIFI_SETTINGS) }
            .setNegativeButton(R.string.pairing_cancel) { _,_-> nativeSession.finishSetup("esp",id,"cancelled"); wifiFlow.onSetupEnded(id) }
            .setOnCancelListener { nativeSession.finishSetup("esp",id,"cancelled"); wifiFlow.onSetupEnded(id) }
            .create()
        dialog.setCanceledOnTouchOutside(false)
        dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        dialog.setOnShowListener {
            val button:Button=dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            button.setOnClickListener {
                val accepted=wifiFlow.submit(id,ssid.text.toString(),passphrase.text.toString())
                passphrase.text.clear()
                if(!accepted && !nativeSession.isSetupCurrent("esp",id)) dialog.dismiss()
            }
        }
        setupDialog=dialog
        dialog.show()
        main.postDelayed({ if(!isDestroyed) nativeSession.isSetupActive() },120_500)
    }
    private fun showWifiMessage(id:String,message:WifiSetupMessage) {
        if(isFinishing || isDestroyed) return
        val text=when(message) {
            WifiSetupMessage.INVALID_INPUT -> R.string.wifi_invalid
            WifiSetupMessage.CONNECTING -> R.string.wifi_connecting
            WifiSetupMessage.CONNECTED -> { setupDialog?.dismiss(); return }
            WifiSetupMessage.PERMISSION_DENIED -> R.string.wifi_denied
            WifiSetupMessage.LOCATION_OFF -> R.string.wifi_location_off
            WifiSetupMessage.UNAVAILABLE -> R.string.wifi_unavailable
            WifiSetupMessage.CONTROLLER_UNREACHABLE -> R.string.wifi_unreachable
            WifiSetupMessage.SAVE_FAILED -> R.string.wifi_save_failed
        }
        if(nativeSession.isSetupCurrent("esp",id)) { wifiStatus?.setText(text); return }
        // The flow has finished as failed: one explanation with the manual fallback. No automatic re-prompt.
        setupDialog?.dismiss()
        val builder=AlertDialog.Builder(this).setTitle(R.string.wifi_title).setMessage(text).setNegativeButton(R.string.wifi_close,null)
        if(message==WifiSetupMessage.LOCATION_OFF) builder.setPositiveButton(R.string.wifi_location_settings) { _,_-> openSettings(Settings.ACTION_LOCATION_SOURCE_SETTINGS) }
        else builder.setPositiveButton(R.string.wifi_manual) { _,_-> wifi.useManual(); openSettings(Settings.ACTION_WIFI_SETTINGS) }
        setupDialog=builder.create().also { it.show() }
    }
    /** A real OS permission screen: the flow has already marked the approval outstanding for this setup. */
    private fun requestWifiPermissions(id:String,permissions:List<String>) {
        if(isFinishing || isDestroyed || !nativeSession.isSetupCurrent("esp",id)) { wifiFlow.onPermissionsResult(id,false); return }
        permissionSetupId=id
        requestPermissions(permissions.toTypedArray(),WIFI_PERMISSION_REQUEST)
    }
    override fun onRequestPermissionsResult(requestCode:Int,permissions:Array<out String>,grantResults:IntArray) {
        super.onRequestPermissionsResult(requestCode,permissions,grantResults)
        if(requestCode!=WIFI_PERMISSION_REQUEST) return
        val id=permissionSetupId ?: return
        permissionSetupId=null
        // An interrupted request returns empty arrays and counts as denied (no automatic re-prompt).
        wifiFlow.onPermissionsResult(id,grantResults.isNotEmpty() && grantResults.all{ it==PackageManager.PERMISSION_GRANTED })
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
        laptop.resume(); esp.resume(); wifi.resume(); lifecycle?.enterForeground(); dashboardView?.onResume(); applyScreenSettings()
    }
    override fun onResume() { super.onResume(); dashboardWindow.onResume() }
    override fun onPause() { dashboardWindow.onPause(); super.onPause() }
    override fun onWindowFocusChanged(hasFocus:Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if(::dashboardWindow.isInitialized) dashboardWindow.onWindowFocusChanged(hasFocus)
    }
    override fun onConfigurationChanged(newConfig:Configuration) {
        super.onConfigurationChanged(newConfig)
        dashboardWindow.onConfigurationChanged()
    }
    override fun onUserLeaveHint() { userLeaving=true; super.onUserLeaveHint() }
    override fun onStop() {
        activityStarted=false
        // Permission/system approval can stop an Activity; genuine Home/background still ends work.
        lifecycle?.onActivityStopped(userLeaving); dashboardView?.onPause(); applyScreenSettings()
        // Only a matching OS approval pause keeps the foreground session; anything else releases hub requests.
        if(!nativeSession.foreground) { laptop.pause(); esp.pause(); wifi.pause() }
        super.onStop()
    }
    override fun onDestroy() {
        setupDialog?.dismiss(); destroyDashboard(); nativeSession.close(); laptop.close(); wifi.close(); esp.close()
        pairingWorker.shutdownNow(); dashboardWindow.close()
        main.removeCallbacksAndMessages(null); super.onDestroy()
    }
    private companion object { const val WIFI_PERMISSION_REQUEST=4101 }
}
