#!/usr/bin/env python3
"""Warm Kokoro TTS (sherpa-onnx): load the model once, serve speech on a unix socket.

Protocol, one request per connection: the client sends one JSON line
{"text": str, "sid": int, "speed": float}; the server streams raw s16le mono PCM at the
model's rate (24 kHz for Kokoro) sentence by sentence as each one is synthesized, then
closes. Zero bytes before close = error (the client falls back to piper). A client that
hangs up mid-reply stops synthesis at the next sentence. One request at a time.

Started on demand by voice.ts through bin/kokoro-server (the nix runtime); exits after
--idle seconds without a request (0 = never) to give the ~460 MB back.
"""
import argparse, fcntl, json, os, socket, sys
import numpy as np
import sherpa_onnx

ap = argparse.ArgumentParser()
for k in ('sock', 'model', 'voices', 'tokens', 'data-dir', 'dict-dir', 'lexicon'):
    ap.add_argument('--' + k, required=k in ('sock', 'model', 'voices', 'tokens', 'data-dir'), default='')
ap.add_argument('--threads', type=int, default=4)
ap.add_argument('--idle', type=float, default=3600)
a = ap.parse_args()

def log(msg):
    print(f'kokoro-server: {msg}', file=sys.stderr, flush=True)

# One server per socket: a second starter (another session, a racing prewarm) leaves at once.
lock = open(a.sock + '.lock', 'w')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    log('already running'); sys.exit(0)

tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
    model=sherpa_onnx.OfflineTtsModelConfig(
        kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=a.model, voices=a.voices, tokens=a.tokens, data_dir=a.data_dir,
            dict_dir=a.dict_dir, lexicon=a.lexicon),
        num_threads=a.threads, provider='cpu'),
    max_num_sentences=1))   # one sentence per callback = first audio after the first sentence

def pcm(samples):
    return (np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes()

def serve(conn):
    f = conn.makefile('rb')
    req = json.loads(f.readline() or b'{}')
    text = str(req.get('text', '')).strip()
    if not text:
        return
    def chunk(samples, _progress):
        try:
            conn.sendall(pcm(samples)); return 1
        except OSError:
            return 0   # client gone (say interrupted): stop synthesizing
    tts.generate(text, sid=int(req.get('sid', 0)), speed=float(req.get('speed', 1.0)), callback=chunk)

try: os.unlink(a.sock)
except FileNotFoundError: pass
srv = socket.socket(socket.AF_UNIX)
srv.bind(a.sock)
srv.listen(8)
if a.idle > 0: srv.settimeout(a.idle)
log(f'ready on {a.sock} (rate {tts.sample_rate}, speakers {tts.num_speakers})')
while True:
    try:
        conn, _ = srv.accept()
    except socket.timeout:
        log(f'idle {a.idle:.0f}s — exiting')
        break
    conn.settimeout(None)
    with conn:
        try: serve(conn)
        except Exception as e: log(f'request failed: {e!r}')
try: os.unlink(a.sock)
except FileNotFoundError: pass
