package com.phonemonitor

import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.Proxy
import java.net.ServerSocket
import java.net.URL
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Real JDK HttpURLConnection through the EspNetwork seam against a scripted loopback socket. Production
 * opens through android.net.Network.openConnection(url, Proxy.NO_PROXY); only this test network redirects
 * the socket to an ephemeral port. Android's own per-network HTTP stack is device-unrun.
 */
class NetworkEspTransportTest {
    private val server=ServerSocket(0,8,InetAddress.getByName("127.0.0.1"))
    private val heads=CopyOnWriteArrayList<String>()
    private val connections=CopyOnWriteArrayList<HttpURLConnection>()
    @Volatile private var script:(OutputStream)->Unit={ it.write(http(200,firmwareState().toByteArray())) }
    private val acceptor=Thread {
        while(!server.isClosed) {
            val socket=try { server.accept() } catch(_:Exception) { break }
            Thread { socket.use { s -> try { heads.add(readHead(s.getInputStream())); script(s.getOutputStream()); s.getOutputStream().flush() } catch(_:Exception) { /* client hung up */ } } }.apply{ isDaemon=true }.start()
        }
    }.apply{ isDaemon=true; start() }
    @After fun stop() { server.close() }
    private fun readHead(input:InputStream):String {
        val out=ByteArrayOutputStream()
        while(!out.toString(Charsets.ISO_8859_1.name()).endsWith("\r\n\r\n")) { val b=input.read(); if(b<0) break; out.write(b) }
        return out.toString(Charsets.ISO_8859_1.name())
    }
    private fun http(status:Int,body:ByteArray,extra:String="",length:Boolean=true):ByteArray =
        ("HTTP/1.1 $status X\r\nContent-Type: application/json\r\nConnection: close\r\n"+(if(length) "Content-Length: ${body.size}\r\n" else "")+extra+"\r\n").toByteArray(Charsets.ISO_8859_1)+body
    private inner class LoopbackNetwork(override val id:String="wifi-test"):EspNetwork {
        val opened=CopyOnWriteArrayList<String>()
        override fun openConnection(url:URL):HttpURLConnection {
            opened.add(url.toString())
            return (URL("http","127.0.0.1",server.localPort,url.file).openConnection(Proxy.NO_PROXY) as HttpURLConnection).also{ connections.add(it) }
        }
    }
    private object Mono:HubClock { override fun epochMs()=System.currentTimeMillis(); override fun monotonicMs()=System.nanoTime()/1_000_000 }
    private fun failure(block:()->Unit):EspTransportException = try { block(); fail("expected failure"); throw AssertionError() } catch(e:EspTransportException) { e }

    @Test fun usesFixedControllerUrlsThroughTheSelectedNetworkWithSafeSettings() {
        val network=LoopbackNetwork()
        val response=NetworkEspTransport(Mono).newCall(network,EspRequest.set(LightPatch(power=true,hex="#00ff7f",bright=9))).execute()
        assertEquals(200,response.status)
        assertEquals(listOf("http://192.168.4.1/api/set?power=1&hex=00FF7F&bright=9"),network.opened)
        val head=heads.single()
        assertTrue(head,head.startsWith("GET /api/set?power=1&hex=00FF7F&bright=9 HTTP/1.1\r\n"))
        assertFalse(head.lowercase().contains("authorization")); assertFalse(head.lowercase().contains("cookie"))
        val c=connections.single()
        assertEquals(1500,c.connectTimeout); assertEquals(2000,c.readTimeout); assertFalse(c.instanceFollowRedirects); assertFalse(c.useCaches)
    }
    @Test fun redirectsOversizeAndTruncationFailClosed() {
        script={ it.write(http(302,ByteArray(0),"Location: http://192.168.4.1/\r\n")) }
        assertEquals("BAD_PAYLOAD",failure{ NetworkEspTransport(Mono).newCall(LoopbackNetwork(),EspRequest.state()).execute() }.code)
        Thread.sleep(100); assertEquals("Redirect is not followed",1,heads.size)
        script={ it.write(http(404,"Not found".toByteArray())) }
        assertEquals("BAD_PAYLOAD",failure{ NetworkEspTransport(Mono).newCall(LoopbackNetwork(),EspRequest.state()).execute() }.code)
        script={ it.write(http(200,ByteArray(0),"Content-Length: ${ESP_REPLY_BYTES+1}\r\n",length=false)) }
        assertEquals("BAD_PAYLOAD",failure{ NetworkEspTransport(Mono).newCall(LoopbackNetwork(),EspRequest.state()).execute() }.code)
        script={ it.write(http(200,ByteArray(ESP_REPLY_BYTES+1){' '.code.toByte()},length=false)) }
        assertEquals("BAD_PAYLOAD",failure{ NetworkEspTransport(Mono).newCall(LoopbackNetwork(),EspRequest.history()).execute() }.code)
        script={ it.write(http(200,"{\"iv\":".toByteArray(),"Content-Length: 900\r\n",length=false)) }
        val truncated=failure{ NetworkEspTransport(Mono).newCall(LoopbackNetwork(),EspRequest.history()).execute() }.code
        assertTrue(truncated,truncated in setOf("BAD_PAYLOAD","WIFI_UNAVAILABLE"))
    }
    @Test fun timeoutsRefusalAndCancellationUseFixedCodes() {
        val hang=CountDownLatch(1)
        script={ hang.await(5,TimeUnit.SECONDS) }
        val started=System.nanoTime()
        assertEquals("REQUEST_TIMEOUT",failure{ NetworkEspTransport(Mono,readTimeoutMs=300).newCall(LoopbackNetwork(),EspRequest.state()).execute() }.code)
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started)<2500)
        val call=NetworkEspTransport(Mono).newCall(LoopbackNetwork(),EspRequest.state())
        var code:String?=null
        val worker=Thread{ code=try { call.execute(); "none" } catch(e:EspTransportException) { e.code } }; worker.start()
        val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(2)
        while(heads.size<2 && System.nanoTime()<deadline) Thread.sleep(10)
        call.cancel(); worker.join(2500)
        assertFalse(worker.isAlive); assertEquals("SESSION_ENDED",code)
        hang.countDown()
        val closedPort=ServerSocket(0,1,InetAddress.getByName("127.0.0.1")).let{ val p=it.localPort; it.close(); p }
        val refused=object:EspNetwork { override val id="wifi-refused"; override fun openConnection(url:URL)=URL("http","127.0.0.1",closedPort,url.file).openConnection(Proxy.NO_PROXY) as HttpURLConnection }
        val error=failure{ NetworkEspTransport(Mono).newCall(refused,EspRequest.state()).execute() }
        assertEquals("WIFI_UNAVAILABLE",error.code); assertNull(error.cause); assertEquals("WIFI_UNAVAILABLE",error.message)
    }
}
