package com.phonemonitor

import android.content.Context
import java.io.IOException

/**
 * Native-only credential boundary. Nothing in BridgeServices, AppStatus or any reply reads it; only
 * LaptopClient's request construction does. Backup/device-transfer are disabled for every storage domain.
 */
interface PairingStore {
    fun getToken():String?
    @Throws(IOException::class) fun setToken(value:String)
    fun clearToken()
}

/** App-private SharedPreferences (MODE_PRIVATE). Survives hub restarts and app restarts until explicit replacement or a hub 401. */
class PrivatePairingStore(context:Context):PairingStore {
    private val preferences=context.applicationContext.getSharedPreferences(FILE,Context.MODE_PRIVATE)
    override fun getToken():String? = preferences.getString(KEY,null)?.takeIf{ LaptopClient.TOKEN_PATTERN.matches(it) }
    override fun setToken(value:String) {
        if(!LaptopClient.TOKEN_PATTERN.matches(value)) throw IOException("TOKEN_PERSIST_FAILED")
        // commit(), not apply(): pairing reports success only once the credential is durable.
        if(!preferences.edit().putString(KEY,value).commit()) throw IOException("TOKEN_PERSIST_FAILED")
    }
    // In memory the rejected token is already gone; if this write is lost, the next start meets one more 401 and clears again.
    override fun clearToken() { preferences.edit().remove(KEY).apply() }
    private companion object { const val FILE="native_pairing"; const val KEY="hub_token" }
}
