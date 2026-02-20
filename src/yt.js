// src/yt.js — yt-dlp с PO Token (обход YouTube без cookies)
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PO_TOKEN = process.env.PO_TOKEN;
const VISITOR_DATA = process.env.VISITOR_DATA;

function ytDlpBin() {
  return path.join(process.cwd(), "bin", "yt-dlp");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => reject(new Error(`${command} spawn error: ${e.message}`)));
    p.on("close", (code) => {
      if (code === 0) return resolve({ out, err });
      reject(new Error((err || out || `exit code ${code}`).slice(-3000)));
    });
  });
}

function ensureTmpDir() {
  const dir = path.join(os.tmpdir(), "mconverter");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(s) {
  return String(s || "")
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function getInfo(url) {
  const args = buildArgs(url, ["--dump-json", "--no-warnings"]);
  const { out } = await run(ytDlpBin(), args);
  return JSON.parse(out);
}

function buildArgs(url, extra = []) {
  const args = [
    "--add-header", "User-Agent: Mozilla/5.0",
    "--geo-bypass",
    "--no-warnings",
  ];

  // Если есть PO Token — используем его
  if (PO_TOKEN && VISITOR_DATA) {
    args.push("--extractor-args", `youtube:po_token=web+${PO_TOKEN};visitor_data=${VISITOR_DATA}`);
  }

  return [...args, ...extra, url];
}

async function downloadAudioAndGetPath(url) {
  const outDir = ensureTmpDir();

  let info = null;
  try {
    info = await getInfo(url);
  } catch (_) {}

  const base = safeName(info?.title || "audio");
  const id = safeName(info?.id || String(Date.now()));
  const outPath = path.join(outDir, `${base} [${id}].mp3`);

  const args = buildArgs(url, [
    "-f", "bestaudio/best",
    "--extract-audio",
    "--audio-format", "mp3",
    "--audio-quality", "192K",
    "-o", outPath,
    "--no-warnings",
  ]);

  const { out, err } = await run(ytDlpBin(), args);
  console.log("yt-dlp out:", out.slice(0, 300));

  if (!fs.existsSync(outPath)) {
    throw new Error(`Файл не скачался: ${(err || out).slice(-2000)}`);
  }

  return { filePath: outPath, title: info?.title || base };
}

module.exports = { run, getInfo, downloadAudioAndGetPath };
