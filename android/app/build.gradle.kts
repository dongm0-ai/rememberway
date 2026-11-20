// 어르신 휴대폰용 위치 중계 앱 (시제품). 앱에는 외부 라이브러리 없이 안드로이드 기본 기능만 쓴다 (아래 두 개는 단위 시험 전용).
plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

// 서버 주소. PC에서 시험할 때만 바꾼다:  gradle assembleDebug -PlocEndpoint=http://127.0.0.1:3000/api/loc
val prodEndpoint = "https://rememberway.vercel.app/api/loc"
val debugEndpoint = (findProperty("locEndpoint") as String?) ?: prodEndpoint

android {
    namespace = "app.rememberway.tracker"
    compileSdk = 34
    defaultConfig {
        applicationId = "app.rememberway.tracker"
        minSdk = 26
        targetSdk = 34
        versionCode = 4
        versionName = "0.2.2"
    }
    // 시제품(디버그) 빌드를 늘 같은 키로 서명한다. 안드로이드는 서명이 같아야 덮어 설치를 받아 주는데,
    // GitHub Actions 는 빌드할 때마다 임시 키를 새로 만들어서 새 판이 나올 때마다 어르신 폰에서 앱을 지우고 다시 깔아야 했다(연결 코드도 다시 입력).
    // debug.keystore 는 저장소에 둔다 — 비밀번호 android 는 안드로이드 디버그 키의 공개된 기본값이고, 이 키는 비밀이 아니다.
    // 저장소를 볼 수 있는 사람은 같은 서명의 APK 를 만들 수 있으므로, 실제로 배포할 때는 저장소에 없는 키로 서명한 release 빌드로 바꾼다.
    signingConfigs {
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }
    buildTypes {
        debug { buildConfigField("String", "ENDPOINT", "\"$debugEndpoint\"") }
        release { buildConfigField("String", "ENDPOINT", "\"$prodEndpoint\"") }
    }
    buildFeatures { buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")   // 안드로이드 단위 시험의 org.json 은 빈 껍데기라 실제 구현을 넣는다
}
