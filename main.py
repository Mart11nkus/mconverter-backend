import os
import json
import uuid
import shutil
import hashlib
import hmac
import subprocess
import socket
import ipaddress
from pathlib import Path
from urllib.parse import parse_qsl, urlparse
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

# Опциональный лимит скачивания (если хочешь): MAX_DOWNLOAD_MB=500
MAX_DOWNLOAD_MB = os.getenv("MAX_DOWNLOAD_MB", "").strip()
MAX_DOWNLOAD_BYTES: Optional[int] = None
if MAX_DOWNLOAD_MB.isdigit():
    MAX_DOWNLOAD_BYTES = int(MAX_DOWNLOAD_MB) * 1024 * 1024

# Ограничим описание, чтобы не улететь в лимиты Telegram
MAX_DESC_CHARS = 800

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


def have_ytdlp() -> bool:
    return shutil.which("yt-dlp") is not None


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
        out_file_name = f"mconverter_audio_{uuid.uuid4().hex[:6]}.mp3"
        return display_title, out_file_name

    display_title = clean_title(base, max_len=48)
    out_file_name = clean_title(base, max_len=40) + f"_{uuid.uuid4().hex[:4]}.mp3"
    return display_title, out_file_name


def nice_output_from_meta(title: Optional[str]) -> Tuple[str, str]:
    base = clean_title(title or "Converted audio", max_len=48)
    if not base:
        display_title = "Converted audio"
        out_file_name = f"mconverter_audio_{uuid.uuid4().hex[:6]}.mp3"
        return display_title, out_file_name

    display_title = base
    out_file_name = clean_title(base, max_len=40) + f"_{uuid.uuid4().hex[:4]}.mp3"
    return display_title, out_file_name


def sanitize_description(desc: Optional[str]) -> str:
    if not desc:
        return ""
    desc = desc.strip()
    if not desc:
        return ""
    desc = "\n".join(line.rstrip() for line in desc.splitlines())
    if len(desc) > MAX_DESC_CHARS:
        desc = desc[:MAX_DESC_CHARS].rstrip() + "…"
    return desc


def ensure_public_http_url(url: str) -> str:
    url = (url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="Empty url")

    p = urlparse(url)
    if p.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Only http/https urls are allowed")
    if not p.netloc:
        raise HTTPException(status_code=400, detail="Invalid url: missing host")

    host = p.hostname
    if not host:
        raise HTTPException(status_code=400, detail="Invalid url host")

    if host in ("localhost",):
        raise HTTPException(status_code=400, detail="Localhost urls are not allowed")

    # SSRF защита: резолвим и баним приватные/локальные диапазоны
    try:
        infos = socket.getaddrinfo(host, None)
        ips = []
        for info in infos:
            ips.append(info[4][0])
        for ip in set(ips):
            ip_obj = ipaddress.ip_address(ip)
            if (
                ip_obj.is_private
                or ip_obj.is_loopback
                or ip_obj.is_link_local
                or ip_obj.is_multicast
                or ip_obj.is_reserved
                or ip_obj.is_unspecified
            ):
                raise HTTPException(status_code=400, detail="Private/local network urls are not allowed")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Could not resolve url host")

    return url


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
    Делает 'правильный' JPEG для Telegram/iOS
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


def ytdlp_extract_info(url: str) -> Dict:
    """
    Метаданные (title/description) через yt-dlp --dump-single-json, без скачивания.
    """
    cmd = [
        "yt-dlp",
        "--no-warnings",
        "--dump-single-json",
        "--no-playlist",
        url,
    ]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        err = (p.stderr or p.stdout or "")[-2000:]
        raise RuntimeError(f"yt-dlp info failed: {err}")

    try:
        return json.loads(p.stdout)
    except Exception:
        raise RuntimeError("yt-dlp returned invalid json")


def ytdlp_download(url: str, out_template: str):
    """
    Скачивание через yt-dlp. Берём bestaudio/best и мёржим в mp4 (если надо).
    """
    cmd = [
        "yt-dlp",
        "--no-warnings",
        "--no-playlist",
        "-f", "bestaudio/best",
        "--merge-output-format", "mp4",
        "-o", out_template,
        url,
    ]

    if MAX_DOWNLOAD_BYTES is not None:
        cmd.insert(1, "--max-filesize")
        cmd.insert(2, f"{int(MAX_DOWNLOAD_BYTES / (1024 * 1024))}M")

    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        err = (p.stderr or p.stdout or "")[-2000:]
        raise RuntimeError(f"yt-dlp download failed: {err}")


def find_downloaded_file(job_id: str) -> Optional[Path]:
    candidates = sorted(
        TMP_DIR.glob(f"{job_id}_download.*"),
        key=lambda x: x.stat().st_mtime,
        reverse=True
    )
    return candidates[0] if candidates else None


async def tg_send_audio(
    chat_id: int,
    mp3_path: Path,
    title: str,
    out_file_name: str,
    description: str = "",
    cover_for_thumb: Optional[Path] = None
):
    """
    Sends mp3 to user via Telegram Bot API.
    - performer: @Martinkusconverter_bot (как ты хочешь)
    - title: то, что видно в плеере
    - out_file_name: имя файла при скачивании
    - description: добавим в caption (обрезано)
    """
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendAudio"

    desc = sanitize_description(description)
    if desc:
        caption_text = f"{desc}\n\nYour audio file is ready 🎧\n\n@Martinkusconverter_bot"
    else:
        caption_text = "Your audio file is ready 🎧\n\n@Martinkusconverter_bot"

    async with httpx.AsyncClient(timeout=240) as client:
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
    out_file_name: str,
    description: str = ""
):
    out_path = TMP_DIR / f"{job_id}.mp3"
    cover_out_path: Optional[Path] = None
    normalized_cover: Optional[Path] = None

    try:
        JOBS[job_id]["status"] = "converting"
        convert_mp4_to_mp3(in_path, out_path)

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
            description=description,
            cover_for_thumb=normalized_cover
        )

        JOBS[job_id]["status"] = "done"
    except Exception as e:
        JOBS[job_id]["status"] = "error"
        JOBS[job_id]["error"] = str(e)[:1500]
    finally:
        # cleanup
        for p in [in_path, out_path, cover_out_path, normalized_cover]:
            try:
                if p and isinstance(p, Path) and p.exists():
                    p.unlink()
            except Exception:
                pass


async def worker_download_convert_and_send(job_id: str, chat_id: int, url: str):
    downloaded: Optional[Path] = None
    try:
        JOBS[job_id]["status"] = "downloading"

        info = ytdlp_extract_info(url)
        title = info.get("title") or "Converted audio"
        description = info.get("description") or ""

        display_title, out_file_name = nice_output_from_meta(title)

        out_template = str(TMP_DIR / f"{job_id}_download.%(ext)s")
        ytdlp_download(url, out_template)

        downloaded = find_downloaded_file(job_id)
        if not downloaded or not downloaded.exists():
            raise RuntimeError("Download finished, but file not found")

        JOBS[job_id]["status"] = "downloaded"

        await worker_convert_and_send(
            job_id=job_id,
            chat_id=chat_id,
            in_path=downloaded,
            display_title=display_title,
            out_file_name=out_file_name,
            description=description
        )

    except Exception as e:
        JOBS[job_id]["status"] = "error"
        JOBS[job_id]["error"] = str(e)[:1500]
        try:
            if downloaded and downloaded.exists():
                downloaded.unlink()
        except Exception:
            pass


@app.get("/health")
async def health():
    return {"ok": True, "ffmpeg": have_ffmpeg(), "yt_dlp": have_ytdlp()}


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
    JOBS[job_id] = {"job_id": job_id, "status": "queued", "source": "upload"}

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


@app.post("/download-by-url")
async def download_by_url(
    background_tasks: BackgroundTasks,
    url: str = Form(...),
    init_data: str = Form(...),
):
    """
    Принимает ссылку (YouTube/TikTok/Instagram и т.п.), качает через yt-dlp,
    конвертирует в mp3 и отправляет пользователю через бота.
    """
    if not BOT_TOKEN:
        raise HTTPException(status_code=500, detail="Server misconfigured: BOT_TOKEN missing")
    if not have_ffmpeg():
        raise HTTPException(status_code=500, detail="ffmpeg not installed on server")
    if not have_ytdlp():
        raise HTTPException(status_code=500, detail="yt-dlp not installed on server")

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

    url = ensure_public_http_url(url)

    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"job_id": job_id, "status": "queued", "source": "url"}

    background_tasks.add_task(worker_download_convert_and_send, job_id, chat_id, url)

    return {"ok": True, "job_id": job_id, "status": "queued"}
