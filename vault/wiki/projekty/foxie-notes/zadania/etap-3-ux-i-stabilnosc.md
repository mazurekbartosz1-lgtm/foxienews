---
title: Zadania — Etap 3 (UX urządzenia, Stabilność, Cykliczni Agenci)
slug: projekty/foxie-notes/zadania/etap-3-ux-i-stabilnosc
updated_at: 2026-11-27T12:20:00Z
tags: [zadania, etap-3, ux, firmware, agenci, foxie-notes]
---

# Zadania — Etap 3 (UX urządzenia, Stabilność, Cykliczni Agenci)

**Priorytet bieżący:** aktywny backlog po wdrożeniu Etapu 2B (`web/`) i chmurowych agentów Fazy 1–3.

Powiązane: [[projekty/foxie-notes/index|Foxie Notes]] · [[projekty/foxie-notes/status|Status i handoff]] · [[projekty/foxie-notes/sprzet-waveshare-v2|Sprzęt Waveshare V2]]

---

## Paczka 1 — Higiena vaulta, poprawka wyścigu `422` i automatyczny przegląd (Zakończone)
- [x] Wyjaśnić i naprawić przyczynę zaległych plików w `raw/inbox/`: dodać retry przy błędzie Git `422 Update is not a fast forward` w `github.ts` oraz ponowne scalanie `wiki/index.md` / `wiki/log.md` w `inboxOrganizer.ts` (`24/24` testy + redeploy `functions`) #backend #stabilnosc
- [x] Dodać kanonizację aliasów `foxie-notes` (`foxy-news`, `foxing-news`, `foxie-news`) i ochronę `sprzet-waveshare-v2.md` / `zadania/*` przed nadpisywaniem przez Organizatora #agenci #ochrona
- [x] Usunąć pomysł sprzętowy `wiki/pomysly/bateria-lipo-obudowa-waveshare` z `obsydianandwiki`, scalić `foxing-news` i notatki UX do zdalnego `wiki/projekty/foxie-notes/notatki.md`, naprawić `wiki/index.md` i przeprocesować 3 zaległe pliki z `raw/inbox/` (`0` pozostałych) #vault
- [x] Dodać skrypt `npm run vault:overview` oraz ustandaryzować reguły przeglądu całego vaulta i raportowania backlogu w `AGENTS.md` i `.agents/skills/obsidian-commit-sync/SKILL.md` #workflow
- [x] Dodać automatyczny `inboxSweeper` (`onSchedule` co 5 min + limit 3 prób `attempts` w `inbox_jobs`), aby `raw/inbox/` czyścił się sam bez ręcznej ingerencji #backend #agenci

---

## Paczka 2 — Quick Wins w firmware Waveshare V2 (Zakończone)
- [x] Wydłużyć maksymalny czas nagrywania z `60 s` do `120 s` (`MAX_DURATION_SEC = 120` w `firmware/include/audio_recorder.h` + `HTTP_RESPONSE_TIMEOUT_MS = 60000`) #firmware #ux
- [x] Wyłączyć ekran skanowania QR całkowicie z przycisków fizycznych (`onBootLongPress()` ignoruje wywołanie; Captive Portal wyłącznie jako fallback przy pustym SSID w NVS) #firmware #ux
- [x] Dodać ikonę trwającej synchronizacji Wi-Fi (`ICON_SYNC_16`) oraz licznik postępu kolejki SD (`SYNC 1/5`, `SYNC 1 z 5`) w `firmware/src/main.cpp` #firmware #ui
- [x] Wyliczyć realny bilans baterii (ile notatek na jednym ładowaniu) i zapisać wynik w dokumentacji sprzętowej (`sprzet-waveshare-v2.md`) #firmware #bateria

---

## Kolejne etapy (Następny krok)
- [x] **Szybkie wybudzanie (`firmware/`):** 3 czytelne stany (`Uśpiony -> Wybudzanie z loaderem -> Nagrywanie/Gotowy`), natychmiastowy partial refresh przez `nextPageToPrevious()` (~`439 ms` bez 3× mrugania), bezpośrednie przejście do nagrywania po wybudzeniu przyciskiem `BOOT` oraz nieblokujące Wi-Fi w tle (`startWifiConnectAsync` / `pollWifiConnectAsync`), zweryfikowane na `COM5` #firmware #ux
- [ ] **Sygnał dźwiękowy `beep` ES8311 (`firmware/`):** odtworzenie krótkiego sygnału dźwiękowego przez kodek ES8311 + wzmacniacz NS4150B (`DOUT=45`, `PA_CTRL=46`) po zakończeniu nagrania #firmware #ux
- [x] **Cykliczni agenci `onSchedule` (`functions/` + `web/`):** okresowy Kurator „Ogrodnik” (`weeklyGardener`, niedziela 04:00 `Europe/Warsaw` + `POST /api/agents/gardener`) oraz Przegląd Tygodniowy (`weeklyReview`, niedziela 19:00 `Europe/Warsaw` -> `wiki/dziennik/tydzien-YYYY-Www.md` + `POST /api/agents/weekly-review`) wraz z przyciskami ręcznego wywołania w `AgentsActivityView.tsx` (`29/29` testy + wdrożono w Firebase) #agenci #backend #webapp
- [ ] **Pomysł `[[pomysly/agent-ai-dla-developera]]`:** zaprojektować architekturę agenta deweloperskiego z podziałem na zadania autonomiczne oraz wymagające akceptacji (approval HITL) #pomysl #agenci
