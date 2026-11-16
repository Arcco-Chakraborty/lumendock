package com.phonemonitor

import com.google.gson.JsonObject
import java.security.MessageDigest
import java.time.*
import java.util.Base64

internal fun JsonObject.text(key: String): String? = get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
internal fun JsonObject.flag(key: String): Boolean = get(key)?.let { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean && it.asBoolean } == true
internal fun JsonObject.objectValue(key: String): JsonObject? = get(key)?.takeIf { it.isJsonObject }?.asJsonObject
internal fun JsonObject.objects(key: String): List<JsonObject> = get(key)?.takeIf { it.isJsonArray }?.asJsonArray?.filter { it.isJsonObject }?.map { it.asJsonObject } ?: emptyList()
internal fun phoneOpaque(prefix: String, raw: String): String = prefix + Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(raw.toByteArray(Charsets.UTF_8))).take(24)
internal fun phoneTrim(value: String, max: Int): String = value.substring(0, value.offsetByCodePoints(0, value.codePointCount(0, value.length).coerceAtMost(max)))
internal fun phoneColor(value: String?): String? = value?.trim()?.takeIf { Regex("#[0-9a-fA-F]{6}").matches(it) }?.uppercase()
internal fun phoneZone(value: String?): String? = value?.takeIf { it == "UTC" || it in ZoneId.getAvailableZoneIds() }
internal fun phoneReminder(items: List<JsonObject>): Int? {
    val valid = items.mapNotNull { o -> o["minutes"]?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.let { n -> runCatching { n.asBigDecimal.intValueExact() }.getOrNull()?.takeIf { it in 0..40320 }?.let { o.text("method") to it } } }
    return valid.firstOrNull { it.first == "popup" }?.second ?: valid.firstOrNull()?.second
}
internal data class PhoneCalendarSource(
    val rawId: String, val id: String, val name: String, val color: String?, val capability: String,
    val reminder: Int?, var zone: String?, val labels: MutableMap<String, JsonObject> = linkedMapOf(),
    var metadataError: String? = null,
) {
    companion object {
        fun parse(o: JsonObject): PhoneCalendarSource? {
            val raw = o.text("id")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            if(o.flag("deleted")) return null
            val override = o.text("summaryOverride")?.trim().orEmpty(); val summary = o.text("summary")?.trim().orEmpty()
            val name = if(override.isNotEmpty() && !override.contains('@')) override else if(summary.isNotEmpty() && !Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$").matches(summary) && !(summary == raw && summary.contains('@'))) summary else if(override.isNotEmpty() && !Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$").matches(override)) override else if(o.flag("primary")) "Primary calendar" else "Calendar"
            return PhoneCalendarSource(raw, phoneOpaque("cal_", raw), phoneTrim(name,120), phoneColor(o.text("backgroundColor")), when(o.text("accessRole")) { "owner","writer","reader" -> "read"; "freeBusyReader" -> "busy"; else -> "unavailable" }, phoneReminder(o.objects("defaultReminders")), phoneZone(o.text("timeZone")))
        }
    }
    fun protocol(selected: Boolean, state: String, success: Long?, error: String?) = jsonObject("sourceId" to id, "name" to name, "color" to color, "selected" to selected, "capability" to capability, "state" to state, "lastSuccessAtEpochMs" to success, "errorCode" to error)
}
internal object PhoneCalendarNormalization {
    private val colors = listOf("#7986CB","#33B679","#8E24AA","#E67C73","#F6BF26","#F4511E","#039BE5","#616161","#3F51B5","#0B8043","#D50000")
    fun event(raw: JsonObject, source: PhoneCalendarSource, range: JsonObject, zone: String): JsonObject? {
        if(raw.text("status") == "cancelled") return null
        val rawId = raw.text("id")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val startRaw = raw.objectValue("start") ?: return null; val endRaw = raw.objectValue("end") ?: return null
        val rangeStart = LocalDate.parse(range.text("startDate")); val rangeEnd = rangeStart.plusDays(range["days"].asLong)
        val rangeZone = ZoneId.of(range.text("timeZone"))
        val start: JsonObject; val end: JsonObject
        try {
            if(startRaw.text("date") != null && endRaw.text("date") != null && !startRaw.has("dateTime") && !endRaw.has("dateTime")) {
                if(!CalendarValidator.date(startRaw["date"]) || !CalendarValidator.date(endRaw["date"])) return null
                val s = LocalDate.parse(startRaw.text("date")); val e = LocalDate.parse(endRaw.text("date"))
                if(s >= e || s >= rangeEnd || e <= rangeStart) return null
                start = jsonObject("kind" to "date", "date" to s.toString()); end = jsonObject("kind" to "date", "date" to e.toString())
            } else if(startRaw.text("dateTime") != null && endRaw.text("dateTime") != null && !startRaw.has("date") && !endRaw.has("date")) {
                val s = OffsetDateTime.parse(startRaw.text("dateTime")).toInstant().toEpochMilli(); val e = OffsetDateTime.parse(endRaw.text("dateTime")).toInstant().toEpochMilli()
                if(s < 0 || s >= e || s >= rangeEnd.atStartOfDay(rangeZone).toInstant().toEpochMilli() || e <= rangeStart.atStartOfDay(rangeZone).toInstant().toEpochMilli()) return null
                val startZone = phoneZone(startRaw.text("timeZone")) ?: zone
                start = jsonObject("kind" to "time", "epochMs" to s, "timeZone" to startZone)
                end = jsonObject("kind" to "time", "epochMs" to e, "timeZone" to (phoneZone(endRaw.text("timeZone")) ?: startZone))
            } else return null
        } catch(_: Exception) { return null }
        val labelId = raw.text("eventLabelId")?.trim()?.takeIf { it.isNotEmpty() }
        val legacyColor = raw.text("colorId")?.toIntOrNull()?.let { colors.getOrNull(it - 1) }
        val label = if(labelId != null) source.labels[labelId] ?: jsonObject("name" to null, "color" to (legacyColor ?: source.color ?: "#64748B")) else legacyColor?.let { jsonObject("name" to null, "color" to it) }
        val reminders = raw.objectValue("reminders")
        val reminder = if(reminders?.get("useDefault")?.let { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean && !it.asBoolean } == true) phoneReminder(reminders.objects("overrides")) else source.reminder
        val self = raw.objects("attendees").firstOrNull { it.flag("self") }?.text("responseStatus")?.takeIf { it in setOf("needsAction", "declined", "tentative", "accepted") }
        return jsonObject("id" to phoneOpaque("evt_", source.rawId + "\u0000" + rawId), "sourceId" to source.id, "title" to phoneTrim(raw.text("summary")?.trim()?.takeIf { it.isNotEmpty() } ?: "Untitled event",256), "start" to start, "end" to end, "calendarName" to source.name, "calendarColor" to source.color, "label" to label, "eventType" to phoneTrim(raw.text("eventType")?.trim()?.takeIf { it.isNotEmpty() } ?: "default",40), "status" to if(raw.text("status") == "tentative") "tentative" else "confirmed", "selfResponseStatus" to self, "reminderMinutes" to reminder).takeIf(CalendarValidator::event)
    }
    fun startEpoch(event: JsonObject, rangeZone: String): Long {
        val start = event.getAsJsonObject("start")
        return if(start.text("kind") == "time") start["epochMs"].asLong else LocalDate.parse(start.text("date")).atStartOfDay(ZoneId.of(rangeZone)).toInstant().toEpochMilli()
    }
}
