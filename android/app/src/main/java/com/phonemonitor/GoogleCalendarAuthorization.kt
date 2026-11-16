package com.phonemonitor

import android.app.Activity
import android.content.Intent
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import com.google.android.gms.tasks.Tasks
import java.util.concurrent.TimeUnit

/** Explicit native consent, with a request generation separate from ordinary Activity foreground I/O. */
class GoogleCalendarAuthorization(
    private val activity: Activity,
    private val auth: PhoneCalendarAuth,
    private val onChanged: () -> Unit = {},
) : AutoCloseable {
    companion object { const val REQUEST_CODE = 6407 }
    private val client = Identity.getAuthorizationClient(activity)
    private val request get() = AuthorizationRequest.builder().setRequestedScopes(PhoneCalendarAuth.SCOPES.map(::Scope)).build()
    private var pendingGeneration: Long? = null
    private var closed = false
    var isResolvingConsent: Boolean = false
        private set
    init {
        auth.setTokenRefresher {
            try {
                val result = Tasks.await(client.authorize(request), 15, TimeUnit.SECONDS)
                if (result.hasResolution()) throw PhoneCalendarFailure("CALENDAR_AUTH_REQUIRED")
                grant(result)
            } catch (_: Exception) { throw PhoneCalendarFailure("CALENDAR_AUTH_REQUIRED") }
        }
    }
    private fun grant(result: AuthorizationResult) = PhoneCalendarGrant(result.accessToken, result.grantedScopes.toSet())
    fun connect() {
        if (closed || pendingGeneration != null) return
        val generation = auth.beginConnect()
        pendingGeneration = generation
        onChanged()
        client.authorize(request).addOnSuccessListener { result ->
            if (!valid(generation)) return@addOnSuccessListener
            if (result.hasResolution()) {
                try {
                    isResolvingConsent = true
                    activity.startIntentSenderForResult(result.pendingIntent!!.intentSender, REQUEST_CODE, null, 0, 0, 0)
                } catch (_: Exception) { fail(generation) }
            } else finish(generation, result)
        }.addOnFailureListener { fail(generation) }
    }
    private fun valid(generation: Long) = !closed && pendingGeneration == generation && auth.generation == generation
    private fun finish(generation: Long, result: AuthorizationResult) {
        if (!valid(generation)) return
        val grant = grant(result)
        auth.accept(generation, grant.token, grant.scopes)
        pendingGeneration = null; isResolvingConsent = false; onChanged()
    }
    private fun fail(generation: Long) {
        if (!valid(generation)) return
        auth.requireAuthorization(generation)
        pendingGeneration = null; isResolvingConsent = false; onChanged()
    }
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQUEST_CODE) return false
        val generation = pendingGeneration ?: return true
        if (!valid(generation)) { pendingGeneration = null; isResolvingConsent = false; return true }
        if (resultCode != Activity.RESULT_OK) { cancel(); return true }
        try { finish(generation, client.getAuthorizationResultFromIntent(data)) } catch (_: Exception) { fail(generation) }
        return true
    }
    fun cancel() {
        pendingGeneration = null; isResolvingConsent = false; auth.cancelConnect(); onChanged()
    }
    override fun close() { closed = true; cancel(); auth.setTokenRefresher(null) }
}
