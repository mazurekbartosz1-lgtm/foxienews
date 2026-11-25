# SCHEMA — Konwencja Vaulta Obsidian & LLM Wiki

Skopiuj ten plik jako `SCHEMA.md` do katalogu głównego swojego prywatnego repozytorium Obsidian na GitHubie. Określa on jednolity format plików dla backendu (`/api/capture`), agenta LLM Wiki oraz parsera webhooka GitHub -> Firestore.

---

## 1. Struktura katalogów vaulta

```text
vault/
├── SCHEMA.md                          # Ten dokument z zasadami
├── raw/
│   └── inbox/                         # Surowe notatki z urządzeń e-ink i web appa (APPEND-ONLY)
│       └── 2026-11-25T07-45-12Z-waveshare-154-pomysl.md
└── wiki/
    ├── index.md                       # Główny spis treści utrzymywany przez LLM Wiki
    ├── log.md                         # Chronologiczny dziennik zmian wykonanych przez LLM Wiki
    ├── <slug>.md                      # Ogólne strony wiedzy (np. zakupy.md)
    └── projekty/
        └── <projekt>/                 # Dedykowany folder projektu
            ├── index.md               # Główna strona projektu
            └── zadania/               # Podfolder z listami zadań do zrobienia
                └── <zakres>.md        # Checklista zadań (- [ ] / - [x])
```

### Zasada niezmienności `raw/inbox/`
- Endpoint `POST /api/capture` tworzy **wyłącznie nowe pliki** w `raw/inbox/`.
- LLM Wiki traktuje `raw/inbox/` jako **tylko do odczytu** (nie edytuje ani nie usuwa surowych wpisów; przetworzoną wiedzę syntetyzuje w `wiki/` i odnotowuje w `wiki/log.md`).

### Dedykowane foldery projektów (`wiki/projekty/<projekt>/`)
- Projekty mogą posiadać własny katalog w `wiki/projekty/<projekt>/` z podfolderem `zadania/` na listy zadań (`- [ ]` / `- [x]`), z których korzysta zarówno Obsidian, jak i parser kolekcji `tasks` w Firestore.

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

Każda strona w `wiki/<slug>.md` używa YAML frontmatteru oraz zwięzłego języka nadającego się zarówno do Obsidiana, jak i do skrótu `plainText` na ekranach e-ink:

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
- Linkuj wyłącznie po nazwie pliku bez rozszerzenia: `[[nazwa-tematu]]` lub z aliasem `[[nazwa-tematu|czytelna nazwa]]`.
- Aplikacja webowa zamienia `[[slug]]` na klikalną nawigację do `/wiki/slug`.

---

## 4. Spis treści (`wiki/index.md`) i dziennik (`wiki/log.md`)

- `wiki/index.md` zawiera listę wszystkich aktywnych stron w formacie:
  ```markdown
  - [[nazwa-tematu]] — Krótki opis tematu (tagi: #projekt, #sprzet)
  ```
- Na podstawie `wiki/index.md` oraz plików w `wiki/` webhook GitHub aktualizuje dokument `wiki_meta/index` oraz kolekcję `wiki_pages` w Firestore.
- `wiki/log.md` zawiera wpisy w porządku odwrotnie chronologicznym z informacją, które pliki z `raw/inbox/` zostały włączone do jakich stron `wiki/`.

---

## 5. Konwencja zadań (`- [ ]` / `- [x]`)

Parser zadań skanuje pliki Markdown w `wiki/` (oraz opcjonalnie nieprzetworzone `raw/inbox/`) w poszukiwaniu standardowych checkboxów GitHub / Obsidian:

- Otwarte zadanie: `- [ ] Treść zadania`
- Zamknięte zadanie: `- [x] Treść zadania` (lub `- [X]`)
- Opcjonalne metadane w linii zadania:
  - Termin: `@due(YYYY-MM-DD)` (np. `@due(2026-12-01)`)
  - Priorytet / kontekst: `#priorytet`, `#dom`, `#praca`

Przykład:
```markdown
- [ ] Zamówić baterię LiPo 3.7V pasującą do obudowy Waveshare @due(2026-11-30) #sprzet
- [x] Skonfigurować piny I2C na GPIO 47/48
```
