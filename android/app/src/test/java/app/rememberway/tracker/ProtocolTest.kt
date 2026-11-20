package app.rememberway.tracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolTest {
    private val sample = """{"device_id":"tracker-001","latitude":37.5665,"longitude":126.978,"fix_age_ms":607,"gps_time":"2026-11-20T04:03:51Z","sequence":21,"firmware_version":"1.0.0"}"""

    // ── 위치 알림 신호 ──

    @Test fun shortNotifySignals() {
        assertEquals(LocationSignal.NewData(21), LocationSignal.parse("GPS:21"))
        assertEquals(LocationSignal.NewData(0), LocationSignal.parse("GPS:0\n"))
        assertTrue(LocationSignal.parse("GPS:WAITING") is LocationSignal.Waiting)
    }

    @Test fun jsonOrGarbageIsNotASignal() {
        assertTrue(LocationSignal.parse(sample) is LocationSignal.Other)
        assertTrue(LocationSignal.parse(sample.take(20)) is LocationSignal.Other)
        assertTrue(LocationSignal.parse("GPS:") is LocationSignal.Other)
        assertTrue(LocationSignal.parse("GPS:abc") is LocationSignal.Other)
    }

    // ── 부저 ACK 판정 ──

    @Test fun matchingAckIsAccepted() {
        assertTrue(BuzzerProtocol.evaluate("BUZZER_FIND", "ACK_FIND").accepted)
        assertTrue(BuzzerProtocol.evaluate("BUZZER_ON", "ACK_ON\n").accepted)
        assertTrue(BuzzerProtocol.evaluate("BUZZER_OFF", "ACK_OFF").accepted)
    }

    @Test fun writeWithoutAckIsNotAccepted() {
        val none = BuzzerProtocol.evaluate("BUZZER_FIND", null)
        assertFalse(none.accepted)
        assertEquals("ack_missing", none.reason)
        // 연결 직후 상태값 READY 를 ACK 로 잘못 보지 않는다
        assertEquals("ack_missing", BuzzerProtocol.evaluate("BUZZER_FIND", "READY").reason)
    }

    @Test fun wrongOrErrorResponseIsFailure() {
        assertEquals("unexpected_response", BuzzerProtocol.evaluate("BUZZER_FIND", "ACK_OFF").reason)
        assertEquals("err_command", BuzzerProtocol.evaluate("BUZZER_FIND", "ERR_COMMAND").reason)
        assertEquals("err_pwm", BuzzerProtocol.evaluate("BUZZER_ON", "ERR_PWM").reason)
    }
}
