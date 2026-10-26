// ---------------------------------------------------------------------------
//  QuakeGuard web page settings
// ---------------------------------------------------------------------------
window.EQ_CONFIG = {
  // Same Firebase Realtime Database URL as in the ESP32 code.
  // Add ?demo to the page address to see sample data instead.
  firebaseUrl: "https://quakeguard-earthquake-default-rtdb.europe-west1.firebasedatabase.app",
  auth: "",                       // leave empty when the database rules allow access

  buildingName: "QuakeGuard",

  // One entry per floor. "path" must match DB_PATH in that floor's ESP32 code.
  floors: [
    { name: "Floor 1", path: "earthquake" }
    // , { name: "Floor 2", path: "floor2" }
  ],

  peoplePerFloor: 20,             // for the "marked safe" counter

  // PIN for reset, tests and detector settings.
  // It stops accidental presses only; anyone can read this file.
  managerPin: "1234",

  // Station position for the regional earthquake map (Herat by default)
  station: { lat: 34.35, lon: 62.20, place: "Herat" },
  region: { radiusKm: 1000, minMag: 4, days: 30 },

  // Default emergency numbers (each phone can change them in Settings)
  contacts: { police: "119", amb: "102", fire: "112", mgr: "" }
};
