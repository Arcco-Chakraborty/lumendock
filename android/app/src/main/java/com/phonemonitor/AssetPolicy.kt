package com.phonemonitor
import java.net.URI
object AssetPolicy {
    const val CSP="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    fun allows(url:String):Boolean = try {
        val u=URI(url)
        u.scheme=="https" && u.rawAuthority=="appassets.androidplatform.net" && u.rawQuery==null &&
            u.rawPath.startsWith("/assets/") && u.rawPath.matches(Regex("/[A-Za-z0-9/_.@-]+")) &&
            u.rawPath.split('/').none{it=="." || it==".."}
    } catch(_:Exception) { false }
}
