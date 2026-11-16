package com.phonemonitor

/** Fixed, non-sensitive failures only. Never attach provider exception messages or response bodies. */
class PhoneCalendarFailure(val code: String, val statusCode: Int = 0, val retryAfterMs: Long = 0) : Exception(code)
class PhoneCalendarGrant(val token: String?, val scopes: Set<String>)

/** Activity-lifetime, in-memory authorization. A new explicit connect is always a new account generation. */
class PhoneCalendarAuth(private val clock: HubClock = SystemHubClock) {
    companion object {
        val SCOPES = setOf(
            "https://www.googleapis.com/auth/calendar.events.readonly",
            "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
            "https://www.googleapis.com/auth/calendar.calendars.readonly",
        )
    }
    private val lock = Any()
    private var epoch = 0L
    private var state = "disconnected"
    private var token: String? = null
    private var receivedAt = 0L
    private var refresher: (() -> PhoneCalendarGrant)? = null
    private val listeners = mutableListOf<() -> Unit>()
    val generation: Long get() = synchronized(lock) { epoch }
    val status: String get() = synchronized(lock) { state }
    fun setTokenRefresher(refresh: (() -> PhoneCalendarGrant)?) = synchronized(lock) { refresher = refresh }
    internal fun onGenerationChanged(listener: () -> Unit) = synchronized(lock) { listeners.add(listener); Unit }
    private fun reset(nextState: String): Long {
        val result: Long
        val callbacks: List<() -> Unit>
        synchronized(lock) { epoch++; result = epoch; token = null; state = nextState; callbacks = listeners.toList() }
        callbacks.forEach { it() }
        return result
    }
    fun beginConnect(): Long = reset("connecting")
    fun cancelConnect() { reset("disconnected") }
    fun disconnect() { reset("disconnected") }
    internal fun requireAuthorization(expectedGeneration: Long) {
        if (generation == expectedGeneration) reset("auth_required")
    }
    fun accept(generation: Long, token: String?, scopes: Set<String>): Boolean = synchronized(lock) {
        if (generation != epoch || state != "connecting") return@synchronized false
        if (token.isNullOrBlank() || token.length > 16384 || token.any { it == '\r' || it == '\n' } || !scopes.containsAll(SCOPES)) {
            this.token = null; state = "auth_required"; return@synchronized false
        }
        this.token = token; receivedAt = clock.monotonicMs(); state = "connected"; true
    }
    /** Called only on the bounded bridge worker. Never starts a consent UI. */
    internal fun acquireToken(): String {
        val refresh: (() -> PhoneCalendarGrant)?
        val expected: Long
        synchronized(lock) {
            if (state != "connected") throw PhoneCalendarFailure("CALENDAR_AUTH_REQUIRED")
            token?.let { if (clock.monotonicMs() - receivedAt < 45 * 60_000) return it }
            expected = epoch; refresh = refresher
        }
        val grant = refresh?.invoke() ?: throw PhoneCalendarFailure("CALENDAR_AUTH_REQUIRED")
        synchronized(lock) {
            if (epoch != expected || state != "connected") throw PhoneCalendarFailure("SESSION_ENDED")
            val renewed = grant.token
            if (renewed.isNullOrBlank() || renewed.length > 16384 || renewed.any { it == '\r' || it == '\n' } || !grant.scopes.containsAll(SCOPES)) {
                throw PhoneCalendarFailure("CALENDAR_AUTH_REQUIRED")
            }
            token = renewed; receivedAt = clock.monotonicMs(); return renewed
        }
    }
}
