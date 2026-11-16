package com.phonemonitor

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import java.time.ZoneId

/**
 * Strict validator mirroring packages/protocol/src/calendar.ts.
 * Enforces Gregorian dates, IANA time zones, opaque IDs, code-point bounds, and 128 KiB UTF-8 page budgets.
 */
object CalendarValidator {
    const val PAGE_BYTES = 128 * 1024
    private const val MAX_SAFE = ProtocolValidator.MAX_SAFE
    private val OPAQUE_ID = Regex("[A-Za-z0-9_-]{1,80}")
    private val CURSOR = Regex("[A-Za-z0-9._~-]{1,256}")
    private val DATE_PATTERN = Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")
    private val HEX_COLOR = Regex("#[0-9a-fA-F]{6}")
    private val ZONES: Set<String> = ZoneId.getAvailableZoneIds().toSet() + "UTC"

    val errors = setOf(
        "CALENDAR_AUTH_REQUIRED",
        "CALENDAR_UNAVAILABLE",
        "CALENDAR_CAPACITY",
        "CALENDAR_CURSOR_EXPIRED",
        "CALENDAR_SELECTION_CHANGED",
        "CALENDAR_UNSUPPORTED",
    )
    val states = setOf(
        "disabled",
        "setup_required",
        "loading",
        "available",
        "partial",
        "auth_required",
        "error",
        "capacity",
    )

    private fun obj(e: JsonElement?, keys: String, optional: String = "", check: (JsonObject) -> Boolean = { true }): Boolean {
        if (e?.isJsonObject != true) return false
        val o = e.asJsonObject
        val required = keys.split(' ').filter(String::isNotEmpty).toSet()
        val allowed = required + optional.split(' ').filter(String::isNotEmpty)
        return o.keySet().containsAll(required) && allowed.containsAll(o.keySet()) && check(o)
    }

    private fun str(e: JsonElement?, max: Int, nonempty: Boolean = false): Boolean =
        e?.isJsonPrimitive == true &&
            e.asJsonPrimitive.isString &&
            e.asString.codePointCount(0, e.asString.length) <= max &&
            (!nonempty || e.asString.isNotEmpty())

    private fun opaqueId(e: JsonElement?): Boolean =
        str(e, 80, true) && OPAQUE_ID.matches(e!!.asString)

    private fun cursor(e: JsonElement?): Boolean =
        str(e, 256, true) && CURSOR.matches(e!!.asString)

    private fun hex(e: JsonElement?): Boolean =
        str(e, 7, true) && HEX_COLOR.matches(e!!.asString)

    private fun bool(e: JsonElement?): Boolean =
        e?.isJsonPrimitive == true && e.asJsonPrimitive.isBoolean

    private fun int(e: JsonElement?, min: Long = 0, max: Long = MAX_SAFE): Boolean =
        e?.isJsonPrimitive == true &&
            e.asJsonPrimitive.isNumber &&
            e.asDouble.isFinite() &&
            e.asDouble in min.toDouble()..max.toDouble() &&
            e.asBigDecimal.stripTrailingZeros().scale() <= 0

    private fun one(e: JsonElement?, vararg options: String): Boolean =
        str(e, 80, true) && e!!.asString in options

    private fun state(e: JsonElement?): Boolean =
        str(e, 80, true) && e!!.asString in states

    private fun calendarError(e: JsonElement?): Boolean =
        str(e, 80, true) && e!!.asString in errors

    private fun nullable(e: JsonElement?, test: (JsonElement) -> Boolean): Boolean =
        e != null && (e.isJsonNull || test(e))

    private fun arr(e: JsonElement?, max: Int, test: (JsonElement) -> Boolean): Boolean =
        e?.isJsonArray == true && e.asJsonArray.size() <= max && e.asJsonArray.all(test)

    private fun budget(e: JsonElement, maxBytes: Int = PAGE_BYTES): Boolean =
        e.toString().toByteArray(Charsets.UTF_8).size <= maxBytes

    fun date(e: JsonElement?): Boolean {
        if (!str(e, 10, true)) return false
        val s = e!!.asString
        if (s.length != 10 || !DATE_PATTERN.matches(s)) return false
        val year = s.substring(0, 4).toInt()
        val month = s.substring(5, 7).toInt()
        val day = s.substring(8, 10).toInt()
        if (year < 1 || month !in 1..12 || day < 1) return false
        val leap = (year % 4 == 0) && (year % 100 != 0 || year % 400 == 0)
        val maxDay = when (month) {
            1, 3, 5, 7, 8, 10, 12 -> 31
            4, 6, 9, 11 -> 30
            2 -> if (leap) 29 else 28
            else -> return false
        }
        return day <= maxDay
    }

    fun timeZone(e: JsonElement?): Boolean {
        if (!str(e, 80, true)) return false
        val s = e!!.asString
        if (s.startsWith("+") || s.startsWith("-")) return false
        return s in ZONES
    }

    private fun rangeObject(e: JsonElement?): Boolean = obj(e, "startDate days timeZone") { o ->
        date(o["startDate"]) && int(o["days"], 1, 31) && timeZone(o["timeZone"])
    }

    fun rangeRequest(e: JsonElement?): Boolean = try {
        obj(e, "startDate days timeZone", "cursor refresh") { o ->
            date(o["startDate"]) &&
                int(o["days"], 1, 31) &&
                timeZone(o["timeZone"]) &&
                (!o.has("cursor") || cursor(o["cursor"])) &&
                (!o.has("refresh") || bool(o["refresh"])) &&
                !(o.has("refresh") && o["refresh"].asBoolean && o.has("cursor"))
        }
    } catch (_: RuntimeException) {
        false
    }

    fun sourcesRequest(e: JsonElement?): Boolean = try {
        obj(e, "", "cursor") { o ->
            !o.has("cursor") || cursor(o["cursor"])
        }
    } catch (_: RuntimeException) {
        false
    }

    fun selectRequest(e: JsonElement?): Boolean = try {
        obj(e, "sourceIds expectedRevision") { o ->
            opaqueId(o["expectedRevision"]) &&
                arr(o["sourceIds"], 100) { opaqueId(it) } &&
                o["sourceIds"].asJsonArray.map { it.asString }.let { ids -> ids.toSet().size == ids.size }
        }
    } catch (_: RuntimeException) {
        false
    }

    fun selectReply(e: JsonElement?): Boolean = try {
        obj(e, "selectionRevision") { o ->
            opaqueId(o["selectionRevision"])
        }
    } catch (_: RuntimeException) {
        false
    }

    fun moment(e: JsonElement?): Boolean = try {
        if (e?.isJsonObject != true) false
        else when (val kind = e.asJsonObject["kind"]?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString) {
            "date" -> obj(e, "kind date") { o -> kind == "date" && date(o["date"]) }
            "time" -> obj(e, "kind epochMs timeZone") { o -> kind == "time" && int(o["epochMs"], 0, MAX_SAFE) && timeZone(o["timeZone"]) }
            else -> false
        }
    } catch (_: RuntimeException) {
        false
    }

    fun event(e: JsonElement?): Boolean = try {
        obj(e, "id sourceId title start end calendarName calendarColor label eventType status selfResponseStatus reminderMinutes") { o ->
            val basic = opaqueId(o["id"]) &&
                opaqueId(o["sourceId"]) &&
                str(o["title"], 256) &&
                moment(o["start"]) &&
                moment(o["end"]) &&
                str(o["calendarName"], 120) &&
                nullable(o["calendarColor"]) { hex(it) } &&
                nullable(o["label"]) { l ->
                    obj(l, "name color") { lo ->
                        nullable(lo["name"]) { str(it, 50) } && hex(lo["color"])
                    }
                } &&
                str(o["eventType"], 40) &&
                one(o["status"], "confirmed", "tentative") &&
                nullable(o["selfResponseStatus"]) { one(it, "needsAction", "declined", "tentative", "accepted") } &&
                nullable(o["reminderMinutes"]) { int(it, 0, 40320) }
            if (!basic) return@obj false
            val start = o["start"].asJsonObject
            val end = o["end"].asJsonObject
            val startKind = start["kind"].asString
            val endKind = end["kind"].asString
            if (startKind != endKind) return@obj false
            if (startKind == "date") start["date"].asString < end["date"].asString
            else start["epochMs"].asLong < end["epochMs"].asLong
        }
    } catch (_: RuntimeException) {
        false
    }

    fun source(e: JsonElement?): Boolean = try {
        obj(e, "sourceId name color selected capability state lastSuccessAtEpochMs errorCode") { o ->
            opaqueId(o["sourceId"]) &&
                str(o["name"], 120) &&
                nullable(o["color"]) { hex(it) } &&
                bool(o["selected"]) &&
                one(o["capability"], "read", "busy", "unavailable") &&
                state(o["state"]) &&
                nullable(o["lastSuccessAtEpochMs"]) { int(it, 0, MAX_SAFE) } &&
                nullable(o["errorCode"]) { calendarError(it) }
        }
    } catch (_: RuntimeException) {
        false
    }

    fun page(e: JsonElement?): Boolean = try {
        obj(
            e,
            "v state errorCode serverNowEpochMs range revision selectionRevision lastSuccessAtEpochMs sourceCount failedSourceCount sources items nextEvent nextCursor",
        ) { o ->
            val basic = int(o["v"], 1, 1) &&
                state(o["state"]) &&
                nullable(o["errorCode"]) { calendarError(it) } &&
                int(o["serverNowEpochMs"], 0, MAX_SAFE) &&
                rangeObject(o["range"]) &&
                opaqueId(o["revision"]) &&
                opaqueId(o["selectionRevision"]) &&
                nullable(o["lastSuccessAtEpochMs"]) { int(it, 0, MAX_SAFE) } &&
                int(o["sourceCount"], 0, 100) &&
                int(o["failedSourceCount"], 0, 100) &&
                arr(o["sources"], 50) { source(it) } &&
                arr(o["items"], 50) { event(it) } &&
                nullable(o["nextEvent"]) { event(it) } &&
                nullable(o["nextCursor"]) { cursor(it) } &&
                budget(o, PAGE_BYTES)
            if (!basic) return@obj false
            val sourceIds = o["sources"].asJsonArray.map { it.asJsonObject["sourceId"].asString }.toSet()
            val sourcesCoverItems = o["items"].asJsonArray.all { it.asJsonObject["sourceId"].asString in sourceIds }
            if (!sourcesCoverItems) return@obj false
            val serverNow = o["serverNowEpochMs"].asLong
            val next = o["nextEvent"]
            next.isJsonNull || next.asJsonObject.let { n ->
                val start = n["start"].asJsonObject
                val end = n["end"].asJsonObject
                start["kind"].asString == "time" &&
                    end["kind"].asString == "time" &&
                    (n["selfResponseStatus"].isJsonNull || n["selfResponseStatus"].asString != "declined") &&
                    end["epochMs"].asLong > serverNow
            }
        }
    } catch (_: RuntimeException) {
        false
    }

    fun sourcesPage(e: JsonElement?): Boolean = try {
        obj(e, "v state errorCode serverNowEpochMs selectionRevision sources nextCursor") { o ->
            int(o["v"], 1, 1) &&
                state(o["state"]) &&
                nullable(o["errorCode"]) { calendarError(it) } &&
                int(o["serverNowEpochMs"], 0, MAX_SAFE) &&
                opaqueId(o["selectionRevision"]) &&
                arr(o["sources"], 50) { source(it) } &&
                nullable(o["nextCursor"]) { cursor(it) } &&
                budget(o, PAGE_BYTES)
        }
    } catch (_: RuntimeException) {
        false
    }

    /** Normalizes empty event titles to 'Untitled event' as specified by CalendarEventSchema. */
    fun normalizePage(page: JsonObject): JsonObject = page.deepCopy().also { copy ->
        copy.getAsJsonArray("items")?.forEach { item ->
            if (item.isJsonObject) normalizeEventTitle(item.asJsonObject)
        }
        val next = copy.get("nextEvent")
        if (next != null && next.isJsonObject) normalizeEventTitle(next.asJsonObject)
    }

    private fun normalizeEventTitle(event: JsonObject) {
        val title = event.get("title")
        if (title != null && title.isJsonPrimitive && title.asJsonPrimitive.isString && title.asString.isEmpty()) {
            event.add("title", JsonPrimitive("Untitled event"))
        }
    }
}
