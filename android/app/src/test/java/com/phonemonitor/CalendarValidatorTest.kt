package com.phonemonitor

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import org.junit.Assert.*
import org.junit.Test

/** Synthetic values only; mirrors packages/protocol/src/calendar.ts and its shared fixtures. */
internal fun calendarPageFixture():JsonObject = StrictJson.parse(CalendarValidatorTest::class.java.getResource("/calendar-page.json")!!.readText()).asJsonObject
internal fun calendarSourcesFixture():JsonObject = StrictJson.parse(CalendarValidatorTest::class.java.getResource("/calendar-sources.json")!!.readText()).asJsonObject
internal fun json(text:String):JsonObject = StrictJson.parse(text).asJsonObject
internal fun JsonObject.copy():JsonObject = deepCopy()
internal fun JsonObject.with(key:String,value:Any?):JsonObject = copy().also{ it.add(key,when(value){ null->com.google.gson.JsonNull.INSTANCE; is JsonElement->value; is Boolean->com.google.gson.JsonPrimitive(value); is Number->com.google.gson.JsonPrimitive(value); else->com.google.gson.JsonPrimitive(value.toString()) }) }
internal fun JsonObject.without(key:String):JsonObject = copy().also{ it.remove(key) }

class CalendarValidatorTest {
    private val v=CalendarValidator
    private fun event(id:String="e1",source:String="synthetic_work",start:Long=1_772_951_400_000,end:Long=1_772_955_000_000):JsonObject=calendarPageFixture().getAsJsonArray("items")[0].asJsonObject.copy()
        .with("id",id).with("sourceId",source)
        .with("start",json("""{"kind":"time","epochMs":$start,"timeZone":"America/New_York"}"""))
        .with("end",json("""{"kind":"time","epochMs":$end,"timeZone":"America/New_York"}"""))
    private fun allDay(start:String,end:String)=event().with("start",json("""{"kind":"date","date":"$start"}""")).with("end",json("""{"kind":"date","date":"$end"}"""))
    private fun page(items:List<JsonObject>?=null,next:JsonObject?=null,mutate:(JsonObject)->Unit={}):JsonObject = calendarPageFixture().also { p ->
        if(items!=null) p.add("items",JsonArray().also{ a->items.forEach(a::add) })
        if(items!=null || next!=null) p.add("nextEvent",next ?: com.google.gson.JsonNull.INSTANCE)
        mutate(p)
    }
    private fun valid(e:JsonObject)=v.page(e)

    // ---- shared fixtures ----
    @Test fun acceptsSharedC1Fixtures() {
        assertTrue(v.page(calendarPageFixture())); assertTrue(v.sourcesPage(calendarSourcesFixture()))
        assertTrue(ProtocolValidator.response("hub.calendar",json("""{"state":"connected","ageMs":0,"stale":false,"data":${calendarPageFixture()},"errorCode":null}""")))
        assertTrue(ProtocolValidator.response("hub.calendarSources",json("""{"state":"connected","ageMs":0,"stale":false,"data":${calendarSourcesFixture()},"errorCode":null}""")))
        assertTrue(ProtocolValidator.response("hub.calendarSelect",json("""{"selectionRevision":"synthetic_selection_2"}""")))
    }

    // ---- requests ----
    private fun range(extra:String="")=json("""{"startDate":"2026-03-08","days":7,"timeZone":"America/New_York"$extra}""")
    @Test fun rangeRequestEnforcesDatesDaysZonesAndRefreshCursorExclusion() {
        assertTrue(v.rangeRequest(range())); assertTrue(v.rangeRequest(range(",\"cursor\":\"abc.DEF_~-9\""))); assertTrue(v.rangeRequest(range(",\"refresh\":true")))
        assertTrue(v.rangeRequest(range(",\"refresh\":false,\"cursor\":\"c1\"")))
        assertFalse("refresh+cursor",v.rangeRequest(range(",\"refresh\":true,\"cursor\":\"c1\"")))
        for(date in listOf("2026-02-29","2026-13-01","2026-00-10","2026-04-31","2026-1-01","20260301","0000-01-01","2026-03-08T00:00:00Z","２０２６-03-08","2026-03-08\n")) assertFalse(date,v.rangeRequest(range().with("startDate",date)))
        assertTrue(v.rangeRequest(range().with("startDate","2028-02-29"))); assertFalse(v.rangeRequest(range().with("startDate","2100-02-29")))
        for(days in listOf(0,32,-1,7.5)) assertFalse(days.toString(),v.rangeRequest(range().with("days",days)))
        assertTrue(v.rangeRequest(range().with("days",1))); assertTrue(v.rangeRequest(range().with("days",31)))
        assertFalse(v.rangeRequest(range().with("days","7")))
        for(zone in listOf("","Mars/Phobos","+05:00","-08:00","UTC+5","GMT+05:30","America/New_York ","america/new york","x".repeat(81))) assertFalse(zone,v.rangeRequest(range().with("timeZone",zone)))
        for(zone in listOf("UTC","Europe/London","Asia/Kolkata","America/New_York","Etc/GMT+5")) assertTrue(zone,v.rangeRequest(range().with("timeZone",zone)))
        assertFalse(v.rangeRequest(range().with("timeZone",null)))
        for(cursor in listOf("","has space","a/b","https://example.test","x".repeat(257),"é")) assertFalse(cursor,v.rangeRequest(range().with("cursor",cursor)))
        assertTrue(v.rangeRequest(range().with("cursor","x".repeat(256))))
        assertFalse(v.rangeRequest(range().with("cursor",null)))
        assertFalse("unknown key",v.rangeRequest(range(",\"url\":\"https://example.test\"")))
        assertFalse(v.rangeRequest(range(",\"refresh\":1")))
        assertFalse(v.rangeRequest(range().without("days")))
    }
    @Test fun sourcesAndSelectRequestsAreStrict() {
        assertTrue(v.sourcesRequest(json("{}"))); assertTrue(v.sourcesRequest(json("""{"cursor":"abc"}""")))
        assertFalse(v.sourcesRequest(json("""{"cursor":"a b"}"""))); assertFalse(v.sourcesRequest(json("""{"cursor":"a","extra":1}""")))
        assertTrue(v.selectRequest(json("""{"sourceIds":["a","b-1","c_2"],"expectedRevision":"rev_1"}""")))
        assertTrue(v.selectRequest(json("""{"sourceIds":[],"expectedRevision":"rev_1"}""")))
        assertFalse("duplicates",v.selectRequest(json("""{"sourceIds":["a","a"],"expectedRevision":"rev_1"}""")))
        val hundred=(1..100).joinToString(","){ "\"s$it\"" }; val over=(1..101).joinToString(","){ "\"s$it\"" }
        assertTrue(v.selectRequest(json("""{"sourceIds":[$hundred],"expectedRevision":"rev_1"}""")))
        assertFalse(v.selectRequest(json("""{"sourceIds":[$over],"expectedRevision":"rev_1"}""")))
        assertFalse(v.selectRequest(json("""{"sourceIds":["a/b"],"expectedRevision":"rev_1"}""")))
        assertFalse(v.selectRequest(json("""{"sourceIds":["${"a".repeat(81)}"],"expectedRevision":"rev_1"}""")))
        assertFalse(v.selectRequest(json("""{"sourceIds":["a"],"expectedRevision":""}""")))
        assertFalse(v.selectRequest(json("""{"sourceIds":["a"]}""")))
        assertFalse(v.selectRequest(json("""{"sourceIds":["a"],"expectedRevision":"r","extra":true}""")))
        assertFalse(v.selectRequest(json("""{"sourceIds":[1],"expectedRevision":"r"}""")))
    }
    @Test fun bridgeRequestValidationCoversThreeOperationsAndRefusesDynamicUrls() {
        fun req(op:String,args:String)=json("""{"v":1,"id":"x","op":"$op","args":$args}""")
        assertTrue(ProtocolValidator.request(req("hub.calendar",range().toString())))
        assertTrue(ProtocolValidator.request(req("hub.calendarSources","{}")))
        assertTrue(ProtocolValidator.request(req("hub.calendarSelect","""{"sourceIds":["a"],"expectedRevision":"r"}""")))
        assertFalse(ProtocolValidator.request(req("hub.calendar","{}")))
        assertFalse(ProtocolValidator.request(req("hub.calendar",range(",\"path\":\"/v1/other\"").toString())))
        assertFalse(ProtocolValidator.request(req("hub.calendarSources","""{"url":"http://example.test"}""")))
        assertFalse(ProtocolValidator.request(req("hub.calendarSelect","""{"sourceIds":["a"]}""")))
        assertFalse(ProtocolValidator.request(req("hub.calendar.delete","{}")))
    }

    // ---- errors and states ----
    @Test fun calendarErrorCodesJoinBridgeErrorsAndStatesAreClosed() {
        val codes=listOf("CALENDAR_AUTH_REQUIRED","CALENDAR_UNAVAILABLE","CALENDAR_CAPACITY","CALENDAR_CURSOR_EXPIRED","CALENDAR_SELECTION_CHANGED","CALENDAR_UNSUPPORTED")
        codes.forEach { assertTrue(it,it in ProtocolValidator.errors); assertTrue(valid(page{ p->p.add("errorCode",com.google.gson.JsonPrimitive(it)) })) }
        assertFalse(valid(page{ it.addProperty("errorCode","AUTH_REQUIRED") })); assertFalse(valid(page{ it.addProperty("errorCode","CALENDAR_OTHER") }))
        for(s in listOf("disabled","setup_required","loading","available","partial","auth_required","error","capacity")) assertTrue(s,valid(page{ it.addProperty("state",s) }))
        assertFalse(valid(page{ it.addProperty("state","ready") }))
        assertFalse(valid(page{ it.addProperty("v",2) }))
    }
    @Test fun setupRequiredPageWithEmptyArraysIsValidAndEchoesRange() {
        val p=page{ o -> o.addProperty("state","setup_required"); o.add("sources",JsonArray()); o.add("items",JsonArray()); o.add("nextEvent",com.google.gson.JsonNull.INSTANCE); o.add("nextCursor",com.google.gson.JsonNull.INSTANCE); o.addProperty("sourceCount",0); o.add("lastSuccessAtEpochMs",com.google.gson.JsonNull.INSTANCE) }
        assertTrue(v.page(p))
        assertFalse("range is required",v.page(p.without("range")))
        assertFalse("revision is required",v.page(p.without("revision")))
    }

    // ---- unknown keys everywhere ----
    @Test fun rejectsUnknownKeysAtEveryLevel() {
        assertFalse(valid(page{ it.addProperty("token","synthetic") }))
        assertFalse(valid(page{ it.getAsJsonObject("range").addProperty("extra",1) }))
        assertFalse(valid(page{ it.getAsJsonArray("sources")[0].asJsonObject.addProperty("email","synthetic@example.test") }))
        assertFalse(valid(page{ it.getAsJsonArray("items")[0].asJsonObject.addProperty("htmlLink","https://example.test") }))
        assertFalse(valid(page{ it.getAsJsonArray("items")[0].asJsonObject.getAsJsonObject("start").addProperty("extra",1) }))
        assertFalse(valid(page{ it.getAsJsonArray("items")[0].asJsonObject.getAsJsonObject("label").addProperty("extra",1) }))
        assertFalse(valid(page{ it.getAsJsonObject("nextEvent").addProperty("description","private") }))
        assertFalse(v.sourcesPage(calendarSourcesFixture().with("extra",1)))
        assertFalse(v.selectReply(json("""{"selectionRevision":"r","extra":1}""")))
        assertFalse(v.selectReply(json("""{}""")))
        assertTrue(v.selectReply(json("""{"selectionRevision":"r_1-a"}""")))
        assertFalse(v.selectReply(json("""{"selectionRevision":"r 1"}""")))
        for(required in listOf("state","errorCode","serverNowEpochMs","range","revision","selectionRevision","lastSuccessAtEpochMs","sourceCount","failedSourceCount","sources","items","nextEvent","nextCursor","v")) assertFalse(required,v.page(calendarPageFixture().without(required)))
    }

    // ---- events ----
    @Test fun eventEndpointsMustMatchAndHavePositiveDuration() {
        assertTrue(v.event(event()))
        assertFalse("equal",v.event(event(start=1000,end=1000))); assertFalse("reversed",v.event(event(start=2000,end=1000)))
        assertTrue(v.event(allDay("2026-03-08","2026-03-09"))); assertTrue(v.event(allDay("2026-12-31","2027-01-01")))
        assertFalse("same date",v.event(allDay("2026-03-08","2026-03-08"))); assertFalse("reversed date",v.event(allDay("2026-03-09","2026-03-08")))
        assertFalse("mixed",v.event(event().with("end",json("""{"kind":"date","date":"2026-03-09"}"""))))
        assertFalse("mixed other way",v.event(allDay("2026-03-08","2026-03-09").with("end",json("""{"kind":"time","epochMs":1772955000000,"timeZone":"UTC"}"""))))
        assertFalse(v.event(allDay("2026-02-30","2026-03-01"))); assertFalse(v.event(allDay("2026-03-08","2026-03-32")))
        assertFalse(v.event(event().with("start",json("""{"kind":"datetime","epochMs":1,"timeZone":"UTC"}"""))))
        assertFalse(v.event(event().with("start",json("""{"kind":"time","epochMs":1,"timeZone":"Mars/Phobos"}"""))))
        assertFalse(v.event(event().with("start",json("""{"kind":"time","epochMs":-1,"timeZone":"UTC"}"""))))
        assertFalse(v.event(event().with("start",json("""{"kind":"time","epochMs":9007199254740992,"timeZone":"UTC"}"""))))
        assertFalse(v.event(event().with("start",json("""{"kind":"time","epochMs":1.5,"timeZone":"UTC"}"""))))
        assertFalse(v.event(event().with("start",json("""{"kind":"time","epochMs":"1","timeZone":"UTC"}"""))))
        assertFalse(v.event(event().with("start",json("""{"kind":"date","date":"2026-03-08","timeZone":"UTC"}"""))))
        assertFalse("time zone retained is required",v.event(event().with("end",json("""{"kind":"time","epochMs":1772955000000}"""))))
    }
    @Test fun eventTextColorStatusAndReminderLimits() {
        fun cp(n:Int)="\uD83D\uDE00".repeat(n)
        assertTrue(v.event(event().with("title",cp(256)))); assertFalse(v.event(event().with("title",cp(257))))
        assertTrue("empty title is normalized by the contract, not dropped",v.event(event().with("title","")))
        assertTrue(v.event(event().with("calendarName",cp(120)))); assertFalse(v.event(event().with("calendarName",cp(121))))
        assertTrue(v.event(event().with("eventType",cp(40)))); assertFalse(v.event(event().with("eventType",cp(41))))
        val label={ name:Any? -> json("""{"name":${if(name==null) "null" else "\"$name\""},"color":"#0088ff"}""") }
        assertTrue(v.event(event().with("label",label(cp(50))))); assertFalse(v.event(event().with("label",label(cp(51)))))
        assertTrue("unnamed label stays valid",v.event(event().with("label",label(null)))); assertTrue(v.event(event().with("label",null)))
        assertFalse(v.event(event().with("label",json("""{"name":"x","color":"red"}"""))))
        assertFalse(v.event(event().with("label",json("""{"name":"x"}"""))))
        for(c in listOf("#12345","#1234567","123456","#GG0000","#12345G","rgb(0,0,0)")) assertFalse(c,v.event(event().with("calendarColor",c)))
        assertTrue(v.event(event().with("calendarColor","#AbCdEf"))); assertTrue(v.event(event().with("calendarColor",null)))
        for(s in listOf("confirmed","tentative")) assertTrue(v.event(event().with("status",s)))
        assertFalse("cancelled rows are not forwarded",v.event(event().with("status","cancelled")))
        for(r in listOf("needsAction","declined","tentative","accepted")) assertTrue(v.event(event().with("selfResponseStatus",r)))
        assertTrue(v.event(event().with("selfResponseStatus",null))); assertFalse(v.event(event().with("selfResponseStatus","maybe")))
        assertTrue(v.event(event().with("status","confirmed").with("selfResponseStatus","declined")))
        for(m in listOf(0,40320)) assertTrue(v.event(event().with("reminderMinutes",m)))
        for(m in listOf(-1,40321,1.5)) assertFalse(m.toString(),v.event(event().with("reminderMinutes",m)))
        assertTrue(v.event(event().with("reminderMinutes",null)))
        assertFalse(v.event(event().without("reminderMinutes")))
        assertFalse(v.event(event().with("id","bad id"))); assertFalse(v.event(event().with("sourceId","a".repeat(81)))); assertFalse(v.event(event().with("id","")))
    }

    // ---- pages ----
    @Test fun pageSourcesMustCoverItemsAndNextEventMustBeEligible() {
        assertFalse(valid(page(items=listOf(event(source="unknown_source")))))
        assertTrue(valid(page(items=listOf(event()),next=event(source="off_page_source"))))
        val serverNow=1_772_953_200_000
        assertFalse("all-day Next up",valid(page(next=allDay("2026-03-08","2026-03-09"))))
        assertFalse("declined Next up",valid(page(next=event().with("selfResponseStatus","declined"))))
        assertFalse("ended Next up",valid(page(next=event(start=serverNow-7_200_000,end=serverNow))))
        assertTrue("ongoing Next up",valid(page(next=event(start=serverNow-3_600_000,end=serverNow+1))))
        assertTrue("confirmed but needsAction",valid(page(next=event().with("selfResponseStatus","needsAction"))))
    }
    @Test fun pageAndSourceCountsAreBounded() {
        val item=event()
        assertTrue(valid(page(items=List(50){ item.with("id","e$it") }))); assertFalse(valid(page(items=List(51){ item.with("id","e$it") })))
        val source=calendarPageFixture().getAsJsonArray("sources")[0].asJsonObject
        fun sources(n:Int)=JsonArray().also{ a->repeat(n){ a.add(source.with("sourceId","synthetic_work$it".takeIf{ it!="synthetic_work0" }?:"synthetic_work")) } }
        assertTrue(valid(page{ it.add("sources",sources(50)) })); assertFalse(valid(page{ it.add("sources",sources(51)) }))
        assertTrue(valid(page{ it.addProperty("sourceCount",100) })); assertFalse(valid(page{ it.addProperty("sourceCount",101) })); assertFalse(valid(page{ it.addProperty("sourceCount",-1) }))
        assertTrue(valid(page{ it.addProperty("failedSourceCount",100) })); assertFalse(valid(page{ it.addProperty("failedSourceCount",101) }))
        assertFalse(valid(page{ it.addProperty("serverNowEpochMs",-1) })); assertFalse(valid(page{ it.addProperty("serverNowEpochMs",1.5) }))
        assertFalse(valid(page{ it.addProperty("revision","has space") })); assertFalse(valid(page{ it.addProperty("revision","") }))
        assertFalse(valid(page{ it.addProperty("nextCursor","has space") })); assertFalse(valid(page{ it.addProperty("nextCursor","x".repeat(257)) }))
        assertTrue(valid(page{ it.add("nextCursor",com.google.gson.JsonNull.INSTANCE) }))
        assertFalse(valid(page{ it.addProperty("range","2026-03-08") }))
        assertFalse(valid(page{ it.getAsJsonObject("range").addProperty("days",32) }))
        assertFalse(valid(page{ it.getAsJsonObject("range").addProperty("startDate","2026-02-30") }))
        assertFalse(valid(page{ it.getAsJsonObject("range").addProperty("timeZone","Mars/Phobos") }))
    }
    @Test fun sourceFieldsAreStrict() {
        val src=calendarPageFixture().getAsJsonArray("sources")[0].asJsonObject
        assertTrue(v.source(src))
        for(cap in listOf("read","busy","unavailable")) assertTrue(v.source(src.with("capability",cap)))
        assertFalse(v.source(src.with("capability","write"))); assertFalse(v.source(src.with("state","ok"))); assertFalse(v.source(src.with("selected","yes")))
        assertFalse(v.source(src.with("errorCode","AUTH_REQUIRED"))); assertTrue(v.source(src.with("errorCode","CALENDAR_UNAVAILABLE")))
        assertTrue(v.source(src.with("lastSuccessAtEpochMs",null))); assertFalse(v.source(src.with("lastSuccessAtEpochMs",-5)))
        assertTrue(v.source(src.with("color",null))); assertFalse(v.source(src.with("color","cyan")))
        assertTrue(v.source(src.with("name","\uD83D\uDE00".repeat(120)))); assertFalse(v.source(src.with("name","\uD83D\uDE00".repeat(121))))
    }
    @Test fun sourcesPageIsBoundedByCountAndBytes() {
        val src=calendarSourcesFixture().getAsJsonArray("sources")[0].asJsonObject
        fun sources(n:Int)=JsonArray().also{ a->repeat(n){ a.add(src.with("sourceId","s$it")) } }
        assertTrue(v.sourcesPage(calendarSourcesFixture().with("sources",sources(50)))); assertFalse(v.sourcesPage(calendarSourcesFixture().with("sources",sources(51))))
        assertFalse(v.sourcesPage(calendarSourcesFixture().without("selectionRevision")))
        assertFalse(v.sourcesPage(calendarSourcesFixture().with("nextCursor","a b")))
    }
    @Test fun serializedPageByteBudgetIsEnforcedInUtf8() {
        // Control characters serialize as six-byte \u00XX escapes, so maximum-length strings can exceed 128 KiB.
        val heavy="\u0001"
        fun bulky(i:Int)=event().with("id","e$i").with("title",heavy.repeat(256)).with("calendarName",heavy.repeat(120)).with("eventType",heavy.repeat(40))
            .with("label",json("""{"name":"${"\\u0001".repeat(50)}","color":"#0088ff"}"""))
        val big=page(items=List(50){ bulky(it) },next=bulky(99)){ it.add("nextEvent",bulky(99).with("sourceId","synthetic_work")) }
        assertTrue("over budget",big.toString().toByteArray(Charsets.UTF_8).size>128*1024)
        assertFalse(valid(big))
        val small=page(items=List(10){ bulky(it) },next=null)
        assertTrue(small.toString().toByteArray(Charsets.UTF_8).size<128*1024)
        assertTrue(valid(small))
        // Multi-byte text counts bytes, not code points.
        val ascii=page(items=List(50){ event().with("id","e$it") }); assertTrue(valid(ascii))
        val sourcesBig=calendarSourcesFixture().also { p -> val src=p.getAsJsonArray("sources")[0].asJsonObject; p.add("sources",JsonArray().also{ a->repeat(50){ a.add(src.with("sourceId","s$it").with("name","\u0001".repeat(120))) } }) }
        assertTrue(sourcesBig.toString().toByteArray(Charsets.UTF_8).size<128*1024); assertTrue(v.sourcesPage(sourcesBig))
    }
    @Test fun linkWrapperRequiresAgeForCachedCalendarData() {
        val data=calendarPageFixture()
        assertFalse(ProtocolValidator.response("hub.calendar",json("""{"state":"connected","ageMs":null,"stale":false,"data":$data,"errorCode":null}""")))
        assertTrue(ProtocolValidator.response("hub.calendar",json("""{"state":"error","ageMs":null,"stale":true,"data":null,"errorCode":"CALENDAR_UNSUPPORTED"}""")))
        assertFalse(ProtocolValidator.response("hub.calendar",json("""{"state":"connected","ageMs":0,"stale":false,"data":${calendarSourcesFixture()},"errorCode":null}""")))
        assertFalse(ProtocolValidator.response("hub.calendarSources",json("""{"state":"connected","ageMs":0,"stale":false,"data":$data,"errorCode":null}""")))
        assertFalse(ProtocolValidator.response("hub.calendarSelect",json("""{"state":"connected","ageMs":0,"stale":false,"data":null,"errorCode":null}""")))
        assertFalse(ProtocolValidator.response("hub.calendar",json("""{"state":"connected","ageMs":0,"stale":false,"data":${data.with("token","x")},"errorCode":null}""")))
    }
}
