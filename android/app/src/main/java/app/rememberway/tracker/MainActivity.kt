package app.rememberway.tracker

import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.text.InputFilter
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.concurrent.thread

/**
 * 어르신 휴대폰용 화면 (한 번 설정하면 끝).
 *  ① 보호자 웹앱(설정)이 만든 연결 코드를 넣고  ② 주변 목걸이를 찾아 하나 고른 뒤  ③ [시작]
 *  → 목걸이의 위치를 받아 서버로 보내고, 보호자가 누른 [소리 울리기]를 목걸이에 전달한다.
 */
class MainActivity : Activity() {
    private lateinit var settings: AppSettings
    private lateinit var codeInput: EditText
    private lateinit var trackerText: TextView
    private lateinit var foundBox: LinearLayout
    private lateinit var status: TextView
    private lateinit var logText: TextView
    private lateinit var scanner: TrackerScanner
    private var pad = 0
    private var notice = ""   // 이 화면에서 바로 알려 줄 말 (코드 글자 수 등)

    private val kst = ZoneId.of("Asia/Seoul")
    private val timeFmt = DateTimeFormatter.ofPattern("M월 d일 HH:mm:ss")
    private val listener: (TrackerState.Snapshot) -> Unit = { render(it) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = AppSettings(this)
        scanner = TrackerScanner(this)
        TrackerState.restoreLastLocation(settings)
        pad = (20 * resources.displayMetrics.density).toInt()

        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad * 2, pad, pad) }
        col.addView(text("리멤버웨이 위치", 26f, true))
        col.addView(text("목걸이의 GPS 위치를 이 휴대폰이 받아 보호자에게 보냅니다. 이 휴대폰을 가지고 다니시고, 앱을 끄지 마세요."))

        col.addView(text("① 보호자 연결 코드", 18f, true))
        col.addView(text("보호자 휴대폰의 리멤버웨이 → 설정 → 어르신 폰 연결 코드", 15f))
        codeInput = EditText(this).apply {
            hint = "ABCD-EFGH-IJKL-MNOP"; textSize = 22f; gravity = Gravity.CENTER
            filters = arrayOf(InputFilter.AllCaps(), InputFilter.LengthFilter(19))
            setText(settings.key.chunked(4).joinToString("-"))
        }
        col.addView(codeInput)

        col.addView(text("② 목걸이", 18f, true))
        trackerText = text("", 17f)
        col.addView(trackerText)
        col.addView(Button(this).apply { text = "목걸이 찾기"; textSize = 18f; setOnClickListener { findTrackers() } })
        foundBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(foundBox)

        col.addView(text("위치는 보호자가 어르신을 찾을 때만 쓰며, 동의한 경우에만 사용합니다. 위치가 서버를 거쳐 보호자에게 전달됩니다.", 13f))
        col.addView(Button(this).apply { text = "시작"; textSize = 20f; setOnClickListener { start() } })
        col.addView(Button(this).apply { text = "멈추기"; setOnClickListener { stop() } })

        status = text("", 18f)
        col.addView(status)

        col.addView(text("목걸이 소리 시험 (이 휴대폰에서 목걸이로 바로)", 15f))
        col.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(Button(this@MainActivity).apply { text = "소리 시험"; setOnClickListener { testBuzzer(BuzzerProtocol.FIND) } }, weight())
            addView(Button(this@MainActivity).apply { text = "소리 멈추기"; setOnClickListener { testBuzzer(BuzzerProtocol.OFF) } }, weight())
        })

        logText = text("", 12f).apply { typeface = Typeface.MONOSPACE }
        col.addView(logText)
        setContentView(ScrollView(this).apply { addView(col) })
        showTracker()
    }

    private fun text(s: String, size: Float = 17f, bold: Boolean = false) = TextView(this).apply {
        text = s; textSize = size; setPadding(0, pad / 3, 0, pad / 3); if (bold) setTypeface(typeface, Typeface.BOLD)
    }
    private fun weight() = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)

    override fun onStart() { super.onStart(); TrackerState.addListener(listener) }
    override fun onStop() { TrackerState.removeListener(listener); scanner.stop(); super.onStop() }

    // ---------------------------------------------------------------- ② 목걸이 찾기·고르기

    private fun showTracker() {
        trackerText.text = if (settings.hasTracker) "연동한 목걸이: ${settings.trackerName}" else "아직 고른 목걸이가 없어요. 목걸이를 켜고 [목걸이 찾기]를 눌러 주세요."
    }

    private fun findTrackers() {
        if (!Permissions.hasAll(this)) { requestPermissions(Permissions.toRequest(), REQ_SCAN); return }
        if (!bluetoothOn()) { askBluetooth(REQ_SCAN); return }
        // 목걸이가 이 휴대폰과 연결돼 있는 동안에는 검색에 잡히지 않을 수 있어서 먼저 멈춘다
        val wasRunning = TrackerService.instance != null
        if (wasRunning) TrackerService.stop(this)
        foundBox.removeAllViews()
        foundBox.addView(text("주변 목걸이를 찾는 중… (8초)", 15f))
        // 방금 끊은 목걸이가 다시 신호를 내보낼 틈을 준다
        foundBox.postDelayed({
            val ok = scanner.start(onUpdate = { showFound(it, done = false) }, onDone = { showFound(it, done = true) })
            if (!ok) { foundBox.removeAllViews(); foundBox.addView(text("블루투스 검색을 시작하지 못했어요. 블루투스를 켜고 다시 눌러 주세요.", 15f)) }
        }, if (wasRunning) 1500L else 0L)
    }

    private fun showFound(list: List<TrackerScanner.Found>, done: Boolean) {
        foundBox.removeAllViews()
        if (list.isEmpty()) {
            if (done) foundBox.addView(text("목걸이를 찾지 못했어요. 목걸이가 켜져 있고 가까이 있는지 확인한 뒤 다시 눌러 주세요. 다른 휴대폰이나 다른 앱이 목걸이에 연결돼 있으면 그쪽 연결을 끊어야 보여요.", 15f))
            else foundBox.addView(text("주변 목걸이를 찾는 중… (8초)", 15f))
            return
        }
        foundBox.addView(text(if (done) "쓸 목걸이를 눌러 주세요 (가까운 것이 위)" else "찾는 중… 쓸 목걸이를 눌러 주세요", 15f))
        for (f in list) {
            // 이름이 같은 목걸이가 여럿일 수 있어 주소 끝 네 글자를 같이 보여 준다
            val label = "${f.name}  ·  ${f.address.takeLast(5)}  ·  " + if (f.connected) "이 휴대폰과 연결돼 있음" else "신호 ${f.rssi}"
            foundBox.addView(Button(this).apply { text = label; isAllCaps = false; setOnClickListener { choose(f) } })
        }
    }

    private fun choose(f: TrackerScanner.Found) {
        scanner.stop()
        if (f.address != settings.trackerAddress) TrackerState.forgetLocation()
        settings.setTracker(f.address, f.name)
        foundBox.removeAllViews()
        showTracker()
        notice = "목걸이를 골랐어요. [시작]을 눌러 주세요."
        render(TrackerState.snapshot)
    }

    // ---------------------------------------------------------------- ③ 시작·멈추기

    private fun start() {
        val key = AppSettings.cleanKey(codeInput.text.toString())
        if (key.length != AppSettings.KEY_LENGTH) { say("연결 코드 16글자를 확인해 주세요"); return }
        if (key != settings.key) settings.key = key
        if (!settings.hasTracker) { say("먼저 [목걸이 찾기]로 목걸이를 골라 주세요"); return }
        if (!Permissions.hasAll(this)) { requestPermissions(Permissions.toRequest(), REQ_START); return }
        if (!bluetoothOn()) { askBluetooth(REQ_START); return }
        scanner.stop(); foundBox.removeAllViews()
        notice = ""
        TrackerService.start(this)
    }

    private fun stop() {
        TrackerService.stop(this)
        say("멈췄어요. 다시 보내려면 [시작]을 눌러 주세요.")
    }

    private fun testBuzzer(command: String) {
        val service = TrackerService.instance
        if (service == null) say("먼저 [시작]을 눌러 목걸이와 연결해 주세요") else service.sendTestBuzzer(command)
    }

    private fun bluetoothOn() = getSystemService(BluetoothManager::class.java)?.adapter?.isEnabled == true

    private fun askBluetooth(req: Int) {
        if (getSystemService(BluetoothManager::class.java)?.adapter == null) { say("이 휴대폰은 블루투스를 지원하지 않아요"); return }
        @Suppress("DEPRECATION")
        startActivityForResult(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), req)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (!Permissions.hasAll(this)) { say("블루투스 권한이 필요해요. 설정에서 '근처 기기' 권한을 허용해 주세요"); return }
        if (requestCode == REQ_SCAN) findTrackers() else start()
    }

    @Deprecated("화면 하나짜리 앱이라 간단한 옛 방식을 쓴다")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK) { say("블루투스를 켜야 목걸이와 연결할 수 있어요"); return }
        if (requestCode == REQ_SCAN) findTrackers() else if (requestCode == REQ_START) start()
    }

    // ---------------------------------------------------------------- 상태 보여 주기

    private fun say(s: String) { notice = s; render(TrackerState.snapshot) }

    private fun kstTime(epochMs: Long): String = timeFmt.format(Instant.ofEpochMilli(epochMs).atZone(kst))
    private fun kstTime(isoUtc: String): String = try { timeFmt.format(Instant.parse(isoUtc).atZone(kst)) } catch (e: Exception) { isoUtc }

    private fun render(s: TrackerState.Snapshot) {
        val p = s.lastPayload
        // 목걸이가 "좌표 없음"을 알려도 이전 위치가 있으면 그것을 계속 보여 준다. 하나도 없을 때만 "기다리는 중"
        val location = when {
            p == null && s.gpsState == "waiting" -> "GPS 위치를 기다리는 중 (밖이나 창가로)"
            p == null -> "없음"
            else -> {
                val head = if (s.gpsState == "valid") "지금 위치" else "이전 위치"
                val measured = p.gpsTime?.let { kstTime(it) } ?: "${kstTime(s.lastReceivedAt)} 받음"
                "%s %.5f, %.5f (%s)".format(head, p.latitude, p.longitude, measured)
            }
        }
        val sent = if (s.lastUploadAt > 0) "${kstTime(s.lastUploadAt)} ${s.lastUpload}" else s.lastUpload
        thread {
            val pending = try { LocalDb.get(applicationContext).pendingCount() } catch (e: Exception) { 0L }
            runOnUiThread {
                status.text = buildString {
                    if (notice.isNotEmpty()) append("▶ $notice\n\n")
                    append("상태: ${s.connection}\n")
                    append("마지막 위치: $location\n")
                    append("보호자에게 보내기: $sent · 대기 ${pending}개\n")
                    append("목걸이 소리: ${s.lastCommand}")
                }
            }
        }
        logText.text = s.logs.take(12).joinToString("\n")
    }

    private companion object {
        const val REQ_START = 1
        const val REQ_SCAN = 2
    }
}
