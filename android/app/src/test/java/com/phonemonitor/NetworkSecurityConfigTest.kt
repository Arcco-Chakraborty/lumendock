package com.phonemonitor

import org.junit.Assert.*
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/** Pins the shipped cleartext policy and manifest flags; the module directory is the JVM test working directory. */
class NetworkSecurityConfigTest {
    private fun xml(path:String)=DocumentBuilderFactory.newInstance().apply{ isNamespaceAware=true }.newDocumentBuilder().parse(File(path)).documentElement
    private fun Element.children(tag:String)=(0 until childNodes.length).map{ childNodes.item(it) }.filterIsInstance<Element>().filter{ it.tagName==tag }

    @Test fun cleartextOnlyForFixedHubAndControllerAddresses() {
        val root=xml("src/main/res/xml/network_security_config.xml")
        assertEquals("false",root.children("base-config").single().getAttribute("cleartextTrafficPermitted"))
        val domainConfig=root.children("domain-config").single()
        assertEquals("true",domainConfig.getAttribute("cleartextTrafficPermitted"))
        val domains=domainConfig.children("domain")
        assertEquals(setOf("127.0.0.1","192.168.4.1"),domains.map{ it.textContent.trim() }.toSet())
        assertTrue(domains.all{ it.getAttribute("includeSubdomains")=="false" })
        assertEquals(2,domains.size)
    }
    @Test fun manifestKeepsBackupOffAndLandscapeDefaultWithoutRecreatingOnRotation() {
        val ns="http://schemas.android.com/apk/res/android"
        val manifest=xml("src/main/AndroidManifest.xml")
        val app=manifest.children("application").single()
        assertEquals("false",app.getAttributeNS(ns,"allowBackup"))
        assertEquals("@xml/network_security_config",app.getAttributeNS(ns,"networkSecurityConfig"))
        val activity=app.children("activity").single()
        assertEquals("sensorLandscape",activity.getAttributeNS(ns,"screenOrientation"))
        assertTrue(activity.getAttributeNS(ns,"configChanges").split('|').containsAll(listOf("orientation","screenSize","screenLayout","smallestScreenSize")))
    }
    @Test fun wifiPermissionsAreScopedByApiLevelAndNeverForLocation() {
        val ns="http://schemas.android.com/apk/res/android"
        val p="android.permission."
        val permissions=xml("src/main/AndroidManifest.xml").children("uses-permission").associateBy{ it.getAttributeNS(ns,"name") }
        assertEquals(setOf("${p}INTERNET","${p}ACCESS_NETWORK_STATE","${p}CHANGE_NETWORK_STATE","${p}CHANGE_WIFI_STATE",
            "${p}ACCESS_FINE_LOCATION","${p}ACCESS_COARSE_LOCATION","${p}NEARBY_WIFI_DEVICES"),permissions.keys)
        assertEquals("32",permissions.getValue("${p}ACCESS_FINE_LOCATION").getAttributeNS(ns,"maxSdkVersion"))
        assertEquals("32",permissions.getValue("${p}ACCESS_COARSE_LOCATION").getAttributeNS(ns,"maxSdkVersion"))
        assertEquals("neverForLocation",permissions.getValue("${p}NEARBY_WIFI_DEVICES").getAttributeNS(ns,"usesPermissionFlags"))
        assertEquals("No background location, wake lock, foreground service, boot receiver or admin",7,permissions.size)
    }
}
