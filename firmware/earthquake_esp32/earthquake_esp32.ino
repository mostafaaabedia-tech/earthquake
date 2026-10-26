/*
  ============================================================================
   QuakeGuard v2  —  Earthquake Detection & Building Evacuation  (ESP32 + MPU6050)
  ============================================================================
   When the MPU6050 senses an earthquake:
     • both buzzers sound (siren)          • the warning LED turns on
     • the servo opens the exit door       • the relay turns on the emergency light
     • the event goes to Firebase and the GitHub web page (QuakeGuard dashboard)
     • optional: a Telegram and/or ntfy.sh message is sent to your phone

   Detection (v2)
     STA/LTA trigger, as used by real seismographs: the 1-second average of the
     vibration (STA) is compared with the 30-second background level (LTA).
     An alarm needs:  ratio >= trigger  AND  vibration >= minimum g
                      for at least the minimum duration (rejects door slams).
     Very strong shaking or fast rotation (gyroscope) also triggers it.

   Behaviour
     MONITORING -> earthquake (or gas, if an MQ-2 is fitted)  -> ALARM
     ALARM      -> calm for the quiet time                     -> HOLD
                   (buzzers off; LED, door and light stay on so people can leave)
     ALARM/HOLD -> reset button or "Reset alarm" on the page   -> MONITORING
     After a real earthquake, a 24-hour AFTERSHOCK WATCH lowers the threshold.

   The web page can change the detection settings, run tests, calibrate the
   sensor and end the aftershock watch. All of it is read from Firebase.

   The alarm runs on core 1 and never waits for the internet.
   Wi-Fi, Firebase and alerts run on core 0.

   Libraries: ESP32Servo (Kevin Harrington).   Board: "ESP32 Dev Module".
  ============================================================================
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <ESP32Servo.h>
#include <math.h>

// ============================ USER SETTINGS =================================
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Firebase Realtime Database URL, without a trailing slash
const char* FIREBASE_URL  = "https://quakeguard-earthquake-default-rtdb.europe-west1.firebasedatabase.app";
const char* FIREBASE_AUTH = "";            // database secret, or empty (see README)

// One database path per floor. Floor 1 = "/earthquake", floor 2 = "/floor2"...
// It must match the "path" of the floor in the web page's config.js.
const char* DB_PATH       = "/earthquake";
const char* FLOOR_NAME    = "Floor 1";

// ---------------- Optional phone alerts (leave empty to switch off) --------
// Telegram: create a bot with @BotFather, press "Start" on it, then put the
// bot token and your chat id here (see README).
const char* TELEGRAM_BOT_TOKEN = "";
const char* TELEGRAM_CHAT_ID   = "";
// ntfy.sh: install the ntfy app and subscribe to a long, secret topic name.
const char* NTFY_TOPIC         = "";

// ------------------------------ Pins ---------------------------------------
const int PIN_SDA        = 21;   // MPU6050 SDA
const int PIN_SCL        = 22;   // MPU6050 SCL
const int PIN_BUZZER_1   = 25;   // active buzzer 1
const int PIN_BUZZER_2   = 26;   // active buzzer 2
const int PIN_LED        = 27;   // warning LED (through 220 ohm resistor)
const int PIN_SERVO      = 13;   // door servo signal
const int PIN_RELAY      = 14;   // relay IN (emergency / corridor light)
const int PIN_RESET_BTN  = 4;    // push button to GND
const int PIN_GAS        = 34;   // MQ-2 AO (optional, through a divider: 5V -> 3.3V)

const bool GAS_SENSOR_INSTALLED = false;  // true if you add an MQ-2 gas sensor
const bool RELAY_ACTIVE_LOW     = true;   // most blue relay modules switch ON with LOW

const int DOOR_CLOSED_ANGLE = 0;
const int DOOR_OPEN_ANGLE   = 90;

// Default detection settings. The web page can change them (Settings tab).
struct Settings {
  float    minG;       // minimum vibration for an earthquake (g)
  float    staTrig;    // STA/LTA trigger ratio
  float    staDetrig;  // STA/LTA detrigger ratio
  float    gyroDps;    // rotation that also counts as shaking (deg/s)
  uint32_t minDurMs;   // shaking must last this long (ms)
  uint32_t quietMs;    // calm time before buzzers stop (ms)
  int      gasLimit;   // MQ-2 raw level (0-4095) for a gas alarm
};
Settings cfg = { 0.03f, 3.0f, 1.5f, 25.0f, 800, 15000, 2200 };

const unsigned long TEST_MS          = 6000;          // test alarm length
const unsigned long RESET_IGNORE_MS  = 2000;          // ignore shaking after reset
const unsigned long DOOR_IGNORE_MS   = 1500;          // ignore shaking while servo moves
const unsigned long MAX_QUAKE_MS     = 120000;        // buzzers stop after 2 min anyway
const unsigned long AFTERSHOCK_MS    = 24UL * 3600000UL; // 24 h aftershock watch
const float         AFTERSHOCK_FACTOR = 0.7f;         // threshold x0.7 during the watch
const unsigned long GAS_WARMUP_MS    = 60000;         // MQ-2 heater warm-up
const unsigned long GAS_CONFIRM_MS   = 2000;
const unsigned long CONFIG_PERIOD_MS = 15000;         // read settings from Firebase

const bool DEBUG_SERIAL = true;
const char* FW_VERSION  = "2.0";
// ============================================================================

// MPU6050
const uint8_t MPU_ADDR = 0x68;
const float ACCEL_LSB_PER_G  = 16384.0f;   // +/-2 g
const float GYRO_LSB_PER_DPS = 131.0f;     // +/-250 deg/s

const unsigned long SAMPLE_PERIOD_MS = 10;  // 100 Hz
const unsigned long TRACE_WINDOW_MS  = 100; // 10 seismograph points per second
const float STA_ALPHA     = 1.0f / 100.0f;  // 1 s at 100 Hz
const float LTA_ALPHA     = 1.0f / 3000.0f; // 30 s at 100 Hz
const float NOISE_FLOOR_G = 0.002f;         // MPU6050 noise floor

enum State : uint8_t { ST_CALIBRATING = 0, ST_MONITOR, ST_ALARM, ST_HOLD };
const char* STATE_NAMES[] = { "CALIBRATING", "MONITORING", "ALARM", "HOLD" };
enum Kind : uint8_t { K_QUAKE = 0, K_FIRE = 1 };

// --------------------------- Shared data ------------------------------------
portMUX_TYPE dataMux = portMUX_INITIALIZER_UNLOCKED;

struct LiveData {
  State state;
  bool  quake, fire, test, latched;
  float shake, gyro, sta, ratio, peak, peakAll, tilt;
  int   gas;
  bool  gasWarm, buzzer, led, light, doorOpen, sensorOk;
  uint32_t quakes, fires, aftershocks;
  long  watchLeftS;
};
LiveData live = {};

const int TRACE_LEN = 64;
float    traceRing[TRACE_LEN];
uint32_t traceSeq = 0;

// Event messages: sensor loop -> network task
struct EvMsg { uint8_t type; uint8_t kind; bool test; float peak; float dur; int gas; };
enum { EV_START = 0, EV_END = 1 };
const int EVQ_LEN = 16;
EvMsg    evq[EVQ_LEN];
volatile uint32_t evHead = 0;

volatile uint32_t resetCount = 0;

// Commands from the web page
volatile bool cmdReset = false, cmdTest = false, cmdTestFire = false;
volatile bool cmdCalibrate = false, cmdEndWatch = false;

// --------------------------- Sensor state -----------------------------------
Servo doorServo;
float baseX = 0, baseY = 0, baseZ = 1;          // current gravity vector
float calX = 0, calY = 0, calZ = 1;             // gravity at calibration (tilt reference)
float gyroOffX = 0, gyroOffY = 0, gyroOffZ = 0;
float shakeAvg = 0, gyroAvg = 0, shakeFast = 0;
float sta = 0, lta = NOISE_FLOOR_G;
bool  sensorOk = false;
bool  doorIsOpen = false;

bool quakeActive = false, fireActive = false, testActive = false, latched = false;
uint8_t testKind = K_QUAKE;
unsigned long trigStartMs = 0, quakeStartMs = 0, lastShakeMs = 0;
unsigned long fireCondMs = 0, fireStartMs = 0, lastFireMs = 0;
unsigned long testStartMs = 0, testEndMs = 0;
unsigned long ignoreUntilMs = 0, watchUntilMs = 0;
float quakePeak = 0, peakAll = 0;
int   gasLevel = 0, firePeakGas = 0;
uint32_t quakeCount = 0, fireCount = 0, aftershockCount = 0;
float windowMax = 0;
unsigned long windowStartMs = 0;

// ============================================================================
//                                MPU6050
// ============================================================================
void mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

bool mpuBegin() {
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  Wire.beginTransmission(MPU_ADDR);
  if (Wire.endTransmission() != 0) return false;
  mpuWrite(0x6B, 0x00);  // wake up
  delay(100);
  mpuWrite(0x1A, 0x03);  // low-pass filter ~44 Hz
  mpuWrite(0x1B, 0x00);  // gyro +/-250 deg/s
  mpuWrite(0x1C, 0x00);  // accel +/-2 g
  return true;
}

bool mpuRead(float& ax, float& ay, float& az, float& gx, float& gy, float& gz) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)MPU_ADDR, 14) != 14) return false;
  int16_t raw[7];
  for (int i = 0; i < 7; i++) raw[i] = (int16_t)((Wire.read() << 8) | Wire.read());
  ax = raw[0] / ACCEL_LSB_PER_G;  ay = raw[1] / ACCEL_LSB_PER_G;  az = raw[2] / ACCEL_LSB_PER_G;
  gx = raw[4] / GYRO_LSB_PER_DPS; gy = raw[5] / GYRO_LSB_PER_DPS; gz = raw[6] / GYRO_LSB_PER_DPS;
  return true;
}

// Keep the sensor still for about 2 seconds.
void calibrate() {
  portENTER_CRITICAL(&dataMux); live.state = ST_CALIBRATING; portEXIT_CRITICAL(&dataMux);
  Serial.println("Calibrating... keep the sensor still.");
  for (int attempt = 0; attempt < 5; attempt++) {
    const int N = 200;
    static float bx[N], by[N], bz[N];
    float sx = 0, sy = 0, sz = 0, sgx = 0, sgy = 0, sgz = 0;
    int good = 0;
    for (int i = 0; i < N; i++) {
      float x, y, z, gx, gy, gz;
      if (mpuRead(x, y, z, gx, gy, gz)) {
        bx[good] = x; by[good] = y; bz[good] = z;
        sx += x; sy += y; sz += z; sgx += gx; sgy += gy; sgz += gz;
        good++;
      }
      digitalWrite(PIN_LED, (i / 20) % 2);
      delay(SAMPLE_PERIOD_MS);
    }
    if (good < N / 2) continue;
    baseX = sx / good; baseY = sy / good; baseZ = sz / good;
    gyroOffX = sgx / good; gyroOffY = sgy / good; gyroOffZ = sgz / good;
    float noise = 0;
    for (int i = 0; i < good; i++) {
      float dx = bx[i] - baseX, dy = by[i] - baseY, dz = bz[i] - baseZ;
      noise += sqrtf(dx * dx + dy * dy + dz * dz);
    }
    noise /= good;
    Serial.printf("Calibration noise: %.4f g\n", noise);
    lta = fmaxf(noise, NOISE_FLOOR_G);
    if (noise < 0.02f) break;
    Serial.println("Too much movement, calibrating again...");
  }
  calX = baseX; calY = baseY; calZ = baseZ;
  digitalWrite(PIN_LED, LOW);
  shakeAvg = gyroAvg = shakeFast = 0;
  sta = 0;
}

float tiltDegrees() {
  float n1 = sqrtf(calX * calX + calY * calY + calZ * calZ);
  float n2 = sqrtf(baseX * baseX + baseY * baseY + baseZ * baseZ);
  if (n1 < 0.1f || n2 < 0.1f) return 0;
  float c = (calX * baseX + calY * baseY + calZ * baseZ) / (n1 * n2);
  c = fminf(1.0f, fmaxf(-1.0f, c));
  return acosf(c) * 57.2958f;
}

// Modified Mercalli intensity from peak acceleration (Worden et al. 2012)
float mmiFromG(float g) {
  float L = log10f(fmaxf(g * 980.665f, 0.01f));
  float m = (L <= 1.57f) ? 1.78f + 1.55f * L : -1.60f + 3.70f * L;
  return fminf(10.0f, fmaxf(1.0f, m));
}
const char* ROMAN[] = { "I", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X" };

// ============================================================================
//                               Outputs
// ============================================================================
void setRelay(bool on)   { digitalWrite(PIN_RELAY, (on != RELAY_ACTIVE_LOW) ? HIGH : LOW); }
void setBuzzers(bool on) { digitalWrite(PIN_BUZZER_1, on); digitalWrite(PIN_BUZZER_2, on); }

void setDoor(bool open, unsigned long now) {
  if (open == doorIsOpen) return;
  doorServo.write(open ? DOOR_OPEN_ANGLE : DOOR_CLOSED_ANGLE);
  doorIsOpen = open;
  ignoreUntilMs = max(ignoreUntilMs, now + DOOR_IGNORE_MS);   // servo vibration is not a quake
}

State currentState() {
  if (quakeActive || fireActive || testActive) return ST_ALARM;
  if (latched) return ST_HOLD;
  return ST_MONITOR;
}

// ============================================================================
//                              Events
// ============================================================================
void pushEvent(uint8_t type, uint8_t kind, bool test, float peak, float dur, int gas) {
  portENTER_CRITICAL(&dataMux);
  evq[evHead % EVQ_LEN] = { type, kind, test, peak, dur, gas };
  evHead = evHead + 1;
  portEXIT_CRITICAL(&dataMux);
}

void endTest(unsigned long now) {
  if (!testActive) return;
  testActive = false;
  pushEvent(EV_END, testKind, true, 0, (now - testStartMs) / 1000.0f, 0);
}

void startQuake(unsigned long now) {
  endTest(now);
  quakeActive = true;
  latched = true;
  quakeStartMs = lastShakeMs = now;
  quakePeak = shakeFast;
  quakeCount++;
  if ((long)(watchUntilMs - now) > 0) aftershockCount++;
  pushEvent(EV_START, K_QUAKE, false, quakePeak, 0, 0);
  Serial.println(">>> EARTHQUAKE DETECTED — ALARM ON");
}

void endQuake(unsigned long now) {
  if (!quakeActive) return;
  quakeActive = false;
  pushEvent(EV_END, K_QUAKE, false, quakePeak, (lastShakeMs - quakeStartMs) / 1000.0f, 0);
  watchUntilMs = now + AFTERSHOCK_MS;
  Serial.println(">>> Shaking stopped — aftershock watch started (24 h)");
}

void startFire(unsigned long now) {
  endTest(now);
  fireActive = true;
  latched = true;
  fireStartMs = lastFireMs = now;
  firePeakGas = gasLevel;
  fireCount++;
  pushEvent(EV_START, K_FIRE, false, 0, 0, gasLevel);
  Serial.println(">>> GAS / FIRE DETECTED — ALARM ON");
}

void endFire(unsigned long now) {
  if (!fireActive) return;
  fireActive = false;
  pushEvent(EV_END, K_FIRE, false, 0, (lastFireMs - fireStartMs) / 1000.0f, firePeakGas);
}

void startTest(unsigned long now, uint8_t kind) {
  if (currentState() != ST_MONITOR) return;
  testActive = true;
  testKind = kind;
  testStartMs = now;
  testEndMs = now + TEST_MS;
  pushEvent(EV_START, kind, true, 0, 0, 0);
  Serial.println(kind == K_FIRE ? ">>> FIRE TEST" : ">>> EARTHQUAKE TEST");
}

void resetSystem(unsigned long now) {
  endQuake(now);
  endFire(now);
  endTest(now);
  latched = false;
  trigStartMs = 0;
  fireCondMs = 0;
  ignoreUntilMs = now + RESET_IGNORE_MS;
  resetCount = resetCount + 1;
  Serial.println(">>> System reset — monitoring");
}

// ============================================================================
//                    Network task (core 0)
// ============================================================================
WiFiClientSecure secureClient;

bool cloudConfigured() {
  return strstr(WIFI_SSID, "YOUR_") == nullptr && strstr(FIREBASE_URL, "YOUR-PROJECT") == nullptr;
}

String fbUrl(const String& path) {
  String url = String(FIREBASE_URL) + DB_PATH + path + ".json";
  if (strlen(FIREBASE_AUTH) > 0) url += "?auth=" + String(FIREBASE_AUTH);
  return url;
}

int fbRequest(const char* method, const String& path, const String& body, String* response) {
  HTTPClient http;
  http.setTimeout(6000);
  if (!http.begin(secureClient, fbUrl(path))) return -1;
  http.addHeader("Content-Type", "application/json");
  int code = (strcmp(method, "GET") == 0) ? http.GET() : http.sendRequest(method, body);
  if (response && code > 0) *response = http.getString();
  http.end();
  return code;
}

String urlEncode(const String& s) {
  String out;
  const char* hex = "0123456789ABCDEF";
  for (size_t i = 0; i < s.length(); i++) {
    uint8_t c = s[i];
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') out += (char)c;
    else { out += '%'; out += hex[c >> 4]; out += hex[c & 15]; }
  }
  return out;
}

void sendAlert(const String& title, const String& text) {
  if (strlen(TELEGRAM_BOT_TOKEN) > 0 && strlen(TELEGRAM_CHAT_ID) > 0) {
    HTTPClient http;
    http.setTimeout(8000);
    String url = String("https://api.telegram.org/bot") + TELEGRAM_BOT_TOKEN +
                 "/sendMessage?chat_id=" + TELEGRAM_CHAT_ID + "&text=" + urlEncode(title + "\n" + text);
    if (http.begin(secureClient, url)) { http.GET(); http.end(); }
  }
  if (strlen(NTFY_TOPIC) > 0) {
    HTTPClient http;
    http.setTimeout(8000);
    if (http.begin(secureClient, String("https://ntfy.sh/") + NTFY_TOPIC)) {
      http.addHeader("Title", title);
      http.addHeader("Priority", "urgent");
      http.addHeader("Tags", "warning,rotating_light");
      http.POST(text);
      http.end();
    }
  }
}

// Reads  "key": number  from a small JSON text.
bool jsonNumber(const String& s, const char* key, float& out) {
  String k = String("\"") + key + "\":";
  int p = s.indexOf(k);
  if (p < 0) return false;
  p += k.length();
  while (p < (int)s.length() && s[p] == ' ') p++;
  int q = p;
  while (q < (int)s.length() && (isdigit(s[q]) || s[q] == '.' || s[q] == '-' || s[q] == 'e' || s[q] == 'E' || s[q] == '+')) q++;
  if (q == p) return false;
  out = s.substring(p, q).toFloat();
  return true;
}

String settingsJson(const Settings& c) {
  return String("{\"minG\":") + String(c.minG, 3) +
         ",\"staTrig\":" + String(c.staTrig, 2) +
         ",\"staDetrig\":" + String(c.staDetrig, 2) +
         ",\"gyroDps\":" + String(c.gyroDps, 1) +
         ",\"minDur\":" + String(c.minDurMs / 1000.0f, 2) +
         ",\"quiet\":" + String(c.quietMs / 1000.0f, 1) +
         ",\"gasLimit\":" + String(c.gasLimit) + "}";
}

void readConfig() {
  String resp;
  if (fbRequest("GET", "/config", "", &resp) != 200) return;
  Settings c;
  portENTER_CRITICAL(&dataMux); c = cfg; portEXIT_CRITICAL(&dataMux);
  if (resp == "null") {                         // first start: publish defaults
    fbRequest("PUT", "/config", settingsJson(c), nullptr);
    return;
  }
  float v;
  if (jsonNumber(resp, "minG", v)      && v >= 0.005f && v <= 1.5f)  c.minG = v;
  if (jsonNumber(resp, "staTrig", v)   && v >= 1.2f   && v <= 20)    c.staTrig = v;
  if (jsonNumber(resp, "staDetrig", v) && v >= 1.0f   && v <= 10)    c.staDetrig = v;
  if (jsonNumber(resp, "gyroDps", v)   && v >= 5      && v <= 250)   c.gyroDps = v;
  if (jsonNumber(resp, "minDur", v)    && v >= 0.1f   && v <= 10)    c.minDurMs = (uint32_t)(v * 1000);
  if (jsonNumber(resp, "quiet", v)     && v >= 3      && v <= 600)   c.quietMs = (uint32_t)(v * 1000);
  if (jsonNumber(resp, "gasLimit", v)  && v >= 100    && v <= 4095)  c.gasLimit = (int)v;
  if (c.staDetrig >= c.staTrig) c.staDetrig = c.staTrig * 0.6f;
  portENTER_CRITICAL(&dataMux); cfg = c; portEXIT_CRITICAL(&dataMux);
}

const char* kindName(uint8_t k) { return k == K_FIRE ? "fire" : "quake"; }

void networkTask(void*) {
  secureClient.setInsecure();   // simple setup: skip certificate check

  String eventKey[2] = { "", "" };
  uint32_t evTail = 0, handledResets = 0;
  uint32_t lastTraceSent = 0;
  unsigned long lastLive = 0, lastCmd = 0, lastWifiTry = 0, lastConfig = 0;
  bool configLoaded = false;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  for (;;) {
    unsigned long now = millis();
    if (WiFi.status() != WL_CONNECTED) {
      if (now - lastWifiTry > 10000) { lastWifiTry = now; WiFi.disconnect(); WiFi.begin(WIFI_SSID, WIFI_PASSWORD); }
      vTaskDelay(pdMS_TO_TICKS(200));
      continue;
    }

    // ---- Settings from the web page
    if (!configLoaded || now - lastConfig >= CONFIG_PERIOD_MS) {
      lastConfig = now;
      configLoaded = true;
      readConfig();
    }

    // ---- Events
    while (evTail != evHead) {
      EvMsg m;
      portENTER_CRITICAL(&dataMux); m = evq[evTail % EVQ_LEN]; portEXIT_CRITICAL(&dataMux);
      evTail++;
      if (m.type == EV_START) {
        String body = String("{\"kind\":\"") + kindName(m.kind) + "\",\"test\":" + (m.test ? "true" : "false") +
                      ",\"floor\":\"" + FLOOR_NAME + "\",\"status\":\"active\",\"peak\":" + String(m.peak, 4) +
                      ",\"gas\":" + String(m.gas) + ",\"start\":{\".sv\":\"timestamp\"}}";
        String resp;
        int code = fbRequest("POST", "/events", body, &resp);
        eventKey[m.kind] = "";
        int p = resp.indexOf("\"name\":\"");
        if (code == 200 && p >= 0) eventKey[m.kind] = resp.substring(p + 8, resp.indexOf('"', p + 8));
        if (!m.test) {
          if (m.kind == K_FIRE) sendAlert(String("QuakeGuard: GAS / FIRE on ") + FLOOR_NAME,
                                          "Gas level " + String(m.gas) + ". Exit door open, emergency lights on. Leave by the stairs.");
          else sendAlert(String("QuakeGuard: EARTHQUAKE on ") + FLOOR_NAME,
                         "Shaking detected. Drop, cover and hold on. Exit door open, emergency lights on.");
        }
      } else {
        if (eventKey[m.kind].length() > 0) {
          String body = String("{\"status\":\"ended\",\"peak\":") + String(m.peak, 4) +
                        ",\"duration\":" + String(m.dur, 1) + ",\"gas\":" + String(m.gas) +
                        ",\"end\":{\".sv\":\"timestamp\"}}";
          fbRequest("PATCH", "/events/" + eventKey[m.kind], body, nullptr);
        }
        if (!m.test && m.kind == K_QUAKE) {
          float mmi = mmiFromG(m.peak);
          sendAlert(String("QuakeGuard: shaking stopped on ") + FLOOR_NAME,
                    "Lasted " + String(m.dur, 0) + " s. Peak " + String(m.peak, 3) + " g, intensity " +
                    ROMAN[(int)roundf(mmi)] + ". Expect aftershocks. Door stays open until reset.");
        }
      }
    }

    // ---- After a reset: clear the "I'm safe" list
    if (handledResets != resetCount) {
      handledResets = resetCount;
      fbRequest("DELETE", "/safe", "", nullptr);
    }

    // ---- Live status
    LiveData s;
    float trace[20];
    int traceCount = 0;
    uint32_t seq;
    Settings c;
    portENTER_CRITICAL(&dataMux);
    s = live;
    c = cfg;
    seq = traceSeq;
    uint32_t pending = seq - lastTraceSent;
    if (pending > 20) pending = 20;
    for (uint32_t i = seq - pending; i < seq; i++) trace[traceCount++] = traceRing[i % TRACE_LEN];
    portEXIT_CRITICAL(&dataMux);

    if (now - lastLive >= (s.state == ST_ALARM ? 500UL : 1000UL)) {
      lastLive = now;
      lastTraceSent = seq;
      String t = "[";
      for (int i = 0; i < traceCount; i++) { if (i) t += ","; t += String(trace[i], 4); }
      t += "]";
      auto b = [](bool v) { return v ? "true" : "false"; };
      String body = String("{") +
        "\"fw\":\"" + FW_VERSION + "\"," +
        "\"floor\":\"" + FLOOR_NAME + "\"," +
        "\"state\":\"" + STATE_NAMES[s.state] + "\"," +
        "\"alarm\":" + b(s.state == ST_ALARM || s.state == ST_HOLD) + "," +
        "\"quake\":" + b(s.quake) + ",\"fire\":" + b(s.fire) + ",\"test\":" + b(s.test) + "," +
        "\"shake\":" + String(s.shake, 4) + ",\"gyro\":" + String(s.gyro, 2) + "," +
        "\"sta\":" + String(s.sta, 4) + ",\"ratio\":" + String(s.ratio, 2) + "," +
        "\"peak\":" + String(s.peak, 4) + ",\"peakAll\":" + String(s.peakAll, 4) + "," +
        "\"tilt\":" + String(s.tilt, 2) + "," +
        "\"threshold\":" + String(c.minG, 3) + ",\"staTrig\":" + String(c.staTrig, 2) +
        ",\"staDetrig\":" + String(c.staDetrig, 2) + ",\"minDur\":" + String(c.minDurMs / 1000.0f, 2) + "," +
        "\"gasEnabled\":" + b(GAS_SENSOR_INSTALLED) + ",\"gas\":" + String(s.gas) + ",\"gasLimit\":" + String(c.gasLimit) +
        ",\"gasWarm\":" + b(s.gasWarm) + "," +
        "\"buzzer\":" + b(s.buzzer) + ",\"led\":" + b(s.led) + ",\"light\":" + b(s.light) + "," +
        "\"door\":\"" + (s.doorOpen ? "open" : "closed") + "\"," +
        "\"sensorOk\":" + b(s.sensorOk) + "," +
        "\"quakes\":" + String(s.quakes) + ",\"fires\":" + String(s.fires) + "," +
        "\"aftershocks\":" + String(s.aftershocks) + ",\"watchLeft\":" + String(s.watchLeftS) + "," +
        "\"uptime\":" + String(now / 1000) + ",\"rssi\":" + String(WiFi.RSSI()) + ",\"heap\":" + String(ESP.getFreeHeap()) + "," +
        "\"traceSeq\":" + String(seq) + ",\"trace\":" + t + "," +
        "\"updated\":{\".sv\":\"timestamp\"}}";
      fbRequest("PUT", "/live", body, nullptr);
    }

    // ---- Commands from the web page
    if (now - lastCmd >= 1500) {
      lastCmd = now;
      String resp;
      if (fbRequest("GET", "/command", "", &resp) == 200 && resp != "null" && resp.indexOf("none") < 0) {
        if (resp.indexOf("testfire") >= 0) cmdTestFire = true;
        else if (resp.indexOf("test") >= 0) cmdTest = true;
        else if (resp.indexOf("reset") >= 0) cmdReset = true;
        else if (resp.indexOf("calibrate") >= 0) cmdCalibrate = true;
        else if (resp.indexOf("endwatch") >= 0) cmdEndWatch = true;
        fbRequest("PUT", "/command", "\"none\"", nullptr);
      }
    }

    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

// ============================================================================
//                                 Setup
// ============================================================================
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.printf("\n=== QuakeGuard v%s — %s ===\n", FW_VERSION, FLOOR_NAME);

  setRelay(false);
  pinMode(PIN_RELAY, OUTPUT);
  setRelay(false);
  pinMode(PIN_BUZZER_1, OUTPUT);
  pinMode(PIN_BUZZER_2, OUTPUT);
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_RESET_BTN, INPUT_PULLUP);
  setBuzzers(false);
  digitalWrite(PIN_LED, LOW);
  if (GAS_SENSOR_INSTALLED) analogSetPinAttenuation(PIN_GAS, ADC_11db);

  ESP32PWM::allocateTimer(0);
  doorServo.setPeriodHertz(50);
  doorServo.attach(PIN_SERVO, 500, 2400);
  doorServo.write(DOOR_CLOSED_ANGLE);
  doorIsOpen = false;

  setBuzzers(true); delay(120); setBuzzers(false);   // power-on beep

  sensorOk = mpuBegin();
  if (!sensorOk) Serial.println("ERROR: MPU6050 not found. Check SDA=21, SCL=22, VCC=3.3V, GND.");
  else calibrate();

  live.state = ST_MONITOR;
  live.sensorOk = sensorOk;
  live.gasWarm = GAS_SENSOR_INSTALLED;
  windowStartMs = millis();

  if (cloudConfigured()) {
    xTaskCreatePinnedToCore(networkTask, "network", 16384, nullptr, 1, nullptr, 0);
    Serial.println("Cloud sync: ON (Firebase)");
  } else {
    Serial.println("Cloud sync: OFF — set Wi-Fi and Firebase in USER SETTINGS. Alarm still works.");
  }
  Serial.println("Monitoring...");
}

// ============================================================================
//                         Main loop (core 1, 100 Hz)
// ============================================================================
void loop() {
  static unsigned long lastSample = 0, lastDebug = 0, btnDownMs = 0, lastSensorRetry = 0, lastGasRead = 0;
  static int readFails = 0;

  unsigned long now = millis();
  if (now - lastSample < SAMPLE_PERIOD_MS) return;
  lastSample = now;

  Settings c;
  portENTER_CRITICAL(&dataMux); c = cfg; portEXIT_CRITICAL(&dataMux);
  bool watch = (long)(watchUntilMs - now) > 0;
  float minG = c.minG * (watch ? AFTERSHOCK_FACTOR : 1.0f);

  // ---------- Motion sensor
  float ax, ay, az, gx, gy, gz;
  float shakeNow = 0, gyroNow = 0;
  if (sensorOk && mpuRead(ax, ay, az, gx, gy, gz)) {
    readFails = 0;
    float dx = ax - baseX, dy = ay - baseY, dz = az - baseZ;
    shakeNow = sqrtf(dx * dx + dy * dy + dz * dz);
    float rx = gx - gyroOffX, ry = gy - gyroOffY, rz = gz - gyroOffZ;
    gyroNow = sqrtf(rx * rx + ry * ry + rz * rz);
    shakeFast += 0.25f * (shakeNow - shakeFast);   // for peak values
    shakeAvg  += 0.08f * (shakeNow - shakeAvg);    // ~0.25 s
    gyroAvg   += 0.08f * (gyroNow - gyroAvg);
    sta       += STA_ALPHA * (shakeNow - sta);     // 1 s
    if (!quakeActive && trigStartMs == 0) {
      lta += LTA_ALPHA * (shakeNow - lta);         // 30 s, frozen while triggered
      if (shakeAvg < minG * 0.5f) {                // follow gravity slowly when calm
        baseX += 0.002f * (ax - baseX);
        baseY += 0.002f * (ay - baseY);
        baseZ += 0.002f * (az - baseZ);
      }
    }
  } else if (sensorOk) {
    if (++readFails > 50) { sensorOk = false; Serial.println("ERROR: lost connection to MPU6050"); }
  } else if (now - lastSensorRetry > 3000) {
    lastSensorRetry = now;
    if (mpuBegin()) { sensorOk = true; calibrate(); }
  }
  float ratio = sta / fmaxf(lta, NOISE_FLOOR_G);

  // ---------- Earthquake detection (STA/LTA + minimum g + duration)
  bool trig = sensorOk && ((ratio >= c.staTrig && sta >= minG) ||
                           shakeAvg >= minG * 3.0f ||
                           gyroAvg >= c.gyroDps);
  if ((long)(ignoreUntilMs - now) > 0) trig = false;
  if (trig) {
    if (trigStartMs == 0) trigStartMs = now;
    if (!quakeActive && now - trigStartMs >= c.minDurMs) startQuake(now);
  } else {
    trigStartMs = 0;
  }
  if (quakeActive) {
    bool still = (ratio >= c.staDetrig && sta >= minG * 0.5f) || shakeAvg >= minG || gyroAvg >= c.gyroDps * 0.6f;
    if (still) lastShakeMs = now;
    if (shakeFast > quakePeak) quakePeak = shakeFast;
    if (quakePeak > peakAll) peakAll = quakePeak;
    if (now - lastShakeMs >= c.quietMs || now - quakeStartMs >= MAX_QUAKE_MS) endQuake(now);
  }

  // ---------- Gas / fire (optional MQ-2)
  bool gasWarm = false;
  if (GAS_SENSOR_INSTALLED) {
    if (now - lastGasRead >= 100) {
      lastGasRead = now;
      int sum = 0;
      for (int i = 0; i < 4; i++) sum += analogRead(PIN_GAS);
      gasLevel = sum / 4;
    }
    gasWarm = now < GAS_WARMUP_MS;
    bool gasHigh = !gasWarm && gasLevel > c.gasLimit;
    if (gasHigh && (long)(ignoreUntilMs - now) <= 0) {
      if (fireCondMs == 0) fireCondMs = now;
      if (!fireActive && now - fireCondMs >= GAS_CONFIRM_MS) startFire(now);
    } else if (!gasHigh) {
      fireCondMs = 0;
    }
    if (fireActive) {
      if (gasLevel > c.gasLimit * 0.9f) lastFireMs = now;
      if (gasLevel > firePeakGas) firePeakGas = gasLevel;
      if (now - lastFireMs >= c.quietMs) endFire(now);
    }
  }

  // ---------- Test alarm
  if (testActive && now >= testEndMs) endTest(now);

  // ---------- Reset button
  if (digitalRead(PIN_RESET_BTN) == LOW) {
    if (btnDownMs == 0) btnDownMs = now;
    if (now - btnDownMs > 50 && currentState() != ST_MONITOR) resetSystem(now);
  } else {
    btnDownMs = 0;
  }

  // ---------- Commands from the web page
  if (cmdReset)    { cmdReset = false;    if (currentState() != ST_MONITOR) resetSystem(now); }
  if (cmdTest)     { cmdTest = false;     startTest(now, K_QUAKE); }
  if (cmdTestFire) { cmdTestFire = false; startTest(now, K_FIRE); }
  if (cmdEndWatch) { cmdEndWatch = false; watchUntilMs = now; aftershockCount = 0; }
  if (cmdCalibrate) {
    cmdCalibrate = false;
    if (currentState() == ST_MONITOR && sensorOk) { calibrate(); now = millis(); ignoreUntilMs = now + RESET_IGNORE_MS; }
  }

  // ---------- Outputs
  State st = currentState();
  bool alarm = (st == ST_ALARM), hold = (st == ST_HOLD);
  bool fireSiren = fireActive || (testActive && testKind == K_FIRE);
  bool buzzerOn = alarm && (fireSiren ? ((now / 150) % 2 == 0) : ((now / 250) % 3 != 2));
  setBuzzers(buzzerOn);
  digitalWrite(PIN_LED, (alarm || hold) ? HIGH : LOW);
  setRelay(alarm || hold);
  setDoor(alarm || hold, now);

  // ---------- Seismograph trace (max of each 100 ms window)
  if (shakeNow > windowMax) windowMax = shakeNow;
  bool windowDone = now - windowStartMs >= TRACE_WINDOW_MS;
  float tilt = windowDone ? tiltDegrees() : live.tilt;

  portENTER_CRITICAL(&dataMux);
  live.state = st;
  live.quake = quakeActive || (testActive && testKind == K_QUAKE);
  live.fire  = fireActive  || (testActive && testKind == K_FIRE);
  live.test  = testActive;
  live.latched = latched;
  live.shake = shakeAvg;   live.gyro = gyroAvg;
  live.sta = sta;          live.ratio = ratio;
  live.peak = quakePeak;   live.peakAll = peakAll;
  live.tilt = tilt;
  live.gas = gasLevel;     live.gasWarm = gasWarm;
  live.buzzer = alarm;     live.led = alarm || hold;  live.light = alarm || hold;
  live.doorOpen = doorIsOpen;
  live.sensorOk = sensorOk;
  live.quakes = quakeCount; live.fires = fireCount; live.aftershocks = aftershockCount;
  live.watchLeftS = watch ? (long)((watchUntilMs - now) / 1000) : 0;
  if (windowDone) { traceRing[traceSeq % TRACE_LEN] = windowMax; traceSeq++; }
  portEXIT_CRITICAL(&dataMux);
  if (windowDone) { windowMax = 0; windowStartMs = now; }

  // ---------- Serial output for tuning
  if (DEBUG_SERIAL && now - lastDebug >= 250) {
    lastDebug = now;
    Serial.printf("shake=%.4f g  sta=%.4f  ratio=%5.2f  gyro=%6.2f dps  tilt=%.2f  gas=%d  state=%s\n",
                  shakeAvg, sta, ratio, gyroAvg, tilt, gasLevel, STATE_NAMES[st]);
  }
}
