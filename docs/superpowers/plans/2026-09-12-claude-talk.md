# claude-talk Implementation Plan (compact)

**Spec:** docs/superpowers/specs/2026-09-12-claude-talk-design.md · executed inline (Vaios: "burn less tokens"), one final review.

1. Scaffold: plugin.json, marketplace.json, .mcp.json, package.json, .gitignore, hooks/hooks.json.
2. `talk.ts` pure: `parseConfig`, `DEFAULTS`, `resolveConfig(env, text)`, `sanitizeForSpeech`, `shouldSpeak`, `sortInbox` + `talk.test.ts`.
3. `server.ts`: state dir, inbox watcher (sweep + fs.watch), channel notifications, failed/ quarantine, shutdown.
4. `bin/say`, `bin/tts`, `bin/talk` (bash), `bin/speak-last` (bun) + hook wiring; manual smoke of each.
5. `skills/configure/SKILL.md`, `flake.nix`, README; `claude plugin validate .`.
