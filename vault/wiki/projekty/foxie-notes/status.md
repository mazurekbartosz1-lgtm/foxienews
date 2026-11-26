---
title: Status projektu i handoff (Foxie Notes)
slug: projekty/foxie-notes/status
updated_at: 2026-11-26T13:00:00Z
tags: [status, handoff, foxie-notes, workflow]
---

# Aktualny stan i handoff — Foxie Notes

Ten dokument jest głównym punktem wejścia po otwarciu nowego okna kontekstowego lub zmianie urządzenia/lokalizacji.

## Co aktualnie działa (zweryfikowane)

1. **Symulator 200×200 px (`simulator/`)**
   - Vite + TypeScript z podglądem 1-bit e-Paper (`200×200`) w przeglądarce (`npm run dev:sim`, port `5174`) oraz buildem (`npm --prefix simulator run build`).
   - Style ekranów z liskiem geometrycznym w stylu *yourmoments*: `Ready` (`FOX_SPRITE_READY`), `Recording` (`LED` mruga wolno), `Sending` (`LED` mruga szybko), `Saved`, `Error`, `Hibernate` (`FOX_SPRITE_HIBERNATE` — lisek śpiący na biurku pod księżycem).
   - Dolny pasek ekranu: po lewej zegar `24h`, po prawej pogoda z pikselowymi ikonami `20×20` w stylu liska; w trybie `Hibernate` zegar `24h` pozostaje widoczny (odświeżany bez Wi-Fi z RTC), a pogoda jest ukryta.
   - Eksporter assetów C++ (`npm --prefix simulator run export:cpp`) generuje `firmware/include/ui_assets.h` (19 sprite'ów / ikon, `20318 bytes PROGMEM`).

2. **Firmware ESP32-S3 (`firmware/`) — Waveshare ESP32-S3-Touch-ePaper-1.54 V2 (`COM5`)**
   - Płytka jest sflashowana najnowszym firmware (PlatformIO `esp32s3_v2`, zweryfikowano na `COM5`).
   - Wi-Fi provisioning przez Captive Portal + NVS (`Preferences`) oraz opcjonalny lokalny fallback w gitignorowanym `firmware/include/config.h` (lokalna nazwa miasta pogodowego konfigurowalna w portalu). Gdy SSID jest zapisane, a Wi-Fi chwilowo niedostępne, urządzenie wchodzi w tryb offline `Ready` (gotowe do nagrywania na MicroSD), zamiast wymuszać ekran QR.
   - Zegar 24h przez NTP (`CET-1CEST,M3.5.0,M10.5.0/3`) oraz pogoda Open-Meteo (domyślnie **Trąbki Wielkie**, odświeżana co 30 min na Wi-Fi).
   - **Audio ES8311 + WAV w PSRAM (`audio_recorder.h/.cpp`):** I²C (`0x18`, wykryto `ID=0x8311 rev=0x01`) + I²S Master RX (`driver/i2s_std.h`, 16 kHz / 16-bit / mono) z buforem do 60 s (`1920044 B`) w PSRAM i dedykowanym taskiem FreeRTOS; zweryfikowane na `COM5` nagraniem testowym 2 s (`wav=65580 B`, `pcm=65536 B`, `dur=2048 ms`, `peak=4180`, `rms=401`).
   - **Kolejka offline MicroSD (`sd_queue.h/.cpp`):** 1-bit SDMMC (`CLK=39`, `D0=40`, `CMD=41`), zweryfikowane na `COM5` (`sdMounted=1`). W trybie offline lub przy błędzie sieci nagrania są atomowo zapisywane w `/foxie_queue/*.wav` (ekran `ZAPISANO SD`, wskaźnik `SD:N` na górnym pasku) i automatycznie wysyłane w tle po odzyskaniu Wi-Fi.
   - **Wysyłka `POST /api/capture` (`capture_client.h/.cpp`):** strumieniowe kodowanie Base64 (`mbedtls_base64_encode`, chunki `3072 B`) bez duplikacji bufora w DRAM, nagłówek `X-API-Key`, obsługa HTTP/HTTPS oraz przejść `Recording` -> `Uploading` -> `Saved` / `Error`.
   - Głęboki sen (`Hibernate`) po ≥ 2 godzinach bezczynności: bezpiecznie usypia ES8311 (`PIN_AUDIO_PWR=HIGH`) i kartę SD (`SD_MMC.end()`), wyłącza Wi-Fi i przechodzi w `deep_sleep` z wybudzeniem przez `ext1` (przycisk lub dotyk `PIN_TP_INT = GPIO21`) oraz cichym timerem RTC co minutę do aktualizacji samego zegara. Po utracie zasilania SSD1681 w hibernacji bufor `0x26` jest odtwarzany przez `nextPageToPrevious()` przed partial refreshem, a co 30 minut wykonywane jest pełne czyszczące odświeżenie (`EPD_FULL_REFRESH_EVERY`).

3. **Backend Firebase (`functions/`, Etap 1B + Etap 2A) — WDROŻONY W CHMURZE (`gen-lang-client-0751515487`)**
   - Funkcja Cloud Functions v2 `api` (`europe-west1`, Node.js 22) wdrożona na `https://europe-west1-gen-lang-client-0751515487.cloudfunctions.net/api` i zweryfikowana na żywo (`GET /api/api/health` -> `200 {"ok":true,"service":"foxie-api"}`).
   - Wszystkie 5 sekretów (`GEMINI_API_KEY`, `GITHUB_TOKEN`, `DEVICE_API_KEY`, `GITHUB_WEBHOOK_SECRET`, `ALLOWED_USER_EMAIL`) zapisane w Firebase Secret Manager oraz lokalnie w gitignorowanym `functions/.secret.local`; `GITHUB_OWNER=mazurekbartosz1-lgtm`, `GITHUB_REPO=foxienews`, `GITHUB_VAULT_PREFIX=vault`, `GEMINI_MODEL=gemini-3.8-flash` w `functions/.env`; `ALLOWED_USER_EMAIL` ustawione w `firestore.rules`.
   - `firmware/include/config.h` (chronione przez `.gitignore`) zaktualizowane o docelowy URL chmurowy i `DEVICE_API_KEY`.
   - ESM TypeScript (`NodeNext`, `@google/genai@^3.6.1`, `@octokit/rest@^22.0.1`), `POST /api/capture` (nagranie audio / tekst -> Gemini 3.8 Flash z obsługą `@due(YYYY-MM-DD)` -> commit Markdown do repozytorium GitHub z obsługą `GITHUB_VAULT_PREFIX` oraz `GITHUB_INBOX_DIR`, domyślnie `raw/inbox`).
   - Lokalny serwer LAN do testów E2E z urządzenia: `npm --prefix functions run dev` (`devServer.ts` ładujący `.env` + `.secret.local`, nasłuch na `0.0.0.0:8787`).
   - **Etap 2A (Webhook GitHub -> Firestore + API Wiki):** `POST /api/webhook/github` z weryfikacją `X-Hub-Signature-256` (`rawBody`), konwerterem `markdownToPlainText`, parserem zadań (`- [ ]` / `- [x]`, `@due(...)`, `#tag`, priorytet) i synchronizacją `wiki_pages` (ID `slug.replace(/\//g, "__")`), `wiki_meta/index` oraz `tasks` (`firestoreStore.ts` + `wikiSync.ts`). Endpointy `GET /api/wiki/index` (`?q=`) oraz `GET /api/wiki/page/*` (`?format=plain` dla e-ink) chronione przez `requireAuth`.
   - Testy jednostkowe i integracyjne (`npm --prefix functions test`) przechodzą w `9/9` przypadkach (`tsc` + `node --test`).

## Kluczowe decyzje i pułapki

- **Sprzęt Waveshare V2 (`N8R8`):** Pamiętaj o pinach specyficznych dla V2 — I²C `SDA=47`, `SCL=48`, dotyk `PIN_TP_RST=7`, `PIN_TP_INT=21`, zatrzask zasilania `PWR_HOLD` włączany na starcie. Szyna kodeka `PIN_AUDIO_PWR=42` jest **active-LOW** i musi być włączona przed `Wire.begin()`, a wbudowany mikrofon jest analogowy (`MIC1P-MIC1N`, `0x14=0x1A`), nie DMIC. Szczegóły w [[projekty/foxie-notes/sprzet-waveshare-v2|notatce sprzętowej V2]].
- **Arduino-ESP32 3.x / ESP-IDF 5.x:** W firmware używamy nowego `driver/i2s_std.h` zamiast przestarzałego `driver/i2s.h`. W `firmware/include/config.h` występują globalne stałe audio z szablonu, dlatego stałe `AudioRecorder` są w `namespace foxie_audio`.
- **Model Gemini:** Nowe klucze Google AI Studio wymagają `gemini-3.8-flash` (`gemini-2.5-flash` zwraca `404` dla nowych użytkowników) — zweryfikowano na żywo (`OK`).
- **Sekrety lokalne:** `firmware/include/config.h` zawiera lokalne dane Wi-Fi i jest chroniony przez `.gitignore` — **nigdy** nie dodawaj go do gita ani nie wpisuj haseł do `vault/`.
- **PowerShell 5.1 na Windows:** Operator `&&` nie działa w lokalnym Windows PowerShell 5.1; w skryptach/komendach używaj `;` z `$ErrorActionPreference = 'Stop'`.
- **Workflow commitów:** Każda zmiana przed `git commit` musi zaktualizować ten plik, listy w `zadania/` oraz `vault/wiki/log.md` zgodnie ze skillem `.agents/skills/obsidian-commit-sync/SKILL.md`.

## Następny krok (Next Action)

1. **Wgranie firmware z URL chmurowym na płytkę (`COM5`) i test E2E:**
   - Podłączyć Waveshare V2 przez USB (`COM5`), wgrać zbudowany firmware (`python -m platformio run -d firmware -t upload --upload-port COM5`) i nagrać pierwszą notatkę głosową przyciskiem `BOOT`, weryfikując automatyczny commit `.md` w `vault/raw/inbox/` na GitHubie (oraz tryb offline SD -> auto-sync).
2. **Etap 2B — Aplikacja webowa (`web/`) + wdrożenie Firestore/Hosting:**
   - Zbudować aplikację React/Vite w `web/` (Firebase Auth z blokadą `ALLOWED_USER_EMAIL`, minimalistyczny papierowy układ: „Do zrobienia” z Firestore + szybkie dodawanie na `POST /api/capture`, oraz „Wiki” z `wiki_meta/index`, wyszukiwarką i `[[wikilinks]]`), a następnie wdrożyć `hosting` i `firestore:rules` oraz podpiąć webhook GitHuba.

## Pliki startowe do wczytania w nowym oknie

1. `AGENTS.md` (reguły repozytorium ładowane automatycznie)
2. `vault/wiki/projekty/foxie-notes/status.md` (ten plik)
3. `vault/wiki/projekty/foxie-notes/zadania/etap-1-urzadzenie.md`
4. `vault/wiki/log.md`
