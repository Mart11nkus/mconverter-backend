import os
import json
import uuid
import shutil
import hashlib
import hmac
import subprocess
from pathlib import Path
from typing import Dict, Tuple
from urllib.parse import parse_qsl

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

APP_NAME = "mconverter-backend"
TMP_DIR = Path("/tmp") / "mconverter"
TMP_DIR.mkdir(parents=True, exist_ok=True)

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()

app = FastAPI(title=APP_NAME)

# CORS для Mini App (можно ужесточить позже)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def have_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None

def validate_telegram_init_data(init_data: str, bot_token: str) -> Tuple[bool, Dict[str, str]]:
    """
    Telegram WebApp initData validation:
      - parse querystring
      - remove 'hash'
      - data_check_string: sorted key=value joined by '\n'
      - secret_key = sha256(bot_token)
      - calculated_hash = hmac_sha256(data_check_string, secret_key).hexdigest()
    """
    if not init_data or not bot_token:
        return False, {}

    data = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = data.pop("hash", None)
    if not received_hash:
        return False, {}

    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret_key = hashlib.sha256(bot_token.encode("utf-8")).digest()
    calculated_hash = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()

    ok = hmac.compare_digest(calculated_hash, received_hash)
    return ok, data

def safe_filename(name: str) -> str:
    # максимально просто и безопасно
    name = name.replace("\\", "_").replace("/", "_")
    return "".join(c for c in name if c.isalnum() or c in ("_", "-", ".", " ")).strip() or "upload.mp4"

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

    ok, data = validate_telegram_init_data(init_data, BOT_TOKEN)
    if not ok:
        raise HTTPException(status_code=401, detail="Bad initData signature")

    # user в initData — это JSON строка
    user_json = data.get("user")
    if not user_json:
        raise HTTPException(status_code=400, detail="No user in initData")

    try:
        user = json.loads(user_json)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid user json in initData")

    # минимальная привязка, чтобы было понятно кто грузит (можно убрать)
    user_id = user.get("id")

    # сохраняем mp4
    job_id = uuid.uuid4().hex
    in_name = safe_filename(file.filename or "upload.mp4")
    in_path = TMP_DIR / f"{job_id}_{in_name}"
    out_path = TMP_DIR / f"{job_id}.mp3"

    try:
        with in_path.open("wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)

        # ffmpeg convert: extract audio to mp3
        # -vn no video, -q:a quality
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
            # вернем stderr (обрезанный)
            err = (p.stderr or "")[-2000:]
            raise HTTPException(status_code=500, detail=f"ffmpeg failed: {err}")

        # отдаём mp3
        filename = Path(in_name).stem + ".mp3"
        return FileResponse(
            path=str(out_path),
            media_type="audio/mpeg",
            filename=filename,
            headers={
                "X-User-Id": str(user_id) if user_id is not None else "unknown",
                "Cache-Control": "no-store",
            }
        )

    finally:
        # входной файл чистим всегда
        try:
            if in_path.exists():
                in_path.unlink()
        except Exception:
            pass
        # выходной файл чистить нельзя до отдачи, но Render обычно отдаёт сразу.
        # Если хочешь 100% гарант, можно сделать "background task", но пока так.
