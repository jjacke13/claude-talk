# claude-talk

Local voice for Claude Code. Speak → **whisper.cpp** → your words land in the session
as a normal turn. Claude answers → **piper** → your speakers. Nothing leaves the machine.

## Prerequisites (all on PATH)

`bun`, `whisper-cli` (whisper.cpp), `piper`, `pw-record`/`pw-play` (PipeWire), `ffmpeg`
(only for `bin/tts`). A whisper ggml model and a piper voice (`.onnx` + `.onnx.json`);
defaults point at `~/.hermes/models/…`. `nix develop` in this repo provides the binaries.

## Install

This repo is its own marketplace:

```
claude plugin marketplace add jjacke13/claude-talk     # or a local path
/plugin install talk@claude-talk
```

Launch with the channel enabled (third-party channel plugins need the dev flag):

```sh
claude --dangerously-load-development-channels plugin:talk@claude-talk
# from a checkout instead:
claude --plugin-dir ~/Desktop/repos/claude-talk --dangerously-load-development-channels plugin:talk@inline
```

## Use

**Inside the session (no second terminal):** `/talk:listen` records 10 s (`/talk:listen 20`
for longer), transcribes, and answers — spoken back in `mirror` mode.

**From a second terminal or a hotkey:**

```sh
bun ~/Desktop/repos/claude-talk/bin/talk            # record until Enter, transcribe, send
bun ~/Desktop/repos/claude-talk/bin/talk --seconds 5
bun ~/Desktop/repos/claude-talk/bin/talk "typed text"   # skip the mic
```

The text appears in the session as `<channel source="plugin:talk:talk" ts="…">` and Claude answers
as usual. The reply is spoken according to `TALK_SPEAK`:

- `mirror` (default) — spoken only when the turn came from `talk`
- `on` — every reply · `off` — never

Code blocks, inline code and tables are never read aloud; long replies are cut at a
sentence boundary (`TALK_MAX_SPEAK_CHARS`, default 1200). A new reply interrupts one
still being spoken.

## Configure

`/talk:configure` — status; `lang el`, `model <ggml>`, `voice <onnx>`, `speak on|off|mirror`,
`player <cmd>`, `max <chars>`; `voices` lists where to download more. Config lives in
`~/.claude/channels/talk/config` (`KEY=value`; shell env overrides). Non-English needs a
multilingual whisper model (`ggml-base.bin`, not `*.en.bin`) and a matching piper voice.

## Scripts

| script | does |
|---|---|
| `bin/talk` | push-to-talk → inbox (`--print` = transcript only + marker, used by `/talk:listen`) |
| `bin/say "text"` | speak now |
| `bin/tts out.ogg "text"` | render ogg/opus + print duration — for SimpleX/Telegram voice bubbles |
| `bin/speak-last` | the Stop hook (reads hook JSON on stdin) |

## How it works

`bin/talk` writes `~/.claude/channels/talk/inbox/<epoch-ms>.txt` atomically; the MCP
server (`server.ts`) watches that directory and pushes each file as a channel
notification. `hooks/hooks.json` registers `bin/speak-last` on `Stop`; it detaches
`bin/say` so the hook returns instantly. The server polls the inbox every 500 ms
(Bun's `fs.watch` dropped events after a few idle minutes). `mirror` mode keys off a
marker file `bin/talk` writes (`~/.claude/channels/talk/spoken`), consumed per reply.

## Test

```sh
bun test                 # pure helpers
bun bin/say "hello"      # speakers
bun bin/talk --seconds 3 # mic → whisper (silence prints "(nothing heard)")
```
