package app.rememberway.tracker

import android.os.Handler
import android.os.Looper
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 서비스 ↔ 화면 사이에 나누는 상태 (같은 프로세스 안, 저장하지 않음) */
object TrackerState {
    data class Snapshot(
        /** 화면에 보여 줄 연결 상태 글 */
        val connection: String = "시작 전",
        /** 서버에 알리는 값: connected / connecting / disconnected / bluetooth_off / stopped */
        val bleState: String = "stopped",
        /** valid / waiting / unknown */
        val gpsState: String = "unknown",
        val lastPayload: GpsPayload? = null,
        val lastReceivedAt: Long = 0L,
        val lastUpload: String = "-",
        val lastUploadAt: Long = 0L,
        val lastCommand: String = "없음",
        val reconnects: Int = 0,
        val logs: List<String> = emptyList(),
    )

    @Volatile var snapshot = Snapshot(); private set
    private val listeners = mutableSetOf<(Snapshot) -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    private val timeFmt = SimpleDateFormat("HH:mm:ss", Locale.KOREA)

    @Synchronized
    fun update(block: (Snapshot) -> Snapshot) {
        snapshot = block(snapshot)
        val s = snapshot
        val ls = listeners.toList()
        main.post { ls.forEach { it(s) } }
    }

    /** 메모리에 위치가 없으면 저장해 둔 마지막 위치를 불러온다 (앱·서비스를 켤 때) */
    fun restoreLastLocation(settings: AppSettings) {
        if (snapshot.lastPayload != null) return
        val (payload, receivedAt) = settings.loadLastLocation() ?: return
        update { if (it.lastPayload != null) it else it.copy(lastPayload = payload, lastReceivedAt = receivedAt) }
    }

    fun forgetLocation() = update { it.copy(lastPayload = null, lastReceivedAt = 0L, gpsState = "unknown") }

    /** 좌표·연결 코드·블루투스 주소는 기록에 넣지 않는다 */
    fun log(msg: String) = update {
        val line = "${timeFmt.format(Date())} $msg"
        it.copy(logs = (listOf(line) + it.logs).take(60))
    }

    @Synchronized fun addListener(l: (Snapshot) -> Unit) { listeners += l; main.post { l(snapshot) } }
    @Synchronized fun removeListener(l: (Snapshot) -> Unit) { listeners -= l }
}
