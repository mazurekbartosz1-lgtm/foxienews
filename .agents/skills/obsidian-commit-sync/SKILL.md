---
name: obsidian-commit-sync
description: Synchronizes the project Obsidian vault (`vault/wiki/`) before every `git commit` so project state, decisions, task checklists, and next steps stay current, and enables resuming work cleanly in a fresh context window from any location. Use whenever preparing a commit, saving a milestone, or starting a new session in this repository.
---

# Obsidian Commit Sync & Handoff

Keeps the project's Obsidian knowledge base (`vault/wiki/`) synchronized with the repository on every commit so any new conversation or device can immediately resume work without re-exploring the codebase.

## Procedure A: Pre-Commit Obsidian Sync

Run these steps **before** running `git commit`:

1. **Inspect pending repository changes**
   - Run `git status --short` and `git diff --stat` to see all modified, added, or untracked files.
2. **Security Gate (MANDATORY — never skip)**
   - Verify that local secret files are ignored and NOT staged (`git check-ignore -v firmware/include/config.h`).
   - Ensure `firmware/include/config.h`, `.env`, `.env.local`, `.secret.local`, Wi-Fi SSIDs/passwords, API keys, and tokens are **never** staged in git and **never** written into `vault/`, `AGENTS.md`, skills, or commit messages.
   - If any secret file appears in `git status`, stop and unstage/ignore it before continuing.
3. **Update Obsidian handoff & documentation in `vault/wiki/`**
   - Update `vault/wiki/projekty/foxie-notes/status.md` (or the active project's `status.md`):
     - Refresh `updated_at` in YAML frontmatter (ISO-8601 UTC).
     - Update **Co aktualnie działa** (what builds, runs, passes tests, or is flashed on hardware).
     - Update **Kluczowe decyzje i pułapki** (pins, architectural choices, tool/platform gotchas).
     - Update **Następny krok (Next Action)** with concrete next tasks.
     - Update **Pliki startowe do wczytania** so a new session knows which 2-4 files to read first.
   - Update checklist items (`[ ]` -> `[x]`) in the relevant `vault/wiki/projekty/<projekt>/zadania/*.md` files for completed tasks.
   - Prepend or append a concise timestamped entry under today's date in `vault/wiki/log.md` summarizing the changes in this commit.
   - If any new wiki page was created, link it in `vault/wiki/projekty/<projekt>/index.md` and `vault/wiki/index.md`.
4. **Stage, re-verify, commit, and sync private Obsidian repo**
   - Run `git add .` and inspect `git status --short` to confirm `vault/` updates are staged and zero secrets/build artifacts (`node_modules/`, `.pio/`, `config.h`, `.env`) are included.
   - Commit with a descriptive Conventional Commits message (`git commit -m "..."`).
   - Run `npm run sync:vault` (`scripts/sync-obsidian-vault.mjs`, with `BypassSandbox: true` if network is sandboxed) so `vault/SCHEMA.md` and `vault/wiki/**` are synced in one atomic commit to the private Obsidian repository configured in `functions/.env` (preserves `raw/inbox/` and never prints tokens).
   - Push the code repository only when requested (`git push origin main`).

## Procedure B: Resume in a New Context Window

When starting work in a fresh context window or after switching machines:

1. Read `vault/wiki/projekty/foxie-notes/status.md` completely first.
2. Read the active task file linked under **Następny krok** (typically `vault/wiki/projekty/foxie-notes/zadania/etap-1-urzadzenie.md` or `etap-2-wiki-webapp.md`).
3. Skim the top section of `vault/wiki/log.md` for recent commits and architectural decisions.
4. Confirm git state with `git status --short` and `git log --oneline -n 5`, then begin the next task directly without re-scanning unrelated files.
