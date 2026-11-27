---
title: Zadania — Etap 3 (UX urządzenia, Stabilność, Cykliczni Agenci)
slug: projekty/foxie-notes/zadania/etap-3-ux-i-stabilnosc
updated_at: 2026-11-27T10:08:00Z
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

---

## Paczka 2 — Quick Wins w firmware Waveshare V2 (Następny krok)
- [ ] Wydłużyć maksymalny czas nagrywania z `60 s` do `120 s` (`MAX_DURATION_SEC = 120` w `firmware/include/audio_recorder.h`) #firmware #ux
- [ ] Ukryć / usunąć ekran skanowania QR z normalnej ścieżki pracy (zostawić tylko pod dedykowaną kombinacją lub z bezpiecznym wyjściem, bez ślepego zaułka) #firmware #ux
- [ ] Dodać ikonę trwającej synchronizacji Wi-Fi oraz licznik postępu kolejki SD (np. `1/5`, `2/5`) w `firmware/src/main.cpp` #firmware #ui
- [ ] Wyliczyć realny bilans baterii (ile notatek na jednym ładowaniu) i zapisać wynik w dokumentacji sprzętowej #firmware #bateria

---

## Kolejne etapy (po Paczce 2)
- [ ] **Szybkie wybudzanie + Beep ES8311 (`firmware/`):** wyeliminować 3× mruganie e-inka przy wybudzaniu, wprowadzić 3 czytelne stany (`Sleeping` -> `Wake up` z loaderem -> `Recording`) oraz sygnał dźwiękowy (`beep`) na głośniku (`DOUT=45`, `PA_CTRL=46`) po zakończeniu nagrania #firmware #ux
- [ ] **Cykliczni agenci `onSchedule` (`functions/`):** okresowy Kurator „Ogrodnik” (porządkowanie `wiki/` na `main`), Przegląd Tygodniowy (`wiki/dziennik/tydzien-YYYY-Www.md`) oraz cykliczny auto-sweeper osieroconych plików w `raw/inbox/` #agenci #backend
- [ ] **Pomysł `[[pomysly/agent-ai-dla-developera]]`:** zaprojektować architekturę agenta deweloperskiego z podziałem na zadania autonomiczne oraz wymagające akceptacji (approval HITL) #pomysl #agenci
