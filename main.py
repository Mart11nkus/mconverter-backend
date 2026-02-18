import os
import json
import uuid
import shutil
import hashlib
import hmac
import subprocess
from pathlib import Path
from urllib.parse import parse_qsl
from typing import Dict, Tuple, Optional

import httpx
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware


APP_NAME = "mconverter-backend"
TMP_DIR = Path("/tmp") / "mconverter"
TMP_DIR.mkdir(parents=True, exist_ok=True)

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()

# thumbnail (bot avatar) рядом с main.py
THUMB_PATH = Path(__file__).parent / "bot_avatar.jpg"

app = FastAPI(title=APP_NAME)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# простая память статусов (MVP)
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


def clean_title(s: str, max_len: int = 48) -> str:
    s = (s or "").strip()
    s = s.replace("_", " ").replace("-", " ")
    s = " ".join(s.split())

    allowed = set(" .()[]'’")
    s = "".join(c for c in s if c.isalnum() or c in allowed).strip()

    if not s:
        s = "audio"

    if len(s) > max_len:
        s = s[:max_len].rstrip()

    return s


def nice_output_name(original_filename: str) -> Tuple[str, str]:
    """
    Возвращает:
      - display_title: то, что будет в плеере Telegram (title)
      - out_file_name: имя файла (как будет скачиваться)
    """
    base = Path(original_filename or "upload.mp4").stem
    base_clean = clean_title(base, max_len=80)

    # если похоже на бессмысленный id (длинная строка без пробелов)
    if (" " not in base_clean) and (len(base_clean) >= 24):
        display_title = "Converted audio"
        # уникализируем, чтобы Telegram не кешировал старое превью
        out_file_name = f"mconverter_audio_{uuid.uuid4().hex[:6]}.mp3"
        return display_title, out_file_name

    display_title = clean_title(base, max_len=48)
    out_file_name = clean_title(base, max_len=40) + f"_{uuid.uuid4().hex[:4]}.mp3"
    return display_title, out_file_name


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


def prepare_cover_jpeg(src_cover: Path) -> Path:
    """
    Делает 'правильный' JPEG для Telegram/iOS:
    - baseline (через ffmpeg)
    - RGB-ish output (yuvj420p для jpeg)
    - фикс 320x320 (с паддингом)
    - без лишних метаданных
    """
    out = TMP_DIR / f"cover_{uuid.uuid4().hex}.jpg"

    cmd = [
        "ffmpeg", "-y",
        "-i", str(src_cover),
        "-vf",
        "scale=320:320:force_original_aspect_ratio=decrease,"
        "pad=320:320:(ow-iw)/2:(oh-ih)/2,"
        "format=yuvj420p",
        "-q:v", "3",
        "-frames:v", "1",
        str(out),
    ]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0 or not out.exists():
        err = (p.stderr or "")[-2000:]
        raise RuntimeError(f"ffmpeg prepare cover failed: {err}")

    return out


def embed_cover_into_mp3(mp3_path: Path, cover_path: Path) -> Path:
    """
    Вшивает cover (jpg) в mp3 через ffmpeg (ID3v2 APIC).
    ✅ -disposition attached_pic — критично для Telegram/iOS.
    """
    out_path = mp3_path.with_suffix(".cover.mp3")

    cmd = [
        "ffmpeg", "-y",
        "-i", str(mp3_path),
        "-i", str(cover_path),
        "-map", "0:a",
        "-map", "1:v:0",
        "-c:a", "copy",
        "-c:v", "mjpeg",
        "-disposition:v:0", "attached_pic",
        "-id3v2_version", "3",
        "-write_id3v2", "1",
        "-metadata:s:v:0", "title=Album cover",
        "-metadata:s:v:0", "comment=Cover (front)",
        str(out_path),
    ]

    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0 or not out_path.exists():
        err = (p.stderr or "")[-2000:]
        raise RuntimeError(f"ffmpeg embed cover failed: {err}")

    return out_path


async def tg_send_audio(chat_id: int, mp3_path: Path, title: str, out_file_name: str, cover_for_thumb: Optional[Path] = None):
    """
    Sends mp3 to user via Telegram Bot API.
    - performer: @Martinkusconverter_bot (оставляем как ты хочешь)
    - title: то, что видно в плеере
    - out_file_name: имя файла при скачивании
    - thumbnail: передаем уже нормализованный jpeg (cover_for_thumb), если есть
    """
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendAudio"

    caption_text = "Your audio file is ready 🎧\n\n@Martinkusconverter_bot"

    async with httpx.AsyncClient(timeout=180) as client:
        files = {}
        data = {
            "chat_id": str(chat_id),
            "title": title,
            "performer": "@Martinkusconverter_bot",
            "caption": caption_text,
            "parse_mode": "HTML",
        }

        with mp3_path.open("rb") as audio_f:
            files["audio"] = (out_file_name, audio_f, "audio/mpeg")

            thumb_f = None
            try:
                if cover_for_thumb and cover_for_thumb.exists():
                    thumb_f = cover_for_thumb.open("rb")
                    files["thumbnail"] = (cover_for_thumb.name, thumb_f, "image/jpeg")

                r = await client.post(url, data=data, files=files)
                payload = r.json()
                if not payload.get("ok", False):
                    raise RuntimeError(f"Telegram sendAudio failed: {payload}")

                return payload

            finally:
                if thumb_f:
                    try:
                        thumb_f.close()
                    except Exception:
                        pass


async def worker_convert_and_send(
    job_id: str,
    chat_id: int,
    in_path: Path,
    display_title: str,
    out_file_name: str
):
    out_path = TMP_DIR / f"{job_id}.mp3"
    cover_out_path: Optional[Path] = None
    normalized_cover: Optional[Path] = None

    try:
        JOBS[job_id]["status"] = "converting"
        convert_mp4_to_mp3(in_path, out_path)

        # ✅ Готовим 'правильную' обложку и вшиваем + даем ее как thumbnail
        if THUMB_PATH.exists():
            JOBS[job_id]["status"] = "preparing_cover"
            normalized_cover = prepare_cover_jpeg(THUMB_PATH)

            JOBS[job_id]["status"] = "embedding_cover"
            cover_out_path = embed_cover_into_mp3(out_path, normalized_cover)
            try:
                out_path.unlink()
            except Exception:
                pass
            out_path = cover_out_path

        JOBS[job_id]["status"] = "sending"
        await tg_send_audio(
            chat_id=chat_id,
            mp3_path=out_path,
            title=display_title,
            out_file_name=out_file_name,
            cover_for_thumb=normalized_cover
        )

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
        try:
            if cover_out_path and cover_out_path.exists():
                cover_out_path.unlink()
        except Exception:
            pass
        try:
            if normalized_cover and normalized_cover.exists():
                normalized_cover.unlink()
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

    # быстро сохраняем файл
    with in_path.open("wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)

    # создаем job и отвечаем сразу
    JOBS[job_id] = {"job_id": job_id, "status": "queued"}

    display_title, out_file_name = nice_output_name(in_name)

    background_tasks.add_task(
        worker_convert_and_send,
        job_id,
        chat_id,
        in_path,
        display_title,
        out_file_name
    )

    return {"ok": True, "job_id": job_id, "status": "queued"}
