package com.phonemonitor
import com.google.gson.JsonObject

enum class PhoneCalendarEndpoint { SOURCES, METADATA, EVENTS }
class PhoneCalendarRequest(val kind: PhoneCalendarEndpoint, internal val token: String, val calendarId: String? = null, val query: Map<String, String> = emptyMap())
interface PhoneCalendarCall { fun execute(): JsonObject; fun cancel() }
interface PhoneCalendarTransport { fun newCall(request: PhoneCalendarRequest): PhoneCalendarCall }
