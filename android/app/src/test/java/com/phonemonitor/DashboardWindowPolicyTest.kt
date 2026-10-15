package com.phonemonitor

import org.junit.Assert.*
import org.junit.Test

class DashboardWindowPolicyTest {
    @Test fun focusAloneCannotHideBarsWhileStoppedOrCoveredByNativeInput() {
        val policy=DashboardWindowPolicy()
        policy.focused=true
        assertFalse(policy.shouldHideBars(dialogShowing=false))
        policy.resumed=true
        assertTrue(policy.shouldHideBars(dialogShowing=false))
        assertFalse(policy.shouldHideBars(dialogShowing=true))
        policy.imeVisible=true
        assertFalse(policy.shouldHideBars(dialogShowing=false))
        policy.imeVisible=false
        policy.focused=false
        assertFalse(policy.shouldHideBars(dialogShowing=false))
        policy.focused=true
        policy.resumed=false
        assertFalse(policy.shouldHideBars(dialogShowing=false))
    }

    @Test fun cutoutPaddingRotatesWithoutRetainingOldEdgesOrAddingImeTwice() {
        val policy=DashboardWindowPolicy()
        assertEquals(ContentInsets(0,56,0,0),policy.contentInsets(ContentInsets(0,56,0,0),0))
        assertEquals(ContentInsets(56,0,0,0),policy.contentInsets(ContentInsets(56,0,0,0),0))
        assertEquals(ContentInsets(0,0,56,480),policy.contentInsets(ContentInsets(0,0,56,20),480))
        assertEquals(ContentInsets(0,0,56,20),policy.contentInsets(ContentInsets(0,0,56,20),0))
        assertEquals(ContentInsets(0,0,0,0),policy.contentInsets(ContentInsets(0,0,0,0),0))
    }
}
