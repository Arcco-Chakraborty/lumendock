package com.phonemonitor

import com.google.gson.JsonObject
import java.util.UUID

/** Activity-owned state. It is deliberately independent of every WebView and its request jobs. */
class NativeSession(
    private val clock:()->Long={System.nanoTime()/1_000_000},
    private val onBackground:()->Unit={},
    private val onStartSetup:(kind:String,id:String)->Unit={_,_->},
    private val onCancelSetup:(kind:String,id:String)->Unit={_,_->},
    private val onScreenChanged:(enabled:Boolean,brightness:Double)->Unit={_,_->},
) : AutoCloseable {
    private data class Setup(val id:String?=null, val state:String="idle", val error:String?=null, val beganAt:Long=0) {
        fun json()=jsonObject("setupId" to id,"state" to state,"errorCode" to error)
    }
    @Volatile var paired=false
    @Volatile var webViewSupported=true
    @Volatile var wifiMode="none"
    @Volatile var foreground=false; private set
    private var ended=false
    private val setup=mutableMapOf("hub" to Setup(),"esp" to Setup())
    private var screenOn=true
    private var brightness=0.6
    private var generation=1L
    private var generationsExhausted=false
    /** Setup whose human-visible OS permission/approval screen is currently outstanding. */
    private var approvalSetupId:String?=null

    @Synchronized fun startSetup(kind:String):JsonObject {
        require(kind in setup)
        if(ended) throw BridgeFailure("SESSION_ENDED")
        expireSetup()
        val current=setup.getValue(kind)
        if(current.state=="in_progress") return jsonObject("setupId" to current.id,"started" to false)
        if(setup.values.any{it.state=="in_progress"}) throw BridgeFailure("SETUP_BUSY")
        val next=Setup(UUID.randomUUID().toString(),"in_progress",beganAt=clock())
        setup[kind]=next
        // Host callback must post native UI rather than wait for human interaction.
        try { onStartSetup(kind,next.id!!) } catch (_:RuntimeException) {
            setup[kind]=next.copy(state="failed",error="SOURCE_UNAVAILABLE")
        }
        return jsonObject("setupId" to next.id,"started" to true)
    }
    @Synchronized fun finishSetup(kind:String,id:String,state:String,errorCode:String?=null) {
        require(state in setOf("succeeded","cancelled","failed"))
        require(if(state=="failed") errorCode in ProtocolValidator.errors else errorCode==null)
        expireSetup()
        val current=setup[kind] ?: return
        if(ended || current.id!=id || current.state!="in_progress") return
        setup[kind]=current.copy(state=state,error=errorCode)
        if(approvalSetupId==id) approvalSetupId=null
        if(kind=="hub" && state=="succeeded") paired=true
    }
    /** A2/A3 call this just before launching an OS permission/approval screen for the live setup flow. */
    @Synchronized fun beginOsApproval(kind:String,setupId:String) {
        expireSetup()
        val current=setup[kind] ?: return
        if(!ended && current.id==setupId && current.state=="in_progress") approvalSetupId=setupId
    }
    @Synchronized fun endOsApproval(setupId:String) { if(approvalSetupId==setupId) approvalSetupId=null }
    /**
     * An Activity stop is an approval pause only when a matching OS approval is outstanding and the user
     * did not leave; active setup alone (e.g. an incoming-call Activity, which skips onUserLeaveHint) is not proof.
     */
    @Synchronized fun activityStopReason(userLeaving:Boolean):String {
        expireSetup()
        val pending=approvalSetupId
        val outstanding=pending!=null && setup.values.any{it.id==pending && it.state=="in_progress"}
        return if(outstanding && !userLeaving) "approval_pause" else "background"
    }
    @Synchronized fun isSetupActive():Boolean { expireSetup(); return setup.values.any{it.state=="in_progress"} }
    /** True only while this exact flow is still live; stale dialogs and late results use it to stand down. */
    @Synchronized fun isSetupCurrent(kind:String,setupId:String):Boolean { expireSetup(); val s=setup[kind]; return !ended && s?.id==setupId && s.state=="in_progress" }
    private fun expireSetup() {
        setup.toMap().forEach { (kind,s) -> if(s.state=="in_progress" && clock()-s.beganAt>=120_000) {
            setup[kind]=s.copy(state="failed",error=if(kind=="hub") "PAIRING_EXPIRED" else "WIFI_UNAVAILABLE")
            if(approvalSetupId==s.id) approvalSetupId=null
            onCancelSetup(kind,s.id!!)
        } }
    }
    @Synchronized fun status():JsonObject {
        expireSetup()
        return jsonObject("paired" to paired,"webViewSupported" to webViewSupported,"wifiMode" to wifiMode,
            "setup" to jsonObject("hub" to setup.getValue("hub").json(),"esp" to setup.getValue("esp").json()),
            "screenOn" to screenOn,"brightness" to brightness,"nextCommandGeneration" to generation)
    }
    @Synchronized fun setScreenOn(enabled:Boolean):JsonObject { screenOn=enabled; onScreenChanged(screenOn,brightness); return screenSettings() }
    @Synchronized fun setBrightness(value:Double):JsonObject { require(value.isFinite() && value in 0.1..1.0); brightness=value; onScreenChanged(screenOn,brightness); return screenSettings() }
    @Synchronized fun screenSettings()=jsonObject("screenOn" to screenOn,"brightness" to brightness)
    /** Reserve before dispatch; never recycle a generation after a timeout or renderer crash. */
    @Synchronized fun reserveGeneration(value:Long) {
        if(generationsExhausted || value<generation || value>ProtocolValidator.MAX_SAFE) throw BridgeFailure("BAD_GENERATION")
        if(value==ProtocolValidator.MAX_SAFE) { generation=value; generationsExhausted=true } else generation=value+1
    }
    @Synchronized fun enterForeground() { if(!ended) foreground=true }
    @Synchronized fun leaveForeground(reason:String) {
        if(reason=="approval_pause" || ended) return
        val wasForeground=foreground; foreground=false
        cancelSetups()
        if(wasForeground) onBackground()
    }
    private fun cancelSetups() {
        approvalSetupId=null
        setup.toMap().forEach { (kind,s) -> if(s.state=="in_progress") {
            setup[kind]=s.copy(state="cancelled",error=null); onCancelSetup(kind,s.id!!)
        } }
    }
    @Synchronized override fun close() {
        if(ended) return
        cancelSetups(); foreground=false; ended=true; onBackground()
    }
}

/** Renderer-owned callbacks. Closing this scope never closes the Activity-owned NativeSession. */
class SessionLifecycle(val session:NativeSession) : AutoCloseable {
    private data class PendingCallback(val epoch:Long,val callback:(String)->Unit)
    private val pending=LinkedHashMap<String,PendingCallback>()
    @Volatile var epoch=0L; private set
    @Volatile var isOpen=true; private set
    /** Closed until the Activity actually starts; a replacement renderer must never accept work while stopped. */
    @Volatile var acceptsRequests=false; private set
    val pendingCount:Int @Synchronized get()=pending.size
    @Synchronized fun registerPending(id:String,callback:(String)->Unit):Boolean {
        if(!isOpen || !acceptsRequests || pending.size>=32 || pending.containsKey(id)) return false
        pending[id]=PendingCallback(epoch,callback); return true
    }
    /** A delayed reply can complete only the registration from its own foreground epoch. */
    @Synchronized fun completePending(id:String,requestEpoch:Long) {
        if(pending[id]?.epoch==requestEpoch) pending.remove(id)
    }
    /** True only for the same renderer scope and foreground epoch that accepted the request. */
    fun isCurrent(requestEpoch:Long):Boolean = isOpen && acceptsRequests && epoch==requestEpoch
    fun enterForeground() { if(isOpen) { acceptsRequests=true; session.enterForeground() } }
    fun onActivityStopped(userLeaving:Boolean) { leaveForeground(session.activityStopReason(userLeaving)) }
    fun leaveForeground(reason:String) {
        if(reason=="approval_pause") return
        epoch++; acceptsRequests=false; cancelPending(); session.leaveForeground(reason)
    }
    private fun cancelPending() {
        val callbacks=synchronized(this) { pending.values.map{it.callback}.also{pending.clear()} }
        callbacks.forEach{it("SESSION_ENDED")}
    }
    override fun close() { epoch++; isOpen=false; acceptsRequests=false; cancelPending() }
}
