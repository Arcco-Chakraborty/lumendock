package com.phonemonitor

import com.google.gson.JsonObject

const val TRUSTED_ORIGIN="https://appassets.androidplatform.net"
const val ENTRY_URL="$TRUSTED_ORIGIN/assets/index.html"

class BridgeFailure(val code:String,val requestId:String="invalid") : RuntimeException(code)
data class BridgeReply(val id:String,val ok:Boolean,val data:JsonObject?=null,val errorCode:String?=null) {
    fun toJson():String = if(ok) jsonObject("v" to 1,"id" to id,"ok" to true,"data" to data).toString()
        else jsonObject("v" to 1,"id" to id,"ok" to false,"error" to jsonObject("code" to (errorCode ?: "BAD_PAYLOAD"),"retryable" to (errorCode in setOf("USB_UNAVAILABLE","WIFI_UNAVAILABLE","REQUEST_TIMEOUT","HUB_UNAVAILABLE")))).toString()
    companion object { fun failure(id:String,code:String)=BridgeReply(id,false,errorCode=if(code in ProtocolValidator.errors) code else "BAD_PAYLOAD") }
}

interface BridgeServices {
    fun hubSnapshot():JsonObject
    fun espState():JsonObject
    fun espHistory():JsonObject
    fun setLight(patch:JsonObject,generation:Long):JsonObject
    fun openWifiSettings():JsonObject
}
/** Explicit unavailable states until A2/A3 clients are installed. No simulated live data. */
open class UnavailableBridgeServices : BridgeServices {
    override fun hubSnapshot()=unavailable("USB_UNAVAILABLE")
    override fun espState()=unavailable("WIFI_UNAVAILABLE").also{it.add("commands",jsonObject("state" to null,"timer" to null))}
    override fun espHistory()=unavailable("WIFI_UNAVAILABLE")
    override fun setLight(patch:JsonObject,generation:Long):JsonObject=throw BridgeFailure("WIFI_UNAVAILABLE")
    override fun openWifiSettings()=jsonObject("opened" to false)
    private fun unavailable(code:String)=jsonObject("state" to "disconnected","ageMs" to null,"stale" to true,"data" to null,"errorCode" to code)
}

class PreparedRequest internal constructor(val id:String,val op:String,val args:JsonObject,val epoch:Long)

/** Validation/reservation is synchronous; typed service execution can run on a bounded worker. */
class BridgeRouter(private val services:BridgeServices,val lifecycle:SessionLifecycle) {
    private val live=mutableMapOf<String,PreparedRequest>()
    private val liveOps=mutableSetOf<String>()
    fun prepare(requestJson:String,sourceOrigin:String,isMainFrame:Boolean):PreparedRequest {
        if(sourceOrigin!=TRUSTED_ORIGIN || !isMainFrame || requestJson.length>16384 || requestJson.toByteArray(Charsets.UTF_8).size>16384) throw BridgeFailure("BAD_PAYLOAD")
        var id="invalid"
        try {
            val value=StrictJson.parse(requestJson)
            require(value.isJsonObject)
            val o=value.asJsonObject
            o["id"]?.let{ if(it.isJsonPrimitive && it.asJsonPrimitive.isString && it.asString.isNotEmpty() && it.asString.codePointCount(0,it.asString.length)<=80) id=it.asString }
            require(ProtocolValidator.request(o))
            val request=PreparedRequest(id,o["op"].asString,o["args"].asJsonObject,lifecycle.epoch)
            synchronized(this) {
                if(!lifecycle.isOpen || !lifecycle.acceptsRequests) throw BridgeFailure("SESSION_ENDED",id)
                if(live.size>=32 || id in live || request.op in liveOps) throw BridgeFailure("BAD_PAYLOAD",id)
                live[id]=request; liveOps.add(request.op)
            }
            return request
        } catch(e:BridgeFailure) { throw e } catch(_:Exception) { throw BridgeFailure("BAD_PAYLOAD",id) }
    }
    fun execute(r:PreparedRequest):BridgeReply {
        try {
            if(!lifecycle.isOpen || !lifecycle.acceptsRequests || lifecycle.epoch!=r.epoch) return BridgeReply.failure(r.id,"SESSION_ENDED")
            val session=lifecycle.session
            val data=when(r.op) {
                "hub.snapshot" -> services.hubSnapshot()
                "esp.state" -> services.espState()
                "esp.history" -> services.espHistory()
                "esp.set" -> { val g=r.args["generation"].asLong; session.reserveGeneration(g); services.setLight(r.args["patch"].asJsonObject,g) }
                "app.status" -> session.status()
                "app.setupHub" -> session.startSetup("hub")
                "app.connectEsp" -> session.startSetup("esp")
                "app.openWifiSettings" -> services.openWifiSettings()
                "app.setScreenOn" -> session.setScreenOn(r.args["enabled"].asBoolean)
                "app.setBrightness" -> session.setBrightness(r.args["value"].asDouble)
                else -> throw BridgeFailure("BAD_PAYLOAD")
            }
            if(!lifecycle.isOpen || !lifecycle.acceptsRequests || lifecycle.epoch!=r.epoch) return BridgeReply.failure(r.id,"SESSION_ENDED")
            if(!ProtocolValidator.response(r.op,data)) return BridgeReply.failure(r.id,"BAD_PAYLOAD")
            return BridgeReply(r.id,true,data.deepCopy())
        } catch(e:BridgeFailure) { return BridgeReply.failure(r.id,e.code) }
        catch(_:Exception) { return BridgeReply.failure(r.id,"BAD_PAYLOAD") }
        finally { release(r) }
    }
    @Synchronized fun release(r:PreparedRequest) { if(live[r.id]===r) {live.remove(r.id); liveOps.remove(r.op)} }
    fun handle(requestJson:String,sourceOrigin:String,isMainFrame:Boolean):BridgeReply = try { execute(prepare(requestJson,sourceOrigin,isMainFrame)) } catch(e:BridgeFailure) { BridgeReply.failure(e.requestId,e.code) }
}
