package app.rememberway.tracker

import org.json.JSONArray
import java.time.Instant

/**
 * 원격 부저 중계: 보호자 웹 [소리 울리기] → 서버 → (여기) → 블루투스 → 목걸이.
 *
 *   서버가 준 명령 → 만료·중복 확인 → 목걸이에 쓰기 → ACK 확인 → 서버에 결과 알림
 *
 * - 명령 id 를 이 휴대폰에 기록해 두어, 같은 명령을 다시 받아도 두 번 울리지 않는다.
 * - 만료된 명령은 뒤늦게 울리지 않는다.
 * - 쓰기가 성공한 것만으로 "받았어요"(accepted)라고 알리지 않는다 — 목걸이의 ACK 가 있어야 한다.
 * - 결과를 서버에 알리지 못하면 기록에 남겨 두었다가 다음에 다시 알린다.
 *
 * handle()·flushReports() 는 서비스의 통신 스레드 하나에서만 부른다.
 */
class CommandProcessor(
    private val api: Api,
    private val db: LocalDb,
    private val ble: () -> TrackerBleClient?,
    private val runOnWorker: (() -> Unit) -> Unit,
    private val onRevoked: () -> Unit,
) {
    fun onServiceStart() {
        db.closeInterruptedCommands()
        db.pruneCommands(7L * 24 * 3600 * 1000)
    }

    /** 서버가 준 명령 목록 [{id, command, expires_at}] */
    fun handle(commands: JSONArray?) {
        if (commands == null) return
        for (i in 0 until commands.length()) {
            val c = commands.optJSONObject(i) ?: continue
            val id = c.optString("id")
            if (id.isNotEmpty()) handleOne(id, c.optString("command"), c.optString("expires_at"))
        }
    }

    private fun handleOne(id: String, command: String, expiresAtIso: String) {
        if (db.commandExists(id)) return   // 이미 했거나 하는 중

        if (command !in BuzzerProtocol.COMMANDS) return closeNew(id, command, "failed", "unknown_command")
        val expiresAt = (try { Instant.parse(expiresAtIso).toEpochMilli() } catch (e: Exception) { null })
            ?: return closeNew(id, command, "failed", "invalid_expires_at")
        if (System.currentTimeMillis() >= expiresAt) return closeNew(id, command, "expired", "expired_before_execution")

        val client = ble()
        if (client == null || !client.isReady) {
            // 만료 전에 목걸이가 다시 연결되면 다음에 받을 때 실행한다 (기록하지 않고 넘어간다)
            TrackerState.update { it.copy(lastCommand = "${label(command)} — 목걸이 연결을 기다리는 중") }
            return
        }

        if (!db.insertCommand(id, command, "writing")) return
        TrackerState.update { it.copy(lastCommand = "${label(command)} — 목걸이로 보내는 중") }
        client.sendBuzzer(command) { result ->
            runOnWorker {
                // 실패 이유는 response 칸에 넣는다 (웹 /find 가 이 값으로 안내 문구를 고른다)
                if (result.accepted) finish(id, command, "accepted", result.response)
                else finish(id, command, "failed", result.reason ?: "unknown")
                flushReports()
            }
        }
    }

    private fun closeNew(id: String, command: String, status: String, response: String) {
        if (db.insertCommand(id, command, status, response)) show(id, command, status, response)
    }

    private fun finish(id: String, command: String, status: String, response: String?) {
        db.finishCommand(id, status, response)
        show(id, command, status, response)
    }

    private fun show(id: String, command: String, status: String, response: String?) {
        val text = when (status) {
            "accepted" -> "목걸이가 받았어요"
            "expired" -> "너무 늦게 도착해 울리지 않았어요"
            else -> "목걸이에 전달하지 못했어요 (${response ?: "-"})"
        }
        TrackerState.update { it.copy(lastCommand = "${label(command)} — $text") }
        TrackerState.log("보호자 요청 ${label(command)}: $text")
    }

    /** 서버에 아직 알리지 못한 결과를 알린다. 돌려주는 값: 서버와 통신이 됐는지 */
    fun flushReports(): Boolean {
        for (c in db.unreportedCommands()) {
            val r = api.call("cmd.result") {
                it.put("id", c.id).put("status", c.status)
                if (c.response != null) it.put("response", c.response)
            }
            when {
                r.isSuccess -> db.markCommandReported(c.id)
                r.isRevoked -> { onRevoked(); return false }
                r.isRetryable || r.code == Api.NO_KEY -> return false   // 다음에 다시
                else -> db.markCommandReported(c.id)                    // 400·404: 다시 보내도 같다
            }
        }
        return true
    }

    private fun label(command: String) = when (command) {
        BuzzerProtocol.FIND -> "소리 울리기"
        BuzzerProtocol.ON -> "소리 켜기"
        BuzzerProtocol.OFF -> "소리 멈추기"
        else -> command
    }
}
