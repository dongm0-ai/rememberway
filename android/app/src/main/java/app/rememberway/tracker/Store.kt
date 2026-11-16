package app.rememberway.tracker

import android.content.Context

/** 앱 설정·상태 (이 휴대폰 안에만). 연결 코드, 화면에 보여 줄 상태 글 */
object Store {
    private fun p(c: Context) = c.getSharedPreferences("rw", Context.MODE_PRIVATE)
    fun key(c: Context): String? = p(c).getString("key", null)
    fun setKey(c: Context, k: String) = p(c).edit().putString("key", k).apply()
    fun status(c: Context): String = p(c).getString("status", "시작 전") ?: ""
    fun status(c: Context, s: String) = p(c).edit().putString("status", s).apply()
    fun last(c: Context): String = p(c).getString("last", "없음") ?: ""
    fun last(c: Context, s: String) = p(c).edit().putString("last", s).apply()
    fun pending(c: Context): Int = p(c).getInt("pending", 0)
    fun pending(c: Context, n: Int) = p(c).edit().putInt("pending", n).apply()
}
