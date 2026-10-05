#!/usr/bin/env python3
"""Wake-word check: max score per model, from the mic or from a WAV file.

Run with the venv python (see README "Wake word"):
  ~/.claude/channels/talk/wake/venv/bin/python bin/wake-check.py [seconds | file.wav] [model ...]
Models: prebuilt names (default hey_jarvis) or paths such as models/hey_claudia.onnx. With a number,
listens on the default mic that long — say the word to see it spike. With a .wav (16-bit; any rate,
mono or first channel), streams the file through the detector exactly like the mic would, so you can
score a recording without saying anything aloud.
"""
import sys
import time
import wave

import numpy as np
import openwakeword
from openwakeword.model import Model
from scipy.signal import resample_poly

RATE = 16000
CHUNK = 1280  # 80 ms, the frame size openwakeword expects


def wav_chunks(path: str):
    with wave.open(path) as w:
        rate, ch = w.getframerate(), w.getnchannels()
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16)[::ch].astype(np.float32)
    if rate != RATE:
        x = resample_poly(x, RATE, rate)
    x = np.clip(x, -32768, 32767).astype(np.int16)
    for i in range(0, len(x) - CHUNK + 1, CHUNK):
        yield x[i:i + CHUNK]


def mic_chunks(secs: float):
    import sounddevice as sd
    with sd.InputStream(samplerate=RATE, channels=1, dtype="int16", blocksize=CHUNK) as mic:
        end = time.monotonic() + secs
        while time.monotonic() < end:
            yield mic.read(CHUNK)[0][:, 0]


def main() -> None:
    src = sys.argv[1] if len(sys.argv) > 1 else "3"
    words = sys.argv[2:] or ["hey_jarvis"]
    prebuilt = [w for w in words if not w.endswith(".onnx")]
    if prebuilt:
        openwakeword.utils.download_models(prebuilt)  # no-op once cached in the venv
    model = Model(wakeword_models=words, inference_framework="onnx")
    best = dict.fromkeys(model.models, 0.0)
    for frames in (wav_chunks(src) if src.endswith(".wav") else mic_chunks(float(src))):
        for k, v in model.predict(frames).items():
            best[k] = max(best[k], float(v))
    what = src if src.endswith(".wav") else f"{float(src):g}s of mic"
    print("  ".join(f"{k} {v:.3f}" for k, v in best.items()), f"({what})")


if __name__ == "__main__":
    main()
