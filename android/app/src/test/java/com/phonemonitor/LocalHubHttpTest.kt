package com.phonemonitor

import org.junit.Assert.*
import org.junit.Test
import java.net.Socket
import java.util.concurrent.TimeUnit

class LocalHubHttpTest {
    private fun withHub(block:(LocalHubController,LocalHubEnrollment,SyntheticLocalNetwork)->Unit) {
        val network=SyntheticLocalNetwork()
        LocalHubController(HubMemoryStore(),LocalHubClock(),network).use { hub ->
            hub.resume(); hub.configure(network.lease); assertTrue(hub.start()); val e=hub.enroll("Synthetic")
            hub.select(e.deviceId); block(hub,e,network)
        }
    }
    private fun raw(request:String):String=Socket("127.0.0.1",8787).use { s ->
        s.soTimeout=4000; s.getOutputStream().write(request.toByteArray()); s.getOutputStream().flush()
        s.getInputStream().readBytes().toString(Charsets.UTF_8)
    }
    private fun http(token:String,path:String="/v1/poll",body:String="""{"v":1}""",extra:String="",method:String="POST")=
        "$method $path HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nAuthorization: Bearer $token\r\nContent-Type: application/json\r\nContent-Length: ${body.toByteArray().size}\r\n${extra}\r\n$body"
    @Test fun strictHttpClosesConnectionWithoutCorsAndNeverAcceptsUrlOrQueryTokens()=withHub { _,e,_ ->
        val ok=raw(http(e.bearer)); assertTrue(ok.startsWith("HTTP/1.1 200")); assertTrue(ok.contains("Connection: close\r\n")); assertFalse(ok.contains("Access-Control"))
        for(req in listOf(http(e.bearer,method="GET"),http(e.bearer,path="/v1/poll?token=x"),http(e.bearer,path="http://example.invalid/v1/poll"),http(e.bearer,extra="Origin: https://example.invalid\r\n"),http(e.bearer,extra="Transfer-Encoding: chunked\r\n"),http(e.bearer,extra="Authorization: Bearer duplicate\r\n"),http(e.bearer,extra="X-Unknown: value\r\n"),http(e.bearer,body="""{"v":1,"v":1}"""))) assertFalse(req.substringBefore('\r'),raw(req).startsWith("HTTP/1.1 200"))
        assertTrue(raw(http("wrong")).startsWith("HTTP/1.1 401"))
    }
    @Test fun bodyAndHeadersAreBoundedBeforeReadingBody()=withHub { _,e,_ ->
        assertTrue(raw("POST /v1/poll HTTP/1.1\r\nHost: synthetic\r\nContent-Length: 16385\r\n\r\n").startsWith("HTTP/1.1 413"))
        val tooBig=http(e.bearer,extra="User-Agent: ${"x".repeat(8192)}\r\n")
        assertFalse(raw(tooBig).startsWith("HTTP/1.1 200"))
    }
    @Test fun pauseClosesPartialRequestsAndDoesNotResumeListenerAutomatically()=withHub { h,_,_ ->
        Socket("127.0.0.1",8787).use { s -> s.soTimeout=3000; s.getOutputStream().write("POST /".toByteArray()); Thread.sleep(50); h.pause(); assertEquals(-1,s.getInputStream().read()) }
        h.resume(); assertFalse(h.status()["state"].asString=="listening")
    }
    @Test fun idleLeaseLossStopsListeningWithoutAnyRequest()=withHub { h,_,n ->
        n.valid=false
        val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(2)
        while(h.status()["state"].asString=="listening" && System.nanoTime()<deadline) Thread.sleep(20)
        assertEquals("error",h.status()["state"].asString)
    }
    @Test fun fifthConcurrentClientIsClosedAndReadDeadlineReleasesSlots()=withHub { _,e,_ ->
        val clients=(1..4).map { Socket("127.0.0.1",8787).apply { soTimeout=4000; getOutputStream().write("P".toByteArray()) } }
        try {
            Thread.sleep(100)
            Socket("127.0.0.1",8787).use { fifth -> fifth.soTimeout=1000; assertEquals(-1,fifth.getInputStream().read()) }
            val start=System.nanoTime()
            clients.forEach { assertEquals(-1,it.getInputStream().read()) }
            assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start)<3000)
            assertTrue(raw(http(e.bearer)).startsWith("HTTP/1.1 200"))
        } finally { clients.forEach{it.close()} }
    }
}
