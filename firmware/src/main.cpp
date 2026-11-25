#include <Arduino.h>
#include "board_pins.h"
#include "ui_assets.h"

enum class DeviceState {
  Ready,
  Recording,
  Uploading,
  Saved,
  Error,
  WifiSetup,
};

static DeviceState currentState = DeviceState::Ready;

void setup() {
  // Latch battery power rail immediately so the board stays awake on LiPo
  pinMode(PIN_PWR_HOLD, OUTPUT);
  digitalWrite(PIN_PWR_HOLD, HIGH);

  pinMode(PIN_LED_STATUS, OUTPUT);
  digitalWrite(PIN_LED_STATUS, LOW);

  pinMode(PIN_BTN_BOOT, INPUT_PULLUP);
  pinMode(PIN_BTN_PWR, INPUT_PULLUP);

  Serial.begin(115200);
  delay(200);

  Serial.println();
  Serial.println("[Foxie] Booting Waveshare ESP32-S3-Touch-ePaper-1.54 V2");
  if (psramFound()) {
    Serial.printf("[Foxie] PSRAM OK: %u bytes free\n", ESP.getFreePsram());
  } else {
    Serial.println("[Foxie] WARNING: PSRAM not detected (check qio_opi build config)");
  }

  // Etap 1C: initialize e-Paper, WiFiManager QR portal, ES8311 codec, and state machine
  (void)currentState;
}

void loop() {
  delay(100);
}
