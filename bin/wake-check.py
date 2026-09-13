#!/usr/bin/env python3
"""Step-1 proof for the wake word: openwakeword + onnxruntime + the mic work on this box.

Run with the venv python (see README "Wake word"):
  ~/.claude/channels/talk/wake/venv/bin/python bin/wake-check.py [seconds] [model]
Listens on the default mic and prints the max score of `model` (prebuilt name, default hey_jarvis,
or a path such as models/hey_claudia.onnx). Say the word to see it spike.
"""
import sys
import time

import sounddevice as sd
import openwakeword
from openwakeword.model import Model

RATE = 16000
CHUNK = 1280  # 80 ms, the frame size openwakeword expects


def main() -> None:
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 3.0
    word = sys.argv[2] if len(sys.argv) > 2 else "hey_jarvis"
    if not word.endswith(".onnx"):
        openwakeword.utils.download_models([word])  # no-op once cached in the venv
    model = Model(wakeword_models=[word], inference_framework="onnx")
    key = next(iter(model.models))
    best = 0.0
    with sd.InputStream(samplerate=RATE, channels=1, dtype="int16", blocksize=CHUNK) as mic:
        end = time.monotonic() + secs
        while time.monotonic() < end:
            frames, _ = mic.read(CHUNK)
            best = max(best, model.predict(frames[:, 0])[key])
    print(f"{key} max score over {secs:g}s: {best:.3f}")


if __name__ == "__main__":
    main()
