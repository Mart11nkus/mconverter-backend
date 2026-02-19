// src/yt.js
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ✅ используем standalone бинарник, чтобы не зависеть от Python
function ytDlpBin() {
  // bin/yt-dlp мы скачали в Build Command
  // cwd при старте обычно корень проекта
  const p = path.join(process.cwd(), "bin", "yt-dlp");
  return p;
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
    "--sleep-interval", "1",
    "--max-sleep-interval", "3",
    "--extractor-args", "youtube:player_client=web",
    "--geo-bypass",
    "--dump-json",
    "--no-warnings",
    url,
  ];

  const { out } = await run(ytDlpBin(), args);
  return JSON.parse(out);
}

async function downloadVideoAndGetPath(url, cookiesPath) {
  const outDir = ensureTmpDir();

  let info = null;
  try {
    info = await getInfo(url, cookiesPath);
  } catch (_) {}

  const base = safeName(info?.title || "video");
  const id = safeName(info?.id || String(Date.now()));
  const outTemplate = path.join(outDir, `${base} [${id}].%(ext)s`);

  const args = [
    "--cookies", cookiesPath,
    "--add-header", "User-Agent: Mozilla/5.0",
    "--sleep-interval", "1",
    "--max-sleep-interval", "3",
    "--extractor-args", "youtube:player_client=web",
    "--geo-bypass",

    "-f", "bv*+ba/best",
    "--merge-output-format", "mp4",

    "-o", outTemplate,
    "--print", "after_move:filepath",
    "--no-warnings",
    url,
  ];

  const { out, err } = await run(ytDlpBin(), args);

  const lines = out.split("\n").map((s) => s.trim()).filter(Boolean);
  const printedPath = lines[lines.length - 1];

  if (!printedPath) {
    throw new Error(`Cannot determine downloaded file path.\n${(err || out).slice(-4000)}`);
  }

  const filePath = path.isAbsolute(printedPath) ? printedPath : path.join(outDir, printedPath);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Downloaded file does not exist.\nprinted="${printedPath}"\nresolved="${filePath}"\n${(err || out).slice(-4000)}`
    );
  }

  return { filePath, log: out };
}

module.exports = { run, getInfo, downloadVideoAndGetPath };
