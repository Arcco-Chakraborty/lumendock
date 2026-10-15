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
 * Real JDK HttpURLConnection against a scripted loopback socket. The production URL stays fixed; only the
 * test's connection opener redirects the socket to an ephemeral port. Android's own HTTP stack is device-unrun.
 */
class LoopbackHubTransportTest {
    private class Captured(val head:String,val body:ByteArray)
    private val server=ServerSocket(0,8,InetAddress.getByName("127.0.0.1"))
    private val captured=CopyOnWriteArrayList<Captured>()
    private val requestedUrls=CopyOnWriteArrayList<String>()
    private val connections=CopyOnWriteArrayList<HttpURLConnection>()
    @Volatile private var script:(OutputStream)->Unit={ it.write(http(200,hubFixture().toByteArray())) }
    private val acceptor=Thread {
        while(!server.isClosed) {
            val socket=try { server.accept() } catch(_:Exception) { break }
            Thread {
                socket.use { s ->
                    try {
                        val input=s.getInputStream(); val head=readHead(input)
                        val length=Regex("(?im)^content-length: *(\\d+)").find(head)?.groupValues?.get(1)?.toInt() ?: 0
                        val body=ByteArray(length).also{ var read=0; while(read<length) { val n=input.read(it,read,length-read); if(n<0) break; read+=n } }
                        captured.add(Captured(head,body))
                        script(s.getOutputStream()); s.getOutputStream().flush()
                    } catch(_:Exception) { /* client hung up */ }
                }
            }.apply{isDaemon=true}.start()
        }
    }.apply{isDaemon=true; start()}
    @After fun stop() { server.close() }

    private fun readHead(input:InputStream):String {
        val out=ByteArrayOutputStream()
        while(!out.toString(Charsets.ISO_8859_1.name()).endsWith("\r\n\r\n")) { val b=input.read(); if(b<0) break; out.write(b) }
        return out.toString(Charsets.ISO_8859_1.name())
    }
    private fun http(status:Int,body:ByteArray,extra:String="",length:Boolean=true):ByteArray =
        ("HTTP/1.1 $status X\r\nContent-Type: application/json\r\nConnection: close\r\n" + (if(length) "Content-Length: ${body.size}\r\n" else "") + extra + "\r\n").toByteArray(Charsets.ISO_8859_1)+body
    private fun transport(connect:Int=2000,read:Int=3000,budget:Long=5000)=LoopbackHubTransport(SystemTestClock,connect,read,budget) { url ->
        requestedUrls.add(url.toString())
        (URL("http","127.0.0.1",server.localPort,url.file).openConnection(Proxy.NO_PROXY) as HttpURLConnection).also{connections.add(it)}
    }
    private object SystemTestClock:HubClock { override fun epochMs()=System.currentTimeMillis(); override fun monotonicMs()=System.nanoTime()/1_000_000 }
    private fun failure(block:()->Unit):HubTransportException = try { block(); fail("expected failure"); throw AssertionError() } catch(e:HubTransportException) { e }

    @Test fun snapshotUsesFixedUrlBearerHeaderAndSafeConnectionSettings() {
        val response=transport().newCall(HubRequest(HubPath.SNAPSHOT,SYNTHETIC_TOKEN)).execute()
        assertEquals(200,response.status); assertEquals(hubFixture(),response.body.toString(Charsets.UTF_8))
        assertEquals(listOf("http://127.0.0.1:8765/v1/snapshot"),requestedUrls)
        val head=captured.single().head
        assertTrue(head.startsWith("GET /v1/snapshot HTTP/1.1\r\n"))
        assertTrue(head.contains("Authorization: Bearer $SYNTHETIC_TOKEN\r\n"))
        assertEquals("Token appears exactly once: the Authorization header",1,head.split(SYNTHETIC_TOKEN).size-1)
        assertFalse(head.lowercase().contains("origin:"))
        assertTrue(head.contains("Connection: close"))
        val c=connections.single()
        assertEquals(2000,c.connectTimeout); assertEquals(3000,c.readTimeout); assertFalse(c.instanceFollowRedirects); assertFalse(c.useCaches)
        val defaults=LoopbackHubTransport()
        assertEquals(2000,defaults.connectTimeoutMs); assertEquals(3000,defaults.readTimeoutMs)
    }
    @Test fun pairPostsOnlyTheCodeWithoutAuthorization() {
        script={ it.write(http(200,"""{"token":"$SYNTHETIC_TOKEN"}""".toByteArray())) }
        val response=transport().newCall(HubRequest(HubPath.PAIR,null,"""{"code":"01234567"}""".toByteArray())).execute()
        assertEquals(200,response.status)
        val request=captured.single()
        assertTrue(request.head.startsWith("POST /v1/pair HTTP/1.1\r\n"))
        assertTrue(request.head.contains("Content-Type: application/json"))
        assertFalse(request.head.contains("Authorization"))
        assertEquals("""{"code":"01234567"}""",request.body.toString(Charsets.UTF_8))
    }
    @Test fun redirectsAreNeverFollowed() {
        script={ it.write(http(302,ByteArray(0),"Location: http://127.0.0.1:8765/v1/pair\r\n")) }
        assertEquals("BAD_PAYLOAD",failure{ transport().newCall(HubRequest(HubPath.SNAPSHOT,SYNTHETIC_TOKEN)).execute() }.code)
        Thread.sleep(100)
        assertEquals(1,captured.size)
    }
    @Test fun declaredOrStreamedOversizeAndTruncatedBodiesFail() {
        script={ it.write(http(200,ByteArray(0),"Content-Length: ${HUB_REPLY_BYTES+1}\r\n",length=false)) }
        assertEquals("BAD_PAYLOAD",failure{ transport().newCall(HubRequest(HubPath.SNAPSHOT,SYNTHETIC_TOKEN)).execute() }.code)
        script={ it.write(http(200,ByteArray(HUB_REPLY_BYTES+1){' '.code.toByte()},length=false)) }
        assertEquals("BAD_PAYLOAD",failure{ transport().newCall(HubRequest(HubPath.SNAPSHOT,SYNTHETIC_TOKEN)).execute() }.code)
        script={ it.write(http(200,"{\"v\":1".toByteArray(),"Content-Length: 900\r\n",length=false)) }
        val truncated=failure{ transport().newCall(HubRequest(HubPath.SNAPSHOT,SYNTHETIC_TOKEN)).execute() }.code
        assertTrue(truncated,truncated in setOf("BAD_PAYLOAD","USB_UNAVAILABLE"))
        script={ it.write(http(200,ByteArray(HUB_REPLY_BYTES){' '.code.toByte()})) }
        assertEquals(HUB_REPLY_BYTES,transport().newCall(HubRequest(HubPath.SNAPSHOT,SYNTHETIC_TOKEN)).execute().body.size)
    }
    @Test fun readTimeoutTotalBudgetAndRefusedConnectionUseSafeCodes() {
        val hang=CountDownLatch(1)
        script={ hang.await(5,TimeUnit.SECONDS) }
        val started=System.nanoTime()
        assertEquals("REQUEST_TIMEOUT",failure{ transport(read=300).newCall(HubRequest(HubPath.SNAPSHOT,SYNTHETIC_TOKEN)).execute() }.code)
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started)<2500)
        script={ out -> out.write(http(200,ByteArray(0),"Content-Length: 50\r\n",length=false)); out.flush(); repeat(50) { out.write(' '.code); out.flush(); Thread.sleep(40) } }
        assertEquals("REQUEST_TIMEOUT",failure{ transport(read=1000,budget=400).newCall(HubRequest(HubPath.SNAPSHOT,SYNTHETIC_TOKEN)).execute() }.code)
        hang.countDown()
        val closedPort=ServerSocket(0,1,InetAddress.getByName("127.0.0.1")).let{ val p=it.localPort; it.close(); p }
        val refused=LoopbackHubTransport(SystemTestClock) { url -> URL("http","127.0.0.1",closedPort,url.file).openConnection(Proxy.NO_PROXY) as HttpURLConnection }
        val error=failure{ refused.newCall(HubRequest(HubPath.SNAPSHOT,SYNTHETIC_TOKEN)).execute() }
        assertEquals("USB_UNAVAILABLE",error.code)
        assertEquals("USB_UNAVAILABLE",error.message)
        assertNull("No underlying exception (which may describe the request) is retained",error.cause)
    }
    @Test fun cancelReleasesABlockedRequestPromptly() {
        val hang=CountDownLatch(1)
        script={ hang.await(5,TimeUnit.SECONDS) }
        val call=transport().newCall(HubRequest(HubPath.SNAPSHOT,SYNTHETIC_TOKEN))
        var code:String?=null
        val worker=Thread{ code=try { call.execute(); "none" } catch(e:HubTransportException) { e.code } }
        val started=System.nanoTime(); worker.start()
        val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(2)
        while(captured.isEmpty() && System.nanoTime()<deadline) Thread.sleep(10)
        call.cancel(); worker.join(2500)
        assertFalse(worker.isAlive)
        assertTrue("Cancellation must not wait for the 3 s read timeout",TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started)<2500)
        assertEquals("SESSION_ENDED",code)
        hang.countDown()
        val again=transport().newCall(HubRequest(HubPath.SNAPSHOT,SYNTHETIC_TOKEN)).also{it.cancel()}
        assertEquals("SESSION_ENDED",failure{ again.execute() }.code)
    }
    @Test fun requestDescriptionNeverContainsBearer() {
        val request=HubRequest(HubPath.SNAPSHOT,SYNTHETIC_TOKEN)
        assertFalse(request.toString().contains(SYNTHETIC_TOKEN))
        assertEquals(setOf("Accept","Accept-Encoding","Connection","Authorization"),request.headers().keys)
    }
}
