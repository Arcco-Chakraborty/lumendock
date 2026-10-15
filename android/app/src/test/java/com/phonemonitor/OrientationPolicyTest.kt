package com.phonemonitor

import org.junit.Assert.*
import org.junit.Test

class OrientationPolicyTest {
    private val policy=OrientationPolicy()
    private var t=0L
    private fun hold(degrees:Int,ms:Long,step:Long=100):OrientationPolicy.Mode? {
        var change:OrientationPolicy.Mode?=null
        val end=t+ms
        while(t<=end) { policy.onReading(degrees,t)?.let{change=it}; t+=step }
        t=end
        return change
    }

    @Test fun startsLandscapeEvenWhenThePhoneIsHeldPortrait() {
        assertEquals(OrientationPolicy.Mode.LANDSCAPE_DEFAULT,policy.mode)
        assertNull(hold(0,10_000)); assertNull(hold(180,10_000))
        assertEquals(OrientationPolicy.Mode.LANDSCAPE_DEFAULT,policy.mode)
        assertTrue(policy.needsSensor)
    }
    @Test fun deliberateRotationFromLandscapeToPortraitUnlocksSensorRotation() {
        assertNull(hold(90,500))
        assertNull("Brief portrait passes do not flip the dashboard",hold(5,OrientationPolicy.PORTRAIT_HOLD_MS-200))
        assertNull(hold(90,300))
        val change=hold(355,OrientationPolicy.PORTRAIT_HOLD_MS)
        assertEquals(OrientationPolicy.Mode.FOLLOW_SENSOR,change)
        assertEquals(OrientationPolicy.Mode.FOLLOW_SENSOR,policy.mode)
        assertFalse(policy.needsSensor)
        assertNull("Once following the sensor, landscape and portrait both rotate freely",hold(270,1000))
        assertEquals(OrientationPolicy.Mode.FOLLOW_SENSOR,policy.mode)
    }
    @Test fun upsideDownPortraitAlsoCountsAndDiagonalsOrUnknownResetTheTimer() {
        hold(270,300)
        assertNull(hold(180,OrientationPolicy.PORTRAIT_HOLD_MS/2))
        assertNull(hold(135,200))
        assertNull(hold(180,OrientationPolicy.PORTRAIT_HOLD_MS/2))
        assertNull(hold(OrientationPolicy.UNKNOWN,200))
        assertNull(hold(180,OrientationPolicy.PORTRAIT_HOLD_MS/2))
        assertEquals(OrientationPolicy.Mode.FOLLOW_SENSOR,hold(180,OrientationPolicy.PORTRAIT_HOLD_MS))
    }
    @Test fun flatOrUnknownReadingsNeverArmTheSwitch() {
        assertNull(hold(OrientationPolicy.UNKNOWN,5000))
        assertNull(hold(10,5000))
        assertEquals(OrientationPolicy.Mode.LANDSCAPE_DEFAULT,policy.mode)
    }
    @Test fun eachNewActivityStartsBackAtTheLandscapeDefault() {
        hold(90,200); hold(0,OrientationPolicy.PORTRAIT_HOLD_MS+100)
        assertEquals(OrientationPolicy.Mode.FOLLOW_SENSOR,policy.mode)
        assertEquals(OrientationPolicy.Mode.LANDSCAPE_DEFAULT,OrientationPolicy().mode)
    }
}
