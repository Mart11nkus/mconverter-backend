const fs = require("fs");

function ensureCookiesFile() {
  const secretPath = "/etc/secrets/cookies.txt";

  if (fs.existsSync(secretPath)) {
    return secretPath;
  }

  throw new Error("Secret cookies file not found at /etc/secrets/cookies.txt");
}

module.exports = { ensureCookiesFile };
