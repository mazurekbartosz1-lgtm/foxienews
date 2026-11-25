# Foxie Notes

Prywatny system wiedzy i notatek głosowych łączący:
- **Urządzenia e-ink ESP32-S3** (priorytet 1: **Waveshare ESP32-S3-Touch-ePaper-1.54 V2**, w przyszłości: reTerminal E1001 7.5"),
- **Symulator e-ink 200×200 w przeglądarce** z eksportem grafik 1-bit `PROGMEM` do C++,
- **Backend Firebase Functions (2nd gen, `europe-west1`)** z transkrypcją Gemini API i zapisem do **Obsidian Vaulta na GitHubie**,
- **Minimalistyczną aplikację webową** (Firebase Hosting + Auth + Firestore cache).

## Struktura monorepo

```text
.
├── docs/
│   └── SCHEMA.example.md      # Wzorcowy SCHEMA.md do skopiowania do vaulta Obsidian
├── firmware/                  # PlatformIO / C++ dla Waveshare ESP32-S3-Touch-ePaper-1.54 V2
│   ├── include/
│   │   ├── board_pins.h       # Mapa pinów V2 (SPI, I2C, I2S, BOOT/PWR, GP3)
│   │   ├── config.h.example   # Szablon konfiguracji domyślnej (kopiuj -> config.h)
│   │   └── ui_assets.h        # Kontrakt bitmap 1-bit PROGMEM z symulatora
│   ├── src/main.cpp
│   └── platformio.ini
├── functions/                 # Firebase Functions 2nd gen (TypeScript + Express)
│   ├── src/
│   │   ├── middleware/auth.ts # X-API-Key lub Firebase ID Token (whitelist e-mail)
│   │   ├── types/api.ts
│   │   ├── app.ts
│   │   └── index.ts           # Eksport funkcji `api` (region europe-west1)
│   └── .env.example
├── simulator/                 # Symulator ekranu e-ink 200×200 (Vite + TypeScript)
├── vault/                     # Lokalna baza wiedzy Obsidian (pamięć projektu i zadania)
│   ├── raw/inbox/             # Surowe notatki (append-only dla /api/capture)
│   └── wiki/projekty/         # Strony projektów i podfoldery zadania/
├── web/                       # Aplikacja webowa React + Vite + Tailwind CSS (Etap 2)
├── firebase.json              # Konfiguracja Hosting + Functions + Firestore + Emulators
├── firestore.rules            # Dostęp wyłącznie dla ALLOWED_USER_EMAIL
├── firestore.indexes.json
└── package.json
```

## Wymagania wstępne

1. **Node.js 22+** i `npm`
2. **Firebase CLI**: `npm install -g firebase-tools` (oraz `firebase login`)
3. **PlatformIO**: rozszerzenie **PlatformIO IDE** w VS Code lub CLI `pio` (`pip install platformio`)

---

## 1. Uruchomienie symulatora e-inka w przeglądarce

```bash
cd simulator
npm install
npm run dev
```

Lub z katalogu głównego:

```bash
npm run dev:sim
```

Symulator uruchomi się domyślnie pod adresem `http://localhost:5174`. Umożliwia podgląd 1:1 (200×200 px, 1-bit) oraz powiększenia `2×` i `3×`, test wirtualnych przycisków `BOOT`/`PWR` i diody `GP3`, a w Etapie 1A także pełne ekrany z maskotką liska i eksport tablic bajtów `PROGMEM` do `firmware/include/ui_assets.h`.

---

## 2. Kompilacja i wgrywanie firmware na Waveshare (ESP32-S3 V2)

> **Ważna uwaga sprzętowa (rewizja V2 — ESP32-S3-PICO-1-N8R8):**
> - Pamięć jest konfigurowana jako **8 MB QSPI Flash + 8 MB OPI PSRAM** (`qio_opi` w `firmware/platformio.ini`).
> - Na tylnej naklejce złącza 2×6 lewa kolumna ma `SDA`/`SCL` (wspólna magistrala I²C dla ES8311, PCF85063, SHTC3 i dotyku na **GPIO 47 / GPIO 48**), natomiast `GP20`/`GP19` w prawej kolumnie to natywne linie **USB D+ / D-** — nie wolno używać ich jako I²C.
> - Przy zasilaniu z akumulatora LiPo pin `PWR_HOLD` (**GPIO 17**) musi zostać ustawiony w stan `HIGH` na starcie `setup()`.
> - W przypadku braku rozpoznania portu USB przy pierwszym wgrywaniu: przytrzymaj przycisk `BOOT` (GPIO 0), podłącz USB-C (lub naciśnij reset) i puść `BOOT`.

1. Skopiuj szablon konfiguracji:
   ```bash
   cp firmware/include/config.h.example firmware/include/config.h
   ```
2. Zainstaluj biblioteki i skompiluj projekt w katalogu `firmware/`:
   ```bash
   cd firmware
   pio run
   ```
3. Wgraj firmware na płytkę podłączoną przez USB-C i otwórz monitor portu szeregowego:
   ```bash
   pio run --target upload --target monitor
   ```

---

## 3. Uruchomienie backendu lokalnie (Firebase Emulators)

1. Skopiuj konfigurację Firebase projektu oraz zmienne środowiskowe:
   ```bash
   cp .firebaserc.example .firebaserc
   cp functions/.env.example functions/.env
   ```
2. Uzupełnij `.firebaserc` prawdziwym `project-id`, a w `functions/.env` wpisz `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH` oraz `GEMINI_MODEL`.
3. Utwórz plik `functions/.secret.local` (ignorowany przez gita) z lokalnymi odpowiednikami sekretów na czas pracy emulatorów:
   ```env
   GITHUB_TOKEN=ghp_...
   GEMINI_API_KEY=AIza...
   DEVICE_API_KEY=twoj-dlugi-klucz-urzadzenia
   GITHUB_WEBHOOK_SECRET=twoj-sekret-webhooka
   ALLOWED_USER_EMAIL=twoj.email@example.com
   ```
4. Zainstaluj zależności `functions/` i uruchom build w trybie watch:
   ```bash
   npm --prefix functions install
   npm run build:functions
   ```
5. W głównym katalogu uruchom emulatory Firebase (`Auth`, `Functions`, `Firestore`, `Hosting`, `Emulator UI`):
   ```bash
   npm run emulators
   ```
   Test zdrowia API: `GET http://127.0.0.1:5001/<project-id>/europe-west1/api/api/health` (lub przez Hosting Emulator `http://127.0.0.1:5000/api/health`).

---

## 4. Konfiguracja sekretów i wdrożenie (Produkcja)

1. Podmień `REPLACE_WITH_ALLOWED_USER_EMAIL` w pliku `firestore.rules` na swój zweryfikowany adres e-mail konta Firebase Auth.
2. Ustaw wszystkie 5 sekretów w **Firebase Secret Manager**:
   ```bash
   firebase functions:secrets:set GITHUB_TOKEN
   firebase functions:secrets:set GEMINI_API_KEY
   firebase functions:secrets:set DEVICE_API_KEY
   firebase functions:secrets:set GITHUB_WEBHOOK_SECRET
   firebase functions:secrets:set ALLOWED_USER_EMAIL
   ```
3. Wdróż reguły Firestore, funkcje i hosting:
   ```bash
   firebase deploy
   ```
