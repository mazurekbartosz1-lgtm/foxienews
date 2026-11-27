#include <Arduino.h>
#include <ArduinoJson.h>
#include <DNSServer.h>
#include <GxEPD2_BW.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <SPI.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <qrcode.h>
#include <stdlib.h>
#include <time.h>
#include "driver/gpio.h"
#include "driver/rtc_io.h"
#include "esp_sleep.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "audio_recorder.h"
#include "board_pins.h"
#include "capture_client.h"
#include "sd_queue.h"
#include "ui_assets.h"

#if __has_include("config.h")
#include "config.h"
#endif

#ifndef FOXIE_AP_SSID
#define FOXIE_AP_SSID "Foxie-Setup"
#endif
#ifndef FOXIE_DEFAULT_WIFI_SSID
#define FOXIE_DEFAULT_WIFI_SSID ""
#endif
#ifndef FOXIE_DEFAULT_WIFI_PASS
#define FOXIE_DEFAULT_WIFI_PASS ""
#endif
#ifndef FOXIE_DEFAULT_API_URL
#define FOXIE_DEFAULT_API_URL ""
#endif
#ifndef FOXIE_DEFAULT_API_KEY
#define FOXIE_DEFAULT_API_KEY ""
#endif

// 1.54" 200x200 B&W e-Paper panel (SSD1681 / GDEH0154D67)
GxEPD2_BW<GxEPD2_154_D67, GxEPD2_154_D67::HEIGHT> display(
  GxEPD2_154_D67(PIN_EPD_CS, PIN_EPD_DC, PIN_EPD_RST, PIN_EPD_BUSY)
);

enum class DeviceState {
  Ready,
  Recording,
  Uploading,
  Saved,
  Error,
  WifiSetup,
};

enum class LedPattern {
  Off,
  SolidOn,
  SlowBlink,
  FastBlink,
  WifiPulse,
};

struct ButtonIsrState {
  int pin;
  volatile bool isDown = false;
  volatile bool longTriggered = false;
  volatile bool shortPending = false;
  volatile bool longPending = false;
  volatile uint32_t lastEdgeMs = 0;
  volatile uint32_t pressedAtMs = 0;
};

struct FoxieConfig {
  String wifiSsid;
  String wifiPass;
  String apiUrl;
  String apiKey;
  String weatherCity;
};

constexpr uint32_t DEBOUNCE_MS = 35;
constexpr uint32_t LONG_PRESS_MS = 2500;
constexpr uint32_t SAVED_AUTO_RETURN_MS = 3500;
constexpr uint32_t ERROR_AUTO_RETURN_MS = 10000;
constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000;
constexpr uint32_t WEATHER_REFRESH_MS = 30UL * 60UL * 1000UL;        // 30 minutes
constexpr uint32_t INACTIVITY_SLEEP_MS = 3UL * 60UL * 1000UL;        // 3 minutes
constexpr uint32_t QUEUE_SYNC_RETRY_MS = 60000;
constexpr uint32_t WIFI_RECONNECT_INTERVAL_MS = 60000;
constexpr uint32_t WIFI_OFFLINE_UI_DEBOUNCE_MS = 12000;
constexpr uint32_t WIFI_COMEBACK_RETRY_DELAY_MS = 2500;
constexpr uint8_t EPD_FULL_REFRESH_EVERY = 30;
constexpr uint8_t DNS_PORT = 53;

constexpr const char* TZ_POLAND = "CET-1CEST,M3.5.0,M10.5.0/3";
constexpr const char* DEFAULT_WEATHER_CITY = "Trabki Wielkie";
constexpr double DEFAULT_WEATHER_LAT = 54.1697; // Trąbki Wielkie, Poland
constexpr double DEFAULT_WEATHER_LON = 18.5397;

// Preserved across ESP32-S3 deep sleep hibernation
RTC_DATA_ATTR static bool rtcInHibernation = false;
RTC_DATA_ATTR static bool rtcWeatherValid = false;
RTC_DATA_ATTR static int16_t rtcWeatherTempC = 0;
RTC_DATA_ATTR static int16_t rtcWeatherCode = 0;
RTC_DATA_ATTR static double rtcLat = DEFAULT_WEATHER_LAT;
RTC_DATA_ATTR static double rtcLon = DEFAULT_WEATHER_LON;
RTC_DATA_ATTR static int16_t rtcHibLastMinute = -1;
RTC_DATA_ATTR static uint8_t rtcHibBatteryPercent = 100;
RTC_DATA_ATTR static uint8_t rtcHibPartialCount = 0;

static DeviceState currentState = DeviceState::Ready;
static volatile LedPattern currentLedPattern = LedPattern::Off;
static bool isSleeping = false;
static bool portalActive = false;
static bool portalSavePending = false;

static uint32_t recordingStartedMs = 0;
static uint32_t lastRecDrawMs = 0;
static uint32_t uploadStartedMs = 0;
static uint32_t savedEnteredMs = 0;
static uint32_t errorEnteredMs = 0;
static uint32_t lastActivityMs = 0;
static uint32_t lastWeatherFetchMs = 0;
static uint32_t lastClockCheckMs = 0;
static int lastRenderedMinute = -1;
static uint8_t readyPartialCount = 0;
static uint8_t uploadProgress = 0;
static uint16_t syncQueueCurrent = 0;
static uint16_t syncQueueTotal = 0;
static uint8_t batteryPercent = 100;
static volatile bool touchActivityPending = false;

static FoxieConfig cfg;
static Preferences prefs;
static DNSServer dnsServer;
static WebServer webServer(80);
static AudioRecorder audioRecorder;
static SdQueue sdQueue;
static bool uploadPending = false;
static bool savedToSdFlag = false;
static bool prevWifiConnected = false;
static volatile uint8_t lastWifiDisconnectReason = 0;
static volatile bool wifiRetryRequested = false;
static bool uiWifiConnected = false;
static uint32_t wifiLostAtMs = 0;
static uint32_t lastQueueSyncAttemptMs = 0;
static uint32_t lastWifiReconnectAttemptMs = 0;
static char lastErrorText[24] = "";

static portMUX_TYPE btnMux = portMUX_INITIALIZER_UNLOCKED;
static ButtonIsrState btnBoot{PIN_BTN_BOOT};
static ButtonIsrState btnPwr{PIN_BTN_PWR};

static void markUserActivity() {
  lastActivityMs = millis();
}

static void IRAM_ATTR handleTouchIsr() {
  touchActivityPending = true;
}

static void IRAM_ATTR handleButtonIsr(void* arg) {
  auto* btn = static_cast<ButtonIsrState*>(arg);
  uint32_t nowMs = static_cast<uint32_t>(esp_timer_get_time() / 1000ULL);
  bool levelLow = (gpio_get_level(static_cast<gpio_num_t>(btn->pin)) == 0);

  portENTER_CRITICAL_ISR(&btnMux);
  if ((nowMs - btn->lastEdgeMs) >= DEBOUNCE_MS) {
    btn->lastEdgeMs = nowMs;
    if (levelLow && !btn->isDown) {
      btn->isDown = true;
      btn->longTriggered = false;
      btn->pressedAtMs = nowMs;
    } else if (!levelLow && btn->isDown) {
      btn->isDown = false;
      if (!btn->longTriggered) {
        if ((nowMs - btn->pressedAtMs) >= LONG_PRESS_MS) {
          btn->longPending = true;
        } else {
          btn->shortPending = true;
        }
      }
    }
  }
  portEXIT_CRITICAL_ISR(&btnMux);
}

static void setLedPhysical(bool on) {
  digitalWrite(PIN_LED_STATUS, on ? LED_ON_LEVEL : LED_OFF_LEVEL);
}

static void ledTask(void* /*param*/) {
  bool ledOn = false;
  uint32_t phaseElapsedMs = 0;
  LedPattern lastPattern = LedPattern::Off;

  for (;;) {
    LedPattern pat = currentLedPattern;
    if (pat != lastPattern) {
      lastPattern = pat;
      phaseElapsedMs = 0;
      ledOn = (pat == LedPattern::SolidOn || pat == LedPattern::SlowBlink ||
               pat == LedPattern::FastBlink || pat == LedPattern::WifiPulse);
      setLedPhysical(ledOn);
    }

    switch (pat) {
      case LedPattern::Off:
        if (ledOn) {
          ledOn = false;
          setLedPhysical(false);
        }
        vTaskDelay(pdMS_TO_TICKS(50));
        break;

      case LedPattern::SolidOn:
        if (!ledOn) {
          ledOn = true;
          setLedPhysical(true);
        }
        vTaskDelay(pdMS_TO_TICKS(50));
        break;

      case LedPattern::SlowBlink:
        vTaskDelay(pdMS_TO_TICKS(50));
        phaseElapsedMs += 50;
        if (phaseElapsedMs >= 500) {
          phaseElapsedMs = 0;
          ledOn = !ledOn;
          setLedPhysical(ledOn);
        }
        break;

      case LedPattern::FastBlink:
        vTaskDelay(pdMS_TO_TICKS(50));
        phaseElapsedMs += 50;
        if (phaseElapsedMs >= 100) {
          phaseElapsedMs = 0;
          ledOn = !ledOn;
          setLedPhysical(ledOn);
        }
        break;

      case LedPattern::WifiPulse:
        vTaskDelay(pdMS_TO_TICKS(50));
        phaseElapsedMs += 50;
        if (ledOn && phaseElapsedMs >= 200) {
          phaseElapsedMs = 0;
          ledOn = false;
          setLedPhysical(false);
        } else if (!ledOn && phaseElapsedMs >= 800) {
          phaseElapsedMs = 0;
          ledOn = true;
          setLedPhysical(true);
        }
        break;
    }
  }
}

static void setDisplayPower(bool on) {
  digitalWrite(PIN_EPD_PWR, on ? EPD_PWR_ON_LEVEL : EPD_PWR_OFF_LEVEL);
  if (on) {
    delay(20);
  }
}

static uint32_t readBatteryMilliVolts() {
  uint32_t sumMv = 0;
  for (uint8_t i = 0; i < 8; i++) {
    sumMv += analogReadMilliVolts(PIN_BAT_ADC);
  }
  return (sumMv / 8) * 2;
}

static uint8_t readBatteryPercent() {
  uint32_t batMv = readBatteryMilliVolts();
  if (batMv <= 3300) return 0;
  if (batMv >= 4200) return 100;
  return static_cast<uint8_t>(((batMv - 3300) * 100) / (4200 - 3300));
}

static void enterIdlePowerProfile() {
  if (!portalActive) {
    setCpuFrequencyMhz(80);
    if (WiFi.status() == WL_CONNECTED) {
      WiFi.setSleep(WIFI_PS_MAX_MODEM);
    }
  }
}

static void enterActiveTransferProfile() {
  setCpuFrequencyMhz(240);
  if (WiFi.getMode() != WIFI_OFF) {
    WiFi.setSleep(WIFI_PS_NONE);
  }
}

static void loadConfigFromNvs() {
  prefs.begin("foxie", false);
  cfg.wifiSsid = prefs.getString("ssid", "");
  cfg.wifiPass = prefs.getString("pass", "");
  cfg.apiUrl = prefs.getString("api_url", "");
  cfg.apiKey = prefs.getString("api_key", "");
  cfg.weatherCity = prefs.getString("w_city", DEFAULT_WEATHER_CITY);
  rtcLat = prefs.getDouble("w_lat", DEFAULT_WEATHER_LAT);
  rtcLon = prefs.getDouble("w_lon", DEFAULT_WEATHER_LON);
  if (!rtcWeatherValid && prefs.getBool("w_valid", false)) {
    rtcWeatherTempC = prefs.getShort("w_temp", 0);
    rtcWeatherCode = prefs.getShort("w_code", 1);
    rtcWeatherValid = true;
  }
  prefs.end();

  if (cfg.wifiSsid.isEmpty() && strlen(FOXIE_DEFAULT_WIFI_SSID) > 0) {
    cfg.wifiSsid = FOXIE_DEFAULT_WIFI_SSID;
    cfg.wifiPass = FOXIE_DEFAULT_WIFI_PASS;
  }
  if (cfg.apiUrl.isEmpty() && strlen(FOXIE_DEFAULT_API_URL) > 0) {
    cfg.apiUrl = FOXIE_DEFAULT_API_URL;
  }
  if (cfg.apiKey.isEmpty() && strlen(FOXIE_DEFAULT_API_KEY) > 0 &&
      strcmp(FOXIE_DEFAULT_API_KEY, "REPLACE_WITH_DEVICE_API_KEY") != 0) {
    cfg.apiKey = FOXIE_DEFAULT_API_KEY;
  }
  if (cfg.weatherCity.isEmpty()) {
    cfg.weatherCity = DEFAULT_WEATHER_CITY;
    rtcLat = DEFAULT_WEATHER_LAT;
    rtcLon = DEFAULT_WEATHER_LON;
  }
}

static void saveConfigToNvs() {
  prefs.begin("foxie", false);
  prefs.putString("ssid", cfg.wifiSsid);
  prefs.putString("pass", cfg.wifiPass);
  prefs.putString("api_url", cfg.apiUrl);
  prefs.putString("api_key", cfg.apiKey);
  prefs.putString("w_city", cfg.weatherCity);
  prefs.putDouble("w_lat", rtcLat);
  prefs.putDouble("w_lon", rtcLon);
  prefs.end();
}

static String htmlEscape(const String& input) {
  String out;
  out.reserve(input.length());
  for (size_t i = 0; i < input.length(); i++) {
    char c = input[i];
    if (c == '&') out += F("&amp;");
    else if (c == '<') out += F("&lt;");
    else if (c == '>') out += F("&gt;");
    else if (c == '"') out += F("&quot;");
    else out += c;
  }
  return out;
}

static String urlEncode(const String& input) {
  String encoded;
  const char hex[] = "0123456789ABCDEF";
  for (size_t i = 0; i < input.length(); i++) {
    unsigned char c = static_cast<unsigned char>(input[i]);
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      encoded += static_cast<char>(c);
    } else if (c == ' ') {
      encoded += F("%20");
    } else {
      encoded += '%';
      encoded += hex[(c >> 4) & 0x0f];
      encoded += hex[c & 0x0f];
    }
  }
  return encoded;
}

static void stopCaptivePortal() {
  if (!portalActive) return;
  webServer.stop();
  dnsServer.stop();
  WiFi.softAPdisconnect(true);
  portalActive = false;
  Serial.println("[Foxie] Captive Portal stopped");
}

static void applyPolandTimezone() {
  setenv("TZ", TZ_POLAND, 1);
  tzset();
}

static void syncNtpTime(uint32_t waitMs = 2500) {
  configTzTime(TZ_POLAND, "pool.ntp.org", "time.google.com");
  struct tm tmNow {};
  uint32_t start = millis();
  while ((millis() - start) < waitMs) {
    if (getLocalTime(&tmNow, 250) && tmNow.tm_year + 1900 >= 2024) {
      Serial.printf("[Foxie] NTP synced: %02d:%02d\n", tmNow.tm_hour, tmNow.tm_min);
      return;
    }
  }
  Serial.println("[Foxie] NTP sync pending in background");
}

static bool getTime24h(char* out, size_t len, int* outMinute = nullptr, int* outSec = nullptr) {
  struct tm tmNow {};
  if (getLocalTime(&tmNow, 10) && tmNow.tm_year + 1900 >= 2024) {
    snprintf(out, len, "%02d:%02d", tmNow.tm_hour, tmNow.tm_min);
    if (outMinute) *outMinute = tmNow.tm_hour * 60 + tmNow.tm_min;
    if (outSec) *outSec = tmNow.tm_sec;
    return true;
  }
  snprintf(out, len, "--:--");
  if (outMinute) *outMinute = -1;
  if (outSec) *outSec = 0;
  return false;
}

static const uint8_t* getWeatherIconForWmo(int code, uint16_t& w, uint16_t& h) {
  w = ICON_WEATHER_SUN_W;
  h = ICON_WEATHER_SUN_H;
  if (code == 0) return ICON_WEATHER_SUN;
  if (code == 1 || code == 2) return ICON_WEATHER_PARTLY;
  if (code == 3) return ICON_WEATHER_CLOUD;
  if (code == 45 || code == 48) return ICON_WEATHER_FOG;
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return ICON_WEATHER_RAIN;
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return ICON_WEATHER_SNOW;
  if (code >= 95) return ICON_WEATHER_STORM;
  return ICON_WEATHER_PARTLY;
}

static void resolveCustomCityIfNeeded() {
  if (cfg.weatherCity.equalsIgnoreCase(DEFAULT_WEATHER_CITY) ||
      cfg.weatherCity.equalsIgnoreCase("Trąbki Wielkie")) {
    rtcLat = DEFAULT_WEATHER_LAT;
    rtcLon = DEFAULT_WEATHER_LON;
    return;
  }

  if (WiFi.status() != WL_CONNECTED) return;

  enterActiveTransferProfile();
  String geoUrl = F("https://geocoding-api.open-meteo.com/v1/search?name=");
  geoUrl += urlEncode(cfg.weatherCity);
  geoUrl += F("&count=1&language=pl");

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.useHTTP10(true);
  http.setTimeout(6000);
  if (http.begin(client, geoUrl)) {
    if (http.GET() == HTTP_CODE_OK) {
      JsonDocument doc;
      if (deserializeJson(doc, http.getString()) == DeserializationError::Ok &&
          doc["results"][0]["latitude"].is<double>()) {
        rtcLat = doc["results"][0]["latitude"].as<double>();
        rtcLon = doc["results"][0]["longitude"].as<double>();
        saveConfigToNvs();
        Serial.printf("[Foxie] City '%s' -> %.4f, %.4f\n",
                      cfg.weatherCity.c_str(),
                      rtcLat,
                      rtcLon);
      }
    }
    http.end();
  }
}

static bool fetchWeatherOpenMeteo() {
  if (WiFi.status() != WL_CONNECTED) return false;

  enterActiveTransferProfile();
  char url[200];
  snprintf(
    url,
    sizeof(url),
    "https://api.open-meteo.com/v1/forecast?latitude=%.4f&longitude=%.4f&current=temperature_2m,weather_code",
    rtcLat,
    rtcLon
  );

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.useHTTP10(true);
  http.setTimeout(8000);
  if (!http.begin(client, url)) {
    Serial.println("[Foxie] Weather http.begin failed");
    return false;
  }

  int statusCode = http.GET();
  bool ok = false;
  if (statusCode == HTTP_CODE_OK) {
    String payload = http.getString();
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, payload);
    if (!err && doc["current"]["temperature_2m"].is<double>()) {
      rtcWeatherTempC = static_cast<int16_t>(lround(doc["current"]["temperature_2m"].as<double>()));
      rtcWeatherCode = static_cast<int16_t>(doc["current"]["weather_code"] | 1);
      rtcWeatherValid = true;
      lastWeatherFetchMs = millis();
      prefs.begin("foxie", false);
      prefs.putBool("w_valid", true);
      prefs.putShort("w_temp", rtcWeatherTempC);
      prefs.putShort("w_code", rtcWeatherCode);
      prefs.end();
      ok = true;
      Serial.printf("[Foxie] Weather (%s): %d C (WMO %d)\n",
                    cfg.weatherCity.c_str(),
                    rtcWeatherTempC,
                    rtcWeatherCode);
    } else {
      Serial.printf("[Foxie] Weather JSON parse error: %s\n", err.c_str());
    }
  } else {
    Serial.printf("[Foxie] Weather HTTP error: %d (%s)\n", statusCode, http.errorToString(statusCode).c_str());
  }
  http.end();
  return ok;
}

static void handleWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    uint8_t reason = info.wifi_sta_disconnected.reason;
    lastWifiDisconnectReason = reason;
    if (reason == 208 || reason == 202 || reason == 205 || reason == 15) {
      wifiRetryRequested = true;
    }
    Serial.printf("[WiFi] Disconnected (reason=%u)\n", static_cast<unsigned>(reason));
  }
}

static void configureStableWifiSta(bool autoReconnect = true) {
  enterActiveTransferProfile();
  WiFi.persistent(false);
  WiFi.setAutoReconnect(autoReconnect);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(WIFI_PS_NONE);
  WiFi.setTxPower(WIFI_POWER_15dBm);
}

static bool connectToWifi(uint32_t timeoutMs = WIFI_CONNECT_TIMEOUT_MS) {
  stopCaptivePortal();

  if (cfg.wifiSsid.isEmpty()) {
    Serial.println("[Foxie] No Wi-Fi SSID configured");
    WiFi.mode(WIFI_OFF);
    return false;
  }

  Serial.printf("[Foxie] Connecting to Wi-Fi '%s'...\n", cfg.wifiSsid.c_str());
  currentLedPattern = LedPattern::WifiPulse;

  configureStableWifiSta(false);
  WiFi.disconnect(false, true);
  delay(150);
  wifiRetryRequested = false;
  lastWifiDisconnectReason = 0;
  WiFi.begin(cfg.wifiSsid.c_str(), cfg.wifiPass.c_str());

  uint32_t startMs = millis();
  uint8_t retryCount = 0;
  while (WiFi.status() != WL_CONNECTED && (millis() - startMs) < timeoutMs) {
    if (wifiRetryRequested && retryCount < 3) {
      wifiRetryRequested = false;
      retryCount++;
      Serial.printf("[Foxie] Wi-Fi assoc refused (reason=%u), waiting %lums before retry %u/3...\n",
                    static_cast<unsigned>(lastWifiDisconnectReason),
                    static_cast<unsigned long>(WIFI_COMEBACK_RETRY_DELAY_MS),
                    static_cast<unsigned>(retryCount));
      uint32_t waitStart = millis();
      while (WiFi.status() != WL_CONNECTED &&
             (millis() - startMs) < timeoutMs &&
             (millis() - waitStart) < WIFI_COMEBACK_RETRY_DELAY_MS) {
        delay(100);
      }
      if (WiFi.status() != WL_CONNECTED && (millis() - startMs) < timeoutMs) {
        WiFi.disconnect(false);
        delay(100);
        WiFi.begin(cfg.wifiSsid.c_str(), cfg.wifiPass.c_str());
      }
    } else {
      delay(150);
    }
  }

  WiFi.setAutoReconnect(true);

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[Foxie] Wi-Fi connected! IP: %s, RSSI: %d dBm\n",
                  WiFi.localIP().toString().c_str(),
                  WiFi.RSSI());
    syncNtpTime();
    resolveCustomCityIfNeeded();
    fetchWeatherOpenMeteo();
    return true;
  }

  Serial.printf("[Foxie] Wi-Fi connection timeout (status=%d, reason=%u)\n",
                static_cast<int>(WiFi.status()),
                static_cast<unsigned>(lastWifiDisconnectReason));
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  return false;
}

static void handlePortalRoot() {
  markUserActivity();
  String html;
  html.reserve(2100);
  html += F("<!doctype html><html lang='pl'><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            "<title>Foxie Setup</title>"
            "<style>body{font-family:system-ui,sans-serif;background:#faf9f5;color:#1c1917;"
            "max-width:420px;margin:24px auto;padding:0 16px}"
            "h1{font-size:1.3rem;margin-bottom:4px}p{color:#6b675e;font-size:.9rem}"
            "label{display:block;margin-top:12px;font-size:.85rem;font-weight:600}"
            "input{width:100%;box-sizing:border-box;padding:10px;margin-top:4px;"
            "border:1px solid #d2cfc4;border-radius:6px;background:#fff;font-size:1rem}"
            "button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:6px;"
            "background:#1c1917;color:#fff;font-size:1rem;cursor:pointer}</style></head><body>"
            "<h1>Foxie Notes — Konfiguracja</h1>"
            "<p>Dane Wi-Fi (2.4 GHz), miasto pogody oraz ustawienia backendu.</p>"
            "<form method='POST' action='/save'>"
            "<label>Nazwa sieci Wi-Fi (SSID)<input name='ssid' required value='");
  html += htmlEscape(cfg.wifiSsid);
  html += F("'></label><label>Haslo Wi-Fi<input name='pass' type='password' placeholder='");
  html += cfg.wifiPass.isEmpty() ? F("haslo sieci") : F("pozostaw puste, aby zachowac");
  html += F("'></label><label>Miasto pogody<input name='w_city' value='");
  html += htmlEscape(cfg.weatherCity);
  html += F("'></label><label>URL API<input name='api_url' value='");
  html += htmlEscape(cfg.apiUrl);
  html += F("'></label><label>X-API-Key<input name='api_key' type='password' placeholder='");
  html += cfg.apiKey.isEmpty() ? F("klucz urzadzenia") : F("pozostaw puste, aby zachowac");
  html += F("'></label><button type='submit'>Zapisz i polacz</button></form></body></html>");

  webServer.send(200, "text/html", html);
}

static void handlePortalSave() {
  markUserActivity();
  String nextSsid = webServer.arg("ssid");
  String nextPass = webServer.arg("pass");
  String nextCity = webServer.arg("w_city");
  String nextApiUrl = webServer.arg("api_url");
  String nextApiKey = webServer.arg("api_key");

  nextSsid.trim();
  nextCity.trim();
  nextApiUrl.trim();
  nextApiKey.trim();

  if (!nextSsid.isEmpty()) cfg.wifiSsid = nextSsid;
  if (!nextPass.isEmpty()) cfg.wifiPass = nextPass;
  if (!nextCity.isEmpty()) cfg.weatherCity = nextCity;
  if (!nextApiUrl.isEmpty()) cfg.apiUrl = nextApiUrl;
  if (!nextApiKey.isEmpty()) cfg.apiKey = nextApiKey;

  saveConfigToNvs();
  portalSavePending = true;

  webServer.send(
    200,
    "text/html",
    F("<!doctype html><html lang='pl'><head><meta charset='utf-8'>"
      "<meta name='viewport' content='width=device-width,initial-scale=1'>"
      "<title>Zapisano</title></head><body style='font-family:system-ui,sans-serif;"
      "background:#faf9f5;color:#1c1917;max-width:420px;margin:32px auto;padding:0 16px'>"
      "<h2>Zapisano w NVS!</h2>"
      "<p>Lisek wylacza punkt dostepowy i laczy sie z Twoim Wi-Fi. Mozesz zamknac to okno.</p>"
      "</body></html>")
  );
}

static void handlePortalRedirect() {
  webServer.sendHeader("Location", "http://192.168.4.1/", true);
  webServer.send(302, "text/plain", "");
}

static void startCaptivePortal() {
  if (portalActive) return;

  enterActiveTransferProfile();
  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP);
  bool apOk = WiFi.softAP(FOXIE_AP_SSID);
  IPAddress apIp = WiFi.softAPIP();

  dnsServer.start(DNS_PORT, "*", apIp);
  webServer.on("/", HTTP_GET, handlePortalRoot);
  webServer.on("/save", HTTP_POST, handlePortalSave);
  webServer.on("/generate_204", HTTP_GET, handlePortalRedirect);
  webServer.on("/hotspot-detect.html", HTTP_GET, handlePortalRedirect);
  webServer.on("/fwlink", HTTP_GET, handlePortalRedirect);
  webServer.onNotFound(handlePortalRedirect);
  webServer.begin();

  portalActive = true;
  portalSavePending = false;
  Serial.printf("[Foxie] Captive Portal '%s' active=%d -> http://%s\n",
                FOXIE_AP_SSID,
                apOk ? 1 : 0,
                apIp.toString().c_str());
}

static void drawCenteredText(int16_t centerX, int16_t y, const char* text, uint8_t scale) {
  int16_t len = static_cast<int16_t>(strlen(text));
  int16_t w = (len > 0) ? (len * 6 * scale - scale) : 0;
  display.setTextSize(scale);
  display.setTextColor(GxEPD_BLACK);
  display.setCursor(centerX - (w / 2), y);
  display.print(text);
}

static void drawBatteryIcon(int16_t x, int16_t y, uint8_t percent) {
  display.drawRect(x, y, 20, 10, GxEPD_BLACK);
  display.fillRect(x + 20, y + 3, 2, 4, GxEPD_BLACK);
  int16_t fillW = static_cast<int16_t>((static_cast<uint32_t>(percent) * 16) / 100);
  if (fillW > 0) {
    display.fillRect(x + 2, y + 2, fillW, 6, GxEPD_BLACK);
  }
}

static void drawStatusBar(const char* label, bool wifiConnected) {
  display.drawBitmap(
    6,
    3,
    wifiConnected ? ICON_WIFI_ON : ICON_WIFI_OFF,
    ICON_WIFI_ON_W,
    ICON_WIFI_ON_H,
    GxEPD_BLACK
  );

  display.setTextSize(1);
  display.setTextColor(GxEPD_BLACK);
  display.setCursor(26, 7);
  display.print(label);

  char batBuf[8];
  snprintf(batBuf, sizeof(batBuf), "%u%%", batteryPercent);
  display.setCursor(144, 7);
  display.print(batBuf);
  drawBatteryIcon(172, 6, batteryPercent);

  display.drawFastHLine(0, UI_STATUS_BAR_H, EPD_WIDTH, GxEPD_BLACK);
}

static void drawBottomInfoRow(bool showWeather) {
  char timeBuf[8];
  getTime24h(timeBuf, sizeof(timeBuf), &lastRenderedMinute);

  display.setTextSize(2);
  display.setTextColor(GxEPD_BLACK);
  display.setCursor(12, UI_INFO_BAR_Y);
  display.print(timeBuf);

  if (!showWeather) {
    return;
  }

  char numBuf[8];
  if (rtcWeatherValid) {
    snprintf(numBuf, sizeof(numBuf), "%d", rtcWeatherTempC);
  } else {
    snprintf(numBuf, sizeof(numBuf), "--");
  }

  int16_t numChars = static_cast<int16_t>(strlen(numBuf));
  int16_t tempWidth = numChars * 12 + 8 + 12;
  int16_t tempX = 188 - tempWidth;

  uint16_t iconW = 20;
  uint16_t iconH = 20;
  const uint8_t* weatherIcon = getWeatherIconForWmo(rtcWeatherCode, iconW, iconH);
  display.drawBitmap(tempX - 24, UI_WEATHER_ICON_Y, weatherIcon, iconW, iconH, GxEPD_BLACK);

  display.setCursor(tempX, UI_INFO_BAR_Y);
  display.print(numBuf);

  int16_t degX = tempX + numChars * 12 + 2;
  int16_t degY = UI_INFO_BAR_Y + 3;
  display.drawCircle(degX, degY, 2, GxEPD_BLACK);

  display.setCursor(degX + 5, UI_INFO_BAR_Y);
  display.print("C");
}

static void drawWifiQrCode() {
  QRCode qrcode;
  uint8_t qrcodeData[qrcode_getBufferSize(3)];
  char payload[64];
  snprintf(payload, sizeof(payload), "WIFI:T:nopass;S:%s;;", FOXIE_AP_SSID);
  qrcode_initText(&qrcode, qrcodeData, 3, ECC_MEDIUM, payload);

  int16_t modules = qrcode.size;
  int16_t cellSize = UI_QR_SIZE / modules;
  if (cellSize < 2) cellSize = 2;
  int16_t totalPx = modules * cellSize;
  int16_t originX = (EPD_WIDTH - totalPx) / 2;
  int16_t originY = UI_QR_Y;

  display.drawRoundRect(originX - 4, originY - 4, totalPx + 8, totalPx + 8, 3, GxEPD_BLACK);
  for (int16_t y = 0; y < modules; y++) {
    for (int16_t x = 0; x < modules; x++) {
      if (qrcode_getModule(&qrcode, x, y)) {
        display.fillRect(
          originX + x * cellSize,
          originY + y * cellSize,
          cellSize,
          cellSize,
          GxEPD_BLACK
        );
      }
    }
  }
}

static void formatMinute24h(int minuteOfDay, char* out, size_t len) {
  if (minuteOfDay >= 0 && minuteOfDay < 1440) {
    snprintf(out, len, "%02d:%02d", minuteOfDay / 60, minuteOfDay % 60);
  } else {
    snprintf(out, len, "--:--");
  }
}

static void drawHibernationFrame(int minuteOfDay, uint8_t batPct) {
  batteryPercent = batPct;
  display.fillScreen(GxEPD_WHITE);
  drawStatusBar("USPIONY", false);
  display.drawBitmap(
    UI_FOX_X,
    UI_FOX_SLEEP_Y,
    FOX_SPRITE_HIBERNATE,
    FOX_SPRITE_HIBERNATE_W,
    FOX_SPRITE_HIBERNATE_H,
    GxEPD_BLACK
  );

  char timeBuf[8];
  formatMinute24h(minuteOfDay, timeBuf, sizeof(timeBuf));
  display.setTextSize(2);
  display.setTextColor(GxEPD_BLACK);
  display.setCursor(12, UI_INFO_BAR_Y);
  display.print(timeBuf);

  display.drawRect(0, 0, EPD_WIDTH, EPD_HEIGHT, GxEPD_BLACK);
}

static void buildReadyStatusLabel(char* out, size_t len, bool wifiConnected) {
  uint16_t pending = sdQueue.pendingCount();
  if (pending > 0) {
    snprintf(
      out,
      len,
      "%s SD:%u",
      wifiConnected ? "POLACZONY" : "OFFLINE",
      static_cast<unsigned>(pending)
    );
  } else {
    snprintf(out, len, "%s", wifiConnected ? "POLACZONY" : "BRAK WI-FI");
  }
}

// 16x16 1-bit sync arrows icon (mirrors ICON_MIC placement on Recording screen)
static const uint8_t ICON_SYNC_16[32] PROGMEM = {
  0x00, 0x00,
  0x07, 0xE0,
  0x1F, 0xF8,
  0x38, 0x3C,
  0x70, 0x1E,
  0x60, 0x3E,
  0xC0, 0x0E,
  0x00, 0x00,
  0x00, 0x00,
  0x70, 0x03,
  0x7C, 0x06,
  0x78, 0x0E,
  0x3C, 0x1C,
  0x1F, 0xF8,
  0x07, 0xE0,
  0x00, 0x00
};

static void renderCurrentScreen(bool partial = false) {
  batteryPercent = readBatteryPercent();
  bool wifiConnected = (!isSleeping && WiFi.status() == WL_CONNECTED);
  if (!isSleeping && currentState == DeviceState::Ready) {
    uiWifiConnected = wifiConnected;
  }

  setDisplayPower(true);
  if (partial) {
    display.setPartialWindow(0, 0, EPD_WIDTH, EPD_HEIGHT);
  } else {
    readyPartialCount = 0;
    display.setFullWindow();
  }

  int hibernationMinute = -1;
  if (isSleeping) {
    char tmp[8];
    getTime24h(tmp, sizeof(tmp), &hibernationMinute);
    lastRenderedMinute = hibernationMinute;
  }

  display.firstPage();
  do {
    display.fillScreen(GxEPD_WHITE);

    if (isSleeping) {
      // Dedicated hibernation pose: 24h clock visible, weather hidden
      drawHibernationFrame(hibernationMinute, batteryPercent);
      continue;
    } else {
      switch (currentState) {
        case DeviceState::Ready: {
          char statusLabel[24];
          buildReadyStatusLabel(statusLabel, sizeof(statusLabel), wifiConnected);
          drawStatusBar(statusLabel, wifiConnected);
          display.drawBitmap(UI_FOX_X, UI_FOX_READY_Y, FOX_SPRITE_READY, FOX_SPRITE_READY_W, FOX_SPRITE_READY_H, GxEPD_BLACK);
          drawBottomInfoRow(true);
          break;
        }

        case DeviceState::Recording: {
          uint32_t elapsedSec = (millis() - recordingStartedMs) / 1000;
          char timeBuf[16];
          snprintf(timeBuf, sizeof(timeBuf), "%02lu:%02lu", elapsedSec / 60, elapsedSec % 60);

          drawStatusBar("NAGRYWANIE", wifiConnected);
          display.drawBitmap(UI_FOX_X, UI_FOX_Y, FOX_SPRITE_LISTEN, FOX_SPRITE_LISTEN_W, FOX_SPRITE_LISTEN_H, GxEPD_BLACK);
          display.drawBitmap(10, 28, ICON_MIC, ICON_MIC_W, ICON_MIC_H, GxEPD_BLACK);
          drawCenteredText(EPD_WIDTH / 2, UI_TITLE_Y, timeBuf, 2);
          break;
        }

        case DeviceState::Uploading: {
          if (syncQueueTotal > 0) {
            char syncLabel[24];
            snprintf(
              syncLabel,
              sizeof(syncLabel),
              "SYNC %u/%u",
              static_cast<unsigned>(syncQueueCurrent),
              static_cast<unsigned>(syncQueueTotal)
            );
            drawStatusBar(syncLabel, wifiConnected);
          } else {
            drawStatusBar("WYSYLANIE", wifiConnected);
          }
          display.drawBitmap(UI_FOX_X, UI_FOX_Y, FOX_SPRITE_UPLOAD, FOX_SPRITE_UPLOAD_W, FOX_SPRITE_UPLOAD_H, GxEPD_BLACK);
          display.drawBitmap(10, 28, ICON_SYNC_16, 16, 16, GxEPD_BLACK);

          int16_t barY = UI_PROGRESS_Y;
          if (syncQueueTotal > 0) {
            char cntBuf[24];
            snprintf(
              cntBuf,
              sizeof(cntBuf),
              "SYNC %u z %u",
              static_cast<unsigned>(syncQueueCurrent),
              static_cast<unsigned>(syncQueueTotal)
            );
            drawCenteredText(EPD_WIDTH / 2, 165, cntBuf, 1);
            barY = 177;
          }

          display.drawRect(28, barY, 144, 12, GxEPD_BLACK);
          int16_t innerW = (140 * uploadProgress) / 100;
          if (innerW > 0) {
            display.fillRect(30, barY + 2, innerW, 8, GxEPD_BLACK);
          }
          break;
        }

        case DeviceState::Saved:
          drawStatusBar(savedToSdFlag ? "ZAPISANO SD" : "ZAPISANO", wifiConnected);
          display.drawBitmap(UI_FOX_X, UI_FOX_Y, FOX_SPRITE_SAVED, FOX_SPRITE_SAVED_W, FOX_SPRITE_SAVED_H, GxEPD_BLACK);
          drawCenteredText(EPD_WIDTH / 2, UI_TITLE_Y, savedToSdFlag ? "NA KARCIE SD" : "ZAPISANO!", 2);
          break;

        case DeviceState::Error:
          drawStatusBar("BLAD", wifiConnected);
          display.drawBitmap(UI_FOX_X, UI_FOX_Y, FOX_SPRITE_ERROR, FOX_SPRITE_ERROR_W, FOX_SPRITE_ERROR_H, GxEPD_BLACK);
          if (lastErrorText[0] != '\0') {
            drawCenteredText(EPD_WIDTH / 2, 166, "BLAD", 2);
            drawCenteredText(EPD_WIDTH / 2, 185, lastErrorText, 1);
          } else {
            drawCenteredText(EPD_WIDTH / 2, UI_TITLE_Y, "BLAD", 2);
          }
          break;

        case DeviceState::WifiSetup: {
          drawStatusBar("WI-FI AP", false);
          display.drawBitmap(UI_PEEK_X, UI_PEEK_Y, FOX_SPRITE_PEEK, FOX_SPRITE_PEEK_W, FOX_SPRITE_PEEK_H, GxEPD_BLACK);
          drawWifiQrCode();
          char apLabel[32];
          snprintf(apLabel, sizeof(apLabel), "AP: %s", FOXIE_AP_SSID);
          drawCenteredText(EPD_WIDTH / 2, 152, apLabel, 1);
          drawCenteredText(EPD_WIDTH / 2, 168, "192.168.4.1", 1);
          break;
        }
      }
    }

    display.drawRect(0, 0, EPD_WIDTH, EPD_HEIGHT, GxEPD_BLACK);
  } while (display.nextPage());

  if (!isSleeping && currentState != DeviceState::Recording) {
    display.powerOff();
  }
}

static void renderBottomInfoPartial() {
  setDisplayPower(true);
  display.setPartialWindow(8, 168, 184, 30);
  display.firstPage();
  do {
    display.fillRect(8, 168, 184, 30, GxEPD_WHITE);
    drawBottomInfoRow(true);
  } while (display.nextPage());
  display.powerOff();
}

static void renderStatusBarPartial(bool wifiConnected) {
  batteryPercent = readBatteryPercent();
  char statusLabel[24];
  buildReadyStatusLabel(statusLabel, sizeof(statusLabel), wifiConnected);

  setDisplayPower(true);
  display.setPartialWindow(0, 0, EPD_WIDTH, UI_STATUS_BAR_H + 1);
  display.firstPage();
  do {
    display.fillRect(0, 0, EPD_WIDTH, UI_STATUS_BAR_H + 1, GxEPD_WHITE);
    drawStatusBar(statusLabel, wifiConnected);
    display.drawFastHLine(0, 0, EPD_WIDTH, GxEPD_BLACK);
    display.drawFastVLine(0, 0, UI_STATUS_BAR_H + 1, GxEPD_BLACK);
    display.drawFastVLine(EPD_WIDTH - 1, 0, UI_STATUS_BAR_H + 1, GxEPD_BLACK);
  } while (display.nextPage());
  display.powerOff();
}

static void renderRecordingTimerPartial() {
  uint32_t elapsedSec = (millis() - recordingStartedMs) / 1000;
  char timeBuf[16];
  snprintf(timeBuf, sizeof(timeBuf), "%02lu:%02lu", elapsedSec / 60, elapsedSec % 60);

  setDisplayPower(true);
  display.setPartialWindow(48, UI_TITLE_Y - 2, 104, 22);
  display.firstPage();
  do {
    display.fillRect(48, UI_TITLE_Y - 2, 104, 22, GxEPD_WHITE);
    drawCenteredText(EPD_WIDTH / 2, UI_TITLE_Y, timeBuf, 2);
  } while (display.nextPage());
}

static bool isApiConfigured() {
  String url = cfg.apiUrl;
  url.trim();
  return !url.isEmpty() && url.indexOf("your-project-id") < 0;
}

static bool isTransientUploadError(int httpStatus) {
  return httpStatus == 0 || httpStatus >= 500 || httpStatus == 408 || httpStatus == 429;
}

static void enterState(DeviceState next, bool partial = false) {
  markUserActivity();
  if (next != DeviceState::WifiSetup) {
    stopCaptivePortal();
  }
  isSleeping = false;
  rtcInHibernation = false;

  if (next == DeviceState::Recording) {
    if (!audioRecorder.startRecording()) {
      snprintf(lastErrorText, sizeof(lastErrorText), "BLAD AUDIO");
      errorEnteredMs = millis();
      currentState = DeviceState::Error;
      currentLedPattern = LedPattern::WifiPulse;
      Serial.println("[Foxie] State -> Error (audio start failed)");
      renderCurrentScreen(partial);
      return;
    }
    recordingStartedMs = millis();
  }

  currentState = next;
  Serial.printf("[Foxie] State -> %d\n", static_cast<int>(next));

  switch (next) {
    case DeviceState::Ready:
      lastErrorText[0] = '\0';
      currentLedPattern = LedPattern::Off;
      break;
    case DeviceState::Recording:
      currentLedPattern = LedPattern::SlowBlink;
      break;
    case DeviceState::Uploading:
      uploadStartedMs = millis();
      if (syncQueueTotal == 0) {
        uploadProgress = 50;
      }
      currentLedPattern = LedPattern::FastBlink;
      break;
    case DeviceState::Saved:
      savedEnteredMs = millis();
      currentLedPattern = LedPattern::SolidOn;
      break;
    case DeviceState::Error:
      errorEnteredMs = millis();
      currentLedPattern = LedPattern::WifiPulse;
      break;
    case DeviceState::WifiSetup:
      currentLedPattern = LedPattern::WifiPulse;
      startCaptivePortal();
      break;
  }

  renderCurrentScreen(partial);
  if (next == DeviceState::Recording) {
    lastRecDrawMs = millis();
  } else if (next == DeviceState::Ready) {
    enterIdlePowerProfile();
  }
}

static void configureRtcWakePin(int gpioNum) {
  auto pin = static_cast<gpio_num_t>(gpioNum);
  rtc_gpio_init(pin);
  rtc_gpio_set_direction(pin, RTC_GPIO_MODE_INPUT_ONLY);
  rtc_gpio_pullup_en(pin);
  rtc_gpio_pulldown_dis(pin);
}

static void armHibernationSleepAndStart() {
  // Latch safe OFF levels on all active-LOW/power control pins during deep sleep
  pinMode(PIN_PWR_HOLD, OUTPUT);
  digitalWrite(PIN_PWR_HOLD, HIGH);
  pinMode(PIN_EPD_PWR, OUTPUT);
  digitalWrite(PIN_EPD_PWR, EPD_PWR_OFF_LEVEL);
  pinMode(PIN_AUDIO_PWR, OUTPUT);
  digitalWrite(PIN_AUDIO_PWR, AUDIO_PWR_OFF_LEVEL);
  pinMode(PIN_AUDIO_PA_CTRL, OUTPUT);
  digitalWrite(PIN_AUDIO_PA_CTRL, LOW);
  pinMode(PIN_LED_STATUS, OUTPUT);
  digitalWrite(PIN_LED_STATUS, LED_OFF_LEVEL);

  gpio_hold_en(static_cast<gpio_num_t>(PIN_PWR_HOLD));
  gpio_hold_en(static_cast<gpio_num_t>(PIN_EPD_PWR));
  gpio_hold_en(static_cast<gpio_num_t>(PIN_AUDIO_PWR));
  gpio_hold_en(static_cast<gpio_num_t>(PIN_AUDIO_PA_CTRL));
  gpio_hold_en(static_cast<gpio_num_t>(PIN_LED_STATUS));
  gpio_deep_sleep_hold_en();

  uint64_t wakeMask = (1ULL << PIN_BTN_BOOT) | (1ULL << PIN_BTN_PWR);
  configureRtcWakePin(PIN_BTN_BOOT);
  configureRtcWakePin(PIN_BTN_PWR);

  if (digitalRead(PIN_TP_INT) == HIGH) {
    configureRtcWakePin(PIN_TP_INT);
    wakeMask |= (1ULL << PIN_TP_INT);
  }

  esp_sleep_enable_ext1_wakeup(wakeMask, ESP_EXT1_WAKEUP_ANY_LOW);

  // Align silent RTC clock tick to next minute boundary (keeps 24h clock fresh with Wi-Fi OFF)
  char tmp[8];
  int minNow = -1;
  int secNow = 0;
  uint64_t sleepSec = 60;
  if (getTime24h(tmp, sizeof(tmp), &minNow, &secNow) && minNow >= 0) {
    if (rtcHibLastMinute < 0) {
      rtcHibLastMinute = static_cast<int16_t>(minNow);
    }
    sleepSec = static_cast<uint64_t>(60 - (secNow % 60));
    if (sleepSec < 5) sleepSec += 60;
  }
  esp_sleep_enable_timer_wakeup(sleepSec * 1000000ULL);

  Serial.flush();
  esp_deep_sleep_start();
}

static void enterDeepSleepHibernation(const char* reason) {
  Serial.printf("[Foxie] Entering deep sleep hibernation (%s)\n", reason);
  stopCaptivePortal();
  audioRecorder.prepareForDeepSleep();
  sdQueue.prepareForDeepSleep();
  isSleeping = true;
  rtcInHibernation = true;
  rtcHibPartialCount = 0;
  currentLedPattern = LedPattern::Off;
  setLedPhysical(false);

  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);

  // Draw dedicated hibernation screen (clock visible, weather hidden) and hibernate panel
  renderCurrentScreen(false);
  rtcHibBatteryPercent = batteryPercent;
  rtcHibLastMinute = static_cast<int16_t>(lastRenderedMinute);
  display.hibernate();
  display.end();
  setDisplayPower(false);

  while (digitalRead(PIN_BTN_BOOT) == LOW || digitalRead(PIN_BTN_PWR) == LOW) {
    delay(20);
  }
  delay(80);

  armHibernationSleepAndStart();
}

static void finishRecordingAndDispatch() {
  foxie_audio::CaptureStats stats;
  audioRecorder.stopRecording(stats);
  if (stats.pcmBytes < 9600) { // < 300 ms at 16 kHz, 16-bit mono
    Serial.println("[Foxie] Recording too short (<300 ms), discarded");
    enterState(DeviceState::Ready);
    return;
  }

  if (WiFi.status() == WL_CONNECTED && isApiConfigured()) {
    savedToSdFlag = false;
    uploadPending = true;
    enterState(DeviceState::Uploading);
    return;
  }

  if (sdQueue.isMounted()) {
    String savedPath;
    if (sdQueue.enqueueWav(audioRecorder.wavData(), audioRecorder.wavSize(), savedPath)) {
      savedToSdFlag = true;
      enterState(DeviceState::Saved);
    } else {
      snprintf(lastErrorText, sizeof(lastErrorText), "BLAD SD");
      enterState(DeviceState::Error);
    }
  } else {
    snprintf(
      lastErrorText,
      sizeof(lastErrorText),
      "%s",
      (WiFi.status() != WL_CONNECTED) ? "BRAK WI-FI" : "BRAK API URL"
    );
    enterState(DeviceState::Error);
  }
}

static void syncOfflineQueueNow() {
  if (!sdQueue.isMounted() || sdQueue.pendingCount() == 0) return;
  if (WiFi.status() != WL_CONNECTED || !isApiConfigured()) return;

  enterActiveTransferProfile();
  markUserActivity();
  lastQueueSyncAttemptMs = millis();
  savedToSdFlag = false;
  uploadPending = false;
  syncQueueTotal = sdQueue.pendingCount();
  syncQueueCurrent = 1;
  uint16_t initialDenom = (syncQueueTotal > 0) ? syncQueueTotal : 1;
  uploadProgress = static_cast<uint8_t>(35U / initialDenom);
  if (uploadProgress < 15) uploadProgress = 15;
  enterState(DeviceState::Uploading);

  uint16_t syncedCount = 0;
  String filePath;
  while (sdQueue.peekOldest(filePath)) {
    if (syncedCount > 0) {
      syncQueueCurrent = syncedCount + 1;
      if (syncQueueCurrent > syncQueueTotal) {
        syncQueueTotal = syncQueueCurrent;
      }
      uint16_t denom = (syncQueueTotal > 0) ? syncQueueTotal : 1;
      uploadProgress = static_cast<uint8_t>((((syncQueueCurrent - 1) * 100U) + 35U) / denom);
      if (uploadProgress > 100) uploadProgress = 100;
      renderCurrentScreen(true);
    }

    uint8_t* wavBuf = nullptr;
    size_t wavSize = 0;
    if (!sdQueue.readFileToPsram(filePath, wavBuf, wavSize)) {
      Serial.printf("[SD] Skipping unreadable queued file: %s\n", filePath.c_str());
      syncQueueCurrent = 0;
      syncQueueTotal = 0;
      sdQueue.suspend();
      enterState(DeviceState::Ready);
      return;
    }

    // Disable e-Paper boost converter during TLS upload to avoid power rail sags
    display.powerOff();

    CaptureUploadResult res = uploadWavCapture(
      cfg.apiUrl,
      cfg.apiKey,
      wavBuf,
      wavSize,
      nullptr
    );
    free(wavBuf);

    if (res.ok) {
      sdQueue.removeFile(filePath);
      syncedCount++;
      markUserActivity();
    } else {
      Serial.printf("[SD] Queue sync paused on %s (%s)\n",
                    filePath.c_str(),
                    res.shortError[0] ? res.shortError : "ERR");
      lastQueueSyncAttemptMs = millis();
      snprintf(
        lastErrorText,
        sizeof(lastErrorText),
        "%s",
        res.shortError[0] ? res.shortError : "BLAD SYNC"
      );
      syncQueueCurrent = 0;
      syncQueueTotal = 0;
      sdQueue.suspend();
      enterState(DeviceState::Error);
      return;
    }
  }

  syncQueueCurrent = 0;
  syncQueueTotal = 0;
  sdQueue.suspend();
  if (syncedCount > 0) {
    Serial.printf("[SD] Offline queue synced (%u file(s))\n", static_cast<unsigned>(syncedCount));
    savedToSdFlag = false;
    enterState(DeviceState::Saved);
  } else {
    enterState(DeviceState::Ready);
  }
}

static void onBootShortPress() {
  markUserActivity();
  Serial.println("[Foxie] BOOT short press");
  if (isSleeping) return;

  switch (currentState) {
    case DeviceState::Ready:
    case DeviceState::Saved:
      enterState(DeviceState::Recording);
      break;
    case DeviceState::Recording:
      finishRecordingAndDispatch();
      break;
    case DeviceState::Error:
      enterState(DeviceState::Ready);
      break;
    case DeviceState::Uploading:
    case DeviceState::WifiSetup:
      break;
  }
}

static void onBootLongPress() {
  markUserActivity();
  Serial.println("[Foxie] BOOT long press ignored (Wi-Fi QR disabled from buttons)");
}

static void onPwrShortPress() {
  markUserActivity();
  Serial.println("[Foxie] PWR short press");
  if (currentState == DeviceState::Recording) {
    foxie_audio::CaptureStats discarded;
    audioRecorder.stopRecording(discarded);
    Serial.println("[Foxie] Recording cancelled by PWR");
    enterState(DeviceState::Ready);
    return;
  }
  if (currentState == DeviceState::WifiSetup) {
    stopCaptivePortal();
    if (!cfg.wifiSsid.isEmpty()) {
      connectToWifi(8000);
    }
  }
  enterState(DeviceState::Ready);
}

static void onPwrLongPress() {
  Serial.println("[Foxie] PWR long press -> deep sleep hibernation");
  enterDeepSleepHibernation("PWR 3s");
}

static void processButton(
  ButtonIsrState& btn,
  void (*onShort)(),
  void (*onLong)()
) {
  bool fireShort = false;
  bool fireLong = false;
  uint32_t nowMs = static_cast<uint32_t>(esp_timer_get_time() / 1000ULL);
  bool currentLow = (digitalRead(btn.pin) == LOW);

  portENTER_CRITICAL(&btnMux);
  if (btn.isDown && !currentLow && (nowMs - btn.lastEdgeMs) >= DEBOUNCE_MS) {
    btn.isDown = false;
    btn.lastEdgeMs = nowMs;
    if (!btn.longTriggered) {
      if ((nowMs - btn.pressedAtMs) >= LONG_PRESS_MS) {
        btn.longPending = true;
      } else {
        btn.shortPending = true;
      }
    }
  }
  if (btn.isDown && !btn.longTriggered && (nowMs - btn.pressedAtMs) >= LONG_PRESS_MS) {
    btn.longTriggered = true;
    fireLong = true;
  }
  if (btn.shortPending) {
    btn.shortPending = false;
    fireShort = true;
  }
  if (btn.longPending) {
    btn.longPending = false;
    fireLong = true;
  }
  portEXIT_CRITICAL(&btnMux);

  if (fireLong) {
    onLong();
  } else if (fireShort) {
    onShort();
  }
}

void setup() {
  // Release deep-sleep hold on power/peripheral pins and keep battery power latched HIGH
  gpio_deep_sleep_hold_dis();
  gpio_hold_dis(static_cast<gpio_num_t>(PIN_PWR_HOLD));
  gpio_hold_dis(static_cast<gpio_num_t>(PIN_EPD_PWR));
  gpio_hold_dis(static_cast<gpio_num_t>(PIN_AUDIO_PWR));
  gpio_hold_dis(static_cast<gpio_num_t>(PIN_AUDIO_PA_CTRL));
  gpio_hold_dis(static_cast<gpio_num_t>(PIN_LED_STATUS));
  pinMode(PIN_PWR_HOLD, OUTPUT);
  digitalWrite(PIN_PWR_HOLD, HIGH);

  rtc_gpio_deinit(static_cast<gpio_num_t>(PIN_BTN_BOOT));
  rtc_gpio_deinit(static_cast<gpio_num_t>(PIN_BTN_PWR));
  rtc_gpio_deinit(static_cast<gpio_num_t>(PIN_TP_INT));

  pinMode(PIN_BTN_BOOT, INPUT_PULLUP);
  pinMode(PIN_BTN_PWR, INPUT_PULLUP);
  pinMode(PIN_TP_INT, INPUT_PULLUP);
  pinMode(PIN_EPD_PWR, OUTPUT);
  pinMode(PIN_AUDIO_PWR, OUTPUT);
  digitalWrite(PIN_AUDIO_PWR, AUDIO_PWR_OFF_LEVEL);
  pinMode(PIN_AUDIO_PA_CTRL, OUTPUT);
  digitalWrite(PIN_AUDIO_PA_CTRL, LOW);

  esp_sleep_wakeup_cause_t wakeCause = esp_sleep_get_wakeup_cause();
  applyPolandTimezone();

  // Ultra-fast silent RTC clock tick during hibernation (Wi-Fi stays OFF, 80 MHz)
  if (wakeCause == ESP_SLEEP_WAKEUP_TIMER && rtcInHibernation) {
    setCpuFrequencyMhz(80);
    char tmp[8];
    int curMinute = -1;
    if (getTime24h(tmp, sizeof(tmp), &curMinute) && curMinute != rtcHibLastMinute) {
      SPI.begin(PIN_EPD_SCK, -1, PIN_EPD_MOSI, PIN_EPD_CS);
      setDisplayPower(true);

      if (rtcHibLastMinute < 0 || rtcHibPartialCount >= EPD_FULL_REFRESH_EVERY) {
        display.init(0, true, 2, false);
        display.setRotation(0);
        display.setTextWrap(false);
        rtcHibBatteryPercent = readBatteryPercent();
        rtcHibPartialCount = 0;
        display.setFullWindow();
        drawHibernationFrame(curMinute, rtcHibBatteryPercent);
        display.display(false);
      } else {
        display.init(0, false, 2, false);
        display.setRotation(0);
        display.setTextWrap(false);

        // Restore SSD1681 previous RAM (0x26) after power-off with the exact on-screen frame
        display.setFullWindow();
        display.firstPage();
        do {
          drawHibernationFrame(rtcHibLastMinute, rtcHibBatteryPercent);
        } while (display.nextPageToPrevious());

        // Write full new frame to current RAM (0x24) and run clean differential partial refresh
        display.setFullWindow();
        drawHibernationFrame(curMinute, rtcHibBatteryPercent);
        display.display(true);
        rtcHibPartialCount++;
      }

      rtcHibLastMinute = static_cast<int16_t>(curMinute);
      display.hibernate();
      display.end();
      setDisplayPower(false);
    }
    armHibernationSleepAndStart();
  }

  // Woken by button/touch or cold boot -> return to full awake mode
  rtcInHibernation = false;
  isSleeping = false;

  gpio_reset_pin(static_cast<gpio_num_t>(PIN_LED_STATUS));
  pinMode(PIN_LED_STATUS, OUTPUT);
  setLedPhysical(false);
  xTaskCreate(ledTask, "led_task", 2048, nullptr, 1, nullptr);

  attachInterruptArg(digitalPinToInterrupt(PIN_BTN_BOOT), handleButtonIsr, &btnBoot, CHANGE);
  attachInterruptArg(digitalPinToInterrupt(PIN_BTN_PWR), handleButtonIsr, &btnPwr, CHANGE);
  attachInterrupt(digitalPinToInterrupt(PIN_TP_INT), handleTouchIsr, FALLING);

  if (wakeCause == ESP_SLEEP_WAKEUP_UNDEFINED) {
    pinMode(PIN_TP_RST, OUTPUT);
    digitalWrite(PIN_TP_RST, LOW);
    delay(10);
    digitalWrite(PIN_TP_RST, HIGH);
    delay(40);
  }

  setDisplayPower(true);
  Serial.begin(115200);
  delay(200);
  WiFi.onEvent(handleWifiEvent);
  Serial.println();
  Serial.printf("[Foxie] Booting Waveshare V2 (wakeCause=%d, resetReason=%d)\n",
                static_cast<int>(wakeCause),
                static_cast<int>(esp_reset_reason()));
  if (wakeCause == ESP_SLEEP_WAKEUP_EXT1) {
    Serial.printf("[Foxie] Woke from hibernation! ext1 mask=0x%llx\n",
                  static_cast<unsigned long long>(esp_sleep_get_ext1_wakeup_status()));
  }
  if (psramFound()) {
    Serial.printf("[Foxie] PSRAM OK: %lu bytes free\n", static_cast<unsigned long>(ESP.getFreePsram()));
  } else {
    Serial.println("[Foxie] WARNING: PSRAM not detected");
  }

  SPI.begin(PIN_EPD_SCK, -1, PIN_EPD_MOSI, PIN_EPD_CS);
  display.init(115200, true, 2, false);
  display.setRotation(0);
  display.setTextWrap(false);

  bool audioOk = audioRecorder.begin();
  Serial.printf("[Foxie] Audio init: %s\n", audioOk ? "OK" : "FAILED");

  bool sdOk = sdQueue.begin();
  Serial.printf("[Foxie] SD queue init: %s (pending=%u)\n",
                sdOk ? "OK" : "NONE",
                static_cast<unsigned>(sdQueue.pendingCount()));

  markUserActivity();
  loadConfigFromNvs();
  if (connectToWifi(WIFI_CONNECT_TIMEOUT_MS)) {
    prevWifiConnected = true;
    uiWifiConnected = true;
    enterState(DeviceState::Ready);
  } else if (cfg.wifiSsid.isEmpty()) {
    prevWifiConnected = false;
    uiWifiConnected = false;
    enterState(DeviceState::WifiSetup);
  } else {
    prevWifiConnected = false;
    uiWifiConnected = false;
    lastWifiReconnectAttemptMs = millis();
    Serial.println("[Foxie] Offline mode -> Ready (SD queue available)");
    enterState(DeviceState::Ready);
  }
}

void loop() {
  if (touchActivityPending) {
    touchActivityPending = false;
    markUserActivity();
  }

  processButton(btnBoot, onBootShortPress, onBootLongPress);
  processButton(btnPwr, onPwrShortPress, onPwrLongPress);

  if (Serial.available() > 0) {
    int ch = Serial.read();
    if (ch == 't' && !isSleeping &&
        currentState != DeviceState::Recording &&
        currentState != DeviceState::Uploading) {
      Serial.println("[Diag] Starting 2s test recording (no upload)...");
      if (audioRecorder.startRecording()) {
        delay(2000);
        foxie_audio::CaptureStats stats;
        audioRecorder.stopRecording(stats);
        Serial.printf("[Diag] Test WAV: wav=%lu B, pcm=%lu B, dur=%lu ms, peak=%d, rms=%u\n",
                      static_cast<unsigned long>(stats.wavBytes),
                      static_cast<unsigned long>(stats.pcmBytes),
                      static_cast<unsigned long>(stats.durationMs),
                      stats.peakAbs,
                      stats.rms);
      } else {
        Serial.println("[Diag] Test recording failed to start");
      }
      markUserActivity();
    } else if (ch == 's') {
      uint32_t batMv = readBatteryMilliVolts();
      uint8_t batPct = readBatteryPercent();
      Serial.printf("[Diag] state=%d wifi=%d cpuMhz=%lu batMv=%lu batPct=%u audioReady=%d es8311=0x%04X rev=0x%02X probe=%uB(peak=%d,rms=%u) sdMounted=%d sdPending=%u psramFree=%lu stackFree=%lu lastWifiErr=%u apiUrlSet=%d apiKeySet=%d\n",
                    static_cast<int>(currentState),
                    static_cast<int>(WiFi.status()),
                    static_cast<unsigned long>(getCpuFrequencyMhz()),
                    static_cast<unsigned long>(batMv),
                    static_cast<unsigned>(batPct),
                    audioRecorder.isReady() ? 1 : 0,
                    audioRecorder.chipId(),
                    audioRecorder.chipRev(),
                    static_cast<unsigned>(audioRecorder.probeBytes()),
                    audioRecorder.probePeak(),
                    audioRecorder.probeRms(),
                    sdQueue.isMounted() ? 1 : 0,
                    static_cast<unsigned>(sdQueue.pendingCount()),
                    static_cast<unsigned long>(ESP.getFreePsram()),
                    static_cast<unsigned long>(uxTaskGetStackHighWaterMark(nullptr)),
                    static_cast<unsigned>(lastWifiDisconnectReason),
                    isApiConfigured() ? 1 : 0,
                    !cfg.apiKey.isEmpty() ? 1 : 0);
    } else if (ch == 'q' && !isSleeping &&
               currentState != DeviceState::Recording &&
               currentState != DeviceState::Uploading) {
      if (!sdQueue.isMounted()) {
        Serial.println("[Diag] SD queue: not mounted");
      } else {
        if (audioRecorder.wavSize() <= 44 && audioRecorder.startRecording()) {
          delay(1500);
          foxie_audio::CaptureStats stats;
          audioRecorder.stopRecording(stats);
        }
        String queuedPath;
        if (audioRecorder.wavSize() > 44 &&
            sdQueue.enqueueWav(audioRecorder.wavData(), audioRecorder.wavSize(), queuedPath)) {
          Serial.printf("[Diag] SD queue saved %s, pending=%u\n",
                        queuedPath.c_str(),
                        static_cast<unsigned>(sdQueue.pendingCount()));
        } else {
          Serial.printf("[Diag] SD queue save failed, pending=%u\n",
                        static_cast<unsigned>(sdQueue.pendingCount()));
        }
      }
      markUserActivity();
    }
  }

  if (portalActive) {
    dnsServer.processNextRequest();
    webServer.handleClient();
    if (portalSavePending) {
      portalSavePending = false;
      delay(300);
      if (connectToWifi(WIFI_CONNECT_TIMEOUT_MS)) {
        prevWifiConnected = true;
        lastQueueSyncAttemptMs = 0;
        enterState(DeviceState::Ready);
      } else {
        prevWifiConnected = false;
        enterState(DeviceState::WifiSetup);
      }
      return;
    }
  }

  uint32_t now = millis();

  if (!isSleeping && currentState == DeviceState::Recording) {
    if (audioRecorder.hasReachedLimit()) {
      Serial.printf("[Foxie] Max recording duration (%lus) reached -> dispatching\n",
                    static_cast<unsigned long>(foxie_audio::MAX_DURATION_SEC));
      finishRecordingAndDispatch();
      return;
    }
    if (now - lastRecDrawMs >= 1000) {
      renderRecordingTimerPartial();
      lastRecDrawMs = millis();
      processButton(btnBoot, onBootShortPress, onBootLongPress);
      processButton(btnPwr, onPwrShortPress, onPwrLongPress);
    }
  } else if (!isSleeping && currentState == DeviceState::Uploading) {
    if (uploadPending) {
      uploadPending = false;
      enterActiveTransferProfile();
      display.powerOff();
      CaptureUploadResult res = uploadWavCapture(
        cfg.apiUrl,
        cfg.apiKey,
        audioRecorder.wavData(),
        audioRecorder.wavSize(),
        nullptr
      );
      if (res.ok) {
        lastErrorText[0] = '\0';
        savedToSdFlag = false;
        enterState(DeviceState::Saved);
      } else if (isTransientUploadError(res.httpStatus) && sdQueue.isMounted()) {
        String savedPath;
        if (sdQueue.enqueueWav(audioRecorder.wavData(), audioRecorder.wavSize(), savedPath)) {
          lastQueueSyncAttemptMs = millis();
          savedToSdFlag = true;
          enterState(DeviceState::Saved);
        } else {
          snprintf(lastErrorText, sizeof(lastErrorText), "BLAD SD");
          enterState(DeviceState::Error);
        }
      } else {
        snprintf(
          lastErrorText,
          sizeof(lastErrorText),
          "%s",
          res.shortError[0] ? res.shortError : "BLAD WYSYLKI"
        );
        enterState(DeviceState::Error);
      }
    }
  } else if (!isSleeping && currentState == DeviceState::Saved) {
    if (now - savedEnteredMs >= SAVED_AUTO_RETURN_MS) {
      savedToSdFlag = false;
      enterState(DeviceState::Ready);
    }
  } else if (!isSleeping && currentState == DeviceState::Error) {
    if (now - errorEnteredMs >= ERROR_AUTO_RETURN_MS) {
      lastErrorText[0] = '\0';
      enterState(DeviceState::Ready);
    }
  } else if (!isSleeping && currentState == DeviceState::Ready) {
    if ((now - lastActivityMs) >= INACTIVITY_SLEEP_MS) {
      enterDeepSleepHibernation("3 min bezczynnosci");
      return;
    }

    bool wifiNow = (WiFi.status() == WL_CONNECTED);
    if (wifiNow) {
      wifiLostAtMs = 0;
      if (!prevWifiConnected) {
        prevWifiConnected = true;
        Serial.printf("[Foxie] Wi-Fi reconnected! IP: %s, RSSI: %d dBm\n",
                      WiFi.localIP().toString().c_str(),
                      WiFi.RSSI());
        syncNtpTime(1500);
        resolveCustomCityIfNeeded();
        bool weatherOk = fetchWeatherOpenMeteo();
        lastQueueSyncAttemptMs = 0;
        if (!uiWifiConnected) {
          uiWifiConnected = true;
          renderStatusBarPartial(true);
          readyPartialCount++;
        }
        if (weatherOk) {
          renderBottomInfoPartial();
          readyPartialCount++;
        }
        enterIdlePowerProfile();
        return;
      }
    } else {
      if (prevWifiConnected) {
        prevWifiConnected = false;
        wifiLostAtMs = now;
        lastWifiReconnectAttemptMs = now;
        Serial.println("[Foxie] Wi-Fi disconnected (waiting debounce before UI update)");
      }
      if (uiWifiConnected && wifiLostAtMs != 0 &&
          (now - wifiLostAtMs) >= WIFI_OFFLINE_UI_DEBOUNCE_MS) {
        uiWifiConnected = false;
        renderStatusBarPartial(false);
        readyPartialCount++;
      }
      if (!cfg.wifiSsid.isEmpty() &&
          (wifiRetryRequested || (now - lastWifiReconnectAttemptMs) >= WIFI_RECONNECT_INTERVAL_MS)) {
        lastWifiReconnectAttemptMs = now;
        wifiRetryRequested = false;
        Serial.println("[Foxie] Attempting background Wi-Fi reconnect...");
        if (!connectToWifi(8000)) {
          enterIdlePowerProfile();
        } else {
          prevWifiConnected = true;
          lastQueueSyncAttemptMs = 0;
          if (!uiWifiConnected) {
            uiWifiConnected = true;
            renderStatusBarPartial(true);
            readyPartialCount++;
          }
          renderBottomInfoPartial();
          readyPartialCount++;
          enterIdlePowerProfile();
        }
        return;
      }
    }

    now = millis();

    if (wifiNow && sdQueue.isMounted() && sdQueue.pendingCount() > 0 && isApiConfigured() &&
        (lastQueueSyncAttemptMs == 0 || (now - lastQueueSyncAttemptMs) >= QUEUE_SYNC_RETRY_MS)) {
      syncOfflineQueueNow();
      return;
    }

    bool needBottomRefresh = false;

    if (wifiNow &&
        (lastWeatherFetchMs == 0 || (now - lastWeatherFetchMs) >= WEATHER_REFRESH_MS)) {
      if (fetchWeatherOpenMeteo()) {
        needBottomRefresh = true;
      } else {
        lastWeatherFetchMs = millis();
      }
      enterIdlePowerProfile();
    }

    now = millis();
    if (now - lastClockCheckMs >= 1000) {
      lastClockCheckMs = now;
      char tmp[8];
      int currentMinute = -1;
      getTime24h(tmp, sizeof(tmp), &currentMinute);
      if (currentMinute != -1 && currentMinute != lastRenderedMinute) {
        needBottomRefresh = true;
      }
    }

    if (needBottomRefresh) {
      if (readyPartialCount >= EPD_FULL_REFRESH_EVERY) {
        renderCurrentScreen(false);
      } else {
        renderBottomInfoPartial();
        readyPartialCount++;
      }
    }
  }

  delay(15);
}
