// src/cookies.js
const fs = require("fs");
const path = require("path");
const os = require("os");

function ensureCookiesFile() {
  const secretsDir = "/etc/secrets";

  let files = [];
  try {
    files = fs.readdirSync(secretsDir);
  } catch (e) {
    throw new Error(
      `Secrets dir not accessible: ${secretsDir}. ` +
      `If you use Render Secret Files, ensure they are attached to this service. ` +
      `Original: ${e.message}`
    );
  }

  const secretPath = path.join(secretsDir, "cookies.txt");

  if (!fs.existsSync(secretPath)) {
    throw new Error(
      `Secret cookies file not found at ${secretPath}. ` +
      `Files in ${secretsDir}: ${files.join(", ") || "(empty)"}`
    );
  }

  const tmpPath = path.join(os.tmpdir(), "mconverter-cookies.txt");
  const data = fs.readFileSync(secretPath, "utf8");
  fs.writeFileSync(tmpPath, data, "utf8");

  return tmpPath;
}

module.exports = { ensureCookiesFile };
