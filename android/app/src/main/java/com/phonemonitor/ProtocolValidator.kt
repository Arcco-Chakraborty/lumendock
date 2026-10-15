package com.phonemonitor

import com.google.gson.*
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.StringReader
import java.math.BigDecimal

/** Strict JSON, including duplicate-key, depth, trailing-data and nonfinite rejection. */
object StrictJson {
    fun parse(text: String): JsonElement = JsonReader(StringReader(text)).use { reader ->
        reader.strictness = Strictness.STRICT
        val value = read(reader, 0)
        require(reader.peek() == JsonToken.END_DOCUMENT)
        value
    }
    private fun read(r: JsonReader, depth: Int): JsonElement {
        require(depth <= 32)
        return when (r.peek()) {
            JsonToken.BEGIN_OBJECT -> JsonObject().also { o ->
                r.beginObject()
                while (r.hasNext()) { val key=r.nextName(); require(!o.has(key)); o.add(key, read(r,depth+1)) }
                r.endObject()
            }
            JsonToken.BEGIN_ARRAY -> JsonArray().also { a -> r.beginArray(); while(r.hasNext()) a.add(read(r,depth+1)); r.endArray() }
            JsonToken.STRING -> JsonPrimitive(r.nextString())
            JsonToken.NUMBER -> JsonPrimitive(BigDecimal(r.nextString()).also { require(it.toDouble().isFinite()) })
            JsonToken.BOOLEAN -> JsonPrimitive(r.nextBoolean())
            JsonToken.NULL -> { r.nextNull(); JsonNull.INSTANCE }
            else -> throw IllegalArgumentException("BAD_PAYLOAD")
        }
    }
}

/** Mirrors packages/protocol/src/schema.ts. No open-ended objects cross the bridge. */
object ProtocolValidator {
    const val MAX_SAFE = 9007199254740991L
    val errors = setOf("USB_UNAVAILABLE","AUTH_REQUIRED","PAIRING_EXPIRED","PAIRING_CLOSED","BAD_PAIRING_CODE","TOKEN_PERSIST_FAILED","WIFI_UNAVAILABLE","SENSOR_UNAVAILABLE","BAD_PAYLOAD","UNSUPPORTED_WEBVIEW","COMMAND_UNCONFIRMED","NOTIFICATION_MONITOR_DENIED","SOURCE_CAPACITY_EXCEEDED","SOURCE_UNAVAILABLE","SETUP_BUSY","BAD_GENERATION","REQUEST_TIMEOUT","BRIDGE_UNAVAILABLE","SESSION_ENDED","QUEUE_FULL","NOTIFICATION_MONITOR_UNAVAILABLE","UNSUPPORTED_SOURCE","HUB_UNAVAILABLE")
    private fun obj(e:JsonElement?, keys:String, optional:String="", check:(JsonObject)->Boolean={true}):Boolean {
        if(e?.isJsonObject != true) return false
        val o=e.asJsonObject; val required=keys.split(' ').filter(String::isNotEmpty).toSet(); val allowed=required+optional.split(' ').filter(String::isNotEmpty)
        return o.keySet().containsAll(required) && allowed.containsAll(o.keySet()) && check(o)
    }
    private fun str(e:JsonElement?, max:Int=80, nonempty:Boolean=false):Boolean = e?.isJsonPrimitive==true && e.asJsonPrimitive.isString && e.asString.codePointCount(0,e.asString.length)<=max && (!nonempty || e.asString.isNotEmpty())
    private fun one(e:JsonElement?, vararg options:String) = str(e,256) && e!!.asString in options
    private fun bool(e:JsonElement?)= e?.isJsonPrimitive==true && e.asJsonPrimitive.isBoolean
    private fun num(e:JsonElement?, min:Double=-Double.MAX_VALUE, max:Double=Double.MAX_VALUE, integer:Boolean=false):Boolean = e?.isJsonPrimitive==true && e.asJsonPrimitive.isNumber && e.asDouble.isFinite() && e.asDouble in min..max && (!integer || e.asBigDecimal.stripTrailingZeros().scale()<=0)
    private fun int(e:JsonElement?, min:Long=0,max:Long=MAX_SAFE)=num(e,min.toDouble(),max.toDouble(),true)
    private fun nullable(e:JsonElement?, test:(JsonElement)->Boolean)=e!=null && (e.isJsonNull || test(e))
    private fun error(e:JsonElement?)=nullable(e){str(it,80) && it.asString in errors}
    private fun arr(e:JsonElement?, max:Int, test:(JsonElement)->Boolean)=e?.isJsonArray==true && e.asJsonArray.size()<=max && e.asJsonArray.all(test)
    private fun hex(e:JsonElement?, upper:Boolean)=str(e,7) && e!!.asString.matches(if(upper) Regex("#[0-9A-F]{6}") else Regex("#[0-9a-fA-F]{6}"))
    private fun budget(e:JsonElement, max:Int)=e.toString().toByteArray(Charsets.UTF_8).size<=max
    private fun brightness(e:JsonElement?)=num(e,0.1,1.0)
    fun request(o:JsonObject):Boolean = obj(o,"v id op args") {
        int(it["v"],1,1) && str(it["id"],80,true) && str(it["op"],80) && args(it["op"].asString,it["args"])
    }
    fun args(op:String, a:JsonElement?):Boolean = when(op) {
        "hub.snapshot","esp.state","esp.history","app.status","app.setupHub","app.connectEsp","app.openWifiSettings" -> obj(a,"")
        "app.setScreenOn" -> obj(a,"enabled"){bool(it["enabled"])}
        "app.setBrightness" -> obj(a,"value"){brightness(it["value"])}
        "esp.set" -> obj(a,"patch generation"){int(it["generation"],1) && patch(it["patch"])}
        else -> false
    }
    fun patch(e:JsonElement?):Boolean = obj(e,"","power hex bright mode speed timerMinutes") { p ->
        p.size()>0 && (!p.has("timerMinutes") || p.size()==1) && p.entrySet().all { (k,v) -> when(k) {
            "power" -> bool(v); "hex" -> hex(v,false); "bright","speed" -> int(v,1,100); "mode" -> int(v,0,8); "timerMinutes" -> int(v,0,720); else -> false
        } }
    }
    private fun esp(e:JsonElement?):Boolean = obj(e,"power hex bright mode speed timerSeconds sensorOk temperatureC humidityPercent uptimeSeconds") { o ->
        bool(o["power"]) && hex(o["hex"],true) && int(o["bright"],1,100) && int(o["mode"],0,8) && int(o["speed"],1,100) && int(o["timerSeconds"],0,43200) && bool(o["sensorOk"]) && nullable(o["temperatureC"]){num(it)} && nullable(o["humidityPercent"]){num(it,0.0,100.0)} && int(o["uptimeSeconds"])
    }
    private fun history(e:JsonElement?):Boolean = obj(e,"intervalSeconds temperatureC humidityPercent") { o ->
        num(o["intervalSeconds"],Double.MIN_VALUE) && arr(o["temperatureC"],120){nullable(it){v->num(v)}} && arr(o["humidityPercent"],120){nullable(it){v->num(v,0.0,100.0)}} && o["temperatureC"].asJsonArray.size()==o["humidityPercent"].asJsonArray.size() && budget(o,65536)
    }
    private fun window(e:JsonElement?):Boolean = obj(e,"bucketId windowId label usedPercent windowDurationMins resetsAtEpochSec reportedAtEpochMs") { o ->
        str(o["bucketId"],80,true) && str(o["windowId"],80,true) && str(o["label"]) && nullable(o["usedPercent"]){num(it,0.0)} && nullable(o["windowDurationMins"]){num(it,Double.MIN_VALUE)} && nullable(o["resetsAtEpochSec"]){int(it,0,253402300799)} && nullable(o["reportedAtEpochMs"]){int(it)}
    }
    private fun usage(e:JsonElement?,provider:String):Boolean = obj(e,"provider source state observedAtEpochMs lastSuccessAtEpochMs stale windows errorCode") { o ->
        one(o["provider"],provider) && one(o["source"],if(provider=="claude") "claude_statusline" else "codex_app_server") && one(o["state"],"available","awaiting_data","auth_required","unsupported","error") && nullable(o["observedAtEpochMs"]){int(it)} && nullable(o["lastSuccessAtEpochMs"]){int(it)} && bool(o["stale"]) && arr(o["windows"],if(provider=="claude") 2 else 62){window(it)} && error(o["errorCode"])
    }
    private fun notification(e:JsonElement?):Boolean = obj(e,"id appId title body receivedAtEpochMs expiresAtEpochMs") { o ->
        str(o["id"],80,true) && str(o["appId"],80,true) && str(o["title"],100) && str(o["body"],280) && int(o["receivedAtEpochMs"]) && int(o["expiresAtEpochMs"]) && (o["expiresAtEpochMs"].asLong-o["receivedAtEpochMs"].asLong) in 1..1800000
    }
    private fun hub(e:JsonElement?):Boolean = obj(e,"v serverNowEpochMs usage notifications") { o ->
        int(o["v"],1,1) && int(o["serverNowEpochMs"]) && obj(o["usage"],"claude codex"){usage(it["claude"],"claude") && usage(it["codex"],"codex")} && obj(o["notifications"],"state errorCode items"){one(it["state"],"disabled","available","unavailable") && error(it["errorCode"]) && arr(it["items"],100){n->notification(n)}} && budget(o,262144)
    }
    private fun command(e:JsonElement?, kind:String?=null):Boolean = obj(e,"generation kind outcome state errorCode") { o ->
        int(o["generation"],1) && one(o["kind"],*(kind?.let{arrayOf(it)} ?: arrayOf("state","timer"))) && one(o["outcome"],"pending","confirmed","unconfirmed","cancelled","superseded") && nullable(o["state"]){esp(it)} && error(o["errorCode"]) && (o["outcome"].asString!="confirmed" || !o["state"].isJsonNull)
    }
    private fun link(e:JsonElement?, payload:(JsonElement)->Boolean, commands:Boolean=false):Boolean = obj(e, "state ageMs stale data errorCode" + if(commands) " commands" else "") { o ->
        one(o["state"],"connecting","connected","disconnected","error") && nullable(o["ageMs"]){num(it,0.0)} && bool(o["stale"]) && nullable(o["data"],payload) && (o["data"].isJsonNull || !o["ageMs"].isJsonNull) && error(o["errorCode"]) && (!commands || obj(o["commands"],"state timer"){nullable(it["state"]){c->command(c,"state")} && nullable(it["timer"]){c->command(c,"timer")}})
    }
    private fun setup(e:JsonElement?):Boolean = obj(e,"setupId state errorCode") { o ->
        nullable(o["setupId"]){str(it,80,true)} && one(o["state"],"idle","in_progress","succeeded","cancelled","failed") && error(o["errorCode"]) && ((o["state"].asString=="idle")==o["setupId"].isJsonNull) && ((o["state"].asString=="failed")==!o["errorCode"].isJsonNull)
    }
    /** Strict HubSnapshot check for a raw hub payload, before it is cached or wrapped in a LinkSnapshot. */
    fun hubSnapshot(e:JsonElement):Boolean = try { hub(e) } catch (_:RuntimeException) { false }
    fun response(op:String,e:JsonObject):Boolean = try { when(op) {
        "hub.snapshot" -> link(e,::hub)
        "esp.state" -> link(e,::esp,true) && budget(e,65536)
        "esp.history" -> link(e,::history)
        "esp.set" -> command(e)
        "app.setupHub","app.connectEsp" -> obj(e,"setupId started"){str(it["setupId"],80,true) && bool(it["started"])}
        "app.openWifiSettings" -> obj(e,"opened"){bool(it["opened"])}
        "app.setScreenOn","app.setBrightness" -> obj(e,"screenOn brightness"){bool(it["screenOn"]) && brightness(it["brightness"])}
        "app.status" -> obj(e,"paired webViewSupported wifiMode setup screenOn brightness nextCommandGeneration") { o ->
            bool(o["paired"]) && bool(o["webViewSupported"]) && one(o["wifiMode"],"none","app_request","manual") && bool(o["screenOn"]) && brightness(o["brightness"]) && int(o["nextCommandGeneration"],1) && obj(o["setup"],"hub esp") { s -> setup(s["hub"]) && setup(s["esp"]) && !(s["hub"].asJsonObject["state"].asString=="in_progress" && s["esp"].asJsonObject["state"].asString=="in_progress") }
        }
        else -> false
    } } catch (_:RuntimeException) { false }
}
internal fun jsonObject(vararg pairs:Pair<String,Any?>):JsonObject = JsonObject().also { o -> pairs.forEach { (k,v) -> o.add(k, when(v) { null -> JsonNull.INSTANCE; is JsonElement -> v; is Boolean -> JsonPrimitive(v); is Number -> JsonPrimitive(v); is String -> JsonPrimitive(v); else -> error("Unsupported JSON value") }) } }
