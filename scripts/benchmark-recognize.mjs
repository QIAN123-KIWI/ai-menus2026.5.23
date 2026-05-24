import fs from "node:fs";
import path from "node:path";
import { Agent, setGlobalDispatcher } from "undici";

const imagePath = process.argv[2];
const model = process.argv[3];
const visionModel = process.argv[4];
const baseUrl = process.argv[5] || "http://127.0.0.1:8787";

if (!imagePath || !model || !visionModel) {
  console.error(
    "Usage: node scripts/benchmark-recognize.mjs <imagePath> <model> <visionModel> [baseUrl]",
  );
  process.exit(1);
}

setGlobalDispatcher(
  new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
  }),
);

const fileBuffer = fs.readFileSync(imagePath);
const form = new FormData();
form.append("files", new Blob([fileBuffer], { type: "image/jpeg" }), path.basename(imagePath));
form.append("model", model);
form.append("visionModel", visionModel);

const startedAt = Date.now();
const response = await fetch(`${baseUrl}/api/recognize`, {
  method: "POST",
  body: form,
});

if (!response.ok || !response.body) {
  console.error(`Request failed: ${response.status}`);
  process.exit(1);
}

const decoder = new TextDecoder();
const reader = response.body.getReader();
let buffer = "";
let firstProgressMs = null;
let firstPartialMs = null;
let firstOcrMs = null;
let finalItems = [];
let progressCounts = [];
let ocrProgressCounts = [];
let translatedCounts = [];

while (true) {
  const { value, done } = await reader.read();
  buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line) {
      const payload = JSON.parse(line);
      if (["ocr_partial", "translated_partial", "final_cleaned", "error"].includes(payload.type)) {
        const elapsed = Date.now() - startedAt;
        console.error(`[${elapsed}ms] ${payload.type} count=${payload.count ?? ""}`);
      }
      if (payload.type === "progress") {
        progressCounts.push(payload.count);
        if (firstProgressMs === null) firstProgressMs = Date.now() - startedAt;
      }
      if (payload.type === "ocr_partial") {
        ocrProgressCounts.push(payload.count);
        if (firstOcrMs === null) firstOcrMs = Date.now() - startedAt;
      }
      if (payload.type === "partial" && firstPartialMs === null) {
        firstPartialMs = Date.now() - startedAt;
      }
      if (payload.type === "translated_partial") {
        translatedCounts.push(payload.count);
        progressCounts.push(payload.count);
        if (firstProgressMs === null) firstProgressMs = Date.now() - startedAt;
        if (firstPartialMs === null) firstPartialMs = Date.now() - startedAt;
      }
      if (payload.type === "final") {
        finalItems = payload.items || [];
      }
      if (payload.type === "final_cleaned") {
        finalItems = payload.items || [];
      }
      if (payload.type === "error") {
        throw new Error(payload.message);
      }
    }
    newlineIndex = buffer.indexOf("\n");
  }

  if (done) break;
}

const normalizeLoose = (input = "") =>
  String(input)
    .normalize("NFKC")
    .replace(/[\s\u3000\u30fb.,_\-()[\]{}:;\\/]+/g, "")
    .toLowerCase();
const hasChineseText = (input = "") => /[\u4e00-\u9fff]/.test(String(input || ""));
const containsForeignMenuScript = (input = "") =>
  /[\u3040-\u30ff\uac00-\ud7af\u0E00-\u0E7F]/.test(String(input || ""));

const untranslated = finalItems.filter((item) => {
  if (item.langCode === "zh-CN") return false;
  const chineseName = String(item.chineseName || "");
  return (
    !hasChineseText(chineseName) ||
    containsForeignMenuScript(chineseName) ||
    normalizeLoose(chineseName) === normalizeLoose(item.sourceText)
  );
});
const dirty = finalItems.filter((item) =>
  /菜单分类|招牌菜|今日推荐|"price"|小红书|水印/.test(`${item.tab} ${item.sourceText} ${item.chineseName}`),
);

const duplicateKeys = new Map();
for (const item of finalItems) {
  const key = [
    normalizeLoose(item.langCode),
    normalizeLoose(item.sourceText),
    normalizeLoose(item.currency),
    item.price || 0,
  ].join("::");
  duplicateKeys.set(key, (duplicateKeys.get(key) || 0) + 1);
}
const duplicateCount = [...duplicateKeys.values()].filter((count) => count > 1).length;

fs.writeFileSync(
  path.join(process.cwd(), ".tmp-benchmark-final.json"),
  JSON.stringify(finalItems, null, 2),
);

const summary = {
  model,
  visionModel,
  firstProgressMs,
  firstPartialMs,
  firstOcrMs,
  maxOcrProgress: ocrProgressCounts.at(-1) || 0,
  maxTranslatedProgress: translatedCounts.at(-1) || 0,
  maxProgress: progressCounts.at(-1) || 0,
  finalCount: finalItems.length,
  dirtyCount: dirty.length,
  untranslatedCount: untranslated.length,
  duplicateCount,
  categories: [...new Set(finalItems.map((item) => item.tab))],
  untranslatedSamples: untranslated.slice(0, 10).map((item) => ({
    sourceText: item.sourceText,
    chineseName: item.chineseName,
    tab: item.tab,
    price: item.price,
  })),
  samples: finalItems.slice(0, 8).map((item) => ({
    sourceText: item.sourceText,
    chineseName: item.chineseName,
    tab: item.tab,
    price: item.price,
  })),
};

console.log(JSON.stringify(summary, null, 2));
