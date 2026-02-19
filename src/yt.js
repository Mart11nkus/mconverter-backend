// src/yt.js
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

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
    p.on("error", (e) =>
      reject(new Error(`${command} spawn error: ${e.message}`))
    );
    p.on("close", (code) => {
      if (code === 0) return resolve({ out, err });
      reject(new Error((err || out || `exit code ${code}`).slice(-6000)));
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

async function getInfo(url, cookiesPath) {
  const args = [
    "--cookies", cookiesPath,
    "--add-header", "User-Agent: Mozilla/5.0",
    "--geo-bypass",
    "--dump-json",
    "--no-warnings",
    url,
  ];
  const { out } = await run(ytDlpBin(), args);
  return JSON.parse(out);
}

async function downloadAudioAndGetPath(url, cookiesPath) {
  const outDir = ensureTmpDir();

  let info = null;
  try {
    info = await getInfo(url, cookiesPath);
  } catch (_) {}

  const base = safeName(info?.title || "audio");
  const id = safeName(info?.id || String(Date.now()));
  const outPath = path.join(outDir, `${base} [${id}].mp3`);

  const args = [
    "--cookies", cookiesPath,
    "--add-header", "User-Agent: Mozilla/5.0",
    "--geo-bypass",
    "-f", "bestaudio/best",
    "--extract-audio",
    "--audio-format", "mp3",
    "--audio-quality", "192K",
    "-o", outPath,
    "--no-warnings",
    url,
  ];

  const { out, err } = await run(ytDlpBin(), args);

  if (!fs.existsSync(outPath)) {
    throw new Error(
      `Downloaded file does not exist: ${outPath}\n${(err || out).slice(-4000)}`
    );
  }

  return { filePath: outPath, title: info?.title || base };
}

module.exports = { run, getInfo, downloadAudioAndGetPath };
