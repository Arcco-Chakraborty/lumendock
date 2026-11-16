package com.phonemonitor

import android.content.Context
import com.google.gson.JsonArray
import java.io.IOException

/** Native private storage contains only bearer digests and non-secret device metadata. */
data class LocalHubStoredDevice(val id:String,val name:String,val digest:String)
data class LocalHubStoredState(val devices:List<LocalHubStoredDevice>,val selectedDeviceId:String?)
interface LocalHubStore {
    fun load():LocalHubStoredState
    @Throws(IOException::class) fun save(value:LocalHubStoredState)
}
data class LocalHubDevice(val id:String,val name:String)
/** Never pass this value to a WebView or status reply. Display the bearer once in native enrollment UI. */
class LocalHubEnrollment(val deviceId:String,val bearer:String) {
    override fun toString()="LocalHubEnrollment(redacted)"
}
class PrivateLocalHubStore(context:Context):LocalHubStore {
    private val preferences=context.applicationContext.getSharedPreferences("native_local_hub",Context.MODE_PRIVATE)
    override fun load():LocalHubStoredState = try {
        val raw=preferences.getString("devices",null) ?: return LocalHubStoredState(emptyList(),null)
        if(raw.length>8192) throw IOException("BAD_PAYLOAD")
        val o=StrictJson.parse(raw).asJsonObject
        require(o.keySet()==setOf("devices","selectedDeviceId"))
        val rows=o["devices"].asJsonArray.map { e ->
            val d=e.asJsonObject; require(d.keySet()==setOf("id","name","digest"))
            require(d.entrySet().all{it.value.isJsonPrimitive && it.value.asJsonPrimitive.isString})
            LocalHubStoredDevice(d["id"].asString,d["name"].asString,d["digest"].asString)
        }
        val selected=o["selectedDeviceId"].let{if(it.isJsonNull) null else {require(it.isJsonPrimitive && it.asJsonPrimitive.isString); it.asString}}
        LocalHubStoredState(rows,selected).also(::validate)
    } catch(_:Exception) { throw IOException("TOKEN_PERSIST_FAILED") }
    override fun save(value:LocalHubStoredState) {
        validate(value)
        val devices=JsonArray().also{a -> value.devices.forEach{d -> a.add(jsonObject("id" to d.id,"name" to d.name,"digest" to d.digest))}}
        if(!preferences.edit().putString("devices",jsonObject("devices" to devices,"selectedDeviceId" to value.selectedDeviceId).toString()).commit()) throw IOException("TOKEN_PERSIST_FAILED")
    }
    internal companion object {
        fun validate(value:LocalHubStoredState) {
            require(value.devices.size<=8 && value.devices.map{it.id}.distinct().size==value.devices.size)
            require(value.devices.map{it.digest}.distinct().size==value.devices.size)
            value.devices.forEach { d -> require(d.id.matches(Regex("[a-f0-9-]{36}")) && validName(d.name) && d.digest.matches(Regex("[a-f0-9]{64}"))) }
            require(value.selectedDeviceId==null || value.devices.any{it.id==value.selectedDeviceId})
        }
        fun validName(name:String)=name.isNotBlank() && name.length<=40 && name.none{it.isISOControl()}
    }
}
