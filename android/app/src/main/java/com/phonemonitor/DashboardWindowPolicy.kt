package com.phonemonitor

/** Window-only state; independent from transport/session foreground ownership. */
internal class DashboardWindowPolicy {
    var resumed=false
    var focused=false
    var imeVisible=false
    fun shouldHideBars(dialogShowing:Boolean)=resumed && focused && !imeVisible && !dialogShowing
    fun contentInsets(cutout:ContentInsets,imeBottom:Int)=cutout.copy(bottom=maxOf(cutout.bottom,imeBottom))
}
internal data class ContentInsets(val left:Int,val top:Int,val right:Int,val bottom:Int)
