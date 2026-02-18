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

import httpx
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware


APP_NAME = "mconverter-backend"
TMP_DIR = Path("/tmp") / "mconverter"
TMP_DIR.mkdir(parents=True, exist_ok=True)

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()

app = FastAPI(title=APP_NAME)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Простая память статусов (на free Render может сброситься при рестарте — для MVP ок)
JOBS: Dict[str, Dict] = {}


def have_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def validate_telegram_webapp_init_data(init_data: str, bot_token: str) -> Tuple[bool, Dict[str, str]]:
    """
    Telegram WebApp initData validation:
      secret_key = HMAC_SHA256("WebAppData", bot_token)
      data_check_string = "\n".join(sorted(key=value)) excluding hash
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


async def tg_send_audio(chat_id: int, mp3_path: Path, title: str = "Converted MP3"):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendAudio"
    async with httpx.AsyncClient(timeout=120) as client:
        with mp3_path.open("rb") as f:
            files = {"audio": (mp3_path.name, f, "audio/mpeg")}
            data = {"chat_id": str(chat_id), "title": title}
            r = await client.post(url, data=data, files=files)
            r.raise_for_status()
            return r.json()


def convert_mp4_to_mp3(in_path: Path, out_path: Path):
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
        raise RuntimeError(f"ffmpeg failed: {err}")


async def worker_convert_and_send(job_id: str, chat_id: int, in_path: Path, out_name: str):
    out_path = TMP_DIR / f"{job_id}.mp3"
    try:
        JOBS[job_id]["status"] = "converting"
        convert_mp4_to_mp3(in_path, out_path)

        JOBS[job_id]["status"] = "sending"
        await tg_send_audio(chat_id=chat_id, mp3_path=out_path, title=out_name)

        JOBS[job_id]["status"] = "done"
    except Exception as e:
        JOBS[job_id]["status"] = "error"
        JOBS[job_id]["error"] = str(e)[:1500]
    finally:
        # cleanup
        try:
            if in_path.exists():
                in_path.unlink()
        except Exception:
            pass
        try:
            if out_path.exists():
                out_path.unlink()
        except Exception:
            pass


@app.get("/health")
async def health():
    return {"ok": True, "ffmpeg": have_ffmpeg()}


@app.get("/job-status/{job_id}")
async def job_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.post("/upload-mp4")
async def upload_mp4(
    background_tasks: BackgroundTasks,
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

    user_json = data.get("user")
    if not user_json:
        raise HTTPException(status_code=400, detail="No user in initData")

    try:
        user = json.loads(user_json)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid user json in initData")

    chat_id = user.get("id")
    if not isinstance(chat_id, int):
        raise HTTPException(status_code=400, detail="No valid user id in initData")

    job_id = uuid.uuid4().hex
    in_name = safe_filename(file.filename)
    in_path = TMP_DIR / f"{job_id}_{in_name}"

    # сохраняем файл быстро
    with in_path.open("wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)

    # регистрируем job и отвечаем СРАЗУ (важно для Telegram)
    JOBS[job_id] = {"job_id": job_id, "status": "queued"}

    out_title = Path(in_name).stem + ".mp3"
    background_tasks.add_task(worker_convert_and_send, job_id, chat_id, in_path, out_title)

    return {"ok": True, "job_id": job_id, "status": "queued"}
