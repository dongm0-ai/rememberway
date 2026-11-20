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
        versionCode = 3
        versionName = "0.2.1"
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
