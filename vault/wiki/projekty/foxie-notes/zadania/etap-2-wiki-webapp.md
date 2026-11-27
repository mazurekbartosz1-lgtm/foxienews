---
title: Zadania — Etap 2 (Webhook, Firestore, Web App)
slug: projekty/foxie-notes/zadania/etap-2-wiki-webapp
updated_at: 2026-11-27T06:55:00Z
tags: [zadania, etap-2, foxie-notes]
---

# Zadania — Etap 2

Cel etapu: synchronizacja zmian z GitHuba do Firestore oraz uruchomienie minimalistycznej aplikacji webowej do przeglądania wiedzy i zadań.

Powiązane: [[projekty/foxie-notes/index|Foxie Notes]] · [[projekty/foxie-notes/zadania/etap-1-urzadzenie|Zadania — Etap 1]]

## Etap 2A — Webhook GitHub i API Wiki (`functions/`)
- [x] Zaimplementować `POST /api/webhook/github` z weryfikacją podpisu HMAC `X-Hub-Signature-256` #etap-2 #backend
- [x] Dodać konwerter Markdown -> zwięzły `plainText` (pod przyszłe ekrany e-ink) dla stron z `wiki/` #etap-2 #backend
- [x] Zsynchronizować kolekcje Firestore `wiki_pages` oraz `wiki_meta/index` po każdym `push` do vaulta #etap-2 #backend
- [x] Zaimplementować parser checkboxów `- [ ]` / `- [x]` (wraz z `@due(...)` i `#tag`) zapisujący zadania do kolekcji `tasks` w Firestore #etap-2 #backend
- [x] Zaimplementować `GET /api/wiki/index` oraz `GET /api/wiki/page/:slug` zwracające lekkie dane z Firestore #etap-2 #backend

## Etap 2B — Aplikacja Webowa (`web/`, gotowa na Vercel)
- [x] Dodać ekran logowania Firebase Auth (Google Sign-In, `LoginPage.tsx`) z blokadą dostępu poza `ALLOWED_USER_EMAIL` #etap-2 #webapp
- [x] Zbudować minimalistyczny, papierowy układ nawigacji w stylu *yourmoments* (`Do zrobienia / Wiki / Agenci / Wyloguj`, `Lora` + `JetBrains Mono`) #etap-2 #webapp
- [x] Zaimplementować widok „Do zrobienia” (`TasksView.tsx`: lista zadań z Firestore `tasks` na żywo + szybki formularz dodawania notatki/zadania na `POST /api/capture`) #etap-2 #webapp
- [x] Zaimplementować widok „Wiki” (`WikiView.tsx`: spis treści `wiki_meta/index` pogrupowany wg PARA + Dziennik, wyszukiwarka, bezpieczny renderer Markdowna, klikalne `[[wikilinks]]` i akcje Research PR / Google Sync) oraz widok „Agenci” (`AgentsActivityView.tsx`) i konfigurację `vercel.json` #etap-2 #webapp
