package app.rememberway.tracker

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.ParcelUuid
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors

/**
 * 목걸이(BLE) → 이 휴대폰 → 서버(/api/loc) 중계. 화면이 꺼져도 돌도록 포그라운드 서비스(알림 표시).
 * 받은 위치는 먼저 파일 대기열에 넣고 보낸다 → 인터넷이 끊겨도 나중에 다시 보냄.
 * UUID는 hardware/necklace/necklace.ino 와 같다.
 */
@SuppressLint("MissingPermission")
class TrackerService : Service() {
    companion object {
        val SERVICE: UUID = UUID.fromString("7a1e0001-5c3b-4f7e-9a2d-525741590001")
        val LOC: UUID = UUID.fromString("7a1e0003-5c3b-4f7e-9a2d-525741590001")
        val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        const val ENDPOINT = "https://rememberway.vercel.app/api/loc"
        const val CHANNEL = "tracker"
        const val ALERT_CHANNEL = "tracker_alert"                // 멈춘 뒤에도 남는 안내용 (진행 중 알림은 서비스와 함께 사라진다)
        const val ALERT_ID = 2
        const val REVOKED_TEXT = "가족이 연결을 끊었어요. 보호자에게 새 연결 코드를 받아 넣어 주세요."
        const val MAX_QUEUE = 5000
    }

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var gatt: BluetoothGatt? = null
    private var scanning = false
    @Volatile private var running = false                  // 보내기 스레드(io)에서도 바꾸므로 스레드 사이에 바로 보이게
    private val queueFile by lazy { File(filesDir, "queue.jsonl") }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "목걸이 위치 중계", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(ALERT_CHANNEL, "연결 안내", NotificationManager.IMPORTANCE_DEFAULT))
        nm.cancel(ALERT_ID)                                    // 다시 시작했으면 지난 멈춤 안내는 치운다
        val n = note("목걸이를 찾는 중")
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE) else startForeground(1, n)
        if (!running) { running = true; scan(); flushLater(0) }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        stopScan(); gatt?.close(); gatt = null
        main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun note(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL).setContentTitle("리멤버웨이 위치").setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation).setOngoing(true).setContentIntent(open).build()
    }
    /** 서비스가 멈춘 뒤에도 어르신이 볼 수 있게 남는 알림 (진행 중 알림이 아님, 누르면 앱이 열림) */
    private fun alert(text: String) {
        val open = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, ALERT_CHANNEL).setContentTitle("리멤버웨이 위치").setContentText(text).setStyle(Notification.BigTextStyle().bigText(text))
            .setSmallIcon(android.R.drawable.ic_menu_mylocation).setOngoing(false).setAutoCancel(true).setContentIntent(open).build()
        getSystemService(NotificationManager::class.java).notify(ALERT_ID, n)
    }
    private fun status(s: String) {
        if (!running) return                                   // 멈춘 뒤 늦게 온 블루투스 콜백이 멈춤 안내를 덮거나 알림을 되살리지 않게
        Store.status(this, s)
        getSystemService(NotificationManager::class.java).notify(1, note(s))
    }

    // ---------------------------------------------------------------- BLE 찾기·연결
    private val scanCb = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            if (!scanning) return
            stopScan(); connect(result.device)
        }
        override fun onScanFailed(errorCode: Int) { status("블루투스 검색 실패($errorCode) — 다시 시도"); scanLater() }
    }
    private fun scan() {
        if (!running) return
        val adapter = getSystemService(BluetoothManager::class.java).adapter
        if (adapter == null || !adapter.isEnabled) { status("블루투스를 켜 주세요"); scanLater(); return }
        val f = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE)).build()
        val s = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build()
        try { adapter.bluetoothLeScanner.startScan(listOf(f), s, scanCb); scanning = true; status("목걸이를 찾는 중") }
        catch (e: Exception) { status("검색 오류: ${e.message}"); scanLater() }
    }
    private fun stopScan() {
        if (!scanning) return
        scanning = false
        try { getSystemService(BluetoothManager::class.java).adapter.bluetoothLeScanner?.stopScan(scanCb) } catch (_: Exception) {}
    }
    private fun scanLater() { main.postDelayed({ scan() }, 5000) }
    private fun connect(d: BluetoothDevice) {
        status("목걸이에 연결 중")
        gatt = d.connectGatt(this, false, gattCb, BluetoothDevice.TRANSPORT_LE)
    }

    private val gattCb = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, st: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) { status("목걸이 연결됨"); g.requestMtu(247) }
            else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                g.close(); if (gatt == g) gatt = null
                status("목걸이와 연결이 끊겼어요 — 다시 찾는 중"); main.postDelayed({ scan() }, 3000)
            }
        }
        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, st: Int) { g.discoverServices() }
        override fun onServicesDiscovered(g: BluetoothGatt, st: Int) {
            val ch = g.getService(SERVICE)?.getCharacteristic(LOC)
            if (ch == null) { status("목걸이 코드가 위치 기능이 없는 버전이에요"); return }
            g.setCharacteristicNotification(ch, true)
            val d = ch.getDescriptor(CCCD) ?: return
            if (Build.VERSION.SDK_INT >= 33) g.writeDescriptor(d, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            else { @Suppress("DEPRECATION") run { d.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE; g.writeDescriptor(d) } }
        }
        // 안드로이드 13 이상
        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray) { handle(g, ch, value) }
        @Deprecated("Android 12 이하") @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic) { if (Build.VERSION.SDK_INT < 33) handle(g, ch, ch.value ?: return) }
        override fun onCharacteristicRead(g: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray, st: Int) { handle(g, ch, value, fromRead = true) }
        @Deprecated("Android 12 이하") @Suppress("DEPRECATION")
        override fun onCharacteristicRead(g: BluetoothGatt, ch: BluetoothGattCharacteristic, st: Int) { if (Build.VERSION.SDK_INT < 33) handle(g, ch, ch.value ?: return, fromRead = true) }
    }

    /** 알림으로 온 JSON이 잘렸으면(블루투스 한 번에 보낼 수 있는 크기가 작을 때) 전체를 다시 읽는다(long read) */
    private fun handle(g: BluetoothGatt, ch: BluetoothGattCharacteristic, bytes: ByteArray, fromRead: Boolean = false) {
        val s = String(bytes, Charsets.UTF_8)
        val o = try { JSONObject(s) } catch (e: Exception) { if (!fromRead) g.readCharacteristic(ch); return }
        if (o.has("status")) { status("목걸이 연결됨 · GPS 위치를 기다리는 중 (밖이나 창가)"); return }
        val lat = o.optDouble("latitude", Double.NaN); val lng = o.optDouble("longitude", Double.NaN)
        if (lat.isNaN() || lng.isNaN() || lat !in -90.0..90.0 || lng !in -180.0..180.0 || !o.has("fix_age_ms")) return
        val now = SimpleDateFormat("HH:mm:ss", Locale.KOREA).format(Date())
        Store.last(this, "%.5f, %.5f (%s 받음)".format(lat, lng, now))
        status("목걸이 연결됨 · 위치 보내는 중")
        io.execute { enqueue(o.toString()); flush() }
    }

    // ---------------------------------------------------------------- 서버로 보내기 (파일 대기열)
    private fun enqueue(line: String) {
        val lines = if (queueFile.exists()) queueFile.readLines().toMutableList() else mutableListOf()
        lines += line
        queueFile.writeText(lines.takeLast(MAX_QUEUE).joinToString("\n") + "\n")
    }
    private fun flushLater(ms: Long) { main.postDelayed({ io.execute { flush() } }, ms) }
    private fun flush() {
        val key = Store.key(this) ?: return
        if (!queueFile.exists()) { Store.pending(this, 0); return }
        val lines = queueFile.readLines().filter { it.isNotBlank() }.toMutableList()
        while (lines.isNotEmpty()) {
            val code = try { post(key, JSONObject(lines[0])) } catch (e: Exception) { -1 }
            when {
                code in 200..299 -> lines.removeAt(0)
                code == 400 || code == 422 -> lines.removeAt(0)          // 잘못된 데이터는 다시 보내지 않음
                code == 410 -> {                                          // 보호자가 연결 코드를 폐기함 → 더 보내지 않고 멈춤(새 코드를 넣고 [시작]하면 다시 동작)
                    if (Store.key(this) != key) {                          // 보내는 사이 새 코드를 넣었다 — 폐기된 건 이전 코드. 멈추지 말고 새 코드로 남은 것을 다시 보낸다
                        queueFile.writeText(lines.joinToString("\n") + "\n"); Store.pending(this, lines.size)
                        if (running) flushLater(0); return
                    }
                    queueFile.writeText(""); Store.pending(this, 0)
                    Store.status(this, REVOKED_TEXT)
                    alert(REVOKED_TEXT)                                    // 멈추면 진행 중 알림도 사라지니, 어르신이 볼 수 있게 따로 남긴다
                    running = false; stopSelf(); return                    // 파일·상태를 먼저 정리한 뒤 멈춤 (running=false로 재전송 예약도 막음)
                }
                else -> { queueFile.writeText(lines.joinToString("\n") + "\n"); Store.pending(this, lines.size); if (running) flushLater(15000); return }
            }
        }
        queueFile.writeText(""); Store.pending(this, 0)
    }
    private fun post(key: String, p: JSONObject): Int {
        val c = URL(ENDPOINT).openConnection() as HttpURLConnection
        c.requestMethod = "POST"; c.connectTimeout = 10000; c.readTimeout = 10000; c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        c.outputStream.use { it.write(JSONObject().put("action", "push").put("key", key).put("p", p).toString().toByteArray()) }
        val code = c.responseCode
        c.disconnect()
        return code
    }
}
