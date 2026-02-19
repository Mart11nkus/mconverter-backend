const fs = require("fs");
const FormData = require("form-data");

const BOT_TOKEN = process.env.BOT_TOKEN;

async function tgRequest(method, formData) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing in env");
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

  const res = await fetch(url, {
    method: "POST",
    body: formData,
    headers: formData.getHeaders(),
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  }
  return data.result;
}

function buildCaption({ title, signature }) {
  const sig = signature ? `\n\n${signature}` : "";
  return `${title || ""}${sig}`.trim();
}

async function sendMediaToUser({ chat_id, filePath, title }) {
  const signature = process.env.BOT_SIGNATURE || "";
  const caption = buildCaption({ title, signature });

  const ext = (filePath.split(".").pop() || "").toLowerCase();

  // sendVideo лучше для mp4
  const isVideo = ext === "mp4" || ext === "mkv" || ext === "webm";
  const method = isVideo ? "sendVideo" : "sendDocument";
  const fieldName = isVideo ? "video" : "document";

  const form = new FormData();
  form.append("chat_id", String(chat_id));
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append(fieldName, fs.createReadStream(filePath));

  // чтобы Telegram показывал имя файла нормально:
  // FormData сам возьмёт basename, но можно дополнительно:
  // form.append(fieldName, fs.createReadStream(filePath), { filename: require("path").basename(filePath) });

  return tgRequest(method, form);
}

module.exports = { sendMediaToUser };
