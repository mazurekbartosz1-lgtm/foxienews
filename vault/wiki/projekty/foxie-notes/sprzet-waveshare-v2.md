---
title: Waveshare ESP32-S3-Touch-ePaper-1.54 V2
slug: projekty/foxie-notes/sprzet-waveshare-v2
updated_at: 2026-11-27T12:00:00Z
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
- **MicroSD (1-bit SDMMC):** `CLK=39`, `D0=40`, `CMD=41` (zweryfikowane na `COM5`: `sdMounted=1`; kolejka offline WAV w `/foxie_queue` z pull-up na `CMD`/`D0` i bezpiecznym `SD_MMC.end()` przed `deep_sleep`).
- **Stabilność Wi-Fi przy HTTPS + e-Paper i rozmiar stosu `loopTask`:** na ESP32-S3 przy wysyłce HTTPS `WiFiClientSecure` (handshake mbedTLS ~4–4.5 KB stosu) nie mieści się na domyślnym stosie Arduino `8192 B`, jeśli na stosie leży dodatkowo bufor `b64Out[4096]` (powodowało to `Stack canary watchpoint triggered (loopTask)` i reset płytki podczas wysyłki). W `firmware/platformio.ini` ustawiono `-DARDUINO_LOOP_STACK_SIZE=16384`, a w `capture_client.cpp` przeniesiono `b64Out` i obiekty `WiFiClient`/`WiFiClientSecure` na stertę (`std::unique_ptr`), co daje > `12000 B` zapasu stosu podczas uploadu. Przed transferem TLS wyłączana jest przetwornica HV (`display.powerOff()`), radio ma `WiFi.setSleep(WIFI_PS_NONE)` w trakcie transferu i `WIFI_POWER_15dBm`. Po twardym resecie routery z 802.11w PMF (np. Orange FunBox) potrafią zwrócić `reason=208` (`Association refused too many times`); `connectToWifi()` odczekuje `2.5 s` (comeback window) i ponawia połączenie bez kolizji z auto-reconnect.
- **Profil oszczędzania baterii (zweryfikowano na `COM5`):**
  - Automatyczna hibernacja `deep_sleep` po **3 minutach** bezczynności (`INACTIVITY_SLEEP_MS = 180000`); w `deep_sleep` wszystkie linie active-LOW/zasilania (`PIN_PWR_HOLD=HIGH`, `PIN_EPD_PWR=HIGH`, `PIN_AUDIO_PWR=HIGH`, `PIN_AUDIO_PA_CTRL=LOW`, `PIN_LED_STATUS=HIGH`) są zablokowane przez `gpio_hold_en()` + `gpio_deep_sleep_hold_en()`, a ciche wybudzenia zegara RTC pracują przy **80 MHz** CPU.
  - **Power-gating ES8311 (`audio_recorder.cpp`):** szyna audio `PIN_AUDIO_PWR` oraz magistrala I²C są wyłączone w spoczynku i budzone wyłącznie na czas nagrywania (`wakeCodec()` / `powerDownCodec()`).
  - **On-demand MicroSD (`sd_queue.cpp`):** `SD_MMC` jest montowane tylko podczas zapisu/odczytu kolejki i odmontowywane po operacji (`suspend()`).
  - **Idle CPU + Wi-Fi Modem Sleep + e-Paper HV OFF:** w stanie `Ready` MCU pracuje na **80 MHz** z `WiFi.setSleep(WIFI_PS_MAX_MODEM)` (w trybie offline `WiFi.mode(WIFI_OFF)` z próbą co `60 s`), po każdym odświeżeniu ekranu wyłączana jest pompa HV (`display.powerOff()`), a odczyt napięcia baterii (`readBatteryMilliVolts()`) uśrednia 8 próbek ADC. Przy aktywnym transferze HTTPS/pogody profil przełącza się na `240 MHz` + `WIFI_PS_NONE`.
  - **Szybkie 3-stanowe wybudzanie (`Sleeping -> WakingUp -> Recording/Ready`) i nieblokujące Wi-Fi:** przy wybudzeniu `EXT1` z `deep_sleep` kontroler SSD1681 odtwarza bufor `0x26` przez `nextPageToPrevious()`, pokazuje w ~`439 ms` ekran `WakingUp` z loaderem (bez pełnych mrugnięć i bez wyłączania HV przed kolejnym krokiem), a przy wybudzeniu przyciskiem `BOOT` wchodzi wprost w `Recording` z wyłączonym Wi-Fi. Przy starcie do `Ready` połączenie Wi-Fi działa asynchronicznie w tle (`startWifiConnectAsync` / `pollWifiConnectAsync`).

## Bilans baterii (szacowana liczba notatek na 1 ładowaniu)

Szacunki oparte na zaimplementowanym profilu mocy (`80 MHz` idle, `240 MHz` tylko przy transferze Wi-Fi/TLS, power-gating ES8311 + on-demand SDMMC + `display.powerOff()`):

- **Koszt pojedynczych operacji (orientacyjny):**
  - Nagranie głosowe `30 s` (`80–240 MHz` + ES8311 + zapis do PSRAM/SD): ok. **0.75 mAh** (dla pełnych `120 s`: ok. **3.0 mAh**).
  - Wysyłka HTTPS przez Wi-Fi (`~10 s` przy `240 MHz` + TLS handshake + `WIFI_PS_NONE`): ok. **0.50 mAh**.
  - Odświeżenie ekranu e-Paper (`Ready`/`Recording`/`Saved`): ok. **0.04 mAh** na cykl.
  - Okno bezczynności `3 min` w trybie `Ready` przed przejściem w `deep_sleep` (`~40 mA` z modem sleep): ok. **2.0 mAh**.
  - Głęboki sen (`deep_sleep`): ok. **0.35–1.0 mA** (zależnie od stanu RTC/peryferiów płytki).
- **Szacowana pojemność w praktyce (notatki ~30 s):**
  - **Akumulator OEM 400 mAh:** ok. **180–250 notatek** przy nagrywaniu seryjnym offline na spacerze (jedno wybudzenie -> wiele nagrań -> późniejsza zbiorcza synchronizacja Wi-Fi) lub **~60–90 niezależnych sesji** (*wybudzenie z kieszeni -> nagranie -> 3 min Ready -> deep_sleep*).
  - **Ogniwo LiPo 1000 mAh (np. 803040 z MX1.25):** ok. **500–600 notatek** w trybie seryjnym offline lub **~180–240 niezależnych sesji** wybudzenia i powrotu do snu.
- **Kluczowa obserwacja UX vs bateria:** Najwięcej energii z pojedynczej szybkiej notatki zjada 3-minutowe okno `Ready` po nagraniu (~2.0 mAh), a nie samo nagrywanie czy e-ink. Skrócenie czasu powrotu do uśpienia po udanym zapisie (`Saved -> deep_sleep` lub krótsze okno po wysłaniu) pozwala niemal podwoić liczbę sesji bez pogarszania responsywności wybudzania.
