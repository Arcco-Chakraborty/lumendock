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
        assertEquals(listOf("android.permission.INTERNET"),manifest.children("uses-permission").map{ it.getAttributeNS(ns,"name") })
    }
}
