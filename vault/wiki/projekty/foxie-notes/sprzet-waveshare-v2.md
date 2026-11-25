---
title: Waveshare ESP32-S3-Touch-ePaper-1.54 V2
slug: projekty/foxie-notes/sprzet-waveshare-v2
updated_at: 2026-11-25T07:45:00Z
tags: [sprzet, waveshare, esp32-s3, pinout]
---

# Waveshare ESP32-S3-Touch-ePaper-1.54 (Rewizja V2)

Notatka referencyjna sprzętu dla [[projekty/foxie-notes/index|Foxie Notes]] (zgodna z `firmware/platformio.ini` oraz `firmware/include/board_pins.h`).

## Układ i pamięć
- **MCU:** `ESP32-S3-PICO-1-N8R8`
- **Flash:** 8 MB QSPI (`qio`)
- **PSRAM:** 8 MB OPI (`opi`, konfiguracja PlatformIO `board_build.arduino.memory_type = qio_opi`)
- **Ekran:** 1.54" e-Paper 200×200 px, 1-bit monochromatyczny + dotyk pojemnościowy (FT6336)

## Mapa pinów GPIO
- **e-Paper (SPI):** `PWR=6` (active-LOW: `LOW` = zasilanie ON, `HIGH` = OFF), `BUSY=8`, `RST=9`, `DC=10`, `CS=11`, `SCK=12`, `MOSI=13`
- **Wspólna magistrala I²C (ES8311, PCF85063 RTC, SHTC3, FT6336):** `SDA=47`, `SCL=48`
  - **Uwaga z naklejki V2:** Na tylnym złączu `2×6` etykiety `SDA`/`SCL` są w lewej kolumnie, a `GP20`/`GP19` w prawej — `GP19`/`GP20` to natywne linie **USB D-/D+** i nie wolno używać ich jako I²C.
- **Kodek Audio ES8311 (I²S):** `MCLK=14`, `BCLK=15`, `DIN=16` (MIC), `WS=38` (LRCK), `DOUT=45` (SPK), `AUDIO_PWR=42`
- **Przyciski, zasilanie i LED:** `BOOT=0` (active LOW), `PWR=18`, `PWR_HOLD=17` (ustawić `HIGH` na starcie `setup()` dla pracy na LiPo), `LED=3` (active-LOW: `LOW` = świeci, `HIGH` = zgaszona; wymaga `gpio_reset_pin()`), `BAT_ADC=4`, `RTC_INT=5`
- **MicroSD (1-bit SDMMC):** `CLK=39`, `D0=40`, `CMD=41`
