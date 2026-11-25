---
title: Status projektu i handoff (Foxie Notes)
slug: projekty/foxie-notes/status
updated_at: 2026-11-25T19:30:00Z
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
   - Płytka jest sflashowana najnowszym firmware (PlatformIO `esp32s3_v2`, `1125664 bytes`).
   - Wi-Fi provisioning przez Captive Portal + NVS (`Preferences`) oraz opcjonalny lokalny fallback w gitignorowanym `firmware/include/config.h` (lokalna nazwa miasta pogodowego konfigurowalna w portalu).
   - Zegar 24h przez NTP (`CET-1CEST,M3.5.0,M10.5.0/3`), zweryfikowany na porcie szeregowym (`[Foxie] NTP synced: 19:26`).
   - Pogoda z Open-Meteo odświeżana co 30 min przy połączeniu Wi-Fi; domyślna lokalizacja **Trąbki Wielkie** (`54.1697, 18.5397`), zweryfikowana na porcie szeregowym (`[Foxie] Weather (Trabki Wielkie): 0 C (WMO 3)`).
   - Głęboki sen (`Hibernate`) po ≥ 2 godzinach bezczynności: wyłącza Wi-Fi i przechodzi w `deep_sleep` z wybudzeniem przez `ext1` (przycisk lub dotyk `PIN_TP_INT = GPIO21`) oraz cichym timerem RTC co minutę do aktualizacji samego zegara.

3. **Backend Firebase (`functions/`, Etap 1B)**
   - ESM TypeScript (`NodeNext`, `@google/genai@^3.6.1`, `@octokit/rest@^22.0.1`), `POST /api/capture` (nagranie audio / tekst -> Gemini 2.5 Flash -> commit Markdown do repozytorium GitHub z obsługą opcjonalnego `GITHUB_VAULT_PREFIX`).
   - Testy jednostkowe (`npm --prefix functions test`) przechodzą w `4/4` przypadkach (`tsc` + `node --test`).

## Kluczowe decyzje i pułapki

- **Sprzęt Waveshare V2 (`N8R8`):** Pamiętaj o pinach specyficznych dla V2 — I²C `SDA=47`, `SCL=48`, dotyk `PIN_TP_RST=7`, `PIN_TP_INT=21`, zatrzask zasilania `PWR_HOLD` włączany na starcie. Szczegóły w [[projekty/foxie-notes/sprzet-waveshare-v2|notatce sprzętowej V2]].
- **Sekrety lokalne:** `firmware/include/config.h` zawiera lokalne dane Wi-Fi i jest chroniony przez `.gitignore` — **nigdy** nie dodawaj go do gita ani nie wpisuj haseł do `vault/`.
- **PowerShell 5.1 na Windows:** Operator `&&` nie działa w lokalnym Windows PowerShell 5.1; w skryptach/komendach używaj `;` z `$ErrorActionPreference = 'Stop'`.
- **Workflow commitów:** Każda zmiana przed `git commit` musi zaktualizować ten plik, listy w `zadania/` oraz `vault/wiki/log.md` zgodnie ze skillem `.agents/skills/obsidian-commit-sync/SKILL.md`.

## Następny krok (Next Action)

1. **Etap 1B — weryfikacja end-to-end backendu:**
   - Skonfigurować lokalne sekrety Firebase (`GEMINI_API_KEY`, `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `DEVICE_API_KEY`) poza gitem (`functions/.secret.local` / `.env`) i przetestować `POST /api/capture` na emulatorze Firebase lub deployu testowym.
2. **Etap 1C — nagrywanie audio i wysyłka z urządzenia:**
   - Dodać obsługę kodeka audio **ES8311** + mikrofonu I²S w `firmware/`, zapis nagrania WAV (w PSRAM) podczas stanu `Recording` oraz wysyłkę `POST /api/capture` przez HTTPS/Wi-Fi ze stanami `Sending` -> `Saved` / `Error`.
3. **Etap 2 — synchronizacja wiki i aplikacja webowa:**
   - Po zamknięciu Etapu 1 przejść do [[projekty/foxie-notes/zadania/etap-2-wiki-webapp|Zadań — Etap 2]].

## Pliki startowe do wczytania w nowym oknie

1. `AGENTS.md` (reguły repozytorium ładowane automatycznie)
2. `vault/wiki/projekty/foxie-notes/status.md` (ten plik)
3. `vault/wiki/projekty/foxie-notes/zadania/etap-1-urzadzenie.md`
4. `vault/wiki/log.md`
