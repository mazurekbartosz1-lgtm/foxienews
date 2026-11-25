#include <Arduino.h>
#include <SPI.h>
#include <WiFi.h>
#include <GxEPD2_BW.h>
#include <qrcode.h>
#include "driver/gpio.h"
#include "esp_timer.h"
#include "board_pins.h"
#include "ui_assets.h"

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

constexpr uint32_t DEBOUNCE_MS = 35;
constexpr uint32_t LONG_PRESS_MS = 2500;
constexpr uint32_t SAVED_AUTO_RETURN_MS = 3500;
constexpr const char* SETUP_AP_SSID = "Foxie-Setup";

static DeviceState currentState = DeviceState::Ready;
static volatile LedPattern currentLedPattern = LedPattern::Off;
static bool isSleeping = false;
static bool wifiApActive = false;

static uint32_t recordingStartedMs = 0;
static uint32_t lastRecDrawMs = 0;
static uint32_t uploadStartedMs = 0;
static uint32_t savedEnteredMs = 0;
static uint8_t uploadProgress = 0;
static uint8_t batteryPercent = 100;

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

static void drawFooter(const char* leftHint, const char* rightHint) {
  display.drawFastHLine(0, UI_FOOTER_Y, EPD_WIDTH, GxEPD_BLACK);
  display.setTextSize(1);
  display.setTextColor(GxEPD_BLACK);
  display.setCursor(8, UI_FOOTER_Y + 9);
  display.print(leftHint);
  if (rightHint && rightHint[0] != '\0') {
    display.setCursor(110, UI_FOOTER_Y + 9);
    display.print(rightHint);
  }
}

static void drawWifiQrCode() {
  QRCode qrcode;
  uint8_t qrcodeData[qrcode_getBufferSize(3)];
  char payload[64];
  snprintf(payload, sizeof(payload), "WIFI:T:nopass;S:%s;;", SETUP_AP_SSID);
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
      display.drawBitmap(UI_FOX_X, UI_FOX_Y, FOX_SPRITE_SLEEP, FOX_SPRITE_SLEEP_W, FOX_SPRITE_SLEEP_H, GxEPD_BLACK);
      drawCenteredText(EPD_WIDTH / 2, UI_TITLE_Y, "FOXIE SPI", 2);
      drawCenteredText(EPD_WIDTH / 2, UI_SUBTITLE_Y + 4, "Nacisnij PWR aby wybudzic", 1);
      drawFooter("PWR:Wybudz", "PWR(3s):Uspij");
    } else {
      switch (currentState) {
        case DeviceState::Ready:
          drawStatusBar("GOTOWY", wifiConnected);
          display.drawBitmap(UI_FOX_X, UI_FOX_Y, FOX_SPRITE_SLEEP, FOX_SPRITE_SLEEP_W, FOX_SPRITE_SLEEP_H, GxEPD_BLACK);
          drawCenteredText(EPD_WIDTH / 2, UI_TITLE_Y, "GOTOWY", 2);
          drawCenteredText(
            EPD_WIDTH / 2,
            UI_SUBTITLE_Y + 4,
            wifiConnected ? "Polaczono z Wi-Fi" : "Tryb offline (demo UI)",
            1
          );
          drawFooter("BOOT:Nagraj", "BOOT(3s):Wi-Fi");
          break;

        case DeviceState::Recording: {
          uint32_t elapsedSec = (millis() - recordingStartedMs) / 1000;
          char timeBuf[16];
          snprintf(timeBuf, sizeof(timeBuf), "%02lu:%02lu", elapsedSec / 60, elapsedSec % 60);

          drawStatusBar("NAGRYWANIE", wifiConnected);
          display.drawBitmap(UI_FOX_X, UI_FOX_Y, FOX_SPRITE_LISTEN, FOX_SPRITE_LISTEN_W, FOX_SPRITE_LISTEN_H, GxEPD_BLACK);
          display.drawBitmap(14, 56, ICON_MIC, ICON_MIC_W, ICON_MIC_H, GxEPD_BLACK);
          drawCenteredText(EPD_WIDTH / 2, UI_TITLE_Y, timeBuf, 2);
          drawCenteredText(EPD_WIDTH / 2, UI_SUBTITLE_Y, "Slucham notatki...", 1);

          // Decorative audio bar indicator (ES8311 capture comes in Etap 1C)
          for (int i = 0; i < 12; i++) {
            int16_t barH = 4 + (i % 3) * 3;
            bool filled = ((i + static_cast<int>(elapsedSec)) % 4) != 0;
            int16_t bx = 34 + i * 11;
            int16_t by = UI_PROGRESS_Y + (10 - barH);
            if (filled) {
              display.fillRect(bx, by, 7, barH, GxEPD_BLACK);
            } else {
              display.drawRect(bx, by, 7, barH, GxEPD_BLACK);
            }
          }
          drawFooter("BOOT:Wyslij", "PWR:Anuluj");
          break;
        }

        case DeviceState::Uploading: {
          drawStatusBar("WYSYLANIE", wifiConnected);
          display.drawBitmap(UI_FOX_X, UI_FOX_Y, FOX_SPRITE_UPLOAD, FOX_SPRITE_UPLOAD_W, FOX_SPRITE_UPLOAD_H, GxEPD_BLACK);
          drawCenteredText(EPD_WIDTH / 2, UI_TITLE_Y, "WYSYLAM...", 2);
          drawCenteredText(EPD_WIDTH / 2, UI_SUBTITLE_Y, "Demo: Gemini + GitHub", 1);
          display.drawRect(28, UI_PROGRESS_Y, 144, 12, GxEPD_BLACK);
          int16_t innerW = (140 * uploadProgress) / 100;
          if (innerW > 0) {
            display.fillRect(30, UI_PROGRESS_Y + 2, innerW, 8, GxEPD_BLACK);
          }
          drawFooter("Prosze czekac", "");
          break;
        }

        case DeviceState::Saved:
          drawStatusBar("ZAPISANO", wifiConnected);
          display.drawBitmap(UI_FOX_X, UI_FOX_Y, FOX_SPRITE_SAVED, FOX_SPRITE_SAVED_W, FOX_SPRITE_SAVED_H, GxEPD_BLACK);
          display.drawBitmap(14, 56, ICON_CHECK, ICON_CHECK_W, ICON_CHECK_H, GxEPD_BLACK);
          drawCenteredText(EPD_WIDTH / 2, UI_TITLE_Y, "ZAPISANO!", 2);
          drawCenteredText(EPD_WIDTH / 2, UI_SUBTITLE_Y, "Demo UI gotowe", 1);
          drawCenteredText(EPD_WIDTH / 2, UI_PROGRESS_Y, "raw/inbox/ -> Demo OK", 1);
          drawFooter("BOOT:Nowa", "PWR:Gotowy");
          break;

        case DeviceState::Error:
          drawStatusBar("BLAD", wifiConnected);
          display.drawBitmap(UI_FOX_X, UI_FOX_Y, FOX_SPRITE_ERROR, FOX_SPRITE_ERROR_W, FOX_SPRITE_ERROR_H, GxEPD_BLACK);
          display.drawBitmap(14, 56, ICON_ALERT, ICON_ALERT_W, ICON_ALERT_H, GxEPD_BLACK);
          drawCenteredText(EPD_WIDTH / 2, UI_TITLE_Y, "BLAD", 2);
          drawCenteredText(EPD_WIDTH / 2, UI_SUBTITLE_Y, "Sprobuj ponownie", 1);
          drawFooter("BOOT:Ponow", "PWR:Wroc");
          break;

        case DeviceState::WifiSetup: {
          drawStatusBar("WI-FI AP", false);
          display.drawBitmap(UI_PEEK_X, UI_PEEK_Y, FOX_SPRITE_PEEK, FOX_SPRITE_PEEK_W, FOX_SPRITE_PEEK_H, GxEPD_BLACK);
          drawWifiQrCode();
          char apLabel[32];
          snprintf(apLabel, sizeof(apLabel), "AP: %s", SETUP_AP_SSID);
          drawCenteredText(EPD_WIDTH / 2, 136, apLabel, 1);
          drawCenteredText(EPD_WIDTH / 2, 150, "Zeskanuj QR telefonem", 1);
          drawFooter("SoftAP otwarty", "PWR:Wroc");
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

static void stopWifiApIfRunning() {
  if (wifiApActive) {
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_OFF);
    wifiApActive = false;
  }
}

static void enterState(DeviceState next, bool partial = false) {
  if (next != DeviceState::WifiSetup) {
    stopWifiApIfRunning();
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
    case DeviceState::WifiSetup:
      currentLedPattern = LedPattern::WifiPulse;
      if (next == DeviceState::WifiSetup) {
        WiFi.mode(WIFI_AP);
        wifiApActive = WiFi.softAP(SETUP_AP_SSID);
        Serial.printf("[Foxie] SoftAP '%s' started -> %s\n",
                      SETUP_AP_SSID,
                      WiFi.softAPIP().toString().c_str());
      }
      break;
  }

  renderCurrentScreen(partial);
  if (next == DeviceState::Recording) {
    // Anchor timer interval AFTER initial render finishes
    lastRecDrawMs = millis();
  }
}

static void enterSleepMode() {
  stopWifiApIfRunning();
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
    enterState(DeviceState::Ready);
    return;
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
    // Safety fallback if a release edge bounced inside debounce window
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

  enterState(DeviceState::Ready);
}

void loop() {
  processButton(btnBoot, onBootShortPress, onBootLongPress);
  processButton(btnPwr, onPwrShortPress, onPwrLongPress);

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
