#include <Arduino.h>
#include <DNSServer.h>
#include <GxEPD2_BW.h>
#include <Preferences.h>
#include <SPI.h>
#include <WebServer.h>
#include <WiFi.h>
#include <qrcode.h>
#include "driver/gpio.h"
#include "esp_timer.h"
#include "board_pins.h"
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
};

constexpr uint32_t DEBOUNCE_MS = 35;
constexpr uint32_t LONG_PRESS_MS = 2500;
constexpr uint32_t SAVED_AUTO_RETURN_MS = 3500;
constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 12000;
constexpr uint8_t DNS_PORT = 53;

static DeviceState currentState = DeviceState::Ready;
static volatile LedPattern currentLedPattern = LedPattern::Off;
static bool isSleeping = false;
static bool portalActive = false;
static bool portalSavePending = false;

static uint32_t recordingStartedMs = 0;
static uint32_t lastRecDrawMs = 0;
static uint32_t uploadStartedMs = 0;
static uint32_t savedEnteredMs = 0;
static uint8_t uploadProgress = 0;
static uint8_t batteryPercent = 100;

static FoxieConfig cfg;
static Preferences prefs;
static DNSServer dnsServer;
static WebServer webServer(80);

static portMUX_TYPE btnMux = portMUX_INITIALIZER_UNLOCKED;
static ButtonIsrState btnBoot{PIN_BTN_BOOT};
static ButtonIsrState btnPwr{PIN_BTN_PWR};

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

static uint8_t readBatteryPercent() {
  uint32_t mv = analogReadMilliVolts(PIN_BAT_ADC);
  // 2x resistive divider on BAT_ADC (GPIO 4)
  uint32_t batMv = mv * 2;
  if (batMv <= 3300) return 0;
  if (batMv >= 4200) return 100;
  return static_cast<uint8_t>(((batMv - 3300) * 100) / (4200 - 3300));
}

static void loadConfigFromNvs() {
  prefs.begin("foxie", false);
  cfg.wifiSsid = prefs.getString("ssid", "");
  cfg.wifiPass = prefs.getString("pass", "");
  cfg.apiUrl = prefs.getString("api_url", "");
  cfg.apiKey = prefs.getString("api_key", "");
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
}

static void saveConfigToNvs() {
  prefs.begin("foxie", false);
  prefs.putString("ssid", cfg.wifiSsid);
  prefs.putString("pass", cfg.wifiPass);
  prefs.putString("api_url", cfg.apiUrl);
  prefs.putString("api_key", cfg.apiKey);
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

static void stopCaptivePortal() {
  if (!portalActive) return;
  webServer.stop();
  dnsServer.stop();
  WiFi.softAPdisconnect(true);
  portalActive = false;
  Serial.println("[Foxie] Captive Portal stopped");
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

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(cfg.wifiSsid.c_str(), cfg.wifiPass.c_str());

  uint32_t startMs = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - startMs) < timeoutMs) {
    delay(250);
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[Foxie] Wi-Fi connected! IP: %s, RSSI: %d dBm\n",
                  WiFi.localIP().toString().c_str(),
                  WiFi.RSSI());
    return true;
  }

  Serial.printf("[Foxie] Wi-Fi connection timeout (status=%d)\n",
                static_cast<int>(WiFi.status()));
  return false;
}

static void handlePortalRoot() {
  String html;
  html.reserve(1800);
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
            "<p>Wpisz dane sieci Wi-Fi (2.4 GHz) oraz opcjonalnie adres backendu i X-API-Key.</p>"
            "<form method='POST' action='/save'>"
            "<label>Nazwa sieci Wi-Fi (SSID)<input name='ssid' required value='");
  html += htmlEscape(cfg.wifiSsid);
  html += F("'></label><label>Haslo Wi-Fi<input name='pass' type='password' placeholder='");
  html += cfg.wifiPass.isEmpty() ? F("haslo sieci") : F("pozostaw puste, aby zachowac");
  html += F("'></label><label>URL API (np. https://twoj-projekt.web.app)<input name='api_url' value='");
  html += htmlEscape(cfg.apiUrl);
  html += F("'></label><label>X-API-Key<input name='api_key' type='password' placeholder='");
  html += cfg.apiKey.isEmpty() ? F("klucz urzadzenia") : F("pozostaw puste, aby zachowac");
  html += F("'></label><button type='submit'>Zapisz i polacz</button></form></body></html>");

  webServer.send(200, "text/html", html);
}

static void handlePortalSave() {
  String nextSsid = webServer.arg("ssid");
  String nextPass = webServer.arg("pass");
  String nextApiUrl = webServer.arg("api_url");
  String nextApiKey = webServer.arg("api_key");

  nextSsid.trim();
  nextApiUrl.trim();
  nextApiKey.trim();

  if (!nextSsid.isEmpty()) {
    cfg.wifiSsid = nextSsid;
  }
  if (!nextPass.isEmpty()) {
    cfg.wifiPass = nextPass;
  }
  if (!nextApiUrl.isEmpty()) {
    cfg.apiUrl = nextApiUrl;
  }
  if (!nextApiKey.isEmpty()) {
    cfg.apiKey = nextApiKey;
  }

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

static void renderCurrentScreen(bool partial = false) {
  batteryPercent = readBatteryPercent();
  bool wifiConnected = (WiFi.status() == WL_CONNECTED);

  setDisplayPower(true);
  if (partial) {
    display.setPartialWindow(0, 0, EPD_WIDTH, EPD_HEIGHT);
  } else {
    display.setFullWindow();
  }

  display.firstPage();
  do {
    display.fillScreen(GxEPD_WHITE);

    if (isSleeping) {
      drawStatusBar("USPIONY", wifiConnected);
      display.drawBitmap(UI_FOX_X, UI_FOX_READY_Y, FOX_SPRITE_SLEEP, FOX_SPRITE_SLEEP_W, FOX_SPRITE_SLEEP_H, GxEPD_BLACK);
    } else {
      switch (currentState) {
        case DeviceState::Ready: {
          drawStatusBar(wifiConnected ? "POLACZONY" : "BRAK WI-FI", wifiConnected);
          display.drawBitmap(UI_FOX_X, UI_FOX_READY_Y, FOX_SPRITE_SLEEP, FOX_SPRITE_SLEEP_W, FOX_SPRITE_SLEEP_H, GxEPD_BLACK);
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
          drawStatusBar("WYSYLANIE", wifiConnected);
          display.drawBitmap(UI_FOX_X, UI_FOX_Y, FOX_SPRITE_UPLOAD, FOX_SPRITE_UPLOAD_W, FOX_SPRITE_UPLOAD_H, GxEPD_BLACK);
          display.drawRect(28, UI_PROGRESS_Y, 144, 12, GxEPD_BLACK);
          int16_t innerW = (140 * uploadProgress) / 100;
          if (innerW > 0) {
            display.fillRect(30, UI_PROGRESS_Y + 2, innerW, 8, GxEPD_BLACK);
          }
          break;
        }

        case DeviceState::Saved:
          drawStatusBar("ZAPISANO", wifiConnected);
          display.drawBitmap(UI_FOX_X, UI_FOX_Y, FOX_SPRITE_SAVED, FOX_SPRITE_SAVED_W, FOX_SPRITE_SAVED_H, GxEPD_BLACK);
          drawCenteredText(EPD_WIDTH / 2, UI_TITLE_Y, "ZAPISANO!", 2);
          break;

        case DeviceState::Error:
          drawStatusBar("BLAD", wifiConnected);
          display.drawBitmap(UI_FOX_X, UI_FOX_Y, FOX_SPRITE_ERROR, FOX_SPRITE_ERROR_W, FOX_SPRITE_ERROR_H, GxEPD_BLACK);
          drawCenteredText(EPD_WIDTH / 2, UI_TITLE_Y, "BLAD", 2);
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
}

// Refresh only the timer box during recording to minimize blocking time
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

static void renderUploadProgressPartial() {
  setDisplayPower(true);
  display.setPartialWindow(24, UI_PROGRESS_Y - 2, 152, 16);
  display.firstPage();
  do {
    display.fillRect(24, UI_PROGRESS_Y - 2, 152, 16, GxEPD_WHITE);
    display.drawRect(28, UI_PROGRESS_Y, 144, 12, GxEPD_BLACK);
    int16_t innerW = (140 * uploadProgress) / 100;
    if (innerW > 0) {
      display.fillRect(30, UI_PROGRESS_Y + 2, innerW, 8, GxEPD_BLACK);
    }
  } while (display.nextPage());
}

static void enterState(DeviceState next, bool partial = false) {
  if (next != DeviceState::WifiSetup) {
    stopCaptivePortal();
  }
  isSleeping = false;
  currentState = next;

  Serial.printf("[Foxie] State -> %d\n", static_cast<int>(next));

  switch (next) {
    case DeviceState::Ready:
      currentLedPattern = LedPattern::Off;
      break;
    case DeviceState::Recording:
      recordingStartedMs = millis();
      currentLedPattern = LedPattern::SlowBlink;
      break;
    case DeviceState::Uploading:
      uploadStartedMs = millis();
      uploadProgress = 30;
      currentLedPattern = LedPattern::FastBlink;
      break;
    case DeviceState::Saved:
      savedEnteredMs = millis();
      currentLedPattern = LedPattern::SolidOn;
      break;
    case DeviceState::Error:
      currentLedPattern = LedPattern::WifiPulse;
      break;
    case DeviceState::WifiSetup:
      currentLedPattern = LedPattern::WifiPulse;
      startCaptivePortal();
      break;
  }

  renderCurrentScreen(partial);
  if (next == DeviceState::Recording) {
    // Anchor timer interval AFTER initial render finishes
    lastRecDrawMs = millis();
  }
}

static void enterSleepMode() {
  stopCaptivePortal();
  isSleeping = true;
  currentLedPattern = LedPattern::Off;
  setLedPhysical(false);
  renderCurrentScreen(false);
  display.hibernate();
  setDisplayPower(false);
  Serial.println("[Foxie] Sleeping (dropping PWR_HOLD)");
  delay(50);
  digitalWrite(PIN_PWR_HOLD, LOW);
}

static void onBootShortPress() {
  Serial.println("[Foxie] BOOT short press");
  if (isSleeping) return;

  switch (currentState) {
    case DeviceState::Ready:
    case DeviceState::Saved:
      enterState(DeviceState::Recording);
      break;
    case DeviceState::Recording:
      enterState(DeviceState::Uploading);
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
  Serial.println("[Foxie] BOOT long press -> Wi-Fi QR");
  enterState(DeviceState::WifiSetup);
}

static void onPwrShortPress() {
  Serial.println("[Foxie] PWR short press");
  if (isSleeping) {
    digitalWrite(PIN_PWR_HOLD, HIGH);
    if (WiFi.status() != WL_CONNECTED && !cfg.wifiSsid.isEmpty()) {
      connectToWifi(8000);
    }
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
  Serial.println("[Foxie] PWR long press");
  if (isSleeping) {
    digitalWrite(PIN_PWR_HOLD, HIGH);
    enterState(DeviceState::Ready);
  } else {
    enterSleepMode();
  }
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
  // Latch battery power rail immediately so the board stays awake on LiPo
  pinMode(PIN_PWR_HOLD, OUTPUT);
  digitalWrite(PIN_PWR_HOLD, HIGH);

  // Detach JTAG on GP3 before configuring as status LED (active-LOW)
  gpio_reset_pin(static_cast<gpio_num_t>(PIN_LED_STATUS));
  pinMode(PIN_LED_STATUS, OUTPUT);
  setLedPhysical(false);
  xTaskCreate(ledTask, "led_task", 2048, nullptr, 1, nullptr);

  pinMode(PIN_BTN_BOOT, INPUT_PULLUP);
  pinMode(PIN_BTN_PWR, INPUT_PULLUP);
  attachInterruptArg(digitalPinToInterrupt(PIN_BTN_BOOT), handleButtonIsr, &btnBoot, CHANGE);
  attachInterruptArg(digitalPinToInterrupt(PIN_BTN_PWR), handleButtonIsr, &btnPwr, CHANGE);

  pinMode(PIN_EPD_PWR, OUTPUT);
  setDisplayPower(true);

  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("[Foxie] Booting Waveshare ESP32-S3-Touch-ePaper-1.54 V2");
  if (psramFound()) {
    Serial.printf("[Foxie] PSRAM OK: %lu bytes free\n", static_cast<unsigned long>(ESP.getFreePsram()));
  } else {
    Serial.println("[Foxie] WARNING: PSRAM not detected");
  }

  SPI.begin(PIN_EPD_SCK, -1, PIN_EPD_MOSI, PIN_EPD_CS);
  display.init(115200, true, 2, false);
  display.setRotation(0);
  display.setTextWrap(false);

  loadConfigFromNvs();
  if (connectToWifi(WIFI_CONNECT_TIMEOUT_MS)) {
    enterState(DeviceState::Ready);
  } else {
    enterState(DeviceState::WifiSetup);
  }
}

void loop() {
  processButton(btnBoot, onBootShortPress, onBootLongPress);
  processButton(btnPwr, onPwrShortPress, onPwrLongPress);

  if (portalActive) {
    dnsServer.processNextRequest();
    webServer.handleClient();
    if (portalSavePending) {
      portalSavePending = false;
      delay(300);
      if (connectToWifi(WIFI_CONNECT_TIMEOUT_MS)) {
        enterState(DeviceState::Ready);
      } else {
        enterState(DeviceState::WifiSetup);
      }
      return;
    }
  }

  uint32_t now = millis();

  if (!isSleeping && currentState == DeviceState::Recording) {
    if (now - lastRecDrawMs >= 1000) {
      renderRecordingTimerPartial();
      lastRecDrawMs = millis();
      processButton(btnBoot, onBootShortPress, onBootLongPress);
      processButton(btnPwr, onPwrShortPress, onPwrLongPress);
    }
  } else if (!isSleeping && currentState == DeviceState::Uploading) {
    uint32_t elapsed = now - uploadStartedMs;
    if (elapsed >= 1800) {
      enterState(DeviceState::Saved);
    } else if (elapsed >= 900 && uploadProgress < 80) {
      uploadProgress = 80;
      renderUploadProgressPartial();
    }
  } else if (!isSleeping && currentState == DeviceState::Saved) {
    if (now - savedEnteredMs >= SAVED_AUTO_RETURN_MS) {
      enterState(DeviceState::Ready);
    }
  }

  delay(15);
}
