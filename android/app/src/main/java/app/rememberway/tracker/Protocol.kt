package app.rememberway.tracker

/** 위치 특성의 짧은 알림: "GPS:21"(새 위치가 있으니 READ 하라), "GPS:WAITING"(좌표 없음). hardware/README.md 의 블루투스 약속 */
sealed class LocationSignal {
    object Waiting : LocationSignal()
    data class NewData(val sequence: Long) : LocationSignal()
    /** 신호 형식이 아님 — 알림에 JSON이 직접 온(또는 잘려서 온) 경우 */
    object Other : LocationSignal()

    companion object {
        private val NEW_DATA = Regex("""^GPS:(\d{1,18})$""")

        fun parse(text: String): LocationSignal {
            val t = text.trim()
            if (t == "GPS:WAITING") return Waiting
            NEW_DATA.matchEntire(t)?.let { return NewData(it.groupValues[1].toLong()) }
            return Other
        }
    }
}

/** 부저 특성에 쓰는 글자와 목걸이의 대답 */
object BuzzerProtocol {
    const val ON = "BUZZER_ON"
    const val OFF = "BUZZER_OFF"
    const val FIND = "BUZZER_FIND"
    val COMMANDS = setOf(ON, OFF, FIND)

    data class Result(val accepted: Boolean, val response: String?, val reason: String?)

    fun expectedAck(command: String): String? = when (command) {
        ON -> "ACK_ON"
        OFF -> "ACK_OFF"
        FIND -> "ACK_FIND"
        else -> null
    }

    /**
     * 쓰기(WRITE)가 성공한 것과 목걸이가 받아들인 것은 다르다. 기대한 ACK 글자를 확인했을 때만 accepted.
     * (ACK 는 "소리를 내기 시작했다"는 목걸이의 대답일 뿐, 실제로 소리가 났다는 증거는 아니다.)
     */
    fun evaluate(command: String, response: String?): Result {
        val r = response?.trim()
        return when {
            r.isNullOrEmpty() -> Result(false, null, "ack_missing")
            r == expectedAck(command) -> Result(true, r, null)
            r.startsWith("ERR_") -> Result(false, r, r.lowercase())
            r == "READY" -> Result(false, r, "ack_missing")   // 연결 직후의 상태 값 — ACK 가 아니다
            else -> Result(false, r, "unexpected_response")
        }
    }

    fun failure(reason: String) = Result(false, null, reason)
}
