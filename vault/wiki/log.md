---
title: Dziennik zmian
slug: log
updated_at: 2026-11-25T19:30:00Z
tags: [log]
---

# Dziennik zmian (LLM Wiki & Rozwój Projektu)

## 2026-11-25
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
