package com.phonemonitor
import org.junit.Assert.*
import org.junit.Test
class AssetPolicyTest {
 @Test fun onlyLocalAssetPathsMayLoadOrNavigate() {
  assertTrue(AssetPolicy.allows("https://appassets.androidplatform.net/assets/index.html"))
  assertTrue(AssetPolicy.allows("https://appassets.androidplatform.net/assets/assets/index-abc.js"))
  listOf("https://example.com/", "file:///etc/passwd", "data:text/html,hi", "content://something", "https://appassets.androidplatform.net:443/assets/index.html", "https://appassets.androidplatform.net/other", "https://appassets.androidplatform.net/assets/../x", "https://appassets.androidplatform.net/assets/%2e%2e/x", "https://appassets.androidplatform.net/assets/index.html?url=https://example.com").forEach { assertFalse(it, AssetPolicy.allows(it)) }
 }
}
