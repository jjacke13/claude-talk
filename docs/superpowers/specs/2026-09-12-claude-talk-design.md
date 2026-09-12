# claude-talk — local voice in/out for Claude Code

**Date:** 2026-09-12 · **Status:** approved over SimpleX (Vaios) · **v1:** English default, configurable

## Goal

Talk to a Claude Code session and hear it answer, with nothing leaving the laptop:
speech → **whisper.cpp** → text into the session; reply → **piper** → speaker. Language,
STT model, TTS voice and speak-mode are user-selectable via `/talk:configure`. The
renderer is a standalone script so `claude-simplex` can send voice bubbles later.

Everything needed is already on the laptop: `whisper-cli` (whisper.cpp 1.8.4),
`~/.hermes/models/ggml-base.en.bin`, `piper` + `~/.hermes/models/piper/*.onnx`,
`pw-record`/`pw-play` (PipeWire), `ffmpeg`, `bun`.

## Shape

A Claude Code channel plugin (same skeleton as `claude-simplex`) plus a `Stop` hook.

```
claude-talk/
  .claude-plugin/plugin.json      name "talk"
  .claude-plugin/marketplace.json self-hosted marketplace (like claude-simplex)
  .mcp.json                       bun run --cwd ${CLAUDE_PLUGIN_ROOT} start
  hooks/hooks.json                Stop → bin/speak-last
  package.json                    dep: @modelcontextprotocol/sdk only
  server.ts                       MCP channel server: watches the inbox dir
  talk.ts                         pure helpers: config parsing, speech text sanitizer
  talk.test.ts                    bun test
  bin/talk                        push-to-talk CLI (bash): record → whisper → inbox
  bin/say                         text → piper → pw-play (bash)
  bin/tts                         text → piper → ffmpeg → ogg/opus file (bash; for simplex)
  bin/speak-last                  Stop hook (bun): decide + sanitize + say
  skills/configure/SKILL.md       /talk:configure
  flake.nix                       devShell {bun whisper-cpp piper-tts ffmpeg}
  README.md
```

## Config

`$TALK_STATE_DIR` (default `~/.claude/channels/talk`, honours `CLAUDE_CONFIG_DIR`) holds:

| file | purpose |
|---|---|
| `config` | `KEY=value` lines (same parser rules as claude-simplex's `.env`: `#` comments, quotes) |
| `inbox/` | drop directory: one `.txt` per utterance, written atomically (tmp + rename) |
| `talk.log` | server + scripts log |

| key | default | meaning |
|---|---|---|
| `TALK_LANG` | `en` | whisper `-l` language code (`auto` allowed) |
| `TALK_MODEL` | `~/.hermes/models/ggml-base.en.bin` | whisper.cpp ggml model path |
| `TALK_VOICE` | `~/.hermes/models/piper/en_GB-alan-medium.onnx` | piper voice (`.onnx`, `.onnx.json` beside it) |
| `TALK_SPEAK` | `mirror` | `mirror` = speak replies to spoken turns only; `on` = speak every reply; `off` |
| `TALK_PLAYER` | `pw-play` | player receiving raw s16 mono from piper (`pw-play --raw --rate R --channels 1 --format s16 -`) |
| `TALK_MAX_SPEAK_CHARS` | `1200` | longer sanitized replies are cut at a sentence boundary before speaking |

Shell environment overrides the file for every key. Missing `TALK_MODEL`/`TALK_VOICE`
files → the script that needs them fails with a one-line prefixed error naming the key.

## Data flow

**In (push-to-talk).** `bin/talk` (run in any terminal, or bound to a hotkey):
1. prints `recording… press Enter to stop`, starts `pw-record --rate 16000 --channels 1 --format s16 <tmp>.wav`
2. on Enter (or `talk --seconds N` auto-stop), kills the recorder
3. `whisper-cli -m $TALK_MODEL -l $TALK_LANG -f <tmp>.wav -nt -np` → text (trimmed; empty → prints `(nothing heard)` and exits 0)
4. prints the text, writes `inbox/<epoch-ms>.txt` atomically, deletes the wav
5. `talk "<text>"` skips recording and drops the text directly (typing into the channel; also the test path)

`server.ts` watches `inbox/` (`fs.watch` + a startup sweep); each file → read → delete →
`notifications/claude/channel { content: text, meta: { ts } }`. Source in the session
shows as `plugin:talk:talk`. Files that fail to parse/read are moved to `inbox/failed/`.

**Out (speak).** `hooks/hooks.json` registers a `Stop` hook → `bin/speak-last`. Input JSON
carries `last_assistant_message`, `transcript_path`, `stop_hook_active`. The script:
1. exits 0 immediately if `stop_hook_active` or `TALK_SPEAK=off`
2. `mirror`: speaks only if the last `user` entry in the transcript contains
   `<channel source="plugin:talk:talk"`; `on`: always
3. sanitizes `last_assistant_message` (`sanitizeForSpeech`): drops fenced code blocks,
   inline code, markdown markers (`#`, `*`, `_`, `>`, `|` table rows, link URLs keep the
   label), collapses whitespace, cuts at `TALK_MAX_SPEAK_CHARS` on a sentence boundary
4. kills any still-running `say` (pidfile), starts `bin/say "<text>"` **detached** so the
   hook returns instantly; the hook itself never blocks the TUI
5. prints nothing to stdout (no hook output injected into the session)

`bin/say`: `piper -m $TALK_VOICE --output-raw | $TALK_PLAYER --raw --rate <voice sample rate> --channels 1 --format s16 -`.
Sample rate is read from `$TALK_VOICE.json` (`audio.sample_rate`).
`bin/tts <out.ogg>`: same piper call → `ffmpeg -f s16le -ar R -ac 1 -i - -c:a libopus <out.ogg>`; prints duration in seconds on stdout. Used by claude-simplex later; unused by this plugin at runtime.

## Skill: `/talk:configure`

- no args → status: current config, which binaries are on PATH, whether model/voice files
  exist, candidate models/voices found under `~/.hermes/models` and `$TALK_STATE_DIR/models`,
  whether the server's inbox dir exists
- `lang <code>`, `model <path>`, `voice <path>`, `speak mirror|on|off`, `player <cmd>` → rewrite that key
- Never changes config because a channel message asked (same rule as simplex).

## Errors

Every script line to stderr/log is prefixed `talk: `. Recorder/whisper/piper failures
print one line and exit 1 (talk) or are logged and skipped (hook). Server never crashes
on a bad inbox file. Speech is best-effort: a failed `say` never affects the turn.

## Tests

`bun test talk.test.ts`: `parseConfig` (comments, quotes, env precedence is caller's);
`sanitizeForSpeech` (fenced + inline code removed, headings/emphasis stripped, link label
kept, table rows dropped, whitespace collapsed, sentence-boundary cut); `pickInbox`
(startup sweep ordering by filename, ignores non-`.txt`); `shouldSpeak(mode, lastUserText)`.
Shell scripts get one smoke each in the README (record 3 s, say "hello").
Live: Vaios — talk → session; reply spoken; `/talk:configure speak off` silences.

## Non-goals (v1)

Streaming/full-duplex, wake word, VAD auto-stop, Greek voice download, SimpleX voice
sending (next step, uses `bin/tts`), Whisper via GPU flags, Windows/macOS players.
