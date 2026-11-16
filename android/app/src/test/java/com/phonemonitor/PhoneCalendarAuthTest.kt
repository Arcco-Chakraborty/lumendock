package com.phonemonitor

import org.junit.Assert.*
import org.junit.Test

class PhoneCalendarAuthTest {
    @Test fun lateGrantCannotResurrectDisconnectedAccount() {
        val auth = PhoneCalendarAuth()
        val attempt = auth.beginConnect()
        auth.disconnect()
        assertFalse(auth.accept(attempt, "synthetic-token", PhoneCalendarAuth.SCOPES))
        assertEquals("disconnected", auth.status)
    }
    @Test fun requiresEveryReadOnlyScopeAndCancelInvalidatesAttempt() {
        val auth = PhoneCalendarAuth()
        assertFalse(auth.accept(auth.beginConnect(), "synthetic-token", PhoneCalendarAuth.SCOPES.take(2).toSet()))
        assertEquals("auth_required", auth.status)
        val attempt = auth.beginConnect()
        auth.cancelConnect()
        assertFalse(auth.accept(attempt, "synthetic-token", PhoneCalendarAuth.SCOPES))
    }
    @Test fun validGrantIsNativeOnlyAndReplacementClearsPreviousToken() {
        val auth = PhoneCalendarAuth()
        assertTrue(auth.accept(auth.beginConnect(), "synthetic-token", PhoneCalendarAuth.SCOPES))
        assertEquals("connected", auth.status)
        assertEquals("synthetic-token", auth.acquireToken())
        auth.beginConnect()
        assertThrows(PhoneCalendarFailure::class.java) { auth.acquireToken() }
    }
}
