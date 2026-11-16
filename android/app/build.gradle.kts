// 어르신 휴대폰용 위치 중계 앱 (시제품). 외부 라이브러리 없이 안드로이드 기본 기능만 쓴다.
plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "app.rememberway.tracker"
    compileSdk = 34
    defaultConfig {
        applicationId = "app.rememberway.tracker"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
