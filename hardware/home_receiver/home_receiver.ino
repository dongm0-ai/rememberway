// REMEMBER WAY — 집 수신기 (SuperMini ESP32-C3, USB 전원)
// 하는 일: 문이 열렸다 닫힌 뒤 목걸이 블루투스 신호가 정해진 시간 동안 안 잡히면
//         → 텔레그램 "외출하신 것 같아요" + 앱 링크(/report?out=시각). 신호가 다시 잡히면 "돌아오신 것 같아요".
// 규칙(코드)으로만 판단한다. 위치는 모른다 (실시간 추적 아님). "나가신 것 같다"는 알림일 뿐 확인은 보호자가 한다.
//
// 연결: 문 센서 선 하나 → 4번, 다른 하나 → GND (자석이 붙으면 닫힘)
// 아두이노 설정: 보드 ESP32C3 Dev Module · USB CDC On Boot: Enabled · Partition Scheme: Huge APP (블루투스+와이파이라 큼)
// 준비: secrets.example.h 를 복사해 secrets.h 로 이름 바꾸고 와이파이·봇 토큰·chat id 채우기
// 시리얼 모니터(115200)에 TEST 입력 → 텔레그램 시험 메시지

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>
#include <time.h>
#include "secrets.h"

#define DEMO_MODE 1   // 1: 시연용 20초 · 0: 실제 3분
const uint32_t ABSENT_MS = DEMO_MODE ? 20000UL : 180000UL;
const int DOOR = 4, LED = 8;   // SuperMini 파란 불은 LOW일 때 켜짐
const char* APP_URL = "https://rememberway.vercel.app";
const char* NECK_NAME = "RW-NECKLACE";
const char* SERVICE   = "7a1e0001-5c3b-4f7e-9a2d-525741590001";

volatile bool doorChanged = false;
volatile uint32_t lastSeen = 0;
volatile int lastRssi = 0;
volatile bool seenEver = false;
enum State { IDLE, WATCH, OUT } state = IDLE;
uint32_t doorAt = 0;
char doorTime[6] = "--:--";

void IRAM_ATTR onDoor() { doorChanged = true; }

class ScanCB : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice d) override {
    bool hit = (d.haveName() && d.getName() == NECK_NAME) || (d.haveServiceUUID() && d.isAdvertisingService(BLEUUID(SERVICE)));
    if (hit) { lastSeen = millis(); lastRssi = d.getRSSI(); seenEver = true; }
  }
};
BLEScan* scan;

String urlenc(const String& s) {
  String o; char b[4];
  for (unsigned int i = 0; i < s.length(); i++) { unsigned char c = (unsigned char)s[i]; if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') o += (char)c; else { sprintf(b, "%%%02X", c); o += b; } }
  return o;
}
bool tg(const String& text) {
  if (WiFi.status() != WL_CONNECTED) { Serial.println("  와이파이 안 됨 → 텔레그램 못 보냄"); return false; }
  WiFiClientSecure c; c.setInsecure();   // 시연용: 인증서 확인 생략
  HTTPClient h;
  h.begin(c, String("https://api.telegram.org/bot") + BOT_TOKEN + "/sendMessage");
  h.addHeader("Content-Type", "application/x-www-form-urlencoded");
  int code = h.POST(String("chat_id=") + CHAT_ID + "&text=" + urlenc(text));
  h.end();
  Serial.printf("  텔레그램 %s (%d)\n", code == 200 ? "보냄" : "실패", code);
  return code == 200;
}
void nowHHMM(char* out) {
  struct tm t;
  if (getLocalTime(&t, 2000)) strftime(out, 6, "%H:%M", &t); else strcpy(out, "--:--");
}

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT); digitalWrite(LED, HIGH);
  pinMode(DOOR, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(DOOR), onDoor, CHANGE);
  delay(1500);
  Serial.printf("\n=== REMEMBER WAY 집 수신기 (%s: %lu초) ===\n", DEMO_MODE ? "시연 모드" : "실제 모드", ABSENT_MS / 1000);

  WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("와이파이 연결 중");
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
  Serial.println(WiFi.status() == WL_CONNECTED ? " 연결됨" : " 실패 (2.4GHz인지, 이름·비밀번호 확인)");
  configTzTime("KST-9", "pool.ntp.org", "time.google.com");

  BLEDevice::init("");
  scan = BLEDevice::getScan();
  scan->setAdvertisedDeviceCallbacks(new ScanCB(), true);
  scan->setActiveScan(true);
  scan->setInterval(100); scan->setWindow(99);
  Serial.println("목걸이 신호 찾는 중… (문 센서: 자석 붙이면 닫힘)");
}

void loop() {
  scan->start(2, false);   // 2초 동안 주변 블루투스 듣기
  scan->clearResults();
  uint32_t now = millis();
  bool home = seenEver && now - lastSeen < ABSENT_MS;

  if (doorChanged) {
    doorChanged = false;
    bool open = digitalRead(DOOR) == HIGH;
    Serial.printf("[문] %s\n", open ? "열림" : "닫힘");
    if (state == IDLE) { state = WATCH; doorAt = now; nowHHMM(doorTime); Serial.printf("  %s 문 움직임 → 목걸이 신호를 %lu초 지켜봄\n", doorTime, ABSENT_MS / 1000); }
  }

  if (state == WATCH) {
    uint32_t since = now - max((uint32_t)lastSeen, doorAt);
    if (!seenEver) {
      if (now - doorAt > ABSENT_MS) { state = IDLE; Serial.println("[판단] 목걸이를 한 번도 못 찾아서 알림을 보내지 않음 (목걸이 켜기)"); }
    } else if (since >= ABSENT_MS) {
      state = OUT; digitalWrite(LED, LOW);
      Serial.println("[판단] 문이 움직인 뒤 목걸이 신호가 없음 → 외출 알림");
      tg(String("🚪 ") + doorTime + " 문이 열린 뒤 목걸이 신호가 " + (ABSENT_MS / 1000) + "초 넘게 안 잡혀요. 외출하신 것 같아요.\n"
         "집에 계신지 먼저 확인해 주세요. 안 보이시면 112에 신고하고 앱으로 단서를 정리하세요:\n" + APP_URL + "/report?out=" + doorTime);
    } else if (home && now - doorAt > ABSENT_MS + 10000) {
      state = IDLE; Serial.println("[판단] 목걸이가 계속 집에 있음 → 외출 아님");
    }
  } else if (state == OUT && home) {
    state = IDLE; digitalWrite(LED, HIGH);
    char t[6]; nowHHMM(t);
    Serial.println("[판단] 목걸이 신호 다시 잡힘 → 귀가 알림");
    tg(String("🏠 ") + t + " 목걸이 신호가 다시 잡혔어요. 돌아오신 것 같아요. 얼굴 보고 확인해 주세요.\n찾은 뒤 기록: " + APP_URL + "/record");
  }

  static uint32_t lastPrint = 0;
  if (now - lastPrint > 5000) {
    lastPrint = now;
    if (!seenEver) Serial.println("[목걸이] 아직 한 번도 못 찾음 (목걸이 전원·거리 확인)");
    else Serial.printf("[목걸이] %s · 마지막 신호 %lu초 전 · 세기 %d · 상태 %s\n", home ? "집에 있음" : "안 잡힘", (now - lastSeen) / 1000, lastRssi, state == IDLE ? "평소" : state == WATCH ? "지켜보는 중" : "외출 알림 보냄");
  }
  if (Serial.available()) { String c = Serial.readStringUntil('\n'); c.trim(); c.toUpperCase(); if (c == "TEST") tg("✅ REMEMBER WAY 집 수신기 시험 메시지입니다."); }
}
