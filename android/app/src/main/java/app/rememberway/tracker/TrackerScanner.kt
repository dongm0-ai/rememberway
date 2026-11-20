package app.rememberway.tracker

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid

/**
 * 목걸이 연동용 검색: 화면이 켜져 있는 동안 주변 목걸이를 잠깐(8초) 찾아 목록으로 돌려준다.
 * 우리 서비스 UUID 를 내보내거나 이름이 GPS-TRACKER 로 시작하는 기기만 고른다.
 * 권한 확인은 부르는 쪽(MainActivity)에서 한다.
 */
@SuppressLint("MissingPermission")
class TrackerScanner(context: Context) {
    /** connected = 이 휴대폰의 다른 앱이 이미 연결해 둔 목걸이 (연결돼 있는 동안에는 검색 신호를 내보내지 않아 검색으로는 안 잡힌다) */
    data class Found(val address: String, val name: String, val rssi: Int, val connected: Boolean = false)

    private val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    private val adapter = manager.adapter
    private val handler = Handler(Looper.getMainLooper())
    private val found = LinkedHashMap<String, Found>()
    private var callback: ScanCallback? = null

    val isScanning: Boolean get() = callback != null

    /** onUpdate: 찾을 때마다(신호 센 순). onDone: 끝났을 때. 블루투스가 꺼져 있으면 false */
    fun start(onUpdate: (List<Found>) -> Unit, onDone: (List<Found>) -> Unit): Boolean {
        stop()
        val scanner = adapter?.takeIf { it.isEnabled }?.bluetoothLeScanner ?: return false
        found.clear()
        // 다른 앱이 이미 연결해 둔 목걸이는 검색에 안 잡히므로 따로 넣는다
        try {
            for (d in manager.getConnectedDevices(BluetoothProfile.GATT)) {
                val name = d.name ?: ""
                if (name.startsWith(TrackerBleClient.NAME_PREFIX)) found[d.address] = Found(d.address, name, 0, connected = true)
            }
        } catch (_: Exception) {}
        if (found.isNotEmpty()) onUpdate(sorted())
        val service = ParcelUuid(TrackerBleClient.SERVICE_UUID)
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val record = result.scanRecord
                val name = record?.deviceName ?: ""
                val ours = record?.serviceUuids?.contains(service) == true || name.startsWith(TrackerBleClient.NAME_PREFIX)
                if (!ours) return
                found[result.device.address] = Found(result.device.address, name.ifEmpty { "이름 없는 목걸이" }, result.rssi)
                onUpdate(sorted())
            }

            override fun onScanFailed(errorCode: Int) {
                finish(onDone)
            }
        }
        return try {
            scanner.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), cb)
            callback = cb
            handler.postDelayed({ if (callback === cb) finish(onDone) }, SCAN_MS)
            true
        } catch (e: Exception) {
            false
        }
    }

    fun stop() {
        val cb = callback ?: return
        callback = null
        handler.removeCallbacksAndMessages(null)
        try { adapter?.bluetoothLeScanner?.stopScan(cb) } catch (_: Exception) {}
    }

    private fun finish(onDone: (List<Found>) -> Unit) {
        stop()
        onDone(sorted())
    }

    private fun sorted() = found.values.sortedWith(compareByDescending<Found> { it.connected }.thenByDescending { it.rssi })

    companion object {
        const val SCAN_MS = 8_000L
    }
}
