package app.rememberway.tracker

import android.content.Context

/** 이 휴대폰 안에만 두는 설정: 보호자 연결 코드, 연동한 목걸이, 마지막으로 받은 위치 */
class AppSettings(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("rw", Context.MODE_PRIVATE)

    /** 보호자 웹앱이 만든 연결 코드 16글자 (A-Z, 2-7). Android Keystore 키로 암호화해 둔다. 없으면 "" */
    var key: String
        get() {
            cachedKey?.let { return it }
            // 0.1 판은 암호화 없이 "key" 에 두었다 → 암호화본으로 옮긴다
            prefs.getString("key", null)?.let { legacy ->
                key = legacy
                return legacy
            }
            val enc = prefs.getString("key_enc", null) ?: return ""
            return (TokenCrypto.decrypt(enc) ?: "").also { cachedKey = it }
        }
        set(v) {
            val k = cleanKey(v)
            val e = prefs.edit().remove("key")
            val enc = if (k.isEmpty()) null else try { TokenCrypto.encrypt(k) } catch (ex: Exception) { null }
            if (enc != null) e.putString("key_enc", enc) else e.remove("key_enc")
            e.apply()
            cachedKey = k
        }

    val hasKey: Boolean get() = key.length == KEY_LENGTH

    /** 연동한 목걸이의 블루투스 주소. 이 휴대폰 밖으로 보내지 않는다(서버에는 이름과 펌웨어 id 만 알린다). */
    val trackerAddress: String get() = prefs.getString("tracker_address", "") ?: ""
    val trackerName: String get() = prefs.getString("tracker_name", "") ?: ""
    val hasTracker: Boolean get() = trackerAddress.isNotEmpty()

    fun setTracker(address: String, name: String) {
        // 다른 목걸이로 바꾸면 이전 목걸이의 마지막 위치는 더 이상 "이전 위치"가 아니다
        if (address != trackerAddress) prefs.edit().remove("last_location_json").remove("last_location_at").apply()
        prefs.edit().putString("tracker_address", address).putString("tracker_name", name).apply()
    }

    /** 마지막으로 받은 유효 위치. 앱을 다시 켜도 "이전 위치"로 보여 줄 수 있게 저장한다. */
    fun saveLastLocation(rawJson: String, receivedAtMs: Long) {
        prefs.edit().putString("last_location_json", rawJson).putLong("last_location_at", receivedAtMs).apply()
    }

    fun loadLastLocation(): Pair<GpsPayload, Long>? {
        val json = prefs.getString("last_location_json", null) ?: return null
        val loc = GpsPayloadParser.parse(json) as? ParseResult.Location ?: return null
        return loc.payload to prefs.getLong("last_location_at", 0L)
    }

    companion object {
        const val KEY_LENGTH = 16
        /** 프로세스 안에서 함께 쓰는 사본 (AppSettings 를 여러 번 만들어도 같은 값) */
        @Volatile private var cachedKey: String? = null

        /** 사용자가 넣은 글자에서 코드에 쓰는 글자(A-Z, 2-7)만 남긴다 — 서버(api/loc.js)와 같은 정리 */
        fun cleanKey(raw: String): String = raw.uppercase().filter { it in 'A'..'Z' || it in '2'..'7' }
    }
}
