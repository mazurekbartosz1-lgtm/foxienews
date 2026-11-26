# Workspace Rules — Foxie Notes

## 1. Resume Context From Obsidian First
When starting a new conversation, session, or task on this repository (including short prompts like `"kontynuujmy zadanie"`, `"kontynuuj"`, `"jedziemy dalej"`, or `"co dalej"`), read these files first before scanning the rest of the codebase or asking the user to repeat context:
1. `vault/wiki/projekty/foxie-notes/status.md` — current verified state, hardware facts, pitfalls, and exact priority #1 next step.
2. The #1 active task checklist linked under `Następny krok (Next Action)` / `Pliki startowe do wczytania w nowym oknie` in `status.md` (e.g. `vault/wiki/projekty/foxie-notes/zadania/etap-2-agenci-chmurowi.md`).
3. Top entries in `vault/wiki/log.md`.

Then immediately resume directly from the first unchecked `- [ ]` item in that active checklist (proposing/confirming only open design choices explicitly marked `- [ ]` at the top of the checklist).

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

## 4. Seamless Handoff & Multi-Machine Sync
Whenever the user pauses work, switches tasks, or prepares to continue in a new context window or on another machine, you MUST follow `.agents/skills/obsidian-commit-sync/SKILL.md` (Procedure C):
- Point `Następny krok (Next Action)` and `Pliki startowe do wczytania w nowym oknie` in `vault/wiki/projekty/foxie-notes/status.md` explicitly to the #1 active `zadania/*.md` file and concrete next action.
- Update checkboxes in `vault/wiki/projekty/foxie-notes/zadania/*.md` and prepend a concise entry in `vault/wiki/log.md`.
- Run `npm run sync:vault` so `obsydianandwiki` on GitHub stays identical to `vault/wiki/`.
- Pass the Section 3 Secret Hygiene check, commit in `foxienews`, and push to `origin/main` so work resumes seamlessly from any context window or computer on `"kontynuujmy zadanie"`.
