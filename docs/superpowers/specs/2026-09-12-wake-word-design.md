# Wake word ("Claudia") — design note, NOT BUILT (parked 2026-09-12)

**Goal:** say "Claudia, …" instead of holding Right Alt. Fully local. Opt-in.

## Shape (inside claude-talk, not a separate plugin)

- `TALK_WAKE=on|off` (default off), `TALK_WAKE_WORD=hey claudia`, `TALK_WAKE_MODEL=<path>.onnx`.
- `wake.ts` (server-side, like `hold.ts`): when on, spawn a detector process reading the mic
  continuously; on detection → play a short "listening" tone (piper says nothing; a 50 ms beep
  from `bin/say` is enough), record until silence, transcribe, `markSpoken()`, `notify(text)`.
  Interrupts current speech like the key does. Lock-file semantics identical to `hold.lock`.
- Detector: **openWakeWord** (Python, ONNX, CPU-light). `bin/wake-listen` = tiny Python script
  printing one line per detection; `wake.ts` reads its stdout. Dependency = python3 +
  openwakeword (nix: python3Packages.openwakeword if present, else pip in a venv under
  `$TALK_STATE_DIR/wake/`).
- Custom word model: openWakeWord trains from synthetic audio. Generate "Claudia" samples with
  piper across all voices in `models/` + speed variations, plus negatives; train script
  `bin/wake-train` (Python), output `models/claudia.onnx`. Ship the trained model in the repo
  so users skip training.
- End-of-utterance: whisper.cpp's `--vad` (silero VAD model `ggml-silero-v5.1.2.bin`) or a
  simple RMS-silence timeout (1.2 s) — start with RMS, it's 10 lines.

## Costs / risks

Mic always open; false triggers (TV, other people); one Python process (~100 MB RSS);
training quality unknown for a two-syllable name — fall back to a prebuilt word
("hey jarvis") to validate the pipeline before training "Claudia".

## Order

After the peer (A2A) plugin. Estimated: half a day incl. training; pipeline validated with a
prebuilt word first.

## AGREED PATH (Vaios, 2026-09-13 by voice) — build next (~2 h after 10:30 EEST)

Decision: the proper detector (openWakeWord), NOT the whisper-every-2-seconds hack (rejected).
**Wake word = "hey claudia"** (two words, like "hey jarvis"; Vaios 2026-09-13 12:56).

States: **idle** → (wake word) → **listening** → transcribe → session turn → Claudia answers
→ **follow-up window** (`TALK_WAKE_FOLLOWUP_S`, default 6; speech starts a new turn without the
wake word; silence → back to idle). Saying the wake word while Claudia speaks cuts her off.

Steps, in order:
1. **Runtime on NixOS**: python3 + openwakeword (+ onnxruntime). Try nixpkgs first
   (`python3Packages.openwakeword` / `onnxruntime`), else a venv under `$TALK_STATE_DIR/wake/`.
   Put the working recipe in `flake.nix` dev shell + README.
2. **Detector process** `bin/wake-listen` (Python): mic → openwakeword → prints one line per
   detection (`<word> <score>`); reads a prebuilt model first (`hey_jarvis`).
3. **`wake.ts`** (server-side, like `hold.ts`): spawn detector, `wake.lock` semantics, on detection:
   kill current speech, beep (short sine through `TALK_PLAYER`), record until silence
   (RMS, `TALK_WAKE_SILENCE_MS` 1200, cap 20 s), `transcribe`, `markSpoken`, `notify`.
   Follow-up window after the Stop hook / speak tool finishes (watch `say.pid` exit → open window).
4. **Validate the chain with "hey jarvis"** end to end in a live session.
5. **Train "Claudia"**: `bin/wake-train` — piper renders "Claudia" across all voices in `models/`
   × speeds (+ negatives: other names, room noise), openwakeword training → `models/claudia.onnx`,
   shipped in the repo. Switch `TALK_WAKE_MODEL=models/hey_claudia.onnx` (`TALK_WAKE_WORD` is already `hey claudia`).
6. Config: `TALK_WAKE=on|off` (off), `TALK_WAKE_WORD`, `TALK_WAKE_MODEL`, `TALK_WAKE_FOLLOWUP_S`,
   `TALK_WAKE_SILENCE_MS`; `/talk:configure wake on|off`, `wakeword <name>`, `followup <s>`.
   Docs: README + AGENTS.md (Windows: mic via sounddevice — untested).

Build as a worker session in this repo (`/peer:configure project talk 7512`), test by
restarting the main session.
