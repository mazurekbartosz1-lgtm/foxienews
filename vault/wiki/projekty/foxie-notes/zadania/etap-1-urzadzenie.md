---
title: Zadania — Etap 1 (Urządzenie, Symulator, /api/capture)
slug: projekty/foxie-notes/zadania/etap-1-urzadzenie
updated_at: 2026-11-25T08:00:00Z
tags: [zadania, etap-1, foxie-notes]
---

# Zadania — Etap 1 (Priorytet 1)

Cel etapu: pełny przepływ **Symulator UI -> Firmware Waveshare V2 -> Nagrywanie głosu ES8311 -> Transkrypcja Gemini API -> Commit `.md` do `raw/inbox/` na GitHubie**.

Powiązane: [[projekty/foxie-notes/index|Foxie Notes]] · [[projekty/foxie-notes/sprzet-waveshare-v2|Sprzęt Waveshare V2]]

## Krok 1 — Szkielet i pamięć lokalna (Zakończone)
- [x] Utworzyć strukturę monorepo (`simulator/`, `firmware/`, `functions/`, `web/`, `firebase.json`, `firestore.rules`)
- [x] Zweryfikować pinout rewizji V2 (`N8R8` `qio_opi`, I²C `GP47/48`, `PWR_HOLD=17`)
- [x] Przygotować `README.md` oraz `docs/SCHEMA.example.md`
- [x] Utworzyć lokalny vault Obsidian w `vault/` z folderem projektu i listami zadań
- [x] Wypchnąć stan początkowy na repozytorium GitHub (`mazurekbartosz1-lgtm/foxienews`)

## Konfiguracja środowiska użytkownika
- [ ] Zainstalować Firebase CLI (`npm install -g firebase-tools`) i zalogować się (`firebase login`) #setup
- [x] Zainstalować PlatformIO (rozszerzenie VS Code lub `pio` CLI) do kompilacji `firmware/` #setup
- [ ] Uzupełnić `ALLOWED_USER_EMAIL` w `firestore.rules` oraz sekrety w Firebase Secret Manager (`GITHUB_TOKEN`, `GEMINI_API_KEY`, `DEVICE_API_KEY`, `GITHUB_WEBHOOK_SECRET`, `ALLOWED_USER_EMAIL`) #setup
- [ ] Zweryfikować `firmware/include/board_pins.h` ze schematem PDF rewizji V2 od Waveshare #sprzet

## Etap 1A — Symulator E-Ink 200×200 (`simulator/`)
- [x] Zaprojektować 1-bitową grafikę maskotki liska dla stanów: Gotowy (śpiący), Nagrywanie (nasłuchujący), Wysyłanie, Zapisano, Błąd, Konfiguracja Wi-Fi (QR) #etap-1 #symulator
- [x] Dodać symulację odświeżania e-paper (krótka inwersja ekranu przy pełnym odświeżeniu) #etap-1 #symulator
- [x] Połączyć wirtualne przyciski `BOOT` i `PWR` (krótkie kliknięcie / długie przytrzymanie ≥ 2.5 s) oraz diodę `GP3` z automatem stanów urządzenia #etap-1 #symulator
- [x] Zaimplementować eksport gotowych bitmap 1-bit `PROGMEM` i definicji layoutu bezpośrednio do `firmware/include/ui_assets.h` #etap-1 #symulator

## Etap 1B — Backend `POST /api/capture` (`functions/`)
- [ ] Zaimplementować walidację żądania `POST /api/capture` (`source`, `text` lub `audioBase64` `audio/wav`) #etap-1 #backend
- [ ] Zintegrować `@google/genai` (Gemini API) do transkrypcji audio WAV i sformatowania notatki (tytuł, podsumowanie, tagi, opcjonalne `- [ ]`) #etap-1 #backend
- [ ] Zintegrować `@octokit/rest` do tworzenia pliku `.md` z YAML frontmatterem w `raw/inbox/` w prywatnym repozytorium GitHub #etap-1 #backend
- [ ] Przetestować endpoint lokalnie na emulatorach Firebase (`curl` + symulator) #etap-1 #backend

## Etap 1C — Firmware Waveshare V2 (`firmware/`)
- [x] Podpiąć sterownik ekranu 1.54" e-Paper 200×200 i renderowanie bitmap z `ui_assets.h` #etap-1 #firmware
- [ ] Zaimplementować Captive Portal / `WiFiManager` z ekranem kodu QR na e-inku oraz zapisem SSID, hasła, URL API i `X-API-Key` w NVS #etap-1 #firmware
- [x] Zaimplementować obsługę przycisków `BOOT` (`GPIO 0`), `PWR` (`GPIO 18`), podtrzymania zasilania `PWR_HOLD` (`GPIO 17`) oraz sygnalizację diodą `GP3` #etap-1 #firmware
- [ ] Skonfigurować kodek audio **ES8311** (I²C `GP47/48` + I²S) i nagrywanie WAV (16 kHz, 16-bit, mono) do bufora w 8 MB OPI PSRAM #etap-1 #firmware
- [ ] Zaimplementować wysyłkę nagrania (Base64 JSON) na `POST /api/capture` z nagłówkiem `X-API-Key` oraz obsługę ekranów Zapisano / Błąd #etap-1 #firmware
