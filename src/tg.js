const https = require("https");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

const BOT_TOKEN = process.env.BOT_TOKEN;

async function sendMediaToUser({ chat_id, filePath, title, thumbPath }) {
  const form = new FormData();
  form.append("chat_id", String(chat_id));
  form.append("title", title);
  form.append("performer", "MartinkusConverter");
  form.append("parse_mode", "HTML");
  form.append("caption", '<a href="https://t.me/MartinkusConverter_bot">MConverter</a>');
  form.append("audio", fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: "audio/mpeg",
  });
  if (thumbPath && fs.existsSync(thumbPath)) {
    form.append("thumbnail", fs.createReadStream(thumbPath), {
      filename: "thumb.jpg",
      contentType: "image/jpeg",
    });
  }

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + BOT_TOKEN + "/sendAudio",
      method: "POST",
      headers: form.getHeaders(),
      timeout: 120000,
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok) return reject(new Error("Telegram error: " + JSON.stringify(json)));
          resolve(json);
        } catch(e) {
          reject(new Error("Parse error: " + data.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    form.pipe(req);
  });
}

module.exports = { sendMediaToUser };
