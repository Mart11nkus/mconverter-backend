// src/cookies.js
const fs = require("fs");

function ensureCookiesFile() {
  // путь к secret file (проверь точный путь в Render!)
  const secretPath = "/etc/secrets/cookies.txt";

  if (!fs.existsSync(secretPath)) {
    throw new Error("Secret cookies file not found at " + secretPath);
  }

  return secretPath;
}

module.exports = { ensureCookiesFile };
