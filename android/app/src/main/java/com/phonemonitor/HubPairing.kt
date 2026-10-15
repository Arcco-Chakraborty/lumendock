package com.phonemonitor

/** What the native code-entry dialog should do next. Codes are protocol enums; never a token. */
sealed interface PairingOutcome {
    data object Succeeded:PairingOutcome
    /** Keep the dialog open: the user may correct the code or reconnect USB within the hub's window. */
    data class Retry(val code:String):PairingOutcome
    /** Setup flow is finished as failed; app.status carries the code. */
    data class Failed(val code:String):PairingOutcome
    /** The setup flow was cancelled/expired/backgrounded meanwhile; nothing to show. */
    data object Ended:PairingOutcome
}

/**
 * Native pairing controller behind app.setupHub. The bridge acknowledges setup immediately (SetupResult);
 * code entry may take any time up to the native 120 s expiry, and completion is published only via AppStatus.
 * The code and the issued token stay in native memory/storage.
 */
class HubPairingFlow(
    private val session:NativeSession,
    private val pair:(String)->PairResult,
    private val worker:(Runnable)->Unit,
    private val post:(()->Unit)->Unit,
) {
    private var busy=false // main thread only

    /** Returns false when the submission was ignored (busy, or the setup flow is no longer current). */
    fun submit(setupId:String,code:String,onOutcome:(PairingOutcome)->Unit):Boolean {
        if(busy || !session.isSetupCurrent("hub",setupId)) return false
        if(!LaptopClient.PAIRING_CODE.matches(code)) { onOutcome(PairingOutcome.Retry("BAD_PAIRING_CODE")); return true }
        busy=true
        try {
            worker(Runnable {
                val result=try { pair(code) } catch(_:Exception) { PairResult(false,"USB_UNAVAILABLE") }
                post { busy=false; onOutcome(settle(setupId,result)) }
            })
        } catch(_:RuntimeException) { busy=false; onOutcome(PairingOutcome.Retry("BRIDGE_UNAVAILABLE")) }
        return true
    }
    private fun settle(setupId:String,result:PairResult):PairingOutcome {
        val live=session.isSetupCurrent("hub",setupId)
        if(result.paired) { if(live) session.finishSetup("hub",setupId,"succeeded"); return if(live) PairingOutcome.Succeeded else PairingOutcome.Ended }
        if(!live) return PairingOutcome.Ended
        return when(val code=result.errorCode ?: "BAD_PAYLOAD") {
            "PAIRING_EXPIRED","PAIRING_CLOSED","TOKEN_PERSIST_FAILED" -> { session.finishSetup("hub",setupId,"failed",code); PairingOutcome.Failed(code) }
            "SESSION_ENDED" -> PairingOutcome.Ended
            else -> PairingOutcome.Retry(if(code in ProtocolValidator.errors) code else "BAD_PAYLOAD")
        }
    }
}
