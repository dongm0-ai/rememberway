package app.rememberway.tracker

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import java.util.UUID

/**
 * 목걸이(추적기)와의 블루투스 연결. UUID·글자 약속은 hardware/README.md "블루투스 약속"과 같다.
 *
 * - 연동해 둔 목걸이(블루투스 주소)만 찾아서 연결한다.
 * - 위치: 짧은 알림("GPS:21")을 받으면 위치 특성을 READ 해서 전체 JSON을 가져온다.
 *   알림에 JSON이 직접 오면 그대로 쓰고, 잘려 있으면 READ 로 다시 읽는다.
 * - 부저: 알림을 먼저 켜 둔 뒤 WRITE(응답 있는 쓰기) → ACK(알림, 없으면 READ)를 확인한다.
 * - 모든 GATT 작업은 한 줄로 세워 하나씩 한다 (앞 작업의 콜백이 온 뒤에 다음 작업).
 * - 끊기면 2→5→10→30초 간격으로 다시 찾는다.
 *
 * 상태는 전부 메인 스레드 한 곳에서만 다룬다. GATT 콜백도 같은 핸들러로 받는다.
 * 권한 확인은 부르는 쪽(TrackerService)에서 한다.
 */
@SuppressLint("MissingPermission")
class TrackerBleClient(
    private val context: Context,
    private val targetAddress: String,
    private val listener: Listener,
) {
    interface Listener {
        fun onLocationData(result: ParseResult)
        fun onStateChanged(state: State, detail: String)
    }

    enum class State { STOPPED, BLUETOOTH_OFF, SCANNING, CONNECTING, DISCOVERING, SUBSCRIBING, READY, BACKOFF }

    companion object {
        const val NAME_PREFIX = "GPS-TRACKER"
        val SERVICE_UUID: UUID = UUID.fromString("a73e0001-1e4d-4a5b-9c3d-120000000001")
        val LOCATION_UUID: UUID = UUID.fromString("a73e0002-1e4d-4a5b-9c3d-120000000001")
        val BUZZER_UUID: UUID = UUID.fromString("a73e0003-1e4d-4a5b-9c3d-120000000001")
        val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        private const val REQUEST_MTU = 247
        private const val SCAN_WINDOW_MS = 20_000L
        private const val CONNECT_TIMEOUT_MS = 15_000L
        private const val OP_TIMEOUT_MS = 10_000L
        private const val ACK_WAIT_MS = 3_000L
        private val BACKOFF_MS = longArrayOf(2_000, 5_000, 10_000, 30_000)
    }

    private sealed class Op {
        object RequestMtu : Op()
        object Discover : Op()
        class EnableNotify(val ch: BluetoothGattCharacteristic) : Op()
        object MarkReady : Op()
        object ReadLocation : Op()
        class Buzzer(val command: String, val callback: (BuzzerProtocol.Result) -> Unit) : Op() {
            var readingAck = false
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    private val adapter = manager.adapter

    private var gatt: BluetoothGatt? = null
    private var locationChar: BluetoothGattCharacteristic? = null
    private var buzzerChar: BluetoothGattCharacteristic? = null

    @Volatile private var state = State.STOPPED
    private var stopped = true
    private var scanning = false
    private var backoffIndex = 0

    private val queue = ArrayDeque<Op>()
    private var current: Op? = null
    private var locationReadDirty = false

    val isReady: Boolean get() = state == State.READY

    // ───────────── 공개 API (어느 스레드에서 불러도 됨) ─────────────

    fun start() = runOnMain {
        if (stopped) {
            stopped = false
            backoffIndex = 0
            startScan()
        }
    }

    fun stop() = runOnMain {
        stopped = true
        handler.removeCallbacks(scanTimeout)
        handler.removeCallbacks(reconnectRunnable)
        stopScan()
        closeGatt("ble_disconnected")
        setState(State.STOPPED, "멈춤")
    }

    private fun runOnMain(block: () -> Unit) {
        handler.post(block)
    }

    /** 부저 명령 전송. 결과 콜백은 메인 스레드에서 정확히 한 번 호출된다. */
    fun sendBuzzer(command: String, callback: (BuzzerProtocol.Result) -> Unit) = runOnMain {
        when {
            command !in BuzzerProtocol.COMMANDS -> callback(BuzzerProtocol.failure("unknown_command"))
            state != State.READY || gatt == null -> callback(BuzzerProtocol.failure("ble_disconnected"))
            buzzerChar == null -> callback(BuzzerProtocol.failure("buzzer_characteristic_missing"))
            else -> {
                val op = Op.Buzzer(command, callback)
                // 정지 명령은 대기 중인 위치 READ보다 먼저 처리한다. 진행 중인 작업은 끊지 않는다.
                if (command == BuzzerProtocol.OFF) queue.addFirst(op) else queue.addLast(op)
                pump()
            }
        }
    }

    // ───────────── 스캔 / 재연결 ─────────────

    private fun startScan() {
        if (stopped || scanning || gatt != null) return
        if (adapter == null || !adapter.isEnabled) {
            setState(State.BLUETOOTH_OFF, "블루투스를 켜 주세요")
            scheduleReconnect()
            return
        }
        // 이 휴대폰의 다른 앱이 이미 목걸이에 연결해 두었으면 목걸이는 검색 신호를 내보내지 않는다 → 찾지 말고 바로 붙는다
        val already = try {
            manager.getConnectedDevices(BluetoothProfile.GATT).firstOrNull { it.address.equals(targetAddress, ignoreCase = true) }
        } catch (e: Exception) { null }
        if (already != null) {
            TrackerState.log("목걸이가 이미 이 휴대폰과 연결돼 있어요")
            connect(already)
            return
        }
        val scanner = adapter.bluetoothLeScanner ?: run { scheduleReconnect(); return }
        // 연동해 둔 목걸이만 찾는다 (필터가 있어야 화면이 꺼진 동안에도 검색 결과가 온다)
        val filters = try {
            listOf(ScanFilter.Builder().setDeviceAddress(targetAddress).build())
        } catch (e: IllegalArgumentException) {
            setState(State.STOPPED, "목걸이를 다시 골라 주세요")
            stopped = true
            return
        }
        val scanSettings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build()
        try {
            scanner.startScan(filters, scanSettings, scanCallback)
        } catch (e: Exception) {
            TrackerState.log("스캔 시작 실패: ${e.javaClass.simpleName}")
            scheduleReconnect()
            return
        }
        scanning = true
        setState(State.SCANNING, "목걸이를 찾는 중")
        handler.postDelayed(scanTimeout, SCAN_WINDOW_MS)
    }

    private fun connect(device: BluetoothDevice) {
        setState(State.CONNECTING, "목걸이에 연결 중")
        gatt = device.connectGatt(
            context, false, gattCallback,
            BluetoothDevice.TRANSPORT_LE, BluetoothDevice.PHY_LE_1M_MASK, handler,
        )
        handler.postDelayed(connectTimeout, CONNECT_TIMEOUT_MS)
    }

    private fun stopScan() {
        if (!scanning) return
        scanning = false
        try { adapter?.bluetoothLeScanner?.stopScan(scanCallback) } catch (_: Exception) {}
    }

    private val scanTimeout = Runnable {
        if (scanning) {
            stopScan()
            scheduleReconnect("목걸이가 근처에 없어요")
        }
    }

    private val reconnectRunnable = Runnable { startScan() }

    private fun scheduleReconnect(why: String? = null) {
        if (stopped) return
        val delay = BACKOFF_MS[minOf(backoffIndex, BACKOFF_MS.size - 1)]
        backoffIndex++
        val prefix = if (why != null) "$why — " else ""
        if (state != State.BLUETOOTH_OFF) setState(State.BACKOFF, "$prefix${delay / 1000}초 뒤 다시 찾아요")
        handler.removeCallbacks(reconnectRunnable)
        handler.postDelayed(reconnectRunnable, delay)
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            if (!scanning || stopped) return
            val device = result.device
            if (!device.address.equals(targetAddress, ignoreCase = true)) return
            stopScan()
            handler.removeCallbacks(scanTimeout)
            TrackerState.log("목걸이 신호를 찾음 (세기 ${result.rssi})")
            connect(device)
        }

        override fun onScanFailed(errorCode: Int) {
            scanning = false
            handler.removeCallbacks(scanTimeout)
            TrackerState.log("스캔 실패 코드 $errorCode")
            scheduleReconnect("블루투스 검색 실패")
        }
    }

    private val connectTimeout = Runnable {
        if (state == State.CONNECTING) teardownAndReconnect("목걸이에 연결하지 못했어요")
    }

    // ───────────── GATT 작업 큐 ─────────────

    private fun enqueue(op: Op) {
        queue.addLast(op)
        pump()
    }

    private fun pump() {
        while (current == null) {
            val op = queue.removeFirstOrNull() ?: return
            val g = gatt
            if (g == null) {
                failOp(op, "ble_disconnected")
                continue
            }
            if (op is Op.MarkReady) {
                backoffIndex = 0
                setState(State.READY, if (buzzerChar != null) "목걸이 연결됨" else "목걸이 연결됨 (소리 기능이 없는 버전)")
                continue
            }
            current = op
            if (execute(g, op)) {
                handler.postDelayed(opTimeout, OP_TIMEOUT_MS)
            } else {
                current = null
                failOp(op, "gatt_request_rejected")
            }
        }
    }

    private fun execute(g: BluetoothGatt, op: Op): Boolean = when (op) {
        is Op.RequestMtu -> g.requestMtu(REQUEST_MTU)
        is Op.Discover -> g.discoverServices()
        is Op.EnableNotify -> {
            g.setCharacteristicNotification(op.ch, true)
            val cccd = op.ch.getDescriptor(CCCD_UUID)
            if (cccd == null) false else writeDescriptorCompat(g, cccd)
        }
        is Op.ReadLocation -> locationChar?.let { g.readCharacteristic(it) } ?: false
        is Op.Buzzer -> buzzerChar?.let {
            writeCharacteristicCompat(g, it, op.command.toByteArray(Charsets.UTF_8))
        } ?: false
        is Op.MarkReady -> true
    }

    private fun finishCurrent() {
        handler.removeCallbacks(opTimeout)
        handler.removeCallbacks(ackTimeout)
        current = null
        pump()
    }

    private fun failOp(op: Op, reason: String) {
        when (op) {
            is Op.Buzzer -> op.callback(BuzzerProtocol.failure(reason))
            is Op.Discover -> { TrackerState.log("서비스 탐색 요청 실패"); teardownAndReconnect("GATT 오류") }
            is Op.EnableNotify -> TrackerState.log("Notify 구독 실패 (${op.ch.uuid.toString().take(8)})")
            is Op.ReadLocation -> TrackerState.log("위치 READ 실패 — 다음 알림에서 재시도")
            else -> {}
        }
    }

    private val opTimeout = Runnable {
        val op = current ?: return@Runnable
        TrackerState.log("GATT 응답 없음 — 재연결")
        current = null
        handler.removeCallbacks(ackTimeout)
        if (op is Op.Buzzer) op.callback(BuzzerProtocol.failure("gatt_timeout"))
        teardownAndReconnect("목걸이가 대답하지 않아요")
    }

    /** 부저 WRITE 후 ACK Notify가 없으면 READ로 한 번 확인한다. */
    private val ackTimeout = Runnable {
        val op = current as? Op.Buzzer ?: return@Runnable
        val g = gatt
        val ch = buzzerChar
        op.readingAck = true
        if (g == null || ch == null || !g.readCharacteristic(ch)) {
            resolveBuzzer(op, BuzzerProtocol.failure("ack_missing"))
        }
    }

    private fun resolveBuzzer(op: Op.Buzzer, result: BuzzerProtocol.Result) {
        if (current !== op) return
        op.callback(result)
        finishCurrent()
    }

    // ───────────── 연결 정리 ─────────────

    private fun closeGatt(pendingReason: String) {
        handler.removeCallbacks(opTimeout)
        handler.removeCallbacks(ackTimeout)
        handler.removeCallbacks(connectTimeout)
        val pending = listOfNotNull(current) + queue
        current = null
        queue.clear()
        locationReadDirty = false
        gatt?.let {
            try { it.disconnect() } catch (_: Exception) {}
            try { it.close() } catch (_: Exception) {}
        }
        gatt = null
        locationChar = null
        buzzerChar = null
        pending.filterIsInstance<Op.Buzzer>().forEach { it.callback(BuzzerProtocol.failure(pendingReason)) }
    }

    private fun teardownAndReconnect(why: String) {
        val wasConnected = gatt != null
        closeGatt("ble_disconnected")
        if (wasConnected) TrackerState.update { it.copy(reconnects = it.reconnects + 1) }
        scheduleReconnect(why)
    }

    // ───────────── GATT 콜백 (handler 스레드) ─────────────

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (g !== gatt) { try { g.close() } catch (_: Exception) {}; return }
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                handler.removeCallbacks(connectTimeout)
                setState(State.DISCOVERING, "목걸이와 연결하는 중")
                enqueue(Op.RequestMtu)
                enqueue(Op.Discover)
            } else {
                teardownAndReconnect("목걸이와 연결이 끊겼어요")
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            if (g !== gatt) return
           if (current is Op.RequestMtu) finishCurrent()
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (g !== gatt || current !is Op.Discover) return
            val service = if (status == BluetoothGatt.GATT_SUCCESS) g.getService(SERVICE_UUID) else null
            val loc = service?.getCharacteristic(LOCATION_UUID)
            if (loc == null) {
                TrackerState.log("이 목걸이에는 위치 기능이 없어요 (펌웨어 확인)")
                teardownAndReconnect("목걸이 버전이 맞지 않아요")
                return
            }
            locationChar = loc
            buzzerChar = service?.getCharacteristic(BUZZER_UUID)
            if (buzzerChar == null) TrackerState.log("이 목걸이에는 소리 기능이 없어요 — 위치만 받아요")
            setState(State.SUBSCRIBING, "목걸이와 연결하는 중")
            // 부저 ACK 유실 방지: Notify 구독을 먼저 끝낸 뒤 READY (명세서 4.4)
            queue.addLast(Op.EnableNotify(loc))
            buzzerChar?.let { queue.addLast(Op.EnableNotify(it)) }
            queue.addLast(Op.MarkReady)
            queue.addLast(Op.ReadLocation) // 연결 직후 1회 READ
            finishCurrent()
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            if (g !== gatt) return
            val op = current as? Op.EnableNotify ?: return
            if (status != BluetoothGatt.GATT_SUCCESS) failOp(op, "cccd_write_failed")
            finishCurrent()
        }

        // API 33+
        override fun onCharacteristicRead(
            g: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray, status: Int,
        ) = onRead(g, ch.uuid, value, status)

        @Deprecated("API 33 미만 호환")
        override fun onCharacteristicRead(g: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
            if (Build.VERSION.SDK_INT >= 33) return
            @Suppress("DEPRECATION")
            onRead(g, ch.uuid, ch.value ?: ByteArray(0), status)
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
            if (g !== gatt) return
            val op = current as? Op.Buzzer ?: return
            if (status != BluetoothGatt.GATT_SUCCESS) {
                resolveBuzzer(op, BuzzerProtocol.failure("ble_write_failed"))
            } else {
                // Write 성공 ≠ 기기 수락. ACK를 기다린다.
                handler.postDelayed(ackTimeout, ACK_WAIT_MS)
            }
        }

        // API 33+
        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray) =
            onNotify(g, ch.uuid, value)

        @Deprecated("API 33 미만 호환")
        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT >= 33) return
            @Suppress("DEPRECATION")
            onNotify(g, ch.uuid, ch.value ?: return)
        }
    }

    private fun onRead(g: BluetoothGatt, uuid: UUID, value: ByteArray, status: Int) {
        if (g !== gatt) return
        val ok = status == BluetoothGatt.GATT_SUCCESS
        when (uuid) {
            LOCATION_UUID -> {
                val op = current as? Op.ReadLocation ?: return
                if (ok) listener.onLocationData(GpsPayloadParser.parse(value)) else failOp(op, "read_failed")
                finishCurrent()
                if (locationReadDirty) {
                    locationReadDirty = false
                    requestLocationRead()
                }
            }
            BUZZER_UUID -> {
                val op = current as? Op.Buzzer ?: return
                if (!op.readingAck) return
                val text = if (ok) String(value, Charsets.UTF_8) else null
                resolveBuzzer(op, BuzzerProtocol.evaluate(op.command, text))
            }
        }
    }

    private fun onNotify(g: BluetoothGatt, uuid: UUID, value: ByteArray) {
        if (g !== gatt) return
        when (uuid) {
            LOCATION_UUID -> {
                val text = String(value, Charsets.UTF_8)
                when (LocationSignal.parse(text)) {
                    is LocationSignal.Waiting -> listener.onLocationData(ParseResult.Status("waiting"))
                    is LocationSignal.NewData -> requestLocationRead()
                    is LocationSignal.Other -> when (val r = GpsPayloadParser.parse(text)) {
                        // 20바이트로 잘린 Notify 등: 전체 값은 READ로 가져온다
                        is ParseResult.Invalid -> requestLocationRead()
                        else -> listener.onLocationData(r)
                    }
                }
            }
            BUZZER_UUID -> {
                val text = String(value, Charsets.UTF_8).trim()
                val op = current as? Op.Buzzer
                // READ 확인이 이미 나간 뒤라면 그 응답을 기다린다(GATT 작업 중첩 방지)
                if (op != null && !op.readingAck) {
                    resolveBuzzer(op, BuzzerProtocol.evaluate(op.command, text))
                }
            }
        }
    }

    /** READ 중에 알림이 또 오면 동시에 읽지 않고 표시만 해 두었다가 끝난 뒤 한 번 더 읽는다. */
    private fun requestLocationRead() {
        if (current is Op.ReadLocation) {
            locationReadDirty = true
            return
        }
        if (queue.any { it is Op.ReadLocation }) return
        enqueue(Op.ReadLocation)
    }

    // ───────────── API 레벨 호환 ─────────────

    private fun writeDescriptorCompat(g: BluetoothGatt, d: BluetoothGattDescriptor): Boolean {
        val value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        return if (Build.VERSION.SDK_INT >= 33) {
            g.writeDescriptor(d, value) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            d.value = value
            @Suppress("DEPRECATION")
            g.writeDescriptor(d)
        }
    }

    private fun writeCharacteristicCompat(g: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray): Boolean {
        val type = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT // write with response
        return if (Build.VERSION.SDK_INT >= 33) {
            g.writeCharacteristic(ch, value, type) == BluetoothStatusCodes.SUCCESS
        } else {
            ch.writeType = type
            @Suppress("DEPRECATION")
            ch.value = value
            @Suppress("DEPRECATION")
            g.writeCharacteristic(ch)
        }
    }

    private fun setState(s: State, detail: String) {
        state = s
        listener.onStateChanged(s, detail)
    }
}
