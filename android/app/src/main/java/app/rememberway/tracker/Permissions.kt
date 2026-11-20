package app.rememberway.tracker

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

object Permissions {
    /** 필수 권한 (알림 권한은 선택: 거부해도 서비스는 동작하나 알림이 안 보일 수 있음) */
    fun required(): Array<String> = when {
        Build.VERSION.SDK_INT >= 31 -> arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        else -> arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

    fun toRequest(): Array<String> =
        if (Build.VERSION.SDK_INT >= 33) required() + Manifest.permission.POST_NOTIFICATIONS else required()

    fun hasAll(context: Context): Boolean = required().all {
        context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
    }
}
