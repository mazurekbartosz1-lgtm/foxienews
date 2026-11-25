---
title: Foxie Notes
slug: projekty/foxie-notes/index
updated_at: 2026-11-25T07:45:00Z
tags: [projekt, foxie-notes, esp32, obsidian]
---

# Foxie Notes

Prywatny system do szybkiego przechwytywania notatek głosowych i przeglądania bazy wiedzy: **urządzenia e-ink ESP32-S3 -> Gemini API -> Obsidian Vault (GitHub) -> Firestore + Web App**.

## Architektura i katalogi
- `simulator/` — symulator ekranu e-ink 200×200 (1-bit) z maskotką liska i eksportem tablic `PROGMEM` do C++.
- `firmware/` — PlatformIO (Arduino / C++) dla **Waveshare ESP32-S3-Touch-ePaper-1.54 V2** (w przyszłości także reTerminal E1001 7.5").
- `functions/` — Firebase Functions 2nd gen (`europe-west1`, TypeScript + Express): `POST /api/capture`, `GET /api/wiki/*`, `POST /api/webhook/github`.
- `web/` — minimalistyczna aplikacja React + Vite + Tailwind CSS na Firebase Hosting (logowanie ograniczone do `ALLOWED_USER_EMAIL`).
- `vault/` — lokalna baza wiedzy Obsidian („pamięć lokalna”) rozwijana równolegle z kodem.

## Zatwierdzona mapa przycisków (Waveshare 1.54" V2)
- `BOOT` (`GPIO 0`, krótkie kliknięcie): start / stop nagrywania notatki głosowej.
- `BOOT` (`GPIO 0`, długie przytrzymanie ≥ 2.5 s): tryb konfiguracji Wi-Fi z kodem QR (Captive Portal).
- `PWR` (`GPIO 18`, krótkie kliknięcie): wybudzenie / odświeżenie ekranu.
- `PWR` (`GPIO 18`, długie przytrzymanie ≥ 2.5 s): bezpieczne uśpienie / wyłączenie zasilania bateryjnego (`PWR_HOLD`).

## Powiązane dokumenty i zadania
- [[projekty/foxie-notes/status|Aktualny stan i handoff (status)]]
- [[projekty/foxie-notes/sprzet-waveshare-v2|Specyfikacja i pinout Waveshare V2]]
- [[projekty/foxie-notes/zadania/etap-1-urzadzenie|Zadania — Etap 1 (Urządzenie, Symulator, /api/capture)]]
- [[projekty/foxie-notes/zadania/etap-2-wiki-webapp|Zadania — Etap 2 (Webhook, Firestore, Web App)]]
