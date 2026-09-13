# claude-talk

> AI agent setting this up? Read [AGENTS.md](AGENTS.md) — step-by-step, verifiable.

Local voice for Claude Code. Speak → **whisper.cpp** → your words land in the session
as a normal turn. Claude answers → **piper** → your speakers. Nothing leaves the machine.

## Prerequisites (all on PATH)

`bun`, `whisper-cli` (whisper.cpp), `piper`, and an audio pair: `pw-record`/`pw-play` (PipeWire,
Linux default) or SoX `rec`/`play` (default on Windows/macOS — **untested**, see AGENTS.md).
`ffmpeg` only for `bin/tts`. A whisper ggml model and a piper voice (`.onnx` + `.onnx.json`);
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

**Hold-to-talk from any window (recommended):** hold **Right Alt** while speaking, release
to send — the plugin's server listens to the keyboard as soon as the session starts, nothing
else to run. Needs your user in the `input` group (NixOS: `users.users.<you>.extraGroups =
[ "input" ];`, rebuild, re-login); without it the server logs one line and only the other
input paths work. `/talk:configure key KEY_F12` picks another key (`KEY_RIGHTCTRL`, `KEY_PAUSE`,
… or a numeric evdev code); taps under 300 ms are ignored. One session owns the key at a time.

**From a second terminal:**

```sh
bun ~/Desktop/repos/claude-talk/bin/talk            # record until Enter, transcribe, send
bun ~/Desktop/repos/claude-talk/bin/talk --seconds 5
bun ~/Desktop/repos/claude-talk/bin/talk "typed text"   # skip the mic
```

The text appears in the session as `<channel source="plugin:talk:talk" ts="…">` and Claude answers
as usual. The reply is spoken according to `TALK_SPEAK`:

- `mirror` (default) — spoken only when the turn came from `talk`
- `on` — every reply · `off` — never

Code blocks and tables are never read aloud (short inline code is spoken as words); long
replies are cut at a sentence boundary (`TALK_MAX_SPEAK_CHARS`, default 1200). Mid-turn
progress comes from the `speak` tool Claude calls in its own words; `TALK_NARRATE=on` adds a
one-line description of each tool call. Speech queues in order; pressing the talk key stops it.

`TALK_REPLY=voice` (`/talk:configure reply voice`) turns it into a pure conversation: Claude answers
only through the `speak` tool and leaves just a marker line in the terminal; `both` (default)
keeps the written reply for details worth reading.

## Configure

`/talk:configure` — status; `lang el`, `model <ggml>`, `voice <onnx>`, `speak on|off|mirror`,
`player <cmd>`, `max <chars>`, `key <KEY_NAME>`, `speed <0.5-3>`; `voices` lists where to download more. Config lives in
`~/.claude/channels/talk/config` (`KEY=value`; shell env overrides). Non-English needs a
multilingual whisper model (`ggml-base.bin`, not `*.en.bin`) and a matching piper voice.

## Scripts

| script | does |
|---|---|
| `bin/talk` | push-to-talk → inbox (`--print` = transcript only + marker, used by `/talk:listen`) |
| `bin/say "text"` | speak now |
| `bin/tts out.ogg "text"` | render ogg/opus + print duration — for SimpleX/Telegram voice bubbles |
| `bin/speak-last` | the Stop hook (reads hook JSON on stdin) |
| `bin/wake-check.py [s]` | wake-word runtime proof: listens `s` seconds, prints max `hey_jarvis` score |
| `bin/wake-listen` | the detector process (Python): mic → openwakeword → one `<model> <score>` line per detection |
| `bin/wake-detector` | runs `wake-listen` inside the nix dev shell + venv; what `wake.ts` spawns |

## Wake word — "hey claudia" (in progress: works with the stand-in model, not yet validated live)

`TALK_WAKE=on` and the server (`wake.ts`) keeps a detector on the mic. Say **"hey claudia"** →
current speech stops, a short beep, then it records until you pause (`TALK_WAKE_SILENCE_MS`,
1200) or 20 s, transcribes, and the text lands in the session like the hold key. After Claudia
answers aloud, a **follow-up window** (`TALK_WAKE_FOLLOWUP_S`, 6) takes the next thing you say
without the wake word; silence closes it. Until `models/hey_claudia.onnx` is trained, the prebuilt
`hey_jarvis` model is the stand-in: say "hey jarvis". Keys: `TALK_WAKE_WORD` (what you say),
`TALK_WAKE_MODEL` (prebuilt name or `.onnx` path), `TALK_WAKE_THRESHOLD` (0.5),
`TALK_WAKE_RMS` (0.01 — mic level that counts as speech; `talk.log` prints each capture's level
trace to tune it). Linux only for now; one server per machine owns it (`wake.lock`).

nixpkgs has no `openwakeword`, so the split is: every binary from nixpkgs (the dev shell's
`python3` carries `onnxruntime numpy scipy tqdm requests sounddevice`), and only the pure-Python
`openwakeword` pip-installed with `--no-deps` into a venv under the talk state dir. One-time setup:

```
nix develop --builders ''            # --builders '' on this laptop: remote builders hang
python3 -m venv --system-site-packages ~/.claude/channels/talk/wake/venv
~/.claude/channels/talk/wake/venv/bin/pip install --no-deps openwakeword
~/.claude/channels/talk/wake/venv/bin/python bin/wake-check.py 5   # downloads the models once
```

The venv only sees the nix packages through the `PYTHONPATH` the dev shell exports, so run it
from inside `nix develop` (same contract as the other binaries). Mic goes through PortAudio →
ALSA `default` → PipeWire. Proof: `bin/say "hey jarvis"` while `wake-check.py` listens → 0.998.

## How it works

`bin/talk` writes `~/.claude/channels/talk/inbox/<epoch-ms>.txt` atomically; the MCP
server (`server.ts`) watches that directory and pushes each file as a channel
notification. `hooks/hooks.json` registers `bin/speak-last` on `PreToolUse` and `Stop`: each run speaks
the turn's text blocks not yet spoken (progress in `speak-progress`), so prose written before a
tool call is heard while the tool runs; blocks queue in order (`say --after PID`), a new turn
interrupts. The hook detaches `bin/say` so it returns instantly. The server polls the inbox every 500 ms
(Bun's `fs.watch` dropped events after a few idle minutes). `mirror` mode keys off a
marker file `bin/talk` writes (`~/.claude/channels/talk/spoken`), consumed per reply.

## Test

```sh
bun test                 # pure helpers
bun bin/say "hello"      # speakers
bun bin/talk --seconds 3 # mic → whisper (silence prints "(nothing heard)")
```
