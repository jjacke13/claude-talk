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
| `bin/wake-check.py [s] [model]` | listens `s` seconds, prints the max score of `model` (default `hey_jarvis`; e.g. `models/hey_claudia.onnx`) |
| `bin/wake-listen` | the detector process (Python): mic → openwakeword → one `<model> <score>` line per detection |
| `bin/wake-detector` | runs `wake-listen` inside the nix dev shell + venv; what `wake.ts` spawns |
| `ui.ts` + `ui.html` | companion page server (TALK_UI=on): SSE events, orb page |
| `bin/wake-train` | trains `models/hey_claudia.onnx` from piper voices (CPU, ~20 min); see "Wake word" |

## Wake word — "hey claudia"

Say **"hey claudia"** instead of holding the key. Linux only for now (Windows/macOS: unsupported —
the detector wrapper is nix + PipeWire; nothing stops a port, it just has not been done).

**Setup (one-time).** nixpkgs has no `openwakeword`, so the split is: every binary from nixpkgs
(the dev shell's `python3` carries `onnxruntime numpy scipy sounddevice …`), and only the
pure-Python `openwakeword` pip-installed with `--no-deps` into a venv under the talk state dir:

```
nix develop --builders ''            # --builders '' on this laptop: remote builders hang
python3 -m venv --system-site-packages ~/.claude/channels/talk/wake/venv
~/.claude/channels/talk/wake/venv/bin/pip install --no-deps openwakeword
~/.claude/channels/talk/wake/venv/bin/python bin/wake-check.py 5 models/hey_claudia.onnx   # say it → score
```

The venv sees the nix packages only through the `PYTHONPATH` the dev shell exports, which is why
`bin/wake-detector` wraps the detector in `nix develop`. Mic path: PortAudio → ALSA `default` → PipeWire.

**Enable.** `/talk:configure wake on` (or `TALK_WAKE=on` in the config) — applies at the next launch.
The server then keeps `bin/wake-listen` on the mic. On the wake word: current speech stops, a short
beep, then it records until you pause (`TALK_WAKE_SILENCE_MS`, 1200 ms) or 20 s, transcribes, and the
text lands in the session exactly like the hold key. **Follow-up window:** after Claudia finishes
speaking, for `TALK_WAKE_FOLLOWUP_S` (6) seconds the next thing you say needs no wake word; silence
closes it, and saying the wake word while she talks cuts her off. One server per machine owns the
mic (`wake.lock`), same as the key.

**Gotchas.**
- **Claudia must never say the wake word aloud** — the detector hears the speaker, and it will
  trigger on her own voice (live-validated: it did). The session instructions tell her; do not ask
  her to "say hey claudia". Worse: the model was trained on her own piper voice and fires on
  ordinary sentences she speaks (0.99 live). So detections while she speaks are IGNORED by default;
  `TALK_WAKE_BARGEIN=on` re-enables voice barge-in (the talk key always interrupts).
- Each capture logs a `rms‰` level trace to `talk.log`; if utterances end too early or never start,
  tune `TALK_WAKE_RMS` (0.01 = speech; this laptop's mic floor is ~0.002) from that trace.
- Footprint of the detector process: ~190 MB RSS, ~10 % of one core (measured after 60 s).

**Keys.** `TALK_WAKE` (off), `TALK_WAKE_WORD` (`hey claudia` — what you say), `TALK_WAKE_MODEL`
(`hey_claudia` = the repo's `models/hey_claudia.onnx`; `hey_jarvis` = openwakeword's prebuilt fallback,
say "hey jarvis"; or any `.onnx` path), `TALK_WAKE_THRESHOLD` (0.5), `TALK_WAKE_FOLLOWUP_S` (6),
`TALK_WAKE_SILENCE_MS` (1200), `TALK_WAKE_RMS` (0.01).

**The model.** `models/hey_claudia.onnx` (589 KB) is trained by `bin/wake-train`, CPU only, in
about 20 minutes: piper renders the phrase (spellings "Claudia"/"Cloudia" cover the English and
the Greek pronunciation) and negatives with every piper voice it finds (yours in
`<state-dir>/models`, `~/.hermes/models/piper`, plus multi-speaker voices dropped into
`<state-dir>/wake/voices` — `en_US-libritts_r`, `en_GB-vctk`, `en_US-l2arctic`, `en_US-arctic`
from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices), ~75 MB each), augments
(speed/pitch, noise, reverb, the room's own noise recorded from the mic), embeds with openwakeword's
own feature extractor and fits a small MLP written as ONNX. Validation with piper through the speaker:
silence 0.016, "hey claudia" 0.998, "hey jarvis" 0.105, "hey claude" 0.036 (threshold 0.5). Trained on
synthetic voices only — if your voice scores low, lower `TALK_WAKE_THRESHOLD` or retrain with more voices.

## Companion UI (optional)

`/talk:configure ui on` (`TALK_UI=on`), relaunch the session, open **http://127.0.0.1:7590** in a browser
next to the terminal (`TALK_UI_PORT` to move it; loopback only, no external assets, no dependencies).
One big orb mirrors the conversation — breathing when idle, ripples while listening (key held or
wake word heard), shimmering arcs while Claude thinks, pulsing while she speaks — with the latest
line you said (dim) and her latest spoken line (bright) underneath; `t` or the corner button flips
to the plain transcript (last 50 lines). Corners: clock, state, and the context percentage when a
`context-*` file exists in the state dir (written by an external Stop hook). `/events` is a
Server-Sent-Events stream, `/state` a JSON snapshot; the page reconnects by itself and shows
"offline" while the server is gone. "Speaking" is read from `say.pid` (no audio analysis); only
what goes through the speak tool is shown as her line — replies spoken by the Stop hook are not.

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
