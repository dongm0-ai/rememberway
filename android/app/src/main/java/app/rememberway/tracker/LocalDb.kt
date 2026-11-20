package app.rememberway.tracker

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * 이 휴대폰 안의 저장소 (안드로이드 기본 SQLite).
 *  - queue        : 서버로 아직 못 보낸 위치. 인터넷이 끊겨도 나중에 다시 보낸다
 *  - command_log  : 서버에서 받은 부저 명령 기록 — 같은 명령을 두 번 울리지 않고, 결과 보고가 실패하면 다시 보내려고
 */
class LocalDb private constructor(context: Context) :
    SQLiteOpenHelper(context.applicationContext, "tracker.db", null, 1) {

    data class Item(val id: Long, val json: String)
    data class Command(val id: String, val command: String, val status: String, val response: String?)

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE queue (id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL, created_at INTEGER NOT NULL)")
        db.execSQL(
            """CREATE TABLE command_log (
                id TEXT PRIMARY KEY,
                command TEXT NOT NULL,
                status TEXT NOT NULL,          -- writing(목걸이로 보내는 중) · accepted · failed · expired
                response TEXT,                 -- 목걸이의 대답(ACK_FIND 등) 또는 실패 이유
                processed_at INTEGER NOT NULL,
                reported INTEGER NOT NULL DEFAULT 0
            )"""
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

    // ── 위치 대기열 ──

    fun enqueue(json: String) {
        writableDatabase.insert("queue", null, ContentValues().apply {
            put("json", json); put("created_at", System.currentTimeMillis())
        })
        // 너무 오래 못 보내면 오래된 것부터 버린다
        writableDatabase.execSQL("DELETE FROM queue WHERE id <= (SELECT MAX(id) FROM queue) - $MAX_QUEUE")
    }

    fun pending(limit: Int = 50): List<Item> =
        readableDatabase.rawQuery("SELECT id, json FROM queue ORDER BY id LIMIT ?", arrayOf(limit.toString()))
            .use { c -> buildList { while (c.moveToNext()) add(Item(c.getLong(0), c.getString(1))) } }

    fun pendingCount(): Long =
        readableDatabase.rawQuery("SELECT COUNT(*) FROM queue", null).use { c -> if (c.moveToFirst()) c.getLong(0) else 0 }

    fun remove(id: Long) { writableDatabase.delete("queue", "id = ?", arrayOf(id.toString())) }

    fun clearQueue() { writableDatabase.delete("queue", null, null) }

    // ── 부저 명령 기록 ──

    fun commandExists(id: String): Boolean =
        readableDatabase.rawQuery("SELECT 1 FROM command_log WHERE id = ?", arrayOf(id)).use { it.moveToFirst() }

    /** 이미 기록된 id 면 false (같은 명령을 다시 실행하지 않는다) */
    fun insertCommand(id: String, command: String, status: String, response: String? = null): Boolean =
        writableDatabase.insertWithOnConflict("command_log", null, ContentValues().apply {
            put("id", id); put("command", command); put("status", status); put("response", response)
            put("processed_at", System.currentTimeMillis()); put("reported", 0)
        }, SQLiteDatabase.CONFLICT_IGNORE) != -1L

    fun finishCommand(id: String, status: String, response: String?) {
        writableDatabase.update("command_log", ContentValues().apply {
            put("status", status); put("response", response)
            put("processed_at", System.currentTimeMillis()); put("reported", 0)
        }, "id = ?", arrayOf(id))
    }

    fun markCommandReported(id: String) {
        writableDatabase.update("command_log", ContentValues().apply { put("reported", 1) }, "id = ?", arrayOf(id))
    }

    /** 결과는 정해졌지만 서버에 아직 알리지 못한 명령 */
    fun unreportedCommands(): List<Command> =
        readableDatabase.rawQuery(
            "SELECT id, command, status, response FROM command_log WHERE reported = 0 AND status != 'writing' ORDER BY processed_at",
            null
        ).use { c ->
            buildList { while (c.moveToNext()) add(Command(c.getString(0), c.getString(1), c.getString(2), c.getString(3))) }
        }

    /** 목걸이의 대답을 받기 전에 앱이 꺼진 명령: 울렸는지 알 수 없으므로 실패로 닫는다 (다시 울리지 않는다) */
    fun closeInterruptedCommands() {
        writableDatabase.update("command_log", ContentValues().apply {
            put("status", "failed"); put("response", "ack_unknown_app_restarted"); put("reported", 0)
        }, "status = 'writing'", null)
    }

    fun pruneCommands(olderThanMs: Long) {
        writableDatabase.delete("command_log", "reported = 1 AND processed_at < ?",
            arrayOf((System.currentTimeMillis() - olderThanMs).toString()))
    }

    fun clearCommands() { writableDatabase.delete("command_log", null, null) }

    companion object {
        const val MAX_QUEUE = 5000
        @Volatile private var instance: LocalDb? = null
        fun get(context: Context): LocalDb =
            instance ?: synchronized(this) { instance ?: LocalDb(context).also { instance = it } }
    }
}
