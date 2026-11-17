// REMEMBER WAY — 목걸이 (XIAO ESP32-C3, 시험은 SuperMini ESP32-C3로 해도 같은 코드)
// 하는 일
//   1) 블루투스 이름표 "RW-NECKLACE"를 계속 내보낸다 → 현관 수신기가 문 앞에서 감지, 보호자 휴대폰(앱 /find)이 근처에서 찾는다
//   2) 휴대폰이 보내는 값으로 부저: 1=울림(멈출 때까지), 0=멈춤
//   3) 움직일 때만 GPS 위치를 10초마다 보드 안 저장공간(LittleFS)에 적는다 → 앱 /gps 로 옮긴다
//   4) 움직이는 동안 10초마다 위치 JSON을 블루투스(READ·NOTIFY)로 내보낸다 → 어르신 휴대폰 앱(android/)이 받아 서버로 → 보호자 웹앱 /track (2026-11-16)
//      JSON 형식은 GPS_BLE 위치중계 가이드 v1의 8개 필드. 위치가 없으면 {"status":"waiting"}
//      - 10초: Shoval 외 2008 (치매 어르신 GPS 연구, 밖에서 10초마다 기록)
//      - 움직일 때만, 3분 안 움직이면 기록 멈춤: Bayat 외 2020 (노인 GPS, 3분 넘게 머물면 정지로 봄, 멈추면 대기)
//      - "움직임" 기준은 근거 자료가 없어 숫자를 정하지 않고, 차고 가만히 있을 때의 흔들림을 재서(CAL) 그보다 크면 움직임으로 본다
// 목걸이 자체에는 통신 모듈이 없다. 실시간 위치는 어르신 휴대폰이 가까이 있고 앱이 켜져 있을 때만 전달된다.
//
// 연결 (코드 핀 번호 = SuperMini 글자 = XIAO 글자)
//   부저 +        → 3  (XIAO D1)    부저 −   → GND
//   MPU-6050 SDA  → 6  (XIAO D4)    SCL      → 7 (XIAO D5)    VCC → 3V3    GND → GND
//   GPS TX        → 4  (XIAO D2)    GPS RX   → 21 (XIAO D6, 지금은 안 써도 됨)   VCC → 3V3    GND → GND
//   (GPS TX → 4번, 9600bps는 GPS_BLE 가이드에서 실제로 위치 수신을 확인한 연결)
// 아두이노 설정: 보드 ESP32C3 Dev Module(또는 XIAO_ESP32C3) · USB CDC On Boot: Enabled · Partition Scheme: Huge APP
// 라이브러리: TinyGPSPlus (라이브러리 매니저에서 "TinyGPSPlus" 검색, Mikal Hart). MPU-6050은 라이브러리 없이 읽는다
// 시리얼 모니터(115200)에 입력: STAT(상태) · CAL(움직임 기준 재기: 목걸이를 차고 10초 가만히) · DUMP(기록 출력) · CLEAR(기록 지우기) · BEEP(울림/멈춤)

#include <Wire.h>
#include <Preferences.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <LittleFS.h>
#include <TinyGPSPlus.h>

#define USE_GPS 1                  // GPS를 아직 안 붙였으면 0
#define USE_MPU 1                  // MPU-6050을 아직 안 붙였으면 0 (그러면 항상 "움직임"으로 보고 10초마다 기록)
const int  BUZ = 3;
const bool BUZ_ON = HIGH;          // 부저가 거꾸로 동작하면 LOW
const int  SDA_PIN = 6, SCL_PIN = 7, GPS_RX = 4, GPS_TX = 21;
const uint8_t MPU = 0x68;
const uint32_t LOG_EVERY_MS = 10000;     // Shoval 외 2008
const uint32_t STILL_MS     = 180000;    // Bayat 외 2020: 3분
const char* NAME    = "RW-NECKLACE";
const char* SERVICE = "7a1e0001-5c3b-4f7e-9a2d-525741590001";   // 앱 /find 와 같은 값
const char* BUZZ    = "7a1e0002-5c3b-4f7e-9a2d-525741590001";
const char* LOC     = "7a1e0003-5c3b-4f7e-9a2d-525741590001";   // 위치 JSON (READ·NOTIFY) — android/ 앱과 같은 값
const char* DEVICE_ID = "rw-necklace-001";
const char* FW_VER    = "1.1.0";
const uint32_t SEND_EVERY_MS = 10000;    // Shoval 외 2008: 10초

TinyGPSPlus gps;
Preferences prefs;
volatile bool buzzing = false;
uint32_t lastLog = 0, lastStat = 0, lastMove = 0, lastRead = 0, lastSend = 0, seq = 0;
BLECharacteristic* locCh = nullptr;
volatile bool phoneConnected = false;
bool fsOk = false, mpuOk = false;
float moveThr = -1;               // CAL로 잰 값 (가만히 있을 때 가장 큰 흔들림). 재기 전에는 -1
float prevMag = -1;

class BuzzCB : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    auto v = c->getValue();
    if (v.length() == 0) return;
    buzzing = ((uint8_t)v[0]) != 0;
    Serial.printf("[휴대폰] 부저 %s\n", buzzing ? "울림" : "멈춤");
  }
};
class ServerCB : public BLEServerCallbacks {
  void onConnect(BLEServer*) override { phoneConnected = true; Serial.println("[휴대폰] 연결됨"); BLEDevice::startAdvertising(); }   // 연결 중에도 신호를 계속 내보내 현관 수신기·보호자 휴대폰이 찾을 수 있게
  void onDisconnect(BLEServer*) override { phoneConnected = false; Serial.println("[휴대폰] 연결 끊김 → 다시 신호 보냄"); buzzing = false; BLEDevice::startAdvertising(); }
};

// ---- MPU-6050 (레지스터 직접 읽기, 가속도만 사용) ----
void mpuWrite(uint8_t reg, uint8_t val) { Wire.beginTransmission(MPU); Wire.write(reg); Wire.write(val); Wire.endTransmission(); }
float accelMag() {   // 가속도 크기 (단위 g). 실패하면 -1
  Wire.beginTransmission(MPU); Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom((int)MPU, 6) != 6) return -1;
  int16_t ax = (Wire.read() << 8) | Wire.read(), ay = (Wire.read() << 8) | Wire.read(), az = (Wire.read() << 8) | Wire.read();
  float x = ax / 16384.0, y = ay / 16384.0, z = az / 16384.0;   // ±2g 범위
  return sqrtf(x * x + y * y + z * z);
}
void calibrate() {
  Serial.println("[CAL] 목걸이를 차고 10초 동안 가만히 앉아 계세요…");
  float prev = accelMag(), mx = 0; uint32_t t0 = millis();
  while (millis() - t0 < 10000) { delay(100); float m = accelMag(); if (m < 0 || prev < 0) continue; mx = max(mx, fabsf(m - prev)); prev = m; }
  moveThr = mx; prefs.putFloat("thr", moveThr);
  Serial.printf("[CAL] 가만히 있을 때 가장 큰 흔들림 %.4f g → 이보다 크면 움직임으로 봄 (저장됨)\n", moveThr);
}

void setup() {
  Serial.begin(115200);
  pinMode(BUZ, OUTPUT); digitalWrite(BUZ, !BUZ_ON);
  delay(1500);
  Serial.println("\n=== REMEMBER WAY 목걸이 ===");
  prefs.begin("rw", false);
  moveThr = prefs.getFloat("thr", -1);

  BLEDevice::init(NAME);
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCB());
  BLEService* svc = server->createService(SERVICE);
  BLECharacteristic* ch = svc->createCharacteristic(BUZZ, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  ch->setCallbacks(new BuzzCB());
  locCh = svc->createCharacteristic(LOC, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  locCh->addDescriptor(new BLE2902());
  locCh->setValue("{\"status\":\"waiting\"}");
  svc->start();
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.printf("블루투스 신호 보내는 중: %s\n", NAME);

  fsOk = LittleFS.begin(true);
  Serial.println(fsOk ? "저장공간 준비됨" : "저장공간 오류 (Partition Scheme 확인)");
#if USE_MPU
  Wire.begin(SDA_PIN, SCL_PIN);
  mpuWrite(0x6B, 0x00);        // 깨우기
  mpuWrite(0x6C, 0x07);        // 자이로 끄기 (가속도만: 제조사 자료 0.5mA)
  mpuWrite(0x1C, 0x00);        // ±2g
  mpuOk = accelMag() > 0;
  Serial.println(mpuOk ? "움직임 센서 준비됨" : "움직임 센서 못 찾음 (SDA 6·SCL 7·3V3·GND 확인)");
  if (mpuOk && moveThr < 0) Serial.println("  → 아직 움직임 기준이 없어요. 목걸이를 차고 CAL 을 입력하세요");
#endif
#if USE_GPS
  Serial1.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);
  Serial.println("GPS 기다리는 중 (창가·밖에서 처음 몇 분)");
#endif
  lastMove = millis();
  digitalWrite(BUZ, BUZ_ON); delay(150); digitalWrite(BUZ, !BUZ_ON); delay(120); digitalWrite(BUZ, BUZ_ON); delay(150); digitalWrite(BUZ, !BUZ_ON);   // 켜짐 신호
}

bool moving() {
#if USE_MPU
  if (!mpuOk || moveThr < 0) return true;   // 센서가 없거나 기준을 안 쟀으면 항상 기록
  return millis() - lastMove < STILL_MS;
#else
  return true;
#endif
}

void loop() {
  // 부저: 삐-쉼 반복 (소리 나는 쪽을 찾기 쉽게)
  digitalWrite(BUZ, buzzing && (millis() / 300) % 2 == 0 ? BUZ_ON : !BUZ_ON);

#if USE_MPU
  if (mpuOk && millis() - lastRead >= 100) {   // 0.1초마다 흔들림 확인
    lastRead = millis();
    float m = accelMag();
    if (m > 0 && prevMag > 0 && moveThr >= 0 && fabsf(m - prevMag) > moveThr) lastMove = millis();
    if (m > 0) prevMag = m;
  }
#endif

#if USE_GPS
  while (Serial1.available()) gps.encode(Serial1.read());
  if (fsOk && moving() && millis() - lastLog >= LOG_EVERY_MS && gps.location.isValid() && gps.location.age() < 5000 && gps.date.isValid() && gps.date.year() > 2024) {
    lastLog = millis();
    File f = LittleFS.open("/log.csv", FILE_APPEND);
    if (f && LittleFS.usedBytes() < LittleFS.totalBytes() - 4096)
      f.printf("%04d-%02d-%02dT%02d:%02d:%02dZ,%.6f,%.6f\n", gps.date.year(), gps.date.month(), gps.date.day(), gps.time.hour(), gps.time.minute(), gps.time.second(), gps.location.lat(), gps.location.lng());
    if (f) f.close();
  }
#endif

#if USE_GPS
  // 움직이는 동안만 10초마다 보낸다. 3분 넘게 멈추면(Bayat 2020) 멈춘 자리를 한 번 보내고 쉰다 → 서버 기록의 빈틈 = 머문 시간 (박진관·오수열 2016 실내 판정과 같은 원리)
  static bool wasMoving = true;
  bool mv = moving();
  if ((mv && millis() - lastSend >= SEND_EVERY_MS) || (!mv && wasMoving)) { lastSend = millis(); sendLocation(); }
  wasMoving = mv;
#endif
  if (millis() - lastStat > 15000) { lastStat = millis(); stat(); }
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n'); cmd.trim(); cmd.toUpperCase();
    if (cmd == "DUMP") dump();
    else if (cmd == "CLEAR") { LittleFS.remove("/log.csv"); Serial.println("기록을 지웠어요"); }
    else if (cmd == "BEEP") { buzzing = !buzzing; }
    else if (cmd == "CAL") calibrate();
    else if (cmd == "STAT") stat();
  }
}

void stat() {
  size_t n = 0; File f = LittleFS.open("/log.csv", FILE_READ); if (f) { n = f.size(); f.close(); }
  Serial.printf("[상태] %s", moving() ? "움직임(기록 중)" : "3분 넘게 멈춤(기록 쉼)");
#if USE_MPU
  Serial.printf(" · 움직임 기준 %s", moveThr < 0 ? "없음(CAL 필요)" : String(moveThr, 4).c_str());
#endif
#if USE_GPS
  Serial.printf(" · GPS 글자 %lu · 위성 %d개 · 위치 %s", (unsigned long)gps.charsProcessed(), gps.satellites.isValid() ? (int)gps.satellites.value() : 0, gps.location.isValid() ? "잡힘" : "아직");
#endif
  Serial.printf(" · 기록 %u바이트 · 휴대폰 %s\n", (unsigned)n, phoneConnected ? "연결됨" : "없음");
#if USE_GPS
  if (gps.charsProcessed() < 10 && millis() > 20000) Serial.println("  → GPS에서 글자가 안 와요: TX·RX 선을 바꿔 꽂거나 VCC·GND를 확인하세요");
#endif
}

// 위치 JSON (GPS_BLE 가이드 v1): 값이 없는 선택 필드는 키를 빼고, 위치가 없으면 {"status":"waiting"}
void sendLocation() {
  char buf[240];
  if (gps.location.isValid() && gps.location.age() < 3000) {
    int n = snprintf(buf, sizeof(buf), "{\"device_id\":\"%s\",\"latitude\":%.6f,\"longitude\":%.6f,\"fix_age_ms\":%lu", DEVICE_ID, gps.location.lat(), gps.location.lng(), (unsigned long)gps.location.age());
    if (gps.speed.isValid()) n += snprintf(buf + n, sizeof(buf) - n, ",\"speed_kmh\":%.2f", gps.speed.kmph());
    if (gps.date.isValid() && gps.time.isValid() && gps.date.year() > 2024)
      n += snprintf(buf + n, sizeof(buf) - n, ",\"gps_time\":\"%04d-%02d-%02dT%02d:%02d:%02dZ\"", gps.date.year(), gps.date.month(), gps.date.day(), gps.time.hour(), gps.time.minute(), gps.time.second());
    snprintf(buf + n, sizeof(buf) - n, ",\"sequence\":%lu,\"firmware_version\":\"%s\"}", (unsigned long)++seq, FW_VER);
  } else strcpy(buf, "{\"status\":\"waiting\"}");
  locCh->setValue((uint8_t*)buf, strlen(buf));
  if (phoneConnected) locCh->notify();
}

void dump() {
  Serial.println("BEGIN");
  Serial.println("time,lat,lon");
  File f = LittleFS.open("/log.csv", FILE_READ);
  if (f) { while (f.available()) Serial.write(f.read()); f.close(); }
  Serial.println("END");
}
