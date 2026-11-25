---
title: Dziennik zmian
slug: log
updated_at: 2026-11-25T18:44:00Z
tags: [log]
---

# Dziennik zmian (LLM Wiki & Rozwój Projektu)

## 2026-11-25
- **Poprawki przycisków i diody `GP3` na Waveshare V2 (COM5):** Dodano przerwania sprzętowe (`IRAM_ATTR`) dla `BOOT`/`PWR`, szybkie częściowe odświeżanie licznika nagrywania i paska postępu oraz niezależny task FreeRTOS sterujący diodą `GP3` jako **active-LOW** (wolne mruganie podczas nagrywania, szybkie przy wysyłaniu, ciągłe po zapisie); zsynchronizowano także `device-sim.ts` i `sprzet-waveshare-v2.md`.
- **Pierwszy flash na płytkę Waveshare V2 (COM5):** Zainstalowano PlatformIO Core 6.2.0, skompilowano i wgrano firmware e-Paper UI ([`main.cpp`](../../../firmware/src/main.cpp)) z 6 ekranami liska z `ui_assets.h`, obsługą przycisków `BOOT`/`PWR`, `PWR_HOLD`, `LED GP3` oraz ekranem kodu QR otwierającym SoftAP `Foxie-Setup`.
- **Etap 1A zakończony:** Zaimplementowano przeglądarkowy symulator e-ink 200×200 (`simulator/`), font bitmapowy 5×7 z polskimi znakami, 1-bitowe sprite'y maskotki liska (6 stanów + 5 ikon statusu), automat stanów `BOOT`/`PWR`/`GP3`/`PWR_HOLD`, skanowalny kod QR Wi-Fi oraz generator C++ `PROGMEM`, który wyeksportował `firmware/include/ui_assets.h` (11 assetów, 3468 B).
- Utworzono czystą strukturę monorepo (`simulator/`, `firmware/`, `functions/`, `web/`, `firebase.json`, `firestore.rules`, `README.md`, `docs/SCHEMA.example.md`).
- Zweryfikowano rewizję sprzętową **Waveshare ESP32-S3-Touch-ePaper-1.54 V2** (`ESP32-S3-PICO-1-N8R8` z `qio_opi`, I²C na `GPIO 47/48`, natywne USB na `GP19/GP20`, `PWR_HOLD` na `GPIO 17`, `BOOT` na `GPIO 0`, `PWR` na `GPIO 18`, `LED` na `GPIO 3`).
- Zatwierdzono podział prac na Etap 1 i Etap 2 oraz mapę przycisków urządzenia.
- Zainicjalizowano lokalną bazę wiedzy Obsidian w katalogu `vault/` wraz z dedykowanym folderem projektu [[projekty/foxie-notes/index|Foxie Notes]] i listami zadań w `vault/wiki/projekty/foxie-notes/zadania/`.
