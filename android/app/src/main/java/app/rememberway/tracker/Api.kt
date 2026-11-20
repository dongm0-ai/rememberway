package app.rememberway.tracker

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * 서버 /api/loc 호출. 로그인 없이 보호자 연결 코드(key)로만 부른다:
 *   push(위치) · cmd.pending(기다리는 부저 명령) · cmd.result(전달 결과) · device.report(연동한 목걸이·상태)
 * 백그라운드 스레드에서만 부른다.
 */
class Api(private val settings: AppSettings) {
    class Response(val code: Int, val body: JSONObject?) {
        val isSuccess: Boolean get() = code in 200..299
        /** 보호자가 연결 코드를 폐기함 — 더 보내지 말고 멈춘다 */
        val isRevoked: Boolean get() = code == 410
        /** 나중에 다시 보내면 될 수 있는 실패 (인터넷 끊김·서버 장애·호출 제한) */
        val isRetryable: Boolean get() = code == NETWORK_ERROR || code == 408 || code == 429 || code >= 500
    }

    companion object {
        const val NETWORK_ERROR = 0
        const val NO_KEY = -1
    }

    fun call(action: String, fill: (JSONObject) -> Unit = {}): Response {
        val key = settings.key
        if (key.length != AppSettings.KEY_LENGTH) return Response(NO_KEY, null)
        val payload = JSONObject().put("action", action).put("key", key)
        fill(payload)

        val conn = try {
            URL(BuildConfig.ENDPOINT).openConnection() as HttpURLConnection
        } catch (e: Exception) {
            return Response(NETWORK_ERROR, null)
        }
        return try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val text = (if (code < 400) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() }
            Response(code, try { JSONObject(text ?: "") } catch (e: Exception) { null })
        } catch (e: IOException) {
            Response(NETWORK_ERROR, null)
        } catch (e: SecurityException) {
            Response(NETWORK_ERROR, null)
        } finally {
            conn.disconnect()
        }
    }
}
