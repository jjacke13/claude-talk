# claude-talk

Local voice for Claude Code: `bin/talk` (pw-record → whisper-cli → inbox drop) → channel
message `<channel source="plugin:talk:talk">`; `Stop` hook `bin/speak-last` → `bin/say`
(piper → pw-play) per `TALK_SPEAK` (mirror|on|off). `bin/tts` renders ogg/opus for
claude-simplex voice bubbles (not wired yet). Built 2026-09-12; **live test pending**.

- Pure logic `talk.ts` (8 tests) · side effects `voice.ts` · server `server.ts` (inbox watcher only).
- Config `~/.claude/channels/talk/config` (`KEY=value`, env wins); `/talk:configure`.
  Defaults point at `~/.hermes/models/{ggml-base.en.bin, piper/en_GB-alan-medium.onnx}`.
- Log: `~/.claude/channels/talk/talk.log` (the detached speaker's stderr lands there).
- Launch: `claude --plugin-dir ~/Desktop/repos/claude-talk --dangerously-load-development-channels plugin:talk@inline`
  (installed: `plugin:talk@claude-talk`). Push-to-talk: `/talk:listen [s]` in-session, or `bun …/bin/talk` from another terminal.
  Mirror mode = marker file `spoken` written by bin/talk, consumed by speak-last.
- Gotchas: **Bun `fs.watch` silently stops delivering after minutes idle → server POLLS (500 ms).**
  `pgrep -f` in checks matches the calling shell (+1). pw-record prints the wav
  path on stderr (harmless). `--seconds N` for hands-free stop; Enter otherwise.
- Hold-to-talk: `bin/talk-hold` reads /dev/input evdev (24-byte input_event), needs `input` group;
  Vaios must add it in my-nixos-config/modules/configuration.nix:294 extraGroups. Tested via FIFO fake device only.
- Not done: Greek voice download, VAD, streaming (needs Agent SDK/hades), SimpleX wiring.
