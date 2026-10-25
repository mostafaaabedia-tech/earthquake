/*
  ============================================================================
   Earthquake Detection & Response System  —  ESP32 + MPU6050
  ============================================================================
   When the MPU6050 (gyroscope + accelerometer) senses earthquake-like shaking:
     • both buzzers sound (siren pattern)
     • the warning LED turns on
     • the servo rotates to OPEN the door (evacuation route)
     • the relay switches the emergency light ON
     • the event is sent to Firebase and shown on the GitHub web page

   Behaviour
     MONITORING -> shaking lasts > CONFIRM_MS           -> ALARM
     ALARM      -> calm for QUIET_MS                    -> HOLD
                   (buzzers stop; LED, door and light stay on for safety)
     HOLD       -> shaking again                        -> ALARM (new event)
     ALARM/HOLD -> reset button or "Reset" on web page  -> MONITORING
                   (door closes, light, LED and buzzers off)

   The alarm reacts locally on core 1. Wi-Fi / Firebase run on core 0, so the
   alarm never waits for the internet and still works with no Wi-Fi at all.

   Libraries (Arduino IDE -> Library Manager):  ESP32Servo  (by Kevin Harrington)
   Board: "ESP32 Dev Module"   (ESP32 Arduino core 2.x or 3.x)
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
const char* FIREBASE_URL  = "https://YOUR-PROJECT-default-rtdb.firebaseio.com";
// Leave empty when the database rules allow access (see README).
// Otherwise put the database secret here.
const char* FIREBASE_AUTH = "";

// ------------------------------ Pins ---------------------------------------
const int PIN_SDA        = 21;   // MPU6050 SDA
const int PIN_SCL        = 22;   // MPU6050 SCL
const int PIN_BUZZER_1   = 25;   // active buzzer 1
const int PIN_BUZZER_2   = 26;   // active buzzer 2
const int PIN_LED        = 27;   // warning LED (through 220 ohm resistor)
const int PIN_SERVO      = 13;   // door servo signal
const int PIN_RELAY      = 14;   // relay IN (emergency light)
const int PIN_RESET_BTN  = 4;    // push button to GND (optional)

const bool RELAY_ACTIVE_LOW = true;   // most blue relay modules switch ON with LOW

// ----------------------------- Door servo ----------------------------------
const int DOOR_CLOSED_ANGLE = 0;
const int DOOR_OPEN_ANGLE   = 90;

// ----------------------------- Detection -----------------------------------
// Raise these numbers if the alarm triggers too easily, lower them for more
// sensitivity. Open Serial Monitor (115200) to see live values while tuning.
const float SHAKE_THRESHOLD_G  = 0.06f;  // average vibration, in g
const float GYRO_THRESHOLD_DPS = 25.0f;  // average rotation, in degrees/second
const unsigned long CONFIRM_MS = 300;    // shaking must last this long (ignores single knocks)
const unsigned long QUIET_MS   = 15000;  // calm time before buzzers stop
const unsigned long TEST_MS    = 5000;   // length of a test run from the web page
const unsigned long RESET_IGNORE_MS = 2000; // ignore shaking right after a reset

const bool DEBUG_SERIAL = true;
// ============================================================================

// MPU6050 registers
const uint8_t MPU_ADDR      = 0x68;
const uint8_t REG_PWR_MGMT  = 0x6B;
const uint8_t REG_CONFIG    = 0x1A;
const uint8_t REG_GYRO_CFG  = 0x1B;
const uint8_t REG_ACCEL_CFG = 0x1C;
const uint8_t REG_DATA      = 0x3B;
const uint8_t REG_WHO_AM_I  = 0x75;
const float   ACCEL_LSB_PER_G   = 16384.0f;  // +/-2 g range
const float   GYRO_LSB_PER_DPS  = 131.0f;    // +/-250 deg/s range

const unsigned long SAMPLE_PERIOD_MS = 10;   // 100 Hz
const unsigned long TRACE_WINDOW_MS  = 100;  // one seismograph point per 100 ms

enum State : uint8_t { ST_CALIBRATING = 0, ST_MONITOR, ST_ALARM, ST_HOLD };
const char* STATE_NAMES[] = { "CALIBRATING", "MONITORING", "ALARM", "HOLD" };

// --------------------------- Shared data ------------------------------------
// Written by the sensor loop (core 1), read by the network task (core 0).
portMUX_TYPE dataMux = portMUX_INITIALIZER_UNLOCKED;

struct LiveData {
  State state;
  float shake;        // current vibration level (g)
  float gyro;         // current rotation (deg/s)
  float peak;         // peak vibration of the current / last event (g)
  bool  buzzer, led, light, doorOpen, testRun, sensorOk;
  uint32_t eventCount;
};
LiveData live = { ST_CALIBRATING, 0, 0, 0, false, false, false, false, false, false, 0 };

const int TRACE_LEN = 64;
float    traceRing[TRACE_LEN];
uint32_t traceSeq = 0;               // total trace points written

// Event hand-off to the network task
volatile uint32_t eventStartCount = 0;
volatile uint32_t eventEndCount   = 0;
volatile bool     eventIsTest     = false;
volatile float    eventPeak       = 0;
volatile float    eventDurationS  = 0;

// Commands coming from the web page
volatile bool cmdReset = false;
volatile bool cmdTest  = false;

// --------------------------- Sensor state -----------------------------------
Servo doorServo;
float baseX = 0, baseY = 0, baseZ = 1;        // gravity vector (g)
float gyroOffX = 0, gyroOffY = 0, gyroOffZ = 0;
float shakeAvg = 0, gyroAvg = 0;              // short-term averages
State state = ST_CALIBRATING;

unsigned long shakeStartMs  = 0;
unsigned long lastShakeMs   = 0;
unsigned long eventStartMs  = 0;
unsigned long ignoreUntilMs = 0;
unsigned long testEndMs     = 0;
bool  testRun   = false;
bool  doorIsOpen = false;
float peakShake = 0;
float windowMax = 0;
unsigned long windowStartMs = 0;
uint32_t eventCount = 0;
bool sensorOk = false;

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

  mpuWrite(REG_PWR_MGMT, 0x00);   // wake up
  delay(100);
  mpuWrite(REG_CONFIG, 0x03);     // digital low-pass filter ~44 Hz
  mpuWrite(REG_GYRO_CFG, 0x00);   // +/-250 deg/s
  mpuWrite(REG_ACCEL_CFG, 0x00);  // +/-2 g

  Wire.beginTransmission(MPU_ADDR);
  Wire.write(REG_WHO_AM_I);
  Wire.endTransmission(false);
  Wire.requestFrom((int)MPU_ADDR, 1);
  if (Wire.available()) {
    uint8_t id = Wire.read();
    Serial.printf("MPU6050 WHO_AM_I = 0x%02X\n", id);  // clones may report 0x70/0x72/0x98
  }
  return true;
}

// Reads acceleration in g and rotation in deg/s. Returns false on I2C error.
bool mpuRead(float& ax, float& ay, float& az, float& gx, float& gy, float& gz) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(REG_DATA);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)MPU_ADDR, 14) != 14) return false;

  int16_t raw[7];
  for (int i = 0; i < 7; i++) raw[i] = (int16_t)((Wire.read() << 8) | Wire.read());
  ax = raw[0] / ACCEL_LSB_PER_G;
  ay = raw[1] / ACCEL_LSB_PER_G;
  az = raw[2] / ACCEL_LSB_PER_G;
  // raw[3] is temperature
  gx = raw[4] / GYRO_LSB_PER_DPS;
  gy = raw[5] / GYRO_LSB_PER_DPS;
  gz = raw[6] / GYRO_LSB_PER_DPS;
  return true;
}

// Keep the sensor still during calibration (about 2 seconds).
void calibrate() {
  Serial.println("Calibrating... keep the sensor still.");
  for (int attempt = 0; attempt < 5; attempt++) {
    const int N = 200;
    float sx = 0, sy = 0, sz = 0, sgx = 0, sgy = 0, sgz = 0;
    float ax[N], ay[N], az[N];
    int good = 0;
    for (int i = 0; i < N; i++) {
      float x, y, z, gx, gy, gz;
      if (mpuRead(x, y, z, gx, gy, gz)) {
        ax[good] = x; ay[good] = y; az[good] = z;
        sx += x; sy += y; sz += z; sgx += gx; sgy += gy; sgz += gz;
        good++;
      }
      // blink LED while calibrating
      digitalWrite(PIN_LED, (i / 20) % 2);
      delay(SAMPLE_PERIOD_MS);
    }
    if (good < N / 2) continue;
    baseX = sx / good; baseY = sy / good; baseZ = sz / good;
    gyroOffX = sgx / good; gyroOffY = sgy / good; gyroOffZ = sgz / good;

    // Check it was really still
    float noise = 0;
    for (int i = 0; i < good; i++) {
      float dx = ax[i] - baseX, dy = ay[i] - baseY, dz = az[i] - baseZ;
      noise += sqrtf(dx * dx + dy * dy + dz * dz);
    }
    noise /= good;
    Serial.printf("Calibration noise: %.4f g\n", noise);
    if (noise < 0.02f) break;
    Serial.println("Too much movement, calibrating again...");
  }
  digitalWrite(PIN_LED, LOW);
  shakeAvg = 0;
  gyroAvg = 0;
}

// ============================================================================
//                               Outputs
// ============================================================================
void setRelay(bool on) {
  digitalWrite(PIN_RELAY, (on != RELAY_ACTIVE_LOW) ? HIGH : LOW);
}

void setBuzzers(bool on) {
  digitalWrite(PIN_BUZZER_1, on ? HIGH : LOW);
  digitalWrite(PIN_BUZZER_2, on ? HIGH : LOW);
}

void setDoor(bool open) {
  if (open == doorIsOpen) return;
  doorServo.write(open ? DOOR_OPEN_ANGLE : DOOR_CLOSED_ANGLE);
  doorIsOpen = open;
}

// Applies the outputs that belong to the current state.
void applyOutputs(unsigned long now, bool& buzzerOn, bool& ledOn, bool& lightOn) {
  switch (state) {
    case ST_ALARM:
      buzzerOn = ((now / 250) % 3) != 2;   // siren pattern: on-on-off
      ledOn = true;
      lightOn = true;
      setDoor(true);
      break;
    case ST_HOLD:
      buzzerOn = false;
      ledOn = true;
      lightOn = true;
      setDoor(true);
      break;
    default:
      buzzerOn = false;
      ledOn = false;
      lightOn = false;
      setDoor(false);
      break;
  }
  setBuzzers(buzzerOn);
  digitalWrite(PIN_LED, ledOn ? HIGH : LOW);
  setRelay(lightOn);
}

// ============================================================================
//                           Alarm state changes
// ============================================================================
void startEvent(unsigned long now, bool isTest) {
  state = ST_ALARM;
  testRun = isTest;
  eventStartMs = now;
  lastShakeMs = now;
  peakShake = isTest ? 0 : shakeAvg;
  if (!isTest) eventCount++;
  eventIsTest = isTest;
  eventPeak = peakShake;
  eventStartCount++;
  Serial.println(isTest ? ">>> TEST ALARM" : ">>> EARTHQUAKE DETECTED — ALARM ON");
}

void endEvent(unsigned long now) {
  eventIsTest = testRun;
  eventPeak = peakShake;
  eventDurationS = (lastShakeMs - eventStartMs) / 1000.0f;
  eventEndCount++;
}

void resetSystem(unsigned long now) {
  if (state == ST_ALARM) endEvent(now);
  state = ST_MONITOR;
  testRun = false;
  shakeStartMs = 0;
  shakeAvg = 0;
  gyroAvg = 0;
  ignoreUntilMs = now + RESET_IGNORE_MS;
  Serial.println(">>> System reset — monitoring");
}

// ============================================================================
//                    Network task (runs on core 0)
// ============================================================================
WiFiClientSecure secureClient;

bool cloudConfigured() {
  return strstr(WIFI_SSID, "YOUR_") == nullptr && strstr(FIREBASE_URL, "YOUR-PROJECT") == nullptr;
}

String fbUrl(const String& path) {
  String url = String(FIREBASE_URL) + path + ".json";
  if (strlen(FIREBASE_AUTH) > 0) url += "?auth=" + String(FIREBASE_AUTH);
  return url;
}

int fbRequest(const char* method, const String& path, const String& body, String* response) {
  HTTPClient http;
  http.setTimeout(6000);
  if (!http.begin(secureClient, fbUrl(path))) return -1;
  http.addHeader("Content-Type", "application/json");
  int code;
  if (strcmp(method, "GET") == 0) code = http.GET();
  else code = http.sendRequest(method, body);
  if (response && code > 0) *response = http.getString();
  http.end();
  return code;
}

void networkTask(void*) {
  secureClient.setInsecure();   // skip certificate check (simple setup)

  String eventKey = "";
  uint32_t handledStarts = 0, handledEnds = 0;
  uint32_t lastTraceSent = 0;
  unsigned long lastLive = 0, lastCmd = 0, lastWifiTry = 0;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  for (;;) {
    unsigned long now = millis();

    if (WiFi.status() != WL_CONNECTED) {
      if (now - lastWifiTry > 10000) {
        lastWifiTry = now;
        WiFi.disconnect();
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      }
      vTaskDelay(pdMS_TO_TICKS(200));
      continue;
    }

    // ---- 1. New event started -> create it in the log
    if (handledStarts != eventStartCount) {
      handledStarts = eventStartCount;
      String body = String("{\"start\":{\".sv\":\"timestamp\"},\"status\":\"active\",\"test\":") +
                    (eventIsTest ? "true" : "false") +
                    ",\"peak\":" + String(eventPeak, 4) + "}";
      String resp;
      int code = fbRequest("POST", "/earthquake/events", body, &resp);
      eventKey = "";
      int p = resp.indexOf("\"name\":\"");
      if (code == 200 && p >= 0) {
        int q = resp.indexOf('"', p + 8);
        eventKey = resp.substring(p + 8, q);
      }
    }

    // ---- 2. Event finished -> store peak and duration
    if (handledEnds != eventEndCount && handledStarts == eventStartCount) {
      handledEnds = eventEndCount;
      if (eventKey.length() > 0) {
        String body = String("{\"status\":\"ended\",\"test\":") + (eventIsTest ? "true" : "false") +
                      ",\"peak\":" + String(eventPeak, 4) +
                      ",\"duration\":" + String(eventDurationS, 1) +
                      ",\"end\":{\".sv\":\"timestamp\"}}";
        fbRequest("PATCH", "/earthquake/events/" + eventKey, body, nullptr);
      }
    }

    // ---- 3. Live status (twice a second during an alarm, otherwise every second)
    LiveData snap;
    float trace[20];
    int traceCount = 0;
    uint32_t seq;
    portENTER_CRITICAL(&dataMux);
    snap = live;
    seq = traceSeq;
    uint32_t pending = seq - lastTraceSent;
    if (pending > 20) pending = 20;
    for (uint32_t i = seq - pending; i < seq; i++) trace[traceCount++] = traceRing[i % TRACE_LEN];
    portEXIT_CRITICAL(&dataMux);

    unsigned long livePeriod = (snap.state == ST_ALARM) ? 500 : 1000;
    if (now - lastLive >= livePeriod) {
      lastLive = now;
      lastTraceSent = seq;
      String t = "[";
      for (int i = 0; i < traceCount; i++) {
        if (i) t += ",";
        t += String(trace[i], 4);
      }
      t += "]";
      String body = String("{") +
        "\"state\":\"" + STATE_NAMES[snap.state] + "\"," +
        "\"alarm\":" + ((snap.state == ST_ALARM || snap.state == ST_HOLD) ? "true" : "false") + "," +
        "\"shaking\":" + (snap.state == ST_ALARM ? "true" : "false") + "," +
        "\"test\":" + (snap.testRun ? "true" : "false") + "," +
        "\"shake\":" + String(snap.shake, 4) + "," +
        "\"gyro\":" + String(snap.gyro, 2) + "," +
        "\"peak\":" + String(snap.peak, 4) + "," +
        "\"threshold\":" + String(SHAKE_THRESHOLD_G, 3) + "," +
        "\"buzzer\":" + (snap.buzzer ? "true" : "false") + "," +
        "\"led\":" + (snap.led ? "true" : "false") + "," +
        "\"light\":" + (snap.light ? "true" : "false") + "," +
        "\"door\":\"" + (snap.doorOpen ? "open" : "closed") + "\"," +
        "\"sensorOk\":" + (snap.sensorOk ? "true" : "false") + "," +
        "\"events\":" + String(snap.eventCount) + "," +
        "\"uptime\":" + String(now / 1000) + "," +
        "\"rssi\":" + String(WiFi.RSSI()) + "," +
        "\"ip\":\"" + WiFi.localIP().toString() + "\"," +
        "\"traceSeq\":" + String(seq) + "," +
        "\"trace\":" + t + "," +
        "\"updated\":{\".sv\":\"timestamp\"}}";
      fbRequest("PUT", "/earthquake/live", body, nullptr);
    }

    // ---- 4. Commands from the web page
    if (now - lastCmd >= 1500) {
      lastCmd = now;
      String resp;
      if (fbRequest("GET", "/earthquake/command", "", &resp) == 200) {
        bool handled = false;
        if (resp.indexOf("reset") >= 0) { cmdReset = true; handled = true; }
        else if (resp.indexOf("test") >= 0) { cmdTest = true; handled = true; }
        if (handled) fbRequest("PUT", "/earthquake/command", "\"none\"", nullptr);
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
  Serial.println("\n=== Earthquake Detection & Response System ===");

  // Outputs safe (off) before anything else
  setRelay(false);
  pinMode(PIN_RELAY, OUTPUT);
  setRelay(false);
  pinMode(PIN_BUZZER_1, OUTPUT);
  pinMode(PIN_BUZZER_2, OUTPUT);
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_RESET_BTN, INPUT_PULLUP);
  setBuzzers(false);
  digitalWrite(PIN_LED, LOW);

  ESP32PWM::allocateTimer(0);
  doorServo.setPeriodHertz(50);
  doorServo.attach(PIN_SERVO, 500, 2400);
  doorServo.write(DOOR_CLOSED_ANGLE);
  doorIsOpen = false;

  // Short beep = power on
  setBuzzers(true); delay(120); setBuzzers(false);

  sensorOk = mpuBegin();
  if (!sensorOk) {
    Serial.println("ERROR: MPU6050 not found. Check SDA=21, SCL=22, VCC=3.3V, GND.");
  } else {
    calibrate();
  }
  state = ST_MONITOR;
  live.sensorOk = sensorOk;
  windowStartMs = millis();

  if (cloudConfigured()) {
    xTaskCreatePinnedToCore(networkTask, "network", 12288, nullptr, 1, nullptr, 0);
    Serial.println("Cloud sync: ON (Firebase)");
  } else {
    Serial.println("Cloud sync: OFF — set Wi-Fi and Firebase in USER SETTINGS. Alarm still works.");
  }
  Serial.println("Monitoring for earthquakes...");
}

// ============================================================================
//                         Main loop (core 1, 100 Hz)
// ============================================================================
void loop() {
  static unsigned long lastSample = 0;
  static unsigned long lastDebug = 0;
  static unsigned long btnDownMs = 0;
  static unsigned long lastSensorRetry = 0;

  unsigned long now = millis();
  if (now - lastSample < SAMPLE_PERIOD_MS) return;
  lastSample = now;

  // ---------- Read sensor
  static int readFails = 0;
  float ax, ay, az, gx, gy, gz;
  float shakeNow = 0, gyroNow = 0;
  if (sensorOk && mpuRead(ax, ay, az, gx, gy, gz)) {
    readFails = 0;
    float dx = ax - baseX, dy = ay - baseY, dz = az - baseZ;
    shakeNow = sqrtf(dx * dx + dy * dy + dz * dz);
    float rx = gx - gyroOffX, ry = gy - gyroOffY, rz = gz - gyroOffZ;
    gyroNow = sqrtf(rx * rx + ry * ry + rz * rz);

    // short-term averages (~0.25 s)
    shakeAvg += 0.08f * (shakeNow - shakeAvg);
    gyroAvg  += 0.08f * (gyroNow - gyroAvg);

    // slowly follow gravity / drift while everything is calm
    if (state == ST_MONITOR && shakeAvg < SHAKE_THRESHOLD_G * 0.5f) {
      baseX += 0.002f * (ax - baseX);
      baseY += 0.002f * (ay - baseY);
      baseZ += 0.002f * (az - baseZ);
    }
  } else if (sensorOk) {
    if (++readFails > 50) {                  // ~0.5 s of failed reads
      sensorOk = false;
      Serial.println("ERROR: lost connection to MPU6050");
    }
  } else if (now - lastSensorRetry > 3000) {
    lastSensorRetry = now;
    if (!sensorOk && mpuBegin()) { sensorOk = true; calibrate(); }
  }

  // ---------- Detection
  bool shaking = (shakeAvg > SHAKE_THRESHOLD_G) || (gyroAvg > GYRO_THRESHOLD_DPS);
  if (now < ignoreUntilMs) shaking = false;

  if (shaking) {
    if (shakeStartMs == 0) shakeStartMs = now;
    bool confirmed = (now - shakeStartMs) >= CONFIRM_MS;
    if (confirmed) {
      lastShakeMs = now;
      if (state == ST_MONITOR || state == ST_HOLD) startEvent(now, false);
      else if (state == ST_ALARM && testRun) { testRun = false; eventCount++; } // real quake during a test
    }
  } else {
    shakeStartMs = 0;
  }
  if (state == ST_ALARM && shakeAvg > peakShake && !testRun) peakShake = shakeAvg;

  // ---------- Timers
  if (state == ST_ALARM) {
    if (testRun && now >= testEndMs) {
      lastShakeMs = now;
      resetSystem(now);                       // a test returns to normal by itself
    } else if (!testRun && now - lastShakeMs >= QUIET_MS) {
      endEvent(now);
      state = ST_HOLD;                        // buzzers off, door & light stay on
      Serial.println(">>> Shaking stopped — buzzers off, door open, light on (press reset)");
    }
  }

  // ---------- Reset button (hold 50 ms)
  if (digitalRead(PIN_RESET_BTN) == LOW) {
    if (btnDownMs == 0) btnDownMs = now;
    if (now - btnDownMs > 50 && (state == ST_ALARM || state == ST_HOLD)) resetSystem(now);
  } else {
    btnDownMs = 0;
  }

  // ---------- Commands from the web page
  if (cmdReset) {
    cmdReset = false;
    if (state == ST_ALARM || state == ST_HOLD) resetSystem(now);
  }
  if (cmdTest) {
    cmdTest = false;
    if (state == ST_MONITOR) {
      startEvent(now, true);
      testEndMs = now + TEST_MS;
    }
  }

  // ---------- Outputs
  bool buzzerOn, ledOn, lightOn;
  applyOutputs(now, buzzerOn, ledOn, lightOn);

  // ---------- Seismograph trace (max per 100 ms window)
  if (shakeNow > windowMax) windowMax = shakeNow;
  bool windowDone = (now - windowStartMs >= TRACE_WINDOW_MS);

  // ---------- Share data with the network task
  portENTER_CRITICAL(&dataMux);
  live.state    = state;
  live.shake    = shakeAvg;
  live.gyro     = gyroAvg;
  live.peak     = peakShake;
  live.buzzer   = (state == ST_ALARM);
  live.led      = ledOn;
  live.light    = lightOn;
  live.doorOpen = doorIsOpen;
  live.testRun  = testRun;
  live.sensorOk = sensorOk;
  live.eventCount = eventCount;
  if (windowDone) {
    traceRing[traceSeq % TRACE_LEN] = windowMax;
    traceSeq++;
  }
  portEXIT_CRITICAL(&dataMux);
  if (windowDone) { windowMax = 0; windowStartMs = now; }

  // ---------- Debug output for tuning
  if (DEBUG_SERIAL && now - lastDebug >= 250) {
    lastDebug = now;
    Serial.printf("shake=%.4f g  gyro=%6.2f dps  state=%s  door=%s  light=%s\n",
                  shakeAvg, gyroAvg, STATE_NAMES[state],
                  doorIsOpen ? "open" : "closed", lightOn ? "on" : "off");
  }
}
