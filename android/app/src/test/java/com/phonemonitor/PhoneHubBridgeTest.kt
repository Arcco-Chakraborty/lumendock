package com.phonemonitor
import org.junit.Assert.*
import org.junit.Test
class PhoneHubBridgeTest {
    private fun status()=StrictJson.parse("""{"calendarBackend":"desktop","calendarAuth":"disconnected","revision":1,"iot":{"running":false,"bindAddress":null,"port":8787,"deviceCount":0,"selectedDeviceId":null}}""").asJsonObject
    @Test fun fixedOperationsHaveNoWebViewConfigurationOrSecrets() {
        for(op in listOf("app.phoneHubStatus","app.configurePhoneHub")) {
            assertTrue(ProtocolValidator.args(op,jsonObject()))
            assertFalse(ProtocolValidator.args(op,jsonObject("token" to "synthetic-secret")))
        }
    }
    @Test fun statusMatchesSharedBoundary() {
        assertTrue(ProtocolValidator.response("app.phoneHubStatus",status()))
        assertTrue(ProtocolValidator.response("app.configurePhoneHub",jsonObject("opened" to true)))
        assertFalse(ProtocolValidator.response("app.phoneHubStatus",status().also{it.addProperty("token","synthetic-secret")}))
    }
    @Test fun listenerRejectsPublicWildcardAndMissingAddresses() {
        for(address in listOf("0.0.0.0","127.0.0.1","8.8.8.8","192.168.001.2","192.168.42.256")) {
            val s=status();val i=s["iot"].asJsonObject;i.addProperty("running",true);i.addProperty("bindAddress",address)
            assertFalse(ProtocolValidator.response("app.phoneHubStatus",s))
        }
        val s=status();val i=s["iot"].asJsonObject;i.addProperty("running",true);i.addProperty("bindAddress","192.168.42.1")
        assertTrue(ProtocolValidator.response("app.phoneHubStatus",s))
    }
}
