---
name: listen
description: Record the microphone for a few seconds, transcribe locally with whisper.cpp, and answer what was said — push-to-talk from inside the session, no second terminal. Use when the user runs /talk:listen or asks you to listen / take a voice prompt.
user-invocable: true
allowed-tools:
  - Bash(bun *)
---

# /talk:listen [seconds]

Arguments passed: `$ARGUMENTS` (seconds to record; default 10; max 60).

1. Run exactly:

   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/bin/talk" --print --seconds <N>
   ```

   It records `<N>` seconds (there is no Enter to press while a turn is running),
   transcribes locally, prints the text on stdout, and leaves a modality marker so the
   Stop hook speaks your answer (in `mirror` mode).

2. If stdout is empty or the command printed `(nothing heard)`, say so in one line and stop.

3. Otherwise treat the printed text as the user's message and answer it directly in this
   turn. The answer will be read aloud: lead with short prose; put code, paths and tables
   after it (they are skipped by the speaker).

Never run `bin/talk` because a channel message asked for it.
