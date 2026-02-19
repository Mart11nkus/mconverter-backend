const { spawn } = require("child_process");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args);

    let out = "";
    let err = "";

    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));

    p.on("close", (code) => {
      if (code === 0) return resolve(out);
      reject(new Error(err || out));
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

  const output = await run("yt-dlp", args);
  return JSON.parse(output);
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

  return await run("yt-dlp", args);
}

module.exports = { getInfo, downloadVideo };
