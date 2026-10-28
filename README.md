# QuakeGuard — Earthquake Detection & Building Evacuation

An ESP32 with an MPU6050 gyroscope/accelerometer watches for earthquakes. When it detects one it:

- sounds **two buzzers** (siren)
- turns on the **warning LED**
- rotates the **servo to open the exit door**
- switches the **relay to turn on the emergency / corridor light**

The same alarm also goes off for **dangerous air**: an **MQ-2** (LPG, smoke) and an **MQ-135** (CO₂) watch the air, just like the Air Monitor project.
- sends the event to **Firebase**, where the **QuakeGuard web page** shows it live
- optionally sends a **Telegram** or **ntfy** message to your phone

The alarm runs on the ESP32 itself, so it still works with no Wi-Fi.

**Live page:** `https://mostafaaabedia-tech.github.io/earthquake/`
**Demo with sample data:** `https://mostafaaabedia-tech.github.io/earthquake/?demo`

**Firebase project:** `quakeguard-earthquake` (Realtime Database in Belgium, europe-west1)
**Database URL:** `https://quakeguard-earthquake-default-rtdb.europe-west1.firebasedatabase.app`
Already set in `config.js` and in the ESP32 code. Only the `earthquake/` path is readable and writable.

---

## Web page features

| Tab | What it does |
|---|---|
| **Dashboard** | Big status banner, animated **floor plan** (green corridor lights, opening stair door, evacuation route), **shaking intensity** (Mercalli I–X), vibration chart, sensor status cards, **I'm safe** counter, what-to-do steps, controls |
| **Live Map** | Floor plan only. Tap your room to see your route, distance and walking time to the stairs |
| **Region** | Map of **real recent earthquakes** near Herat (USGS, with EMSC as backup) on OpenStreetMap, with magnitude, depth, distance and links. Background on the 2023 Herat earthquakes |
| **Air** | From the Air Monitor project: headline (clean / getting worse / dangerous), **LPG, smoke and CO₂ dial gauges**, **Silence the alarm**, floating-particle background, 10-minute gas trend chart, **city PM2.5 and weather** (WeatherAPI, add your key in `config.js`), team credits |
| **History** | Vibration chart, **STA/LTA trigger chart**, alarm timeline, event log with **"Was it a real earthquake?"** (checks the USGS catalog), **CSV/JSON download** |
| **Settings** | **Detector settings** that the ESP32 reads from Firebase (no re-flashing), sensor calibration, sensor health, emergency contacts with tap-to-call and SMS, notifications, voice, theme, large text, **دری / English**, QR code, **printable evacuation plan**, install as an app |

Also:
- a **full-screen alarm** ("Follow the green lights"), spoken instructions, phone vibration and siren sound
- a **manager PIN** for reset, tests and settings
- **several floors** (one ESP32 per floor)
- a **24-hour aftershock watch** after a real quake
- **offline support** (the page and safety steps work without internet)

---

## Parts

| Part | Qty |
|---|---|
| ESP32 DevKit | 1 |
| MPU6050 module (GY-521) | 1 |
| Active buzzer | 2 |
| LED + 220 Ω resistor | 1 |
| Servo SG90 / MG90S (door) | 1 |
| 1-channel relay module (5 V) | 1 |
| Lamp for the emergency light (own supply) | 1 |
| Push button (reset) | 1 |
| 5 V supply for the servo (≥ 1 A) | 1 |
| OLED 0.96" SSD1306 128×64 I2C (or 1.3" SH1106 / 1.5" SH1107) | 1 |
| MQ-2 gas sensor (LPG, smoke) | 1 |
| MQ-135 air sensor (CO₂) | 1 |
| Resistors for two dividers (10 kΩ + 20 kΩ each) | 4 |

## Wiring

| Component | Pin | ESP32 |
|---|---|---|
| MPU6050 | VCC / GND | 3V3 / GND |
| | SDA / SCL | GPIO 21 / GPIO 22 |
| OLED | VCC / GND | 3V3 / GND |
| | SDA / SCL | GPIO 21 / GPIO 22 (shared with the MPU6050) |
| Buzzer 1 | + / − | GPIO 25 / GND |
| Buzzer 2 | + / − | GPIO 26 / GND |
| LED | anode → 220 Ω / cathode | GPIO 27 / GND |
| Servo | signal / red / brown | GPIO 13 / **external 5 V** / GND |
| Relay | IN / VCC / GND | GPIO 14 / 5 V (VIN) / GND |
| Reset button | two legs | GPIO 4 / GND |
| MQ-2 | VCC / GND / AO through divider (10 kΩ + 20 kΩ) | 5 V (VIN) / GND / GPIO 34 |
| MQ-135 | VCC / GND / AO through divider (10 kΩ + 20 kΩ) | 5 V (VIN) / GND / GPIO 35 |

- The lamp goes through relay **COM** and **NO**, so it is off until an alarm.
- **Connect all grounds together.** Never power the servo from the ESP32's 3.3 V pin.
- Mount the MPU6050 **firmly**, **away from the buzzers and servo**. As a safeguard the buzzers stop after 2 minutes anyway.
- The servo door must **always open by hand** too. Never let it lock people in.
- The MQ sensors run on **5 V** and their AO can reach 5 V, so each AO goes through a divider (AO → 10 kΩ → GPIO, GPIO → 20 kΩ → GND) to keep the ESP32 pin under 3.3 V.
- They need about **60 s to warm up** after power-on; no gas alarms during that time.
- No MQ sensors? Set `AIR_SENSORS_INSTALLED = false` and it runs as an earthquake-only alarm.

## 1. Firebase (already done for `quakeguard-earthquake`)

To make your own project instead:

1. <https://console.firebase.google.com> → **Add project**.
2. **Build → Realtime Database → Create database** (test mode).
3. Copy the URL, e.g. `https://my-quake-default-rtdb.firebaseio.com`.
4. **Rules** tab → paste and **Publish**. Use one block per floor path:

```json
{
  "rules": {
    "earthquake": { ".read": true, ".write": true }
  }
}
```

This is fine for a school project. For a real building, use Firebase Authentication so only the manager can write `config` and `command`.

## 2. ESP32

1. Arduino IDE → Boards Manager → **esp32 by Espressif**. Library Manager → **ESP32Servo** and **U8g2**.
2. Open `firmware/earthquake_esp32/earthquake_esp32.ino` and fill in your Wi-Fi (the Firebase URL is already set):

```cpp
const char* WIFI_SSID     = "your Wi-Fi";
const char* WIFI_PASSWORD = "your password";
const char* FIREBASE_URL  = "https://quakeguard-earthquake-default-rtdb.europe-west1.firebasedatabase.app";
const char* DB_PATH       = "/earthquake";   // floor 2: "/floor2" ...
const char* FLOOR_NAME    = "Floor 1";
```

3. Board **ESP32 Dev Module** → Upload. Keep it still for 2 s while it calibrates (the LED blinks).

### Phone alerts (optional, work even when the page is closed)

**Telegram:**
1. In Telegram, message **@BotFather** → `/newbot` → copy the **token**.
2. Open your new bot and press **Start**.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `"chat":{"id": ...}`.
4. Put both in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

**ntfy:** install the ntfy app, subscribe to a long secret topic name (e.g. `herat-quake-x7k29q`), and put it in `NTFY_TOPIC`.

You get one message when shaking starts and one when it ends (with peak and intensity).

## 3. Web page

1. Edit `config.js`: put the same `firebaseUrl`, set `managerPin`, and list your floors.
2. GitHub → **Settings → Pages → Deploy from a branch → `main` / root → Save**.
3. Open `https://mostafaaabedia-tech.github.io/earthquake/`.

## Air alarm (MQ-2 + MQ-135)

The ESP32 turns the sensor readings into estimates, using the same formulas as the Air Monitor project:

| Reading | From | Formula (raw 0–4095) | Alarm |
|---|---|---|---|
| LPG | MQ-2 | raw / 4095 × 1000 | 600 ppm |
| Smoke | MQ-2 | raw / 4095 × 800 | 300 ppm |
| CO₂ | MQ-135 | 400 + raw / 4095 × 1600 | 1500 ppm |

These are rough estimates, not calibrated ppm. When any of them stays above its limit for 2 s, the ESP32 starts a **dangerous-air alarm**: buzzers (fast beeps), LED, door open, emergency light, event log and Telegram/ntfy. **Silence the alarm** on the page stops only the buzzers; the door and light stay on until reset. Change the three limits in **Settings → Detector settings**.

**City air:** paste your WeatherAPI.com key into `weatherApiKey` in `config.js` to show Herat's PM2.5 and weather on the Air tab.

## OLED screen

Set your model at the top of the ESP32 code: `#define OLED_MODEL 1` (0.96" SSD1306), `2` (1.3" SH1106) or `3` (1.5" SH1107). If no OLED is found, the ESP32 runs without it.

| Screen | Shows |
|---|---|
| Boot | QuakeGuard logo, *HBRT Afghan-Turk* |
| Calibrating | progress bar, "keep the station still" |
| **SEISMO** page | live scrolling seismograph with the alarm level dotted, Mercalli intensity box, g value, aftershock watch |
| **AIR** page | LPG, smoke and CO₂ bars with the alarm limit marked, values in ppm, warm-up countdown |
| **SYSTEM** page | tilt, uptime, number of quakes and air alarms, IP address, floor |
| Alarm | flashing screen: EARTHQUAKE! or BAD AIR!, intensity or worst gas, "Buzzer silenced", moving **EXIT ▶▶▶** arrows |
| After the alarm | "SHAKING STOPPED / AIR CLEARED – press RESET when the area is safe" |

The top bar shows the page dots, Wi-Fi signal bars, and a cloud icon (filled when Firebase is updating, crossed out when offline). Pages change every 5 seconds.

## How it behaves

| State | Buzzers | LED | Door | Light | Ends when |
|---|---|---|---|---|---|
| Monitoring | off | off | closed | off | an earthquake (or gas) is confirmed |
| Alarm | siren | on | **open** | **on** | 15 s without shaking (quiet time) |
| Hold | off | on | open | on | reset button or **Reset alarm** on the page |

- After a real earthquake, a **24 h aftershock watch** lowers the threshold to 70% and counts aftershocks.
- **Test earthquake / fire alarm** turns everything on for 6 s and then returns to normal. Tests do not trigger the full-screen alarm or phone alerts.
- **Reset** also clears the "I'm safe" list.

## Detection and tuning

The ESP32 uses an **STA/LTA trigger**, the method used by real seismographs:

- **STA** is the 1-second average vibration and **LTA** is the 30-second background level.
- An earthquake is confirmed when **STA/LTA ≥ trigger ratio** *and* vibration ≥ **minimum shaking**, for at least the **minimum duration**.
- Very strong shaking (3× the minimum) or fast rotation also triggers it.
- A door slam is too short to count.

| Setting | Default | Raise it if… |
|---|---|---|
| Minimum shaking | 0.03 g | footsteps or tables cause alarms |
| Trigger ratio | 3.0 | alarms happen in a noisy room |
| Detrigger ratio | 1.5 | the alarm lasts too long |
| Minimum duration | 0.8 s | knocks still trigger it |
| Quiet time | 15 s | — |
| LPG / smoke / CO₂ alarm | 600 / 300 / 1500 ppm | the MQ sensors trigger in clean air |

Change these in **Settings → Detector settings**. The ESP32 reads them every 15 s. Serial Monitor (115200) shows `shake`, `sta`, `ratio`, `gyro`, `tilt` and `gas` live for tuning.

**Intensity:** the page converts peak acceleration to the Modified Mercalli scale with the Worden et al. (2012) equation used by USGS ShakeMap. It describes the shaking **at the sensor**, not the earthquake's magnitude. One sensor cannot measure magnitude, so the page takes magnitudes from the USGS catalog instead. The MPU6050 reliably senses shaking from about intensity III–IV upward.

## Database layout

```
<floor path>/            e.g. earthquake/
  live      status written by the ESP32 every second
  events/   one record per alarm (kind, test, start, duration, peak, gas)
  config    detector settings (written by the page, read by the ESP32)
  command   "reset" | "test" | "testfire" | "calibrate" | "endwatch" | "silence"
  safe/     "I'm safe" taps (cleared on reset)
```

## Emergency numbers (Afghanistan)

Police **119** is listed by every official source. Ambulance (**102**) and fire (**112**) numbers differ between sources, so check them locally and edit them in **Settings** or in `config.js`.

## Files

```
index.html, style.css, app.js, i18n.js   web page
config.js                                page settings
sw.js, manifest.webmanifest, icons/      install as an app / offline
firmware/earthquake_esp32/               ESP32 code
```

*Educational alarm, not a certified early-warning system.*
