# Human-sounding voice for the AI Chat tab, the same in every browser: Kokoro
# (open-source 82M TTS, Apache-2.0) run locally with onnxruntime — free, no
# account, text never leaves this Mac. Model files live in models/ (gitignored):
#   https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0
#   kokoro-v1.0.onnx (the int8 file is ~2.5x slower on this Intel CPU) + voices-v1.0.bin
# ~2x faster than real time here; the browser asks sentence by sentence and
# plays one while the next is made.
import io
import os
import re
import threading
import wave

import numpy as np
from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import Response

import auth

router = APIRouter()
MODELS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
MAX_CHARS = 600  # per request; the browser sends a few sentences at a time

# id -> (Kokoro English variant, label). Hindi voices switch to Hindi phonemes
# for Devanagari text; English text is always read with English phonemes.
VOICES = {
    "af_heart": ("en-us", "Heart — female, warm (US)"),
    "af_bella": ("en-us", "Bella — female, bright (US)"),
    "am_michael": ("en-us", "Michael — male (US)"),
    "am_fenrir": ("en-us", "Fenrir — male, deep (US)"),
    "bf_emma": ("en-gb", "Emma — female (UK)"),
    "bm_george": ("en-gb", "George — male (UK)"),
    "hf_alpha": ("en-us", "Alpha — female (Hindi)"),
    "hf_beta": ("en-us", "Beta — female (Hindi)"),
    "hm_omega": ("en-us", "Omega — male (Hindi)"),
    "hm_psi": ("en-us", "Psi — male (Hindi)"),
}
DEVANAGARI = re.compile(r"[ऀ-ॿ]")
_model = None
_lock = threading.Lock()  # ponytail: one synthesis at a time (CPU-bound); a queue per user if many listen at once


def _kokoro():
    """Load on first use (~600MB), so the backend doesn't pay for it until someone listens."""
    global _model
    if _model is None:
        from kokoro_onnx import Kokoro
        _model = Kokoro(os.path.join(MODELS, "kokoro-v1.0.onnx"), os.path.join(MODELS, "voices-v1.0.bin"))
    return _model


def _speakable(text):
    """What Kokoro should read: no emoji/markup, currency and ranges said out loud."""
    text = text.replace("₹", " rupees ").replace("$", " dollars ")
    text = re.sub(r"(\d)\s*[-–]\s*(\d)", r"\1 to \2", text)  # 22733-22753 -> 22733 to 22753
    text = re.sub(r"[*#_`>|~]|[\U0001F000-\U0001FFFF☀-➿️]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def synthesize(text, voice):
    """16-bit mono WAV bytes."""
    lang = "hi" if DEVANAGARI.search(text) else VOICES[voice][0]
    with _lock:
        samples, rate = _kokoro().create(text, voice=voice, speed=1.0, lang=lang)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())
    return buf.getvalue()


@router.get("/api/ai/voices")
def voices(user=Depends(auth.get_current_user)):
    ready = os.path.exists(os.path.join(MODELS, "kokoro-v1.0.onnx"))
    return {"ready": ready, "voices": [{"id": k, "label": v[1]} for k, v in VOICES.items()] if ready else []}


@router.post("/api/ai/tts")
def tts(payload: dict = Body(...), user=Depends(auth.get_current_user)):
    voice = payload.get("voice")
    if voice not in VOICES:
        raise HTTPException(400, "unknown voice")
    text = _speakable(str(payload.get("text") or ""))[:MAX_CHARS]
    if not text:
        raise HTTPException(400, "text required")
    try:
        audio = synthesize(text, voice)
    except Exception as e:  # model files missing / phonemizer failure: the browser falls back to its own voice
        raise HTTPException(503, f"voice unavailable: {e}")
    return Response(audio, media_type="audio/wav", headers={"Cache-Control": "no-store"})


if __name__ == "__main__":  # self-check: python tts.py
    assert _speakable("R 22733-22753 ₹5 **bold** 🚀") == "R 22733 to 22753 rupees 5 bold"
    for v, text in (("af_heart", "Nifty is holding support."), ("hf_alpha", "निफ्टी सपोर्ट पर है।"), ("hm_omega", "Bank Nifty looks weak.")):
        wav = synthesize(text, v)
        assert wav[:4] == b"RIFF" and len(wav) > 20000, v
    print("tts OK")
