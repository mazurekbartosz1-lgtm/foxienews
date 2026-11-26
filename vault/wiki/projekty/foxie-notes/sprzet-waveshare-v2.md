---
title: Waveshare ESP32-S3-Touch-ePaper-1.54 V2
slug: projekty/foxie-notes/sprzet-waveshare-v2
updated_at: 2026-11-26T05:50:00Z
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
  - **Pułapka SSD1681 RAM loss:** Odcięcie zasilania panelu (`PIN_EPD_PWR=HIGH`) kasuje wewnętrzną pamięć RAM kontrolera SSD1681 (`0x24` i `0x26`). Przed częściowym odświeżeniem po utracie zasilania trzeba odtworzyć bufor `0x26` identyczną poprzednią klatką (`display.nextPageToPrevious()`), zapisać pełną nową klatkę do `0x24` i wykonać `display.display(true)`, a okresowo (co 30 min) robić pełne odświeżenie `display.display(false)` oraz wywoływać `display.end()` przed wyłączeniem `PIN_EPD_PWR`.
- **Wspólna magistrala I²C (ES8311, PCF85063 RTC, SHTC3, FT6336):** `SDA=47`, `SCL=48`
  - **Dotyk pojemnościowy (FT6336):** `TP_RST=7`, `TP_INT=21` (`RTC_GPIO21`, active-LOW — obsługuje wybudzanie z deep sleep)
  - **Uwaga z naklejki V2:** Na tylnym złączu `2×6` etykiety `SDA`/`SCL` są w lewej kolumnie, a `GP20`/`GP19` w prawej — `GP19`/`GP20` to natywne linie **USB D-/D+** i nie wolno używać ich jako I²C.
- **Kodek Audio ES8311 (I²C + I²S):** adres I²C **`0x18`** (ID `0x8311`, `rev=0x01` na wspólnej magistrali `SDA=47`, `SCL=48`), I²S `MCLK=14`, `BCLK=15`, `DIN=16` (MIC), `WS=38` (LRCK), `DOUT=45` (SPK), `AUDIO_PWR=42` (**active-LOW**: `LOW` = zasilanie ON, musi być ustawione przed `Wire.begin()`, inaczej niezasilany kodek może zablokować magistralę I²C), `PA_CTRL=46` (wzmacniacz głośnika NS4150B, `LOW` podczas nagrywania/spoczynku). Wbudowany mikrofon jest **analogowy** (`MIC1P-MIC1N`, rejestr `0x14=0x1A`, nie DMIC).
- **Przyciski, zasilanie i LED:** `BOOT=0` (active LOW), `PWR=18`, `PWR_HOLD=17` (ustawić `HIGH` na starcie `setup()` dla pracy na LiPo), `LED=3` (active-LOW: `LOW` = świeci, `HIGH` = zgaszona; wymaga `gpio_reset_pin()`), `BAT_ADC=4`, `RTC_INT=5`
- **MicroSD (1-bit SDMMC):** `CLK=39`, `D0=40`, `CMD=41`
