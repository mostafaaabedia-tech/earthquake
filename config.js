// ---------------------------------------------------------------------------
//  Web page settings
//  Put the SAME Firebase Realtime Database URL that is in the ESP32 code.
// ---------------------------------------------------------------------------
window.EQ_CONFIG = {
  // Example: "https://my-quake-project-default-rtdb.firebaseio.com"
  firebaseUrl: "https://YOUR-PROJECT-default-rtdb.firebaseio.com",

  // Leave empty when the database rules allow access (see README)
  auth: "",

  // Name shown at the top of the page
  stationName: "Earthquake Detection & Response System",
  location: "Monitoring station"
};
