package com.phonemonitor

/**
 * A1-R4 landscape-default policy, with no bridge operation. Each Activity starts in sensor-landscape, so a
 * phone held portrait still shows the landscape dashboard. Portrait stays available: once the device has been
 * seen in landscape and is then deliberately held portrait (either way up) for PORTRAIT_HOLD_MS, the policy
 * switches to full-sensor rotation for the rest of that Activity. Flat/unknown/diagonal readings never arm it.
 */
class OrientationPolicy {
    enum class Mode { LANDSCAPE_DEFAULT, FOLLOW_SENSOR }
    var mode=Mode.LANDSCAPE_DEFAULT; private set
    private var sawLandscape=false
    private var portraitSince:Long?=null
    /** The orientation sensor is only needed until the user has unlocked portrait. */
    val needsSensor get()=mode==Mode.LANDSCAPE_DEFAULT

    /** degrees: OrientationEventListener value 0..359, or UNKNOWN. Returns the new mode on a change. */
    fun onReading(degrees:Int,nowMs:Long):Mode? {
        if(mode!=Mode.LANDSCAPE_DEFAULT) return null
        when(classify(degrees)) {
            Pose.LANDSCAPE -> { sawLandscape=true; portraitSince=null }
            Pose.PORTRAIT -> if(sawLandscape) {
                val since=portraitSince ?: nowMs.also{ portraitSince=it }
                if(nowMs-since>=PORTRAIT_HOLD_MS) { mode=Mode.FOLLOW_SENSOR; return mode }
            }
            Pose.OTHER -> portraitSince=null
        }
        return null
    }
    private enum class Pose { PORTRAIT, LANDSCAPE, OTHER }
    private fun classify(d:Int):Pose = when {
        d !in 0..359 -> Pose.OTHER
        d<=TOLERANCE || d>=360-TOLERANCE || d in (180-TOLERANCE)..(180+TOLERANCE) -> Pose.PORTRAIT
        d in (90-TOLERANCE)..(90+TOLERANCE) || d in (270-TOLERANCE)..(270+TOLERANCE) -> Pose.LANDSCAPE
        else -> Pose.OTHER
    }
    companion object {
        const val UNKNOWN=-1
        const val PORTRAIT_HOLD_MS=1200L
        private const val TOLERANCE=30
    }
}
