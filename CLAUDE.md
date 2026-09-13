# claude-talk

Local voice for Claude Code: `bin/talk` (pw-record → whisper-cli → inbox drop) → channel
message `<channel source="plugin:talk:talk">`; `Stop` hook `bin/speak-last` → `bin/say`
(piper → pw-play) per `TALK_SPEAK` (mirror|on|off). `bin/tts` renders ogg/opus for
claude-simplex voice bubbles (not wired yet). Built + **LIVE-VALIDATED 2026-09-12** (hold Right Alt → whisper → session → spoken reply). v0.1.9.
**Speak tool** (`mcp__plugin_talk_talk__speak`) = immediate queued speech in my own words — Vaios wants it
used for anything conversational on spoken turns; Stop hook speaks the final prose (dedup via spoken.log);
PreToolUse narration opt-in `TALK_NARRATE`; only the talk-key press interrupts. Voice: Cori high ("Claudia").

- Pure logic `talk.ts` (8 tests) · side effects `voice.ts` · server `server.ts` (inbox watcher only).
- Config `~/.claude/channels/talk/config` (`KEY=value`, env wins); `/talk:configure`.
  Defaults point at `~/.hermes/models/{ggml-base.en.bin, piper/en_GB-alan-medium.onnx}`.
- Log: `~/.claude/channels/talk/talk.log` (the detached speaker's stderr lands there).
- Launch: `claude --plugin-dir ~/Desktop/repos/claude-talk --dangerously-load-development-channels plugin:talk@inline`
  (installed: `plugin:talk@claude-talk`). Push-to-talk: `/talk:listen [s]` in-session, or `bun …/bin/talk` from another terminal.
  Mirror mode = marker file `spoken` written by bin/talk, consumed by speak-last.
- Gotchas: `input` group only takes effect in shells not spawned by the pre-existing `systemd --user`
  (GNOME terminals are) → `newgrp input` before launching claude, until the next reboot.
  **Bun `fs.watch` silently stops delivering after minutes idle → server POLLS (500 ms).**
  `pgrep -f` in checks matches the calling shell (+1). pw-record prints the wav
  path on stderr (harmless). `--seconds N` for hands-free stop; Enter otherwise.
- Hold-to-talk lives IN the server (`hold.ts`, evdev 24-byte input_event, `hold.lock` = one session owns the key);
  needs `input` group — Vaios adds it in my-nixos-config/modules/configuration.nix:294 extraGroups. Tested via FIFO fake device only.
- `TALK_SPEED` → piper `--length-scale 1/speed`.
- **Claude Code transcript lag (2.1.257):** in-turn assistant text after a thinking block is appended
  to the JSONL only at turn end (first block of a turn is immediate). So PreToolUse cannot read my
  prose → it narrates the TOOL CALL (`toolNarration`: Bash description, "reading X", …); Stop speaks
  the prose via `turnState` + `last_assistant_message` fallback. Tool results can carry text parts
  ("file changed on disk") — only messages WITHOUT tool_result reset the turn.
- Portability (2026-09-12, for Vaios's upcoming Windows box): player/recorder are argv TEMPLATES
  (`{rate}`, `{raw}`), defaults PipeWire on linux / SoX elsewhere; recorder writes RAW, we add the
  WAV header (`wrapWav`) so killing it is always safe; win32 hold = `bun:ffi` GetAsyncKeyState poll
  (`VKEYS`). **All non-Linux paths UNTESTED** — first thing to validate on the Windows machine.
- **Wake word "Claudia": parked, design in docs/superpowers/specs/2026-09-12-wake-word-design.md** (openWakeWord in the server, TALK_WAKE=on; after the peer plugin).
- Not done: Greek voice download, VAD, streaming (needs Agent SDK/hades), SimpleX wiring.
