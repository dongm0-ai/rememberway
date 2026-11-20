package app.rememberway.tracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GpsPayloadParserTest {
    private val sample = """{"device_id":"tracker-001","latitude":37.566500,"longitude":126.978000,"fix_age_ms":607,"speed_kmh":0.31,"gps_time":"2026-11-20T04:03:51Z","sequence":21,"firmware_version":"1.0.0"}"""

    @Test fun parsesSpecSample() {
        val r = GpsPayloadParser.parse(sample)
        assertTrue(r is ParseResult.Location)
        val p = (r as ParseResult.Location).payload
        assertEquals("tracker-001", p.deviceId)
        assertEquals(37.5665, p.latitude, 1e-9)
        assertEquals(607L, p.fixAgeMs)
        assertEquals(21L, p.sequence)
        assertEquals("tracker-001:2026-11-20T04:03:51Z:21", p.contentKey)
    }

    @Test fun optionalFieldsMayBeOmitted() {
        val r = GpsPayloadParser.parse("""{"device_id":"tracker-001","latitude":1.0,"longitude":2.0,"fix_age_ms":0,"sequence":5,"firmware_version":"1.0.0"}""")
        val p = (r as ParseResult.Location).payload
        assertNull(p.speedKmh)
        assertNull(p.gpsTime)
    }

    @Test fun waitingIsStatusNotLocation() {
        assertTrue(GpsPayloadParser.parse("""{"status":"waiting"}""") is ParseResult.Status)
    }

    @Test fun truncatedJsonIsInvalid() {
        // 기본 MTU 23 → Notify로 20바이트만 도착한 경우
        assertTrue(GpsPayloadParser.parse(sample.take(20)) is ParseResult.Invalid)
    }

    @Test fun coordinateRangeEnforced() {
        assertTrue(GpsPayloadParser.parse(sample.replace("37.566500", "91.0")) is ParseResult.Invalid)
        assertTrue(GpsPayloadParser.parse(sample.replace("126.978000", "-181")) is ParseResult.Invalid)
    }

    @Test fun fixAgeOnlyNeedsToBeNonNegative() {
        assertTrue(GpsPayloadParser.parse(sample.replace("\"fix_age_ms\":607", "\"fix_age_ms\":45000")) is ParseResult.Location)
        assertTrue(GpsPayloadParser.parse(sample.replace("\"fix_age_ms\":607", "\"fix_age_ms\":-1")) is ParseResult.Invalid)
    }

    @Test fun missingRequiredRejected() {
        assertTrue(GpsPayloadParser.parse(sample.replace("\"sequence\":21,", "")) is ParseResult.Invalid)
    }

    @Test fun badGpsTimeRejected() {
        assertTrue(GpsPayloadParser.parse(sample.replace("04:03:51Z", "04:03:51")) is ParseResult.Invalid)
        assertTrue(GpsPayloadParser.parse(sample.replace("2026-11-20T", "2026-13-40T")) is ParseResult.Invalid)
    }
}
