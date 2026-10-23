#!/usr/bin/env python3
"""Speech-to-text worker for the page's microphone button (lib/stt.js).

Reads one JSON object per line on stdin ({"id": 1, "path": "/tmp/x.webm"}) and
answers one per line on stdout ({"id": 1, "text": "..."} or {"id": 1, "error":
"..."}). The model is loaded once, at start, and the first line out is
{"ready": true}. Everything else goes to stderr, never to stdout.
"""
import json
import sys

locale = sys.argv[1] if len(sys.argv) > 1 else "pt-BR"
out = sys.stdout
sys.stdout = sys.stderr  # a stray print from a library must not break the protocol


def reply(obj):
    out.write(json.dumps(obj, ensure_ascii=False) + "\n")
    out.flush()


try:
    from soda_stt import SodaRecognizer

    rec = SodaRecognizer.for_locale(locale)
except Exception as e:  # noqa: BLE001
    reply({"fatal": f"{type(e).__name__}: {e}"})
    sys.exit(1)

reply({"ready": True})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except ValueError:
        continue
    try:
        text = rec.transcribe(req["path"], fast=False)
        reply({"id": req.get("id"), "text": " ".join(str(text or "").split())})
    except Exception as e:  # noqa: BLE001
        reply({"id": req.get("id"), "error": f"{type(e).__name__}: {e}"})
