package app.rememberway.tracker

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputFilter
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * 어르신 휴대폰용 화면 (한 번 설정하면 끝).
 * 보호자 웹앱(/track)이 만든 연결 코드를 넣고 [시작] → 목걸이 블루투스 위치를 받아 서버로 보낸다.
 */
class MainActivity : Activity() {
    private lateinit var codeInput: EditText
    private lateinit var status: TextView
    private val ui = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() { showStatus(); ui.postDelayed(this, 1000) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (20 * resources.displayMetrics.density).toInt()
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad * 2, pad, pad) }
        fun text(s: String, size: Float = 17f, bold: Boolean = false) = TextView(this).apply {
            text = s; textSize = size; setPadding(0, pad / 3, 0, pad / 3); if (bold) setTypeface(typeface, Typeface.BOLD)
        }
        col.addView(text("리멤버웨이 위치", 26f, true))
        col.addView(text("목걸이의 GPS 위치를 이 휴대폰이 받아 보호자에게 보냅니다. 이 휴대폰을 가지고 다니시고, 앱을 끄지 마세요."))
        col.addView(text("보호자 연결 코드 (보호자 휴대폰의 리멤버웨이 → 목걸이 위치 보기)", 15f))
        codeInput = EditText(this).apply {
            hint = "ABCD-EFGH-IJKL-MNOP"; textSize = 22f; gravity = Gravity.CENTER
            filters = arrayOf(InputFilter.AllCaps(), InputFilter.LengthFilter(19))
            setText(Store.key(this@MainActivity)?.chunked(4)?.joinToString("-") ?: "")
        }
        col.addView(codeInput)
        col.addView(text("위치는 보호자가 어르신을 찾을 때만 쓰며, 동의한 경우에만 사용합니다. 위치가 서버를 거쳐 보호자에게 전달됩니다.", 13f))
        col.addView(Button(this).apply { text = "시작"; textSize = 20f; setOnClickListener { start() } })
        col.addView(Button(this).apply { text = "멈추기"; setOnClickListener { stopService(Intent(this@MainActivity, TrackerService::class.java)); Store.status(this@MainActivity, "멈춤") } })
        status = text("", 18f)
        col.addView(status)
        setContentView(ScrollView(this).apply { addView(col) })
    }

    override fun onResume() { super.onResume(); ui.post(tick) }
    override fun onPause() { super.onPause(); ui.removeCallbacks(tick) }

    private fun needed(): Array<String> {
        val p = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= 31) { p += Manifest.permission.BLUETOOTH_SCAN; p += Manifest.permission.BLUETOOTH_CONNECT }
        else p += Manifest.permission.ACCESS_FINE_LOCATION
        if (Build.VERSION.SDK_INT >= 33) p += Manifest.permission.POST_NOTIFICATIONS
        return p.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }.toTypedArray()
    }

    private fun start() {
        val key = codeInput.text.toString().uppercase().filter { it in 'A'..'Z' || it in '2'..'7' }
        if (key.length != 16) { Store.status(this, "연결 코드 16글자를 확인해 주세요"); showStatus(); return }
        Store.setKey(this, key)
        val missing = needed()
        if (missing.isNotEmpty()) { requestPermissions(missing, 1); return }
        startForegroundService(Intent(this, TrackerService::class.java))
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (needed().none { it != Manifest.permission.POST_NOTIFICATIONS }) startForegroundService(Intent(this, TrackerService::class.java))
        else Store.status(this, "블루투스 권한이 필요해요. 설정에서 '근처 기기' 권한을 허용해 주세요")
    }

    private fun showStatus() {
        status.text = "상태: ${Store.status(this)}\n마지막 위치: ${Store.last(this)}\n보내기 대기: ${Store.pending(this)}개"
    }
}
