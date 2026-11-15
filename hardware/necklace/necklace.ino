// REMEMBER WAY — 목걸이 (XIAO ESP32-C3, 시험은 SuperMini ESP32-C3로 해도 같은 코드)
// 하는 일
//   1) 블루투스 이름표 "RW-NECKLACE"를 계속 내보낸다 → 집 수신기가 "집에 있음/없음"을 안다, 보호자 휴대폰이 근처에서 찾는다
//   2) 휴대폰(앱 /find)이 보내는 값으로 부저를 울린다: 0=멈춤, 1~250=그 초만큼, 255=계속
//   3) GPS가 연결돼 있으면 30초마다 "시각,위도,경도"를 보드 안 저장공간(LittleFS)에 적는다 → 앱 /gps 에서 가져간다
// 실시간 위치 추적은 하지 않는다 (통신 모듈 없음). 기록은 보드 안에만 있고, USB로 앱에 옮길 때만 밖으로 나간다.
//
// 연결 (코드 핀 번호 = SuperMini 글자 = XIAO 글자)
//   부저 +  → 3  (XIAO D1)      부저 − → GND
//   GPS TX → 20 (XIAO D7)      GPS RX → 21 (XIAO D6)     GPS VCC → 3V3     GPS GND → GND
// 아두이노 설정: 보드 ESP32C3 Dev Module(또는 XIAO_ESP32C3) · USB CDC On Boot: Enabled · Partition Scheme: Huge APP
// 라이브러리: TinyGPSPlus (라이브러리 매니저에서 "TinyGPSPlus" 검색, Mikal Hart)
// 시리얼 모니터(115200)에 입력: STAT(상태) · DUMP(기록 출력) · CLEAR(기록 지우기) · BEEP(2초 울림)

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <LittleFS.h>
#include <TinyGPSPlus.h>

#define USE_GPS 1                 // GPS를 아직 안 붙였으면 0
const int  BUZ = 3;
const bool BUZ_ON = HIGH;         // 부저가 거꾸로(평소에 울리고 신호 주면 멈춤) 동작하면 LOW로 바꾸기
const int  GPS_RX = 20, GPS_TX = 21;
const uint32_t LOG_EVERY_MS = 30000;   // 30초마다 한 줄
const size_t   LOG_MAX = 900 * 1024;   // 저장공간이 차면 기록 멈춤 (약 2만 줄 = 30초 간격으로 1주일 이상)
const char* NAME    = "RW-NECKLACE";
const char* SERVICE = "7a1e0001-5c3b-4f7e-9a2d-525741590001";   // 앱 /find 와 같은 값
const char* BUZZ    = "7a1e0002-5c3b-4f7e-9a2d-525741590001";

TinyGPSPlus gps;
volatile uint32_t buzzUntil = 0;
volatile bool buzzForever = false;
uint32_t lastLog = 0, lastStat = 0;
bool fsOk = false;

class BuzzCB : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    auto v = c->getValue();
    if (v.length() == 0) return;
    uint8_t x = (uint8_t)v[0];
    buzzForever = (x == 255);
    buzzUntil = (x == 0 || x == 255) ? 0 : millis() + x * 1000UL;
    Serial.printf("[휴대폰] 부저 %s\n", x == 0 ? "멈춤" : x == 255 ? "계속" : (String(x) + "초").c_str());
  }
};
class ServerCB : public BLEServerCallbacks {
  void onConnect(BLEServer*) override { Serial.println("[휴대폰] 연결됨"); }
  void onDisconnect(BLEServer*) override { Serial.println("[휴대폰] 연결 끊김 → 다시 신호 보냄"); BLEDevice::startAdvertising(); }
};

void setup() {
  Serial.begin(115200);
  pinMode(BUZ, OUTPUT); digitalWrite(BUZ, !BUZ_ON);
  delay(1500);
  Serial.println("\n=== REMEMBER WAY 목걸이 ===");

  BLEDevice::init(NAME);
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCB());
  BLEService* svc = server->createService(SERVICE);
  BLECharacteristic* ch = svc->createCharacteristic(BUZZ, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  ch->setCallbacks(new BuzzCB());
  svc->start();
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.printf("블루투스 신호 보내는 중: %s\n", NAME);

  fsOk = LittleFS.begin(true);
  Serial.println(fsOk ? "저장공간 준비됨" : "저장공간 오류 (Partition Scheme 확인)");
#if USE_GPS
  Serial1.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);
  Serial.println("GPS 기다리는 중 (창가·밖에서 5~15분)");
#endif
  beep(150); delay(120); beep(150);   // 켜졌다는 신호 (짧게 두 번)
}

void beep(int ms) { digitalWrite(BUZ, BUZ_ON); delay(ms); digitalWrite(BUZ, !BUZ_ON); }

void loop() {
  // 부저: 삐-쉼 반복 (계속 울리는 것보다 소리 나는 쪽을 찾기 쉽다)
  bool on = buzzForever || (buzzUntil && millis() < buzzUntil);
  if (!on) buzzUntil = 0;
  digitalWrite(BUZ, on && (millis() / 300) % 2 == 0 ? BUZ_ON : !BUZ_ON);

#if USE_GPS
  while (Serial1.available()) gps.encode(Serial1.read());
  if (fsOk && millis() - lastLog > LOG_EVERY_MS && gps.location.isValid() && gps.location.age() < 5000 && gps.date.isValid() && gps.date.year() > 2024) {
    lastLog = millis();
    File f = LittleFS.open("/log.csv", FILE_APPEND);
    if (f && f.size() < LOG_MAX) {
      f.printf("%04d-%02d-%02dT%02d:%02d:%02dZ,%.6f,%.6f\n", gps.date.year(), gps.date.month(), gps.date.day(), gps.time.hour(), gps.time.minute(), gps.time.second(), gps.location.lat(), gps.location.lng());
    }
    if (f) f.close();
  }
#endif

  if (millis() - lastStat > 15000) { lastStat = millis(); stat(); }
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n'); cmd.trim(); cmd.toUpperCase();
    if (cmd == "DUMP") dump();
    else if (cmd == "CLEAR") { LittleFS.remove("/log.csv"); Serial.println("기록을 지웠어요"); }
    else if (cmd == "BEEP") { buzzUntil = millis() + 2000; }
    else if (cmd == "STAT") stat();
  }
}

void stat() {
  size_t n = 0; File f = LittleFS.open("/log.csv", FILE_READ); if (f) { n = f.size(); f.close(); }
#if USE_GPS
  Serial.printf("[상태] GPS 글자 수신 %lu · 위성 %d개 · 위치 %s · 기록 %u바이트\n", (unsigned long)gps.charsProcessed(), gps.satellites.isValid() ? (int)gps.satellites.value() : 0, gps.location.isValid() ? "잡힘" : "아직", (unsigned)n);
  if (gps.charsProcessed() < 10 && millis() > 20000) Serial.println("  → GPS에서 글자가 안 와요: TX·RX 선을 바꿔 꽂거나 VCC·GND를 확인하세요");
#else
  Serial.printf("[상태] GPS 꺼짐(USE_GPS 0) · 기록 %u바이트\n", (unsigned)n);
#endif
}

void dump() {
  Serial.println("BEGIN");
  Serial.println("time,lat,lon");
  File f = LittleFS.open("/log.csv", FILE_READ);
  if (f) { while (f.available()) Serial.write(f.read()); f.close(); }
  Serial.println("END");
}
