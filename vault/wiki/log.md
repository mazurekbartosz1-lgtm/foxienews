---
title: Dziennik zmian
slug: log
updated_at: 2026-11-25T19:03:00Z
tags: [log]
---

# Dziennik zmian (LLM Wiki & Rozwój Projektu)

## 2026-11-25
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
