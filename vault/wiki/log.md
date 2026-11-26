---
title: Dziennik zmian
slug: log
updated_at: 2026-11-26T05:50:00Z
tags: [log]
---

# Dziennik zmian (LLM Wiki & Rozwój Projektu)

## 2026-11-26
- **Naprawa „śnieżenia” e-Paper po wybudzeniu zegara w hibernacji:** Odcięcie zasilania panelu (`PIN_EPD_PWR=HIGH`) kasowało pamięć RAM kontrolera SSD1681 (`0x24` i `0x26`), przez co cichy partial refresh zegara porównywał wyczyszczone okno zegara z losowymi bajtami na reszcie ekranu. W [`main.cpp`](../../../firmware/src/main.cpp) dodano deterministyczny `drawHibernationFrame()`, odtwarzanie poprzedniej klatki w `0x26` przez `display.nextPageToPrevious()` przed `display.display(true)`, okresowe pełne czyszczenie co 30 minut (`EPD_FULL_REFRESH_EVERY`, w hibernacji i w `Ready`) oraz `display.end()` przed odłączeniem zasilania panelu.

## 2026-11-25
- **Etap 1C zakończony — kodek ES8311, nagrywanie WAV w PSRAM i wysyłka `POST /api/capture`:**
  - Dodano moduł [`audio_recorder.h`](../../../firmware/include/audio_recorder.h) / [`audio_recorder.cpp`](../../../firmware/src/audio_recorder.cpp): zasilanie `AUDIO_PWR=42` (active-LOW przed `Wire.begin()`), inicjalizacja kodeka ES8311 (`0x18`, `ID=0x8311 rev=0x01`) dla analogowego mikrofonu `MIC1P-MIC1N`, I²S Master RX (`driver/i2s_std.h`, 16 kHz / 16-bit / mono) oraz nagrywanie przez dedykowany task FreeRTOS do bufora WAV (do 60 s = `1920044 B`) w 8 MB OPI PSRAM. Zweryfikowano na płytce (`COM5`) nagraniem testowym 2 s (`65580 B` WAV, `peak=3127`, `rms=247`).
  - Dodano strumieniowego klienta [`capture_client.h`](../../../firmware/include/capture_client.h) / [`capture_client.cpp`](../../../firmware/src/capture_client.cpp) (`mbedtls_base64_encode`, `POST /api/capture` z `X-API-Key`) oraz podpięto prawdziwe przejścia `Recording` -> `Uploading` -> `Saved` / `Error` w [`main.cpp`](../../../firmware/src/main.cpp).
- **Skill `obsidian-commit-sync`, reguła `AGENTS.md` i `status.md`:** Dodano workspace skill `.agents/skills/obsidian-commit-sync/SKILL.md`, regułę repozytorium `AGENTS.md` oraz stronę handoffową `[[projekty/foxie-notes/status|status]]`, aby każdy `git commit` aktualizował kontekst Obsidian i umożliwiał płynne wznowienie pracy z nowego okna kontekstowego.
- **Dedykowany lisek hibernacji + pogoda dla Trąbek Wielkich:** Rozdzielono stany `FOX_SPRITE_READY` (czujny lisek) i `FOX_SPRITE_HIBERNATE` (lisek śpiący na biurku pod księżycem, zegar 24h widoczny i odświeżany bez Wi-Fi co minutę z RTC, pogoda ukryta). Domyślną lokalizację Open-Meteo ustawiono na Trąbki Wielkie (`54.1697, 18.5397`) z możliwością zmiany miasta w Captive Portalu.
- **Zegar 24h, pogoda Foxie (co 30 min) i hibernacja deep sleep (2h) + Etap 1B:**
  - Zaimplementowano i przetestowano w `functions/` endpoint `POST /api/capture` (walidacja, `@google/genai`, `@octokit/rest`, 4/4 testy `node --test`).
  - Dodano pod kreską biurka zegar 24h (NTP `CET/CEST`) po lewej i 7 ikon pogody Foxie (`20×20` px) + temperaturę z Open-Meteo po prawej (odświeżane co 30 min na Wi-Fi).
  - Dodano prawdziwą hibernację **deep sleep** ESP32-S3 po 2 godzinach bezczynności (Wi-Fi OFF, wybudzanie przez `BOOT`, `PWR` lub dotyk ekranu `GPIO 21`).
- **Minimalistyczny układ ekranu (duży lisek 192×136):** Powiększono sprite'y liska przy biurku do `192×136` px (16634 B `PROGMEM`), usunięto dolny pasek opisów przycisków oraz napisy `GOTOWY` / `Wi-Fi OK` / IP, zastępując status w górnym pasku etykietą `POŁĄCZONY` / `BRAK WI-FI`.
- **Wi-Fi STA + NVS + Captive Portal (`192.168.4.1`):** Dodano obsługę zapisu konfiguracji Wi-Fi / API URL / `X-API-Key` w NVS (`Preferences`), automatyczne łączenie z Wi-Fi przy starcie z lokalnym fallbackiem w ignorowanym przez git `firmware/include/config.h` oraz pełny Captive Portal HTTP + DNS pod ekranem QR `Foxie-Setup`.
- **Nowy lisek przy biurku (`yourmoments` -> 1-bit):** Zaadaptowano geometrycznego liska przy biurku z maszyną do pisania z `mazurekbartosz1-lgtm/yourmoments` (`CompanionDesk.tsx`) do 1-bitowego rasteryzera `vector-1bit.ts` dla wszystkich 6 stanów urządzenia + wyglądającego liska nad QR Wi-Fi, wyeksportowano `ui_assets.h` i wgrano na Waveshare V2 (`COM5`).
- **Poprawki przycisków i diody `GP3` na Waveshare V2 (COM5):** Dodano przerwania sprzętowe (`IRAM_ATTR`) dla `BOOT`/`PWR`, szybkie częściowe odświeżanie licznika nagrywania i paska postępu oraz niezależny task FreeRTOS sterujący diodą `GP3` jako **active-LOW** (wolne mruganie podczas nagrywania, szybkie przy wysyłaniu, ciągłe po zapisie); zsynchronizowano także `device-sim.ts` i `sprzet-waveshare-v2.md`.
- **Pierwszy flash na płytkę Waveshare V2 (COM5):** Zainstalowano PlatformIO Core 6.2.0, skompilowano i wgrano firmware e-Paper UI ([`main.cpp`](../../../firmware/src/main.cpp)) z 6 ekranami liska z `ui_assets.h`, obsługą przycisków `BOOT`/`PWR`, `PWR_HOLD`, `LED GP3` oraz ekranem kodu QR otwierającym SoftAP `Foxie-Setup`.
- **Etap 1A zakończony:** Zaimplementowano przeglądarkowy symulator e-ink 200×200 (`simulator/`), font bitmapowy 5×7 z polskimi znakami, 1-bitowe sprite'y maskotki liska (6 stanów + 5 ikon statusu), automat stanów `BOOT`/`PWR`/`GP3`/`PWR_HOLD`, skanowalny kod QR Wi-Fi oraz generator C++ `PROGMEM`, który wyeksportował `firmware/include/ui_assets.h` (11 assetów, 3468 B).
- Utworzono czystą strukturę monorepo (`simulator/`, `firmware/`, `functions/`, `web/`, `firebase.json`, `firestore.rules`, `README.md`, `docs/SCHEMA.example.md`).
- Zweryfikowano rewizję sprzętową **Waveshare ESP32-S3-Touch-ePaper-1.54 V2** (`ESP32-S3-PICO-1-N8R8` z `qio_opi`, I²C na `GPIO 47/48`, natywne USB na `GP19/GP20`, `PWR_HOLD` na `GPIO 17`, `BOOT` na `GPIO 0`, `PWR` na `GPIO 18`, `LED` na `GPIO 3`).
- Zatwierdzono podział prac na Etap 1 i Etap 2 oraz mapę przycisków urządzenia.
- Zainicjalizowano lokalną bazę wiedzy Obsidian w katalogu `vault/` wraz z dedykowanym folderem projektu [[projekty/foxie-notes/index|Foxie Notes]] i listami zadań w `vault/wiki/projekty/foxie-notes/zadania/`.
