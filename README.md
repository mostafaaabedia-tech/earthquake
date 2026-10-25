# Earthquake Detection & Response System

An ESP32 with an MPU6050 gyroscope/accelerometer watches for earthquake-like shaking. When it detects one it:

- sounds **two buzzers** (siren pattern)
- turns on the **warning LED**
- rotates the **servo to open the exit door**
- switches the **relay to turn on the emergency light**
- sends the event to **Firebase**, where this repository's **web page** shows it live

The alarm reacts on the ESP32 itself, so it works even with no Wi-Fi. The web page is only for watching and for remote reset/test.

**Live page:** `https://mostafaaabedia-tech.github.io/earthquake/`
**Preview with sample data:** `https://mostafaaabedia-tech.github.io/earthquake/?demo`

---

## Parts

| Part | Qty |
|---|---|
| ESP32 DevKit (30 or 38 pin) | 1 |
| MPU6050 module (GY-521) | 1 |
| Active buzzer (5 V or 3.3 V) | 2 |
| LED + 220 Ω resistor | 1 |
| Servo SG90 or MG90S (door) | 1 |
| 1-channel relay module (5 V) | 1 |
| Lamp for the emergency light (with its own supply) | 1 |
| Push button (reset, optional) | 1 |
| 5 V supply for the servo (≥1 A recommended) | 1 |

## Wiring

| Component | Component pin | ESP32 |
|---|---|---|
| MPU6050 | VCC | 3V3 |
| | GND | GND |
| | SDA | GPIO 21 |
| | SCL | GPIO 22 |
| Buzzer 1 | + | GPIO 25 |
| | − | GND |
| Buzzer 2 | + | GPIO 26 |
| | − | GND |
| LED | anode (long leg) → 220 Ω | GPIO 27 |
| | cathode | GND |
| Servo | signal (orange) | GPIO 13 |
| | red | **external 5 V** |
| | brown | GND (shared with ESP32) |
| Relay module | IN | GPIO 14 |
| | VCC | 5 V (VIN) |
| | GND | GND |
| Reset button | one leg | GPIO 4 |
| | other leg | GND |

**Relay contacts (the light):** the lamp's supply goes through **COM** and **NO** (normally open), so the light is off until an alarm.

Important notes:

- **All grounds must be connected together** (ESP32, servo supply, relay).
- Do not power the servo from the ESP32's 3.3 V pin; the ESP32 can reset when the servo moves.
- If your buzzers draw more than about 20 mA, drive them through an NPN transistor (e.g. 2N2222 with a 1 kΩ base resistor).
- Mount the MPU6050 **firmly** on the base of the model, **away from the buzzers and servo**, so their vibration does not keep the alarm going.
- If the lamp runs on mains (220 V), ask your teacher to check the wiring. A 12 V LED lamp is safer for a school model.

## 1. Firebase (database)

1. Go to <https://console.firebase.google.com>, click **Add project**, give it a name.
2. In the left menu open **Build → Realtime Database → Create database**. Choose a location and start in **test mode**.
3. Copy the database URL shown at the top, for example
   `https://my-quake-default-rtdb.firebaseio.com`
4. Open the **Rules** tab and paste these rules (allow only the `earthquake` folder), then **Publish**:

```json
{
  "rules": {
    "earthquake": {
      ".read": true,
      ".write": true
    }
  }
}
```

These rules let anyone with the URL read the data and press Reset/Test. That is fine for a school project; for a real building, use Firebase Authentication.

## 2. ESP32 code

1. Install the **Arduino IDE** and the ESP32 boards (Boards Manager → *esp32 by Espressif*).
2. Library Manager → install **ESP32Servo** (by Kevin Harrington).
3. Open `firmware/earthquake_esp32/earthquake_esp32.ino` and fill in the top settings:

```cpp
const char* WIFI_SSID     = "your Wi-Fi name";
const char* WIFI_PASSWORD = "your Wi-Fi password";
const char* FIREBASE_URL  = "https://my-quake-default-rtdb.firebaseio.com";
```

4. Board: **ESP32 Dev Module** → Upload.
5. Keep the model **still for 2 seconds** after power-on while the sensor calibrates (the LED blinks).

## 3. Web page

1. Open `config.js` in this repository and put the same Firebase URL in `firebaseUrl`.
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder `/ (root)` → Save**.
3. After about a minute the page is live at `https://mostafaaabedia-tech.github.io/earthquake/`.

## How it behaves

| State | Buzzers | LED | Door | Light | Ends when |
|---|---|---|---|---|---|
| Monitoring | off | off | closed | off | shaking lasts more than 0.3 s |
| Alarm (shaking) | siren | on | **open** | **on** | 15 s without shaking |
| Hold (shaking stopped) | off | on | open | on | Reset button or **Reset system** on the page |

- The door and light **stay on after the shaking stops** on purpose, so people can still leave safely. Press reset when the building is safe.
- New shaking during *Hold* starts a new alarm.
- **Run test** on the page turns everything on for 5 seconds, then returns to monitoring.

## Tuning the sensitivity

Open **Serial Monitor at 115200**. It prints the vibration (`shake`, in g) and rotation (`gyro`, in °/s) four times a second.

- Watch the values when the table is still and when you shake it.
- Set `SHAKE_THRESHOLD_G` between the two, e.g. still = 0.01, shaking = 0.15 → use 0.06.
- Alarm triggers too easily (knocks, footsteps)? Raise `SHAKE_THRESHOLD_G`, `GYRO_THRESHOLD_DPS` or `CONFIRM_MS`.
- Door opens the wrong way? Swap `DOOR_OPEN_ANGLE` and `DOOR_CLOSED_ANGLE`, or change the angles.
- Light on when it should be off? Set `RELAY_ACTIVE_LOW` to `false`.

## How detection works

1. At start-up the ESP32 averages 200 readings to learn which way gravity points and the gyroscope's resting offset.
2. 100 times a second it measures how far the acceleration moves away from that resting vector (vibration, in g) and how fast the board rotates (°/s).
3. Both are smoothed over about a quarter second. If either stays above its threshold for 0.3 s, it is treated as an earthquake. A single knock is too short to trigger it.
4. The page estimates the **Modified Mercalli intensity** from the peak vibration (Wald et al., 1999). On a model this describes the shaking at the sensor, not a real magnitude.

## Files

```
index.html, style.css, app.js   web page (GitHub Pages)
config.js                       web page settings (Firebase URL)
firmware/earthquake_esp32/      ESP32 Arduino code
```

## Database layout

```
earthquake/
  live       current status, written by the ESP32 every second
  events/    one record per detected event (start, duration, peak)
  command    "reset" or "test", written by the page and cleared by the ESP32
```
