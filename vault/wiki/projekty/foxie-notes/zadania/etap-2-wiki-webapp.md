---
title: Zadania — Etap 2 (Webhook, Firestore, Web App)
slug: projekty/foxie-notes/zadania/etap-2-wiki-webapp
updated_at: 2026-11-26T05:57:00Z
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

## Etap 2B — Aplikacja Webowa (`web/`)
- [ ] Dodać ekran logowania Firebase Auth z blokadą dostępu poza `ALLOWED_USER_EMAIL` #etap-2 #webapp
- [ ] Zbudować minimalistyczny, papierowy układ nawigacji (Do zrobienia / Wiki / Wyloguj) #etap-2 #webapp
- [ ] Zaimplementować widok „Do zrobienia” (lista zadań z Firestore + szybki formularz dodawania notatki/zadania na `POST /api/capture`) #etap-2 #webapp
- [ ] Zaimplementować widok „Wiki” (spis treści `wiki_meta/index`, wyszukiwarka, renderowanie Markdowna i klikalne linki `[[wikilinks]]`) #etap-2 #webapp
