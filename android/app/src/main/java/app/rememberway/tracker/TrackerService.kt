package app.rememberway.tracker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import org.json.JSONObject

/**
 * 목걸이(블루투스) ↔ 이 휴대폰 ↔ 서버(/api/loc) 중계. 화면이 꺼져도 돌도록 포그라운드 서비스(알림 표시).
 *  - 받은 위치는 먼저 이 휴대폰의 대기열에 넣고 보낸다 → 인터넷이 끊겨도 나중에 다시 보낸다
 *  - 보호자가 웹에서 누른 [소리 울리기]를 서버에서 받아 목걸이로 전달하고 결과를 알린다
 *  - 연동한 목걸이와 연결 상태를 서버에 알린다 (보호자 화면의 "위치 단말")
 * 어르신(또는 가족)이 앱에서 [시작]을 눌렀을 때만 시작한다.
 */
class TrackerService : Service(), TrackerBleClient.Listener {
    companion object {
        private const val CHANNEL = "tracker"
        private const val ALERT_CHANNEL = "tracker_alert"       // 멈춘 뒤에도 남는 안내용 (진행 중 알림은 서비스와 함께 사라진다)
        private const val NOTIF_ID = 1
        private const val ALERT_ID = 2
        const val REVOKED_TEXT = "가족이 연결을 끊었어요. 보호자에게 새 연결 코드를 받아 넣어 주세요."

        /** 위치를 보내지 않는 동안 서버에 부저 명령을 물어보는 간격. 명령은 60초 뒤 만료되므로 그보다 충분히 짧게 */
        private const val POLL_MS = 10_000L
        /** 상태가 그대로여도 이 간격으로는 서버에 알린다 (보호자 화면이 "소식이 끊김"을 알 수 있게) */
        private const val REPORT_EVERY_MS = 5 * 60_000L
        /** 통신이 안 될 때 다시 해 보는 간격. 가장 긴 것도 부저 명령 만료(60초)의 절반 — 통신이 돌아오면 만료 전에 명령을 가져올 수 있게 */
        private val RETRY_MS = longArrayOf(10_000, 20_000, 30_000)
        private const val WAITING_TEXT = "인터넷 연결을 기다리는 중"

        @Volatile var instance: TrackerService? = null
            private set

        fun start(context: Context) { context.startForegroundService(Intent(context, TrackerService::class.java)) }
        fun stop(context: Context) { context.stopService(Intent(context, TrackerService::class.java)) }
    }

    private lateinit var settings: AppSettings
    private lateinit var db: LocalDb
    private lateinit var api: Api
    private lateinit var commands: CommandProcessor
    private lateinit var netThread: HandlerThread
    private lateinit var net: Handler

    private var ble: TrackerBleClient? = null
    @Volatile private var running = false
    private var lastContentKey: String? = null
    private var lastNotificationText = ""

    // 통신 스레드(net)에서만 쓰는 값
    private var failures = 0
    private var lastReport = ""
    private var lastReportAt = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        settings = AppSettings(this)
        TrackerState.restoreLastLocation(settings)
        db = LocalDb.get(this)
        api = Api(settings)
        netThread = HandlerThread("tracker-net").apply { start() }
        net = Handler(netThread.looper)
        commands = CommandProcessor(api, db, { ble }, { block -> net.post(block) }, { net.post { revoked() } })
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "목걸이 위치 중계", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(ALERT_CHANNEL, "연결 안내", NotificationManager.IMPORTANCE_DEFAULT))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        getSystemService(NotificationManager::class.java).cancel(ALERT_ID)   // 다시 시작했으면 지난 멈춤 안내는 치운다
        val n = note("목걸이를 찾는 중")
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        else startForeground(NOTIF_ID, n)

        if (!Permissions.hasAll(this) || !settings.hasKey || !settings.hasTracker) {
            TrackerState.update { it.copy(connection = "연결 코드·목걸이·블루투스 권한을 확인해 주세요") }
            stopSelf()
            return START_NOT_STICKY
        }
        if (!running) {
            running = true
            instance = this
            TrackerState.log("시작")
            ble = TrackerBleClient(this, settings.trackerAddress, this).also { it.start() }
            net.post { commands.onServiceStart() }
            requestSync(0)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        val wasRunning = running
        running = false
        instance = null
        ble?.stop()
        ble = null
        TrackerState.update { it.copy(bleState = "stopped", gpsState = "unknown", connection = if (it.connection == REVOKED_TEXT) it.connection else "멈춤") }
        if (wasRunning) net.post { try { report(force = true) } catch (_: Exception) {} }   // 보호자 화면에 "앱이 멈춰 있음"으로 보이게
        netThread.quitSafely()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- 블루투스에서 온 것 (메인 스레드)

    override fun onStateChanged(state: TrackerBleClient.State, detail: String) {
        if (!running) return   // 멈춘 뒤 늦게 온 콜백이 멈춤 안내를 덮지 않게
        val bleState = when (state) {
            TrackerBleClient.State.READY -> "connected"
            TrackerBleClient.State.STOPPED -> "stopped"
            TrackerBleClient.State.BLUETOOTH_OFF -> "bluetooth_off"
            TrackerBleClient.State.SCANNING, TrackerBleClient.State.BACKOFF -> "disconnected"
            else -> "connecting"
        }
        val before = TrackerState.snapshot.bleState
        TrackerState.update {
            // 연결이 끊기면 GPS 상태는 알 수 없다. 마지막 위치는 그대로 둔다
            it.copy(connection = detail, bleState = bleState, gpsState = if (bleState == "connected") it.gpsState else "unknown")
        }
        notifyStatus(detail)
        // 연결됐거나 끊겼으면 바로 서버에 알리고, 기다리던 부저 명령도 바로 다시 확인한다
        if (before != bleState && (before == "connected" || bleState == "connected")) requestSync(500)
    }

    override fun onLocationData(result: ParseResult) {
        if (!running) return
        when (result) {
            // 새 좌표가 없다는 뜻. 이전 위치는 지우지 않고 화면에서 계속 보여 준다. 서버에는 아무것도 보내지 않는다(이전 좌표는 이미 가 있다)
            is ParseResult.Status -> {
                val changed = TrackerState.snapshot.gpsState != "waiting"
                TrackerState.update { it.copy(gpsState = "waiting") }
                notifyStatus("목걸이 연결됨 · GPS 위치를 기다리는 중 (밖이나 창가)")
                if (changed) requestSync(500)
            }
            is ParseResult.Invalid -> TrackerState.log("위치를 읽지 못했어요: ${result.reason}")
            is ParseResult.Location -> {
                val p = result.payload
                val now = System.currentTimeMillis()
                TrackerState.update { it.copy(gpsState = "valid", lastPayload = p, lastReceivedAt = now) }
                notifyStatus("목걸이 연결됨 · 위치 보내는 중")
                // 연결 직후 읽은 값과 알림 뒤 읽은 값이 같은 표본일 수 있다
                if (p.contentKey == lastContentKey) return
                lastContentKey = p.contentKey
                settings.saveLastLocation(result.rawJson, now)
                net.post { db.enqueue(result.rawJson) }
                requestSync(0)
            }
        }
    }

    /** 화면의 [소리 시험] — 서버를 거치지 않고 이 휴대폰에서 목걸이로 바로 보낸다 */
    fun sendTestBuzzer(command: String) {
        val client = ble ?: return
        val name = if (command == BuzzerProtocol.OFF) "소리 멈추기" else "소리 시험"
        TrackerState.update { it.copy(lastCommand = "$name — 보내는 중") }
        client.sendBuzzer(command) { r ->
            val text = if (r.accepted) "목걸이가 받았어요" else "보내지 못했어요 (${r.reason})"
            TrackerState.update { it.copy(lastCommand = "$name — $text") }
        }
    }

    // ---------------------------------------------------------------- 서버와 주고받기 (통신 스레드)

    private val syncRunnable = Runnable {
        val next = try { sync() } catch (e: Exception) { TrackerState.log("통신 오류: ${e.javaClass.simpleName}"); RETRY_MS[0] }
        if (running && next > 0) net.postDelayed(syncTick, next)
    }
    private val syncTick = Runnable { requestSync(0) }

    /** 지금(또는 조금 뒤) 서버와 한 번 주고받는다. 예약돼 있던 것은 이걸로 바꾼다 */
    private fun requestSync(delayMs: Long) {
        net.removeCallbacks(syncTick)
        net.removeCallbacks(syncRunnable)
        net.postDelayed(syncRunnable, delayMs)
    }

    /** 한 번 주고받기. 돌려주는 값: 다음에 다시 할 때까지 기다릴 시간(ms), 0 이하면 다시 하지 않음 */
    private fun sync(): Long {
        if (!running) return 0
        var talked = false   // 이번에 서버와 주고받았는지 (위치를 보냈으면 부저 명령을 따로 물어볼 필요가 없다)
        var failed = false

        // 1) 대기열의 위치 보내기 — 응답에 부저 명령이 같이 온다
        send@ while (true) {
            val batch = db.pending()
            if (batch.isEmpty()) break
            for (item in batch) {
                val p = try { JSONObject(item.json) } catch (e: Exception) { db.remove(item.id); continue }
                val r = api.call("push") { it.put("p", p) }
                when {
                    r.isSuccess -> {
                        db.remove(item.id); talked = true
                        TrackerState.update { it.copy(lastUploadAt = System.currentTimeMillis(), lastUpload = "보냈어요") }
                        commands.handle(r.body?.optJSONArray("commands"))
                    }
                    r.isRevoked -> { revoked(); return 0 }
                    r.code == 400 || r.code == 422 -> db.remove(item.id)   // 잘못된 데이터는 다시 보내지 않음
                    else -> { failed = true; break@send }
                }
            }
        }

        // 2) 보낸 위치가 없으면 기다리는 부저 명령만 물어본다
        if (!talked && !failed) {
            val r = api.call("cmd.pending")
            when {
                r.isSuccess -> commands.handle(r.body?.optJSONArray("commands"))
                r.isRevoked -> { revoked(); return 0 }
                else -> failed = true
            }
        }

        // 3) 서버에 아직 알리지 못한 부저 결과, 4) 목걸이·연결 상태
        if (!failed) {
            if (!commands.flushReports()) failed = true
            if (!running) return 0
            // 상태 알림이 실패해도 부저 명령을 묻는 간격은 늘리지 않는다 (다음 번에 다시 알린다)
            if (!failed) report(force = false)
        }

        if (failed) {
            TrackerState.update { it.copy(lastUpload = WAITING_TEXT) }
            return RETRY_MS[minOf(failures++, RETRY_MS.size - 1)]
        }
        failures = 0
        // 다시 통하면 "기다리는 중" 글을 지운다 (GPS 좌표가 없는 동안에는 위치를 보내지 않아 이 글이 그대로 남았다)
        TrackerState.update { if (it.lastUpload == WAITING_TEXT) it.copy(lastUpload = "서버와 연결됨") else it }
        return POLL_MS
    }

    /** 연동한 목걸이와 지금 상태를 서버에 알린다 (바뀌었거나 5분이 지났을 때). 블루투스 주소는 보내지 않는다 */
    private fun report(force: Boolean): Boolean {
        val s = TrackerState.snapshot
        val p = s.lastPayload
        val signature = "${s.bleState}|${s.gpsState}|${settings.trackerName}|${p?.deviceId}|${p?.firmwareVersion}"
        val now = System.currentTimeMillis()
        if (!force && signature == lastReport && now - lastReportAt < REPORT_EVERY_MS) return true
        val r = api.call("device.report") {
            it.put("ble", s.bleState).put("gps", s.gpsState).put("app", BuildConfig.VERSION_NAME)
            it.put("tracker", JSONObject().put("name", settings.trackerName).apply {
                if (p != null) put("id", p.deviceId).put("fw", p.firmwareVersion)
            })
        }
        if (r.isRevoked) { if (running) revoked(); return false }
        if (!r.isSuccess) return r.code in 400..499   // 서버가 아직 이 기능을 모르면(400) 다시 보내도 같다 — 실패로 치지 않는다
        lastReport = signature; lastReportAt = now
        return true
    }

    /** 보호자가 연결 코드를 폐기했다 → 대기열을 비우고 멈춘다. 새 코드를 넣고 [시작]하면 다시 동작 */
    private fun revoked() {
        if (!running) return
        running = false
        db.clearQueue()
        db.clearCommands()
        TrackerState.update { it.copy(connection = REVOKED_TEXT, lastUpload = "-") }
        alert(REVOKED_TEXT)   // 멈추면 진행 중 알림도 사라지니, 어르신이 볼 수 있게 따로 남긴다
        stopSelf()
    }

    // ---------------------------------------------------------------- 알림

    private fun note(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL).setContentTitle("리멤버웨이 위치").setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation).setOngoing(true).setContentIntent(open).build()
    }

    private fun notifyStatus(text: String) {
        if (!running || text == lastNotificationText) return
        lastNotificationText = text
        getSystemService(NotificationManager::class.java).notify(NOTIF_ID, note(text))
    }

    /** 서비스가 멈춘 뒤에도 어르신이 볼 수 있게 남는 알림 (누르면 앱이 열림) */
    private fun alert(text: String) {
        val open = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, ALERT_CHANNEL).setContentTitle("리멤버웨이 위치").setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setSmallIcon(android.R.drawable.ic_menu_mylocation).setOngoing(false).setAutoCancel(true).setContentIntent(open).build()
        getSystemService(NotificationManager::class.java).notify(ALERT_ID, n)
    }
}
