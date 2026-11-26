# Workspace Rules — Foxie Notes

## 1. Resume Context From Obsidian First
When starting a new conversation, session, or task on this repository, read these files first before scanning the rest of the codebase:
1. `vault/wiki/projekty/foxie-notes/status.md` — current verified state, hardware facts, pitfalls, and exact next step.
2. The active task checklist linked in `status.md` (e.g. `vault/wiki/projekty/foxie-notes/zadania/etap-1-urzadzenie.md`).
3. Top entries in `vault/wiki/log.md`.

## 2. Mandatory Obsidian Sync Before Every Commit
Before running any `git commit`, you MUST follow `.agents/skills/obsidian-commit-sync/SKILL.md` (Procedure A):
- Update `vault/wiki/projekty/foxie-notes/status.md` (`updated_at`, working status, decisions/pitfalls, next step).
- Update completed checkboxes in `vault/wiki/projekty/foxie-notes/zadania/*.md`.
- Add a concise entry to `vault/wiki/log.md`.
- After updating `vault/wiki/`, run `npm run sync:vault` (`scripts/sync-obsidian-vault.mjs`) to sync `vault/SCHEMA.md` and `vault/wiki/**` to the private Obsidian repository configured in `functions/.env` (without modifying `raw/inbox/`).
- Stage all updated `vault/` notes together in the same commit as the code changes.

## 3. Secret Hygiene (Strict)
- NEVER commit, stage, or copy into `vault/` any local credentials or ignored config files (`firmware/include/config.h`, `functions/.env`, `functions/.secret.local`, Wi-Fi SSIDs/passwords, Gemini/GitHub tokens).
- Always run `git check-ignore -v firmware/include/config.h` and inspect `git status --short` prior to committing.
