const { spawn } = require("child_process");

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

async function getInfo(url, cookiesPath) {
  const args = [
    "--cookies", cookiesPath,
    "--add-header", "User-Agent: Mozilla/5.0",
    "--dump-json",
    "--no-warnings",
    url
  ];

  const { out } = await run("yt-dlp", args);
  return JSON.parse(out);
}

async function downloadVideo(url, cookiesPath) {
  const args = [
    "--cookies", cookiesPath,
    "--add-header", "User-Agent: Mozilla/5.0",
    "--no-warnings",
    "-f", "bv*+ba/best",
    "-o", "downloads/%(title).200B [%(id)s].%(ext)s",
    url
  ];

  const { out } = await run("yt-dlp", args);
  return out;
}

module.exports = { run, getInfo, downloadVideo };
