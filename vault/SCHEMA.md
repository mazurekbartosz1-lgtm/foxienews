# SCHEMA — Konwencja Vaulta Obsidian & LLM Wiki

Ten dokument określa jednolity format plików dla backendu (`/api/capture`), agenta LLM Wiki, lokalnej pracy w Obsidianie oraz parsera webhooka GitHub -> Firestore.

---

## 1. Struktura katalogów vaulta

```text
vault/
├── SCHEMA.md                          # Ten dokument z zasadami
├── raw/
│   ├── inbox/                         # Kolejka surowych notatek z urządzeń e-ink i web appa
│   │   └── 2026-11-25T07-45-12Z-waveshare-154-pomysl.md
│   └── processed/                     # Oryginały przeniesione po przetworzeniu przez Agenta Organizatora
│       └── 2026-11/
│           └── 2026-11-25T07-45-12Z-waveshare-154-pomysl.md
└── wiki/
    ├── index.md                       # Główny spis treści (sekcje: Projekty, Obszary, Pomysły, Zasoby, Dziennik, System)
    ├── log.md                         # Chronologiczny dziennik zmian wykonanych przez LLM Wiki i agentów
    ├── projekty/
    │   └── <projekt>/                 # Dedykowany folder aktywnego projektu (np. foxie-notes/)
    │       ├── index.md               # Główna strona projektu i decyzje architektoniczne
    │       ├── <notatka>.md           # Notatki techniczne / sprzętowe projektu
    │       └── zadania/               # Podfolder z listami zadań do zrobienia
    │           └── <zakres>.md        # Checklista zadań (- [ ] / - [x])
    ├── obszary/
    │   └── <obszar>/                  # Stałe obszary życia (np. dom/, auto/, zdrowie/, finanse/, praca/)
    │       └── <temat>.md
    ├── pomysly/
    │   └── <temat>.md                 # Pomysły i kandydaci do analizy przez Researchera (research-idea)
    ├── zasoby/
    │   └── <temat>.md                 # Wiedza referencyjna, artykuły, narzędzia, materiały
    └── dziennik/
        └── YYYY-MM-DD.md              # Dziennik dzienny (obserwacje, refleksje, notatki #test)
```

### Przepływ `raw/inbox/` -> `raw/processed/YYYY-MM/`
- Endpoint `POST /api/capture` tworzy **wyłącznie nowe pliki** w `raw/inbox/`.
- **Agent Organizator** przetwarza nowe notatki z `raw/inbox/`, klasyfikuje ich intencję, syntetyzuje treść w odpowiednim podkatalogu `wiki/` (PARA + Dziennik), aktualizuje `wiki/index.md` oraz `wiki/log.md` i **w tym samym atomowym commicie** przenosi niezmieniony oryginał do `raw/processed/YYYY-MM/<plik>.md` (pozostawiając `raw/inbox/.gitkeep`).
- Żadne surowe nagranie/transkrypcja nie jest usuwane — archiwum w `raw/processed/` pozostaje tylko do odczytu.

### Konwencja commitów agentów (ochrona przed pętlą webhooków)
- Agent Organizator: `agent(organizer): <krótki tytuł> (<intent>)`
- Agent Researcher: `agent(researcher): <krótki tytuł>`
- Agent Planowania: `agent(planner): <krótki tytuł>`
- Webhook `POST /api/webhook/github` ignoruje commity z prefiksem `agent(` lub `docs(vault):` przy wykrywaniu nowych plików `raw/inbox/*.md`, aby nie tworzyć pętli zwrotnych.

### Dedykowane foldery projektów (`wiki/projekty/<projekt>/`)
- Każdy większy projekt posiada własny katalog w `wiki/projekty/<projekt>/`.
- Zadania projektowe przechowujemy w podfolderze `wiki/projekty/<projekt>/zadania/*.md` z użyciem standardowych checkboxów `- [ ]` / `- [x]`, aby zarówno Obsidian, jak i parser Firestore (`tasks`) zbierały je w jednym miejscu.

---

## 2. Format plików w `raw/inbox/`

Nazwa pliku: `YYYY-MM-DDTHH-MM-SSZ-<source>-<krotki-slug>.md`

```markdown
---
created_at: 2026-11-25T07:45:12Z
source: waveshare-154
type: voice-note
tags: [inbox, pomysl]
---

# Krótki tytuł wygenerowany z notatki

Zwięzła transkrypcja i uporządkowana treść notatki.

## Zadania
- [ ] Sprawdzić pobór prądu w trybie deep sleep
```

Dozwolone wartości `source`: `waveshare-154`, `reterminal-e1001`, `web`.

---

## 3. Format stron w `wiki/`

Każda strona w `wiki/` używa YAML frontmatteru oraz zwięzłego języka nadającego się zarówno do Obsidiana, jak i do skrótu `plainText` na ekranach e-ink:

```markdown
---
title: Nazwa tematu
slug: nazwa-tematu
updated_at: 2026-11-25T08:00:00Z
tags: [projekt, sprzet]
---

Krótkie podsumowanie (1–2 zdania na potrzeby ekranów e-ink).

Powiązane: [[inny-temat]], [[lista-zadan]]

## Notatki
- Kluczowy fakt lub decyzja.

## Zadania
- [ ] Zadanie do wykonania @due(2026-12-01) #priorytet
```

### Linki wewnętrzne (`[[wikilinks]]`)
- Linkuj względnie po ścieżce w `wiki/` bez rozszerzenia `.md`: `[[nazwa-tematu]]`, `[[projekty/foxie-notes/index|Foxie Notes]]`.
- Aplikacja webowa zamienia `[[slug]]` na klikalną nawigację w widoku Wiki.

---

## 4. Spis treści (`wiki/index.md`) i dziennik (`wiki/log.md`)

- `wiki/index.md` grupuje aktywne strony w sekcjach: `## Projekty`, `## Obszary`, `## Pomysły`, `## Zasoby`, `## Dziennik`, `## System`, w formacie:
  ```markdown
  - [[projekty/foxie-notes/index|Foxie Notes]] — Krótki opis (tagi: #projekt, #esp32)
  ```
- Na podstawie `wiki/index.md` oraz plików w `wiki/` webhook GitHub aktualizuje dokument `wiki_meta/index` oraz kolekcję `wiki_pages` w Firestore.
- `wiki/log.md` zawiera wpisy w porządku odwrotnie chronologicznym z informacją o zmianach i włączonych wpisach z `raw/inbox/`.

---

## 5. Konwencja zadań (`- [ ]` / `- [x]`)

Parser zadań skanuje pliki Markdown w `wiki/` (w tym `wiki/projekty/*/zadania/*.md`) w poszukiwaniu standardowych checkboxów GitHub / Obsidian:

- Otwarte zadanie: `- [ ] Treść zadania`
- Zamknięte zadanie: `- [x] Treść zadania` (lub `- [X]`)
- Opcjonalne metadane w linii zadania:
  - Termin: `@due(YYYY-MM-DD)` (np. `@due(2026-12-01)`)
  - Priorytet / kontekst: `#priorytet`, `#etap-1`, `#etap-2`, `#dom`, `#praca`

Przykład:
```markdown
- [ ] Zamówić baterię LiPo 3.7V pasującą do obudowy Waveshare @due(2026-11-30) #sprzet
- [x] Skonfigurować piny I2C na GPIO 47/48
```
