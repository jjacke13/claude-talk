# claude-talk

Local voice for Claude Code: `bin/talk` (pw-record → whisper-cli → inbox drop) → channel
message `<channel source="plugin:talk:talk">`; `Stop` hook `bin/speak-last` → `bin/say`
(piper → pw-play) per `TALK_SPEAK` (mirror|on|off). `bin/tts` renders ogg/opus for
claude-simplex voice bubbles (not wired yet). Built + **LIVE-VALIDATED 2026-09-12** (hold Right Alt → whisper → session → spoken reply). v0.1.13.
**Speak tool** (`mcp__plugin_talk_talk__speak`) = immediate queued speech in my own words — Vaios wants it
used for anything conversational on spoken turns; Stop hook speaks the final prose ONLY on turns where speak was not used (v0.1.10);
PreToolUse narration opt-in `TALK_NARRATE`; `TALK_REPLY=voice` → channel meta `reply="voice"` → speak-only answers, marker line in terminal (0.1.11); only the talk-key press interrupts. Voice: Cori high ("Claudia").

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
- **Wake word "hey claudia": in progress on `feat/wake-word`, design in docs/superpowers/specs/2026-09-12-wake-word-design.md** (openWakeWord in the server, TALK_WAKE=on).
  Step 1 done 2026-09-13: runtime = nix devShell python (`onnxruntime numpy scipy tqdm requests sounddevice`) + venv
  `~/.claude/channels/talk/wake/venv` with ONLY `pip install --no-deps openwakeword` (0.6.0; nixpkgs lacks it — has
  `pyopen-wakeword` 1.1.0, Rhasspy's alternative lib, not evaluated). Venv python sees nix packages only via the
  devShell's `PYTHONPATH` → run inside `nix develop --builders ''`. `bin/wake-check.py` = proof; piper "hey jarvis"
  through speaker → 0.998. Models cached in the venv's `openwakeword/resources/models/`.
  **Steps 2+3 done 2026-09-13** (worker session, on laptop's instruction): `bin/wake-listen` (py detector, `ready` then
  `<model> <score>` lines, 2 s refractory, PR_SET_PDEATHSIG so it dies with the server) ← `bin/wake-detector` (bash:
  `exec nix develop <root> --builders '' -c <venv python> …`, exec chain holds so the child pid IS python) ← `wake.ts`
  (state machine idle→listening→followup, `wake.lock`, beep = 120 ms 880 Hz sine via TALK_PLAYER, end-of-utterance =
  RMS via pure `listenStep/listenDone` in talk.ts; follow-up window opens on say.pid alive→gone after a wake turn).
  Wired in server.ts after startHold. Config keys TALK_WAKE(off) _WORD("hey claudia") _MODEL(hey_jarvis) _THRESHOLD _FOLLOWUP_S
  _SILENCE_MS _RMS(0.01 — added beyond the agreed six: mic calibration knob). Validated with piper through the speaker
  (throwaway script, NOT the live server): wake → beep → question → transcript → reply → follow-up without wake word →
  silence closes. Gotchas found: beep/wake-word tail at recording start → `MIN_SPEECH_MS` 300 cumulative + `GRACE_MS` 500
  before speech counts; cori-high piper has ~2 s synth latency before audio (matters for scripted tests); laptop mic floor
  ≈ 0.002 RMS, speaker-fed speech 0.01–0.07; each capture logs its `rms‰` trace to talk.log for tuning.
  Barge-in (wake word while Claudia speaks) NOT validated — two synthetic voices on one speaker masked it; step 4 (live).
  **Step 4 live-validated by Vaios 2026-09-13** (real voice: detect 0.82–0.94, follow-up, barge-in — it even fired on Claudia
  saying "hey jarvis" herself → she must never say the wake word aloud). **Steps 5+6 done 2026-09-13**: `bin/wake-train`
  (no torch: piper API renders in-process with a 1-thread ORT shim, numpy/scipy augmentation, openwakeword's own
  `AudioFeatures.embed_clips`, sklearn MLP (96,32) → hand-built ONNX Reshape/Gemm/Relu/Sigmoid `[1,16,96]→[1,1]`; flake python
  gained `scikit-learn onnx`). Voices: 4 local + 4 multi-speaker from HF rhasspy/piper-voices in `~/.claude/channels/talk/wake/voices/`
  (libritts_r 904 spk, vctk 109, l2arctic 24, arctic 18; ~74 MB each) → 40 speakers/voice, 32k examples, ~20 min CPU
  (features step dominates; renders cached per voice-chunk in `wake/train/*.npz`). `models/hey_claudia.onnx` 589 KB, git-tracked;
  DEFAULT TALK_WAKE_MODEL=hey_claudia → wake.ts `modelArg` maps bare name → models/<name>.onnx, hey_jarvis fallback.
  **Training gotchas paid for:** (1) the official openwakeword trainer needs torch+speechbrain+piper-sample-generator+multi-GB
  negative features — rejected; (2) v1 scored ~1.0 on ANY live speech although held-out FP was 1.8%: batch features vs streaming
  mismatch — I had only placed speech flush at the window end and zero-padded (openwakeword's docstring warns streaming melspec
  diverges on zero padding). Fix = noise bed under every example (never digital silence), positives also as "early" (≥0.7 s
  before end) and "prefix-cut" negatives, near-misses at random positions. v2 live via speaker: silence 0.016, "hey claudia"
  0.998, "hey jarvis" 0.105, "hey claude" 0.036, bare "Claudia" 0.009. (3) cori-high has ~2 s synth latency: a 4.5 s
  wake-check window clips the phrase → flaky 0.00x; use ≥7 s windows in scripted tests. Detector footprint 192 MB RSS, ~10 % core.
  Background Bash tasks in this harness got killed mid-training twice → long jobs run `setsid nohup … &` + Monitor on a log.
- Not done: Vaios's real voice against hey_claudia.onnx (only synthetic voices so far — if it misses, lower TALK_WAKE_THRESHOLD or
  add voices to wake/voices and retrain), Greek voice download, VAD, streaming (needs Agent SDK/hades), SimpleX wiring, Windows wake.

## Wake word — live findings (2026-09-13, main session)
- QUEUED FIX: follow-up window opens only after a wake-word turn (`armed` set in wake.ts `turn()`).
  It must open after ANY spoken turn — hold-to-talk too. Plan: hoist `armed` to module scope,
  `export function armFollowUp()`, and in server.ts wrap the hold callback: `startHold(cfg, t => { armFollowUp(); notify(t) })`.
- From across the room the detector hears the wake word but the sentence RMS sits at ~5‰ (< TALK_WAKE_RMS 10‰) → "nothing heard". Either lower TALK_WAKE_RMS to ~0.006 or speak up after the beep; floor is ~2‰.
- Claudia must never SAY the wake word: her own voice through the speaker triggers barge-in (0.94).
