package com.phonemonitor

import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.security.MessageDigest

/** A candidate is not proof of hotspot identity. Native setup requires the human to confirm it. */
data class LocalHubInterface(val interfaceName:String,val interfaceIndex:Int,val address:String)
class LocalHubLease internal constructor(val selected:LocalHubInterface,internal val identity:String)
/** Injectable only inside this module; production construction always uses LocalHubNetworks. */
internal interface LocalHubNetworkAccess {
    fun valid(lease:LocalHubLease):Boolean
    fun bindAddress(lease:LocalHubLease):InetSocketAddress
}
object LocalHubNetworks:LocalHubNetworkAccess {
    fun isPrivateIpv4(address:String):Boolean {
        val parts=address.split('.')
        if(parts.size!=4 || parts.any{!it.matches(Regex("0|[1-9][0-9]{0,2}"))}) return false
        val n=parts.map{it.toInt()}; if(n.any{it>255}) return false
        return n[0]==10 || (n[0]==172 && n[1] in 16..31) || (n[0]==192 && n[1]==168)
    }
    private fun eligible(n:NetworkInterface)=n.isUp && !n.isLoopback && !n.isPointToPoint && !n.isVirtual
    private fun identity(n:NetworkInterface):String = MessageDigest.getInstance("SHA-256").digest(
        (n.name+":"+n.index+":"+(n.hardwareAddress?.joinToString(""){"%02x".format(it)} ?: "unavailable")).toByteArray()
    ).joinToString(""){"%02x".format(it)}
    fun candidates():List<LocalHubInterface> = try {
        NetworkInterface.getNetworkInterfaces()?.toList().orEmpty().filter(::eligible).flatMap { n ->
            n.inetAddresses.toList().filterIsInstance<Inet4Address>().mapNotNull { a ->
                a.hostAddress?.takeIf(::isPrivateIpv4)?.let{LocalHubInterface(n.name,n.index,it)}
            }
        }.sortedWith(compareBy({it.interfaceName},{it.address}))
    } catch(_:Exception) { emptyList() }
    /** Caller invokes only after explicit native selection and confirmation; never choose the first candidate. */
    fun confirm(candidate:LocalHubInterface):LocalHubLease {
        if(candidate !in candidates()) throw BridgeFailure("WIFI_UNAVAILABLE")
        return try {
            val n=NetworkInterface.getByName(candidate.interfaceName) ?: throw BridgeFailure("WIFI_UNAVAILABLE")
            LocalHubLease(candidate,identity(n)).also { if(!valid(it)) throw BridgeFailure("WIFI_UNAVAILABLE") }
        } catch(_:Exception) { throw BridgeFailure("WIFI_UNAVAILABLE") }
    }
    override fun valid(lease:LocalHubLease):Boolean=try {
        val s=lease.selected; val n=NetworkInterface.getByName(s.interfaceName)
        isPrivateIpv4(s.address) && n!=null && eligible(n) && n.index==s.interfaceIndex && identity(n)==lease.identity &&
            n.inetAddresses.toList().any{it is Inet4Address && it.hostAddress==s.address}
    } catch(_:Exception) { false }
    override fun bindAddress(lease:LocalHubLease):InetSocketAddress {
        if(!valid(lease)) throw BridgeFailure("WIFI_UNAVAILABLE")
        // Already validated decimal IPv4; no DNS, wildcard, default-interface or fallback binding.
        return InetSocketAddress(InetAddress.getByAddress(lease.selected.address.split('.').map{it.toInt().toByte()}.toByteArray()),8787)
    }
}
