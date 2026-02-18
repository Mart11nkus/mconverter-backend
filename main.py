# main.py — clean production version for Render (FastAPI + ffmpeg + Telegram WebApp initData validation)

import os
import json
import uuid
import shutil
import hashlib
import hmac
import subprocess
from pathlib import Path
from urllib.parse import parse_qsl
from typing import Dict, Tuple

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse


APP_NAME = "mconverter-backend"
TMP_DIR = Path("/tmp") / "mconverter"
TMP_DIR.mkdir(parents=True, exist_ok=True)

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()

app = FastAPI(title=APP_NAME)

# CORS for Telegram Mini App (tighten later if you want)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def have_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def validate_telegram_webapp_init_data(init_data: str, bot_token: str) -> Tuple[bool, Dict[str, str]]:
    """
    Telegram WebApp initData validation (NOT login widget):
      secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
      data_check_string = "\n".join(sorted(key=value)) excluding "hash"
      calculated_hash = HMAC_SHA256(secret_key, data_check_string).hexdigest()
    """
    if not init_data or not bot_token:
        return False, {}

    data = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = data.pop("hash", None)
    if not received_hash:
        return False, {}

    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))

    secret_key = hmac.new(
        key=b"WebAppData",
        msg=bot_token.encode("utf-8"),
        digestmod=hashlib.sha256
    ).digest()

    calculated_hash = hmac.new(
        key=secret_key,
        msg=data_check_string.encode("utf-8"),
        digestmod=hashlib.sha256
    ).hexdigest()

    return hmac.compare_digest(calculated_hash, received_hash), data


def safe_filename(name: str) -> str:
    name = (name or "upload.mp4").replace("\\", "_").replace("/", "_")
    cleaned = "".join(c for c in name if c.isalnum() or c in ("_", "-", ".", " ")).strip()
    return cleaned or "upload.mp4"


@app.get("/health")
async def health():
    return {"ok": True, "ffmpeg": have_ffmpeg()}


@app.post("/upload-mp4")
async def upload_mp4(
    file: UploadFile = File(...),
    init_data: str = Form(...),
):
    if not BOT_TOKEN:
        raise HTTPException(status_code=500, detail="Server misconfigured: BOT_TOKEN missing")
    if not have_ffmpeg():
        raise HTTPException(status_code=500, detail="ffmpeg not installed on server")

    ok, data = validate_telegram_webapp_init_data(init_data, BOT_TOKEN)
    if not ok:
        raise HTTPException(status_code=401, detail="Bad initData signature")

    # Extract user info (optional, but useful)
    user_json = data.get("user")
    if not user_json:
        raise HTTPException(status_code=400, detail="No user in initData")
    try:
        user = json.loads(user_json)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid user json in initData")

    job_id = uuid.uuid4().hex
    in_name = safe_filename(file.filename)
    in_path = TMP_DIR / f"{job_id}_{in_name}"
    out_path = TMP_DIR / f"{job_id}.mp3"

    try:
        # Save upload
        with in_path.open("wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)

        # Convert with ffmpeg
        cmd = [
            "ffmpeg", "-y",
            "-i", str(in_path),
            "-vn",
            "-acodec", "libmp3lame",
            "-q:a", "2",
            str(out_path),
        ]
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        if p.returncode != 0 or not out_path.exists():
            err = (p.stderr or "")[-2000:]
            raise HTTPException(status_code=500, detail=f"ffmpeg failed: {err}")

        # Return mp3 file
        filename = Path(in_name).stem + ".mp3"
        return FileResponse(
            path=str(out_path),
            media_type="audio/mpeg",
            filename=filename,
            headers={
                "Cache-Control": "no-store",
                "X-User-Id": str(user.get("id", "unknown")),
            },
        )

    finally:
        # Cleanup input always
        try:
            if in_path.exists():
                in_path.unlink()
        except Exception:
            pass
        # Cleanup output best-effort (after response, OS may keep it briefly)
        # If you want guaranteed post-response cleanup, we can add BackgroundTasks later.
        try:
            if out_path.exists():
                out_path.unlink()
        except Exception:
            pass
