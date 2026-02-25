const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");

function ensureTmpDir() {
  const dir = path.join(os.tmpdir(), "mconverter");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(s) {
  return String(s || "").replace(/[/\\:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
}

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", d => out += d);
    p.stderr.on("data", d => err += d);
    p.on("error", reject);
    p.on("close", code => code === 0 ? resolve({ out, err }) : reject(new Error((err || out).slice(-2000))));
  });
}

function downloadThumb(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) { file.close(); return reject(new Error("thumb HTTP " + res.statusCode)); }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    }).on("error", reject);
  });
}

async function downloadAudioAndGetPath(url) {
  const outDir = ensureTmpDir();
  const outTemplate = path.join(outDir, "%(title)s [%(id)s].%(ext)s");

  let thumbPath = null;
  let videoTitle = null;

  try {
    const { out } = await run(["--dump-json", "--no-warnings", url]);
    const info = JSON.parse(out);
    videoTitle = info.title;
    if (info.thumbnail) {
      thumbPath = path.join(outDir, "thumb_" + info.id + ".jpg");
      await downloadThumb(info.thumbnail, thumbPath);
      console.log("Thumbnail downloaded:", thumbPath);
    }
  } catch (e) {
    console.log("thumb/info error:", e.message);
  }

  const args = [
    "--no-warnings",
    "--extract-audio",
    "--audio-format", "mp3",
    "--audio-quality", "192K",
    "-o", outTemplate,
    "--print", "after_move:filepath",
    url
  ];

  console.log("yt-dlp starting:", url);
  const { out } = await run(args);
  const filePath = out.trim().split("\n").pop();
  if (!filePath || !fs.existsSync(filePath)) throw new Error("Файл не найден после скачивания");
  const title = videoTitle || safeName(path.basename(filePath).replace(/\s*\[[^\]]+\]\.mp3$/, "").replace(/\.mp3$/, ""));
  console.log("Done:", filePath, "thumb:", thumbPath);
  return { filePath, title, thumbPath };
}

module.exports = { downloadAudioAndGetPath };
