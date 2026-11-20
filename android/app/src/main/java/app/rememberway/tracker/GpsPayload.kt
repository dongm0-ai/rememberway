package app.rememberway.tracker

import org.json.JSONException
import org.json.JSONObject
import java.time.Instant

/** 명세서 4.3 위치 JSON (8개 필드). speedKmh / gpsTime 은 키가 없으면 null. */
data class GpsPayload(
    val deviceId: String,
    val latitude: Double,
    val longitude: Double,
    val fixAgeMs: Long,
    val speedKmh: Double?,
    val gpsTime: String?,
    val sequence: Long,
    val firmwareVersion: String,
) {
    /** 앱 내부 중복 판정용 (명세서 5.4: device_id + gps_time + sequence) */
    val contentKey: String get() = "$deviceId:${gpsTime ?: "-"}:$sequence"
}

sealed class ParseResult {
    data class Location(val payload: GpsPayload, val rawJson: String) : ParseResult()
    data class Status(val status: String) : ParseResult()
    data class Invalid(val reason: String) : ParseResult()
}

object GpsPayloadParser {
    private val GPS_TIME_REGEX = Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$""")

    fun parse(bytes: ByteArray): ParseResult = parse(String(bytes, Charsets.UTF_8))

    fun parse(text: String): ParseResult {
        val trimmed = text.trim()
        val obj = try {
            JSONObject(trimmed)
        } catch (e: JSONException) {
            return ParseResult.Invalid("JSON 파싱 실패(잘림 가능, ${trimmed.length}자)")
        }

        // {"status":"waiting"}: 좌표가 아니므로 서버 위치 API에 올리지 않는다 (0,0 생성 금지)
        if (obj.has("status") && !obj.has("latitude")) {
            return ParseResult.Status(obj.optString("status"))
        }

        return try {
            val p = GpsPayload(
                deviceId = requireString(obj, "device_id", maxLen = 64),
                latitude = requireNumber(obj, "latitude").also {
                    if (it !in -90.0..90.0) throw IllegalArgumentException("latitude 범위 초과")
                },
                longitude = requireNumber(obj, "longitude").also {
                    if (it !in -180.0..180.0) throw IllegalArgumentException("longitude 범위 초과")
                },
                fixAgeMs = requireInteger(obj, "fix_age_ms").also {
                    if (it < 0) throw IllegalArgumentException("fix_age_ms 음수")
                },
                speedKmh = if (obj.has("speed_kmh")) requireNumber(obj, "speed_kmh").also {
                    if (it < 0) throw IllegalArgumentException("speed_kmh 음수")
                } else null,
                gpsTime = if (obj.has("gps_time")) requireString(obj, "gps_time", 40).also {
                    if (!GPS_TIME_REGEX.matches(it)) throw IllegalArgumentException("gps_time 형식 오류")
                    try { Instant.parse(it) } catch (e: Exception) {
                        throw IllegalArgumentException("gps_time 날짜 오류")
                    }
                } else null,
                sequence = requireInteger(obj, "sequence").also {
                    if (it < 0) throw IllegalArgumentException("sequence 음수")
                },
                firmwareVersion = requireString(obj, "firmware_version", maxLen = 32),
            )
            ParseResult.Location(p, trimmed)
        } catch (e: IllegalArgumentException) {
            ParseResult.Invalid(e.message ?: "검증 실패")
        }
    }

    private fun requireString(o: JSONObject, key: String, maxLen: Int): String {
        val v = o.opt(key) as? String ?: throw IllegalArgumentException("$key 누락/타입 오류")
        if (v.isBlank() || v.length > maxLen) throw IllegalArgumentException("$key 길이 오류")
        return v
    }

    private fun requireNumber(o: JSONObject, key: String): Double {
        val v = o.opt(key) as? Number ?: throw IllegalArgumentException("$key 누락/타입 오류")
        val d = v.toDouble()
        if (d.isNaN() || d.isInfinite()) throw IllegalArgumentException("$key 값 오류")
        return d
    }

    private fun requireInteger(o: JSONObject, key: String): Long {
        val v = o.opt(key)
        return when (v) {
            is Int -> v.toLong()
            is Long -> v
            else -> throw IllegalArgumentException("$key 누락/정수 아님")
        }
    }
}
