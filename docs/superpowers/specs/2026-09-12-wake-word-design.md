# Wake word ("Claudia") — design note, NOT BUILT (parked 2026-09-12)

**Goal:** say "Claudia, …" instead of holding Right Alt. Fully local. Opt-in.

## Shape (inside claude-talk, not a separate plugin)

- `TALK_WAKE=on|off` (default off), `TALK_WAKE_WORD=claudia`, `TALK_WAKE_MODEL=<path>.onnx`.
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
