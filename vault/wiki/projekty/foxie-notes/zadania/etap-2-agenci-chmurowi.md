---
title: Zadania — Chmurowi Agenci (Organizator, Researcher PR, Kalendarz/Tasks)
slug: projekty/foxie-notes/zadania/etap-2-agenci-chmurowi
updated_at: 2026-11-26T18:40:00Z
tags: [zadania, agenci, chmura, obsidian, foxie-notes]
---

# Zadania — Chmurowi Agenci nad `obsydianandwiki`

**Priorytet bieżący:** realizowane **przed** aplikacją webową `web/` ([[projekty/foxie-notes/zadania/etap-2-wiki-webapp|Etap 2B]]).

Urządzenie Waveshare V2 działa w pełni (test spacerowy offline SD -> Wi-Fi -> `obsydianandwiki/raw/inbox/` zaliczony). Teraz surowa płaska lista plików w `raw/inbox/` ma być automatycznie porządkowana i przetwarzana w chmurze Firebase (`functions/`) przez wyspecjalizowanych agentów.

Powiązane: [[projekty/foxie-notes/index|Foxie Notes]] · [[projekty/foxie-notes/status|Status i handoff]] · [[projekty/foxie-notes/zadania/etap-2-wiki-webapp|Etap 2B (Web App)]]

---

## Docelowy pipeline multi-agentowy

1. **Wyzwalacz (Webhook GitHub -> Firestore Job Queue + Idempotencja):**
   - Webhook `push` z repozytorium `mazurekbartosz1-lgtm/obsydianandwiki` kierowany na `POST /api/webhook/github` (weryfikacja podpisu HMAC `X-Hub-Signature-256` jest już zaimplementowana w `functions/src/app.ts`).
   - Filtr anty-pętlowy: reagujemy wyłącznie na nowo dodane pliki `raw/inbox/*.md` (ignorujemy commity samych agentów modyfikujące `wiki/` lub `agent/`).
   - Śledzenie stanu przetwarzania w Firestore (`inbox_jobs/<shaOrPath>`) zapobiega duplikatom.

2. **Faza 1 — Agent Organizator (Triage i spójna taksonomia katalogów):**
   - Czyta nowy plik z `raw/inbox/`, `SCHEMA.md` (zasady taksonomii) oraz bieżącą listę ścieżek `wiki/**` i `wiki/index.md` z GitHuba.
   - Klasyfikuje intencję notatki: `knowledge | project | plan-calendar | todo | research-idea`.
   - Umieszcza / dopisuje zsyntetyzowaną treść w spójnym podkatalogu (np. `wiki/projekty/<projekt>/`, `wiki/obszary/<obszar>/`, `wiki/pomysly/`, `wiki/zasoby/`, `wiki/dziennik/`), dodaje `[[wikilinks]]`, aktualizuje `wiki/index.md` i `wiki/log.md` jednym atomowym commitem przez GitHub Git Data API.

3. **Faza 2 — Agent Researcher (Pomysły -> Pull Request w Git do akceptacji):**
   - Wyzwalany dla notatek zaklasyfikowanych jako `research-idea`.
   - Uruchamia `gemini-3.8-flash` z Google Search grounding / głębszą analizą (problem, warianty rozwiązania, ryzyka, źródła, następne kroki).
   - Tworzy osobną gałąź `agent/research-<slug>` w `obsydianandwiki`, zapisuje raport Markdown (np. `wiki/pomysly/<slug>/research.md`) i otwiera **Pull Request** do przeglądu i scalenia (`Merge PR`) przez użytkownika w GitHubie.

4. **Faza 3 — Agent Planowania (Google Calendar + Google Tasks):**
   - Wyzwalany dla notatek zaklasyfikowanych jako `plan-calendar` lub `todo` (z obsługą `@due(YYYY-MM-DD)`).
   - Integruje się z Google Calendar API i Google Tasks API (OAuth2 refresh token przechowywany w Firebase Secret Manager).
   - Zapisuje ID utworzonych wydarzeń/zadań z powrotem w notatce (idempotencja) i stosuje jawny próg bezpieczeństwa przed dodaniem wydarzenia do kalendarza, żeby luźna myśl ze spaceru nie zaśmiecała grafiku.

---

## Checklista wdrożenia (do realizacji po kolei)

### Krok startowy (pierwsze decyzje z użytkownikiem w nowym oknie)
- [x] Potwierdzić docelową taksonomię folderów w `obsydianandwiki/SCHEMA.md` (**PARA + Dziennik**: `projekty/`, `obszary/`, `pomysly/`, `zasoby/`, `dziennik/YYYY-MM-DD.md`) #agenci #architektura
- [x] Ustalić los przetworzonych plików w `raw/inbox/`: przenoszenie oryginałów w atomowym commicie do `raw/processed/YYYY-MM/` (czysty inbox w Obsidianie) #agenci #architektura
- [x] Skonfigurować webhook `push` na repozytorium `mazurekbartosz1-lgtm/obsydianandwiki` wskazujący na `/api/api/webhook/github` z `GITHUB_WEBHOOK_SECRET` (webhook `id: 717206121`, `ping` + `push` `200 OK`) #agenci #github

### Faza 1 — Agent Organizator (Triage & Taksonomia)
- [x] Rozbudować `POST /api/webhook/github` o wykrywanie nowych plików `raw/inbox/*.md` i pomijanie commitów własnych agentów (`agent(...)`, `docs(vault):`) — brak pętli zwrotnej #agenci #backend
- [x] Dodać w `functions/src/services/github.ts` serwis atomowych operacji GitHub Git Data API (`createGitHubVaultClient`: odczyt drzewa, atomowe bloby/drzewa/commity, tworzenie branchy i Pull Requestów) #agenci #github
- [x] Zaimplementować `inboxOrganizer.ts` (`gemini-3.8-flash` + deterministyczne składanie/scalanie Markdown, `wiki/index.md`, `wiki/log.md`, przenoszenie do `raw/processed/YYYY-MM/` oraz kolejka idempotencji `inbox_jobs` w Firestore) i endpoint `POST /api/agents/organize-inbox` #agenci #ai
- [x] Dodać testy jednostkowe / integracyjne (`npm --prefix functions test` -> `13/13`), wdrożyć funkcję `api` + `firestore:rules` i przeprocesować 8 istniejących notatek w `obsydianandwiki/raw/inbox/` (`8/8 processed`, zero błędów) #agenci #testy

### Faza 2 — Agent Researcher (Analiza -> Git Pull Request)
- [x] Zaimplementować `researchAgent` (Gemini `gemini-3.8-flash` z Google Search grounding `tools: [{ googleSearch: {} }]` generujący ustrukturyzowany raport + zweryfikowane źródła z `groundingMetadata` + checkboxy `- [ ]` + fallback bez narzędzia) i endpoint `POST /api/agents/research` #agenci #ai
- [x] Dodać automatyczne tworzenie gałęzi `agent/research-<slug>` (z obsługą kolizji `422` i deduplikacją otwartych PR przez `findOpenPullRequest`) i otwieranie Pull Requesta w `mazurekbartosz1-lgtm/obsydianandwiki` po klasyfikacji `research-idea` #agenci #github
- [x] Dodać testy scenariusza `research-idea -> PR` (`16/16` w `npm --prefix functions test`) i zweryfikować na żywo (`POST /api/api/capture` -> webhook -> Organizator -> `obsydianandwiki/pull/1`) #agenci #testy

### Faza 3 — Agent Planowania (Google Calendar + Google Tasks)
- [ ] Skonfigurować OAuth2 (Calendar + Tasks scopes) i zapisać refresh token w Firebase Secret Manager (`functions/.secret.local` lokalnie) #agenci #sekrety
- [ ] Zaimplementować `planningAgent` tworzący zadania w Google Tasks i/lub wydarzenia w Google Calendar z idempotencją po `inbox_jobs` #agenci #google
- [ ] Przetestować pełny obieg głosówki: `Waveshare V2 -> raw/inbox/ -> Organizator -> Tasks/Calendar lub Researcher PR` #agenci #e2e

---

## Stan techniczny na start nowego okna
- **Backend chmurowy:** `functions/src/app.ts` (`POST /api/capture`, `POST /api/webhook/github`, `GET /api/wiki/*`), wdrożony jako Cloud Function v2 `api` (`europe-west1`) w projekcie `gen-lang-client-0751515487`.
- **Istniejące serwisy:** `functions/src/services/gemini.ts` (`gemini-3.8-flash`), `github.ts`, `wikiParser.ts`, `wikiSync.ts`, `firestoreStore.ts`.
- **Sekrety już w Firebase Secret Manager:** `GEMINI_API_KEY`, `GITHUB_TOKEN`, `DEVICE_API_KEY`, `GITHUB_WEBHOOK_SECRET`, `ALLOWED_USER_EMAIL`.
- **Repozytorium vaulta:** `mazurekbartosz1-lgtm/obsydianandwiki` (`main`, surowe notatki w `raw/inbox/`, wiki w `wiki/`, synchronizacja dokumentacji projektu z kodu przez `npm run sync:vault`).
