// REMEMBER WAY — 현관 수신기 (SuperMini ESP32-C3, USB 전원, 현관문 옆에 둔다)
// 하는 일: 현관문이 열려 있는 동안 목걸이 블루투스 신호를 듣고, 문 앞에서 잡히면
//         → 텔레그램 "현관으로 나가신 것 같아요" + 앱 링크(/report?out=시각)
// 근거: 국민건강보험공단 배회감지기 매트형(현관문 앞, 감지하면 바로 알람)·태그형(블루투스),
//       Rafferty 외 2018 Safe Beacon(문 쪽 수신기가 착용 비콘 감지, 신호 세기 기준은 현장에서 재서 정함)
// 기다리는 시간 기준은 없다. "문 앞" 신호 세기는 숫자를 정하지 않고 CAL 로 우리 현관에서 잰다.
// 위치는 모른다 (실시간 추적 아님). 알림은 "나가신 것 같다"일 뿐, 확인은 보호자가 한다.
//
// 연결: 문 센서 선 하나 → 4번, 다른 하나 → GND (자석이 붙으면 닫힘)
// 아두이노 설정: 보드 ESP32C3 Dev Module · USB CDC On Boot: Enabled · Partition Scheme: Huge APP
// 준비: secrets.example.h 를 복사해 secrets.h 로 이름 바꾸고 와이파이·봇 토큰·chat id 채우기
// 시리얼 모니터(115200)에 입력: TEST(텔레그램 시험) · CAL(목걸이를 차고 문턱에 10초 서 있기) · STAT

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>
#include <time.h>
#include "secrets.h"

const int DOOR = 4, LED = 8;   // SuperMini 파란 불은 LOW일 때 켜짐
const char* APP_URL   = "https://rememberway.vercel.app";
const char* NECK_NAME = "RW-NECKLACE";
const char* SERVICE   = "7a1e0001-5c3b-4f7e-9a2d-525741590001";

Preferences prefs;
volatile bool doorChanged = false;
volatile int bestRssi = -999;      // 지금 듣는 동안 가장 센 목걸이 신호
volatile int lastRssi = -999;
volatile uint32_t lastSeen = 0;
int doorRssi = -999;               // CAL 로 잰 "문턱에 섰을 때" 가장 약한 신호. 재기 전에는 -999 (잡히기만 하면 알림)

void IRAM_ATTR onDoor() { doorChanged = true; }

class ScanCB : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice d) override {
    bool hit = (d.haveName() && d.getName() == NECK_NAME) || (d.haveServiceUUID() && d.isAdvertisingService(BLEUUID(SERVICE)));
    if (!hit) return;
    int r = d.getRSSI();
    lastRssi = r; lastSeen = millis();
    if (r > bestRssi) bestRssi = r;
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
  WiFiClientSecure c; c.setInsecure();   // 시연용: 인증서 확인 생략 (README 한계에 적음)
  HTTPClient h;
  h.begin(c, String("https://api.telegram.org/bot") + BOT_TOKEN + "/sendMessage");
  h.addHeader("Content-Type", "application/x-www-form-urlencoded");
  int code = h.POST(String("chat_id=") + CHAT_ID + "&text=" + urlenc(text));
  h.end();
  Serial.printf("  텔레그램 %s (%d)\n", code == 200 ? "보냄" : "실패", code);
  return code == 200;
}
void nowHHMM(char* out) { struct tm t; if (getLocalTime(&t, 2000)) strftime(out, 6, "%H:%M", &t); else strcpy(out, "--:--"); }
bool doorOpen() { return digitalRead(DOOR) == HIGH; }
void listen(int sec) { scan->start(sec, false); scan->clearResults(); }

void calibrate() {
  Serial.println("[CAL] 목걸이를 차고 현관 문턱(나가는 자리)에 10초 서 계세요…");
  int weakest = 0; bool any = false; uint32_t t0 = millis();
  while (millis() - t0 < 10000) { bestRssi = -999; listen(1); if (bestRssi > -999) { any = true; if (bestRssi < weakest) weakest = bestRssi; } }
  if (!any) { Serial.println("[CAL] 목걸이 신호를 못 잡았어요. 목걸이가 켜져 있는지 확인하세요"); return; }
  doorRssi = weakest; prefs.putInt("door", doorRssi);
  Serial.printf("[CAL] 문턱에서 잡힌 가장 약한 신호 %d → 문이 열렸을 때 이 이상이면 알림 (저장됨)\n", doorRssi);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT); digitalWrite(LED, HIGH);
  pinMode(DOOR, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(DOOR), onDoor, CHANGE);
  delay(1500);
  Serial.println("\n=== REMEMBER WAY 현관 수신기 ===");
  prefs.begin("rw", false);
  doorRssi = prefs.getInt("door", -999);
  if (doorRssi == -999) Serial.println("아직 문턱 신호를 안 쟀어요. 목걸이를 차고 문턱에 서서 CAL 을 입력하세요");

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
  Serial.println("준비됨. 문이 열리면 목걸이 신호를 듣습니다.");
}

void loop() {
  if (doorChanged) {
    doorChanged = false;
    if (doorOpen()) {
      char t[6]; nowHHMM(t);
      Serial.printf("[문] %s 열림 → 닫힐 때까지 목걸이 신호 듣기\n", t);
      digitalWrite(LED, LOW);
      bestRssi = -999;
      while (doorOpen()) listen(1);      // 문이 열려 있는 동안 계속 듣기 (매트형처럼 기다리는 시간 기준 없음)
      listen(1);                          // 닫히는 순간 지나가는 경우까지 1초 더
      doorChanged = false;
      digitalWrite(LED, HIGH);
      bool near = bestRssi > -999 && bestRssi >= doorRssi;
      Serial.printf("[문] 닫힘 · 목걸이 신호 %s (가장 센 값 %d, 문턱 기준 %d)\n", bestRssi > -999 ? "잡힘" : "없음", bestRssi, doorRssi);
      if (near) {
        Serial.println("[판단] 문이 열릴 때 문 앞에서 목걸이 감지 → 알림");
        tg(String("🚪 ") + t + " 현관문이 열릴 때 문 앞에서 목걸이 신호가 잡혔어요. 현관으로 나가신 것 같아요.\n"
           "집에 계신지 먼저 확인해 주세요. 안 보이시면 112에 신고하고 앱으로 단서를 정리하세요:\n" + APP_URL + "/report?out=" + t);
      }
    }
  }
  static uint32_t lastPrint = 0;
  if (millis() - lastPrint > 10000) {
    lastPrint = millis();
    bestRssi = -999; listen(1);
    Serial.printf("[대기] 문 %s · 목걸이 %s (세기 %d) · 문턱 기준 %s\n", doorOpen() ? "열림" : "닫힘", bestRssi > -999 ? "잡힘" : "안 잡힘", bestRssi, doorRssi == -999 ? "없음(CAL 필요)" : String(doorRssi).c_str());
  }
  if (Serial.available()) {
    String c = Serial.readStringUntil('\n'); c.trim(); c.toUpperCase();
    if (c == "TEST") tg("✅ REMEMBER WAY 현관 수신기 시험 메시지입니다.");
    else if (c == "CAL") calibrate();
  }
  delay(50);
}
