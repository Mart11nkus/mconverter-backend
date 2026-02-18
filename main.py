import hashlib
import hmac
import json
import os
import shutil
import tempfile
import urllib.parse
import asyncio
from typing import Dict, Tuple

import httpx
from fastapi import FastAPI, UploadFile, File, Form, HTTPException

BOT_TOKEN = os.getenv("BOT_TOKEN")
if not BOT_TOKEN:
    raise RuntimeError("No BOT_TOKEN env var set")

app = FastAPI()
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def have_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None

def parse_init_data(init_data: str) -> Dict[str, str]:
    parsed = urllib.parse.parse_qs(init_data, strict_parsing=True)
    return {k: v[0] for k, v in parsed.items()}

import hashlib
import hmac
from urllib.parse import parse_qsl

def validate_init_data(init_data: str, bot_token: str):
    data = dict(parse_qsl(init_data, keep_blank_values=True))

    received_hash = data.pop("hash", None)
    if not received_hash:
        return False, {}

    data_check_string = "\n".join(
        f"{k}={v}" for k, v in sorted(data.items())
    )

    secret_key = hashlib.sha256(bot_token.encode()).digest()

    calculated_hash = hmac.new(
        secret_key,
        data_check_string.encode(),
        hashlib.sha256
    ).hexdigest()

    is_valid = hmac.compare_digest(calculated_hash, received_hash)

    return is_valid, data

    try:
        data = parse_init_data(init_data)
    except Exception:
        return False, {}

    hash_received = data.get("hash")
    if not hash_received:
        return False, data

    items = []
    for k, v in data.items():
        if k == "hash":
            continue
        items.append(f"{k}={v}")
    items.sort()
    data_check_string = "\n".join(items)

    secret_key = hashlib.sha256(bot_token.encode()).digest()
    hash_calc = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(hash_calc, hash_received), data

async def run_ffmpeg_mp4_to_mp3(mp4_path: str, mp3_path: str) -> None:
    cmd = ["ffmpeg", "-y", "-i", mp4_path, "-vn", "-b:a", "192k", mp3_path]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(err.decode("utf-8", errors="ignore")[-2000:])

async def send_audio_to_user(user_id: int, mp3_path: str, caption: str = "Готово ✅ MP3"):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendAudio"
    async with httpx.AsyncClient(timeout=180) as client:
        with open(mp3_path, "rb") as f:
            files = {"audio": ("audio.mp3", f, "audio/mpeg")}
            data = {"chat_id": str(user_id), "caption": caption}
            r = await client.post(url, data=data, files=files)
            if r.status_code != 200:
                raise RuntimeError(f"sendAudio failed: {r.status_code} {r.text}")

@app.get("/health")
async def health():
    return {"ok": True, "ffmpeg": have_ffmpeg()}

@app.post("/upload-mp4")
async def upload_mp4(
    file: UploadFile = File(...),
    init_data: str = Form(...),
):
    if not have_ffmpeg():
        raise HTTPException(status_code=500, detail="ffmpeg not installed on server")

    ok, data = validate_init_data(init_data, BOT_TOKEN)
    if not ok:
        raise HTTPException(status_code=401, detail="Bad initData signature")

    user_json = data.get("user")
    if not user_json:
        raise HTTPException(status_code=400, detail="No user in initData")
    user = json.loads(user_json)
    user_id = int(user["id"])

    with tempfile.TemporaryDirectory() as tmp:
        mp4_path = os.path.join(tmp, "input.mp4")
        mp3_path = os.path.join(tmp, "output.mp3")

        with open(mp4_path, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)

        try:
            await run_ffmpeg_mp4_to_mp3(mp4_path, mp3_path)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"ffmpeg error: {e}")

        try:
            await send_audio_to_user(user_id, mp3_path)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"telegram send error: {e}")

    return {"ok": True}


