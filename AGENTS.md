# Workspace Rules — Foxie Notes

## 1. Resume Context From Obsidian First
When starting a new conversation, session, or task on this repository (including prompts like `"kontynuujmy zadanie"`, `"kontynuuj"`, `"jedziemy dalej"`, `"co dalej"`, `"gdzie jesteśmy"`, `"co możemy teraz zrobić"`, `"przegląd"`, `"podsumowanie"`, or `"backlog"`), read these files AND run the live vault overview first before scanning the rest of the codebase or asking the user to repeat context:
1. `vault/wiki/projekty/foxie-notes/status.md` — current verified state, hardware facts, pitfalls, and exact priority #1 next step.
2. The #1 active task checklist linked under `Następny krok (Next Action)` / `Pliki startowe do wczytania w nowym oknie` in `status.md` (e.g. `vault/wiki/projekty/foxie-notes/zadania/etap-3-ux-i-stabilnosc.md`).
3. Top entries in `vault/wiki/log.md`.
4. Run `npm run vault:overview` (`BypassSandbox: true` if network is sandboxed) to inspect the live remote `obsydianandwiki` repository (`raw/inbox/`, `wiki/projekty/`, `wiki/pomysly/`, `wiki/obszary/`, `wiki/zasoby/`, plus `wiki/index.md` integrity).

Then immediately resume directly from the first unchecked `- [ ]` item in that active checklist (proposing/confirming only open design choices explicitly marked `- [ ]` at the top of the checklist) or present the structured overview from Section 5 when the user asked for status/planning.

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

## 5. Structured Status & Backlog Triage Response
Whenever the user asks for current status, backlog review, next steps, or starts a new session overview (`"gdzie jesteśmy"`, `"co możemy teraz zrobić"`, `"przegląd"`, `"podsumowanie"`, `"co dalej"`), ALWAYS include both local `vault/` and live `npm run vault:overview` output (`raw/inbox/`, `wiki/projekty/`, `wiki/pomysly/`, `wiki/obszary/`) and structure the answer in 3 clear parts:
1. **Gdzie jesteśmy** — verified state of the codebase + full picture of the live vault (`raw/inbox/`, `projekty/`, `pomysly/`).
2. **Quick Wins (szybkie zmiany na start)** — small, low-risk tasks to clear the backlog first.
3. **Ocena i rekomendowany ciąg pracy** — effort vs value prioritization table and concrete recommendation for what to do next.
