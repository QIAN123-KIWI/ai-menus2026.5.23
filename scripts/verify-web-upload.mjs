import path from "node:path";
import fs from "node:fs";
import { chromium } from "playwright";

const rawArgs = process.argv.slice(2);
const baseUrl = rawArgs.at(-1)?.startsWith("http") ? rawArgs.pop() : "http://127.0.0.1:8787/";
const imagePaths = rawArgs.length ? rawArgs : [path.resolve(process.cwd(), "..", "测试2", "9.jpg")];

const browserPaths = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const executablePath = browserPaths.find((candidate) => fs.existsSync(candidate));
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });

const startedAt = Date.now();
const marks = [];
let firstFoundMs = null;
let firstChineseMs = null;
let lastFound = 0;
const uploadReports = [];

function elapsed() {
  return Date.now() - startedAt;
}

await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
await page.evaluate(() => {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {}
});
await page.reload({ waitUntil: "domcontentloaded" });

const clearButton = page.getByRole("button", { name: /清空当前菜单/ });
if (await clearButton.count()) {
  await clearButton.click().catch(() => {});
}

async function readState() {
  const text = await page.locator("body").innerText();
  const foundMatches = [...text.matchAll(/(?:已找到|导入|重新导入)\s*(\d+)/g)].map((match) => Number(match[1]));
  return {
    text,
    found: foundMatches.length ? Math.max(...foundMatches) : 0,
  };
}

for (const imagePath of imagePaths) {
  const before = await readState();
  const uploadStartedAt = Date.now();
  await page.locator('input[type="file"]').first().setInputFiles(imagePath);
  let after = before;
  while (Date.now() - uploadStartedAt < 90000) {
    after = await readState();
    if (after.found > before.found) break;
    if (before.found === 0 && /识别完成|本次导入/.test(after.text) && after.found > 0) break;
    await page.waitForTimeout(500);
  }
  uploadReports.push({
    image: imagePath,
    beforeFound: before.found,
    afterFound: after.found,
    elapsedMs: Date.now() - uploadStartedAt,
  });
}

const watchStartedAt = Date.now();
while (Date.now() - watchStartedAt < 90000) {
  const { text, found } = await readState();
  if (found > lastFound) {
    lastFound = found;
    if (firstFoundMs === null) firstFoundMs = elapsed();
    marks.push({ ms: elapsed(), found });
  }
  if (firstChineseMs === null && /(海鲜|担担面|太平燕|套餐|杂烩面|牛肉|鸡肉|沙拉|盖饭)/.test(text)) {
    firstChineseMs = elapsed();
  }
  if (/识别完成|本次导入/.test(text) && found > 0) break;
  await page.waitForTimeout(500);
}

const bodyText = await page.locator("body").innerText();
const clickGenerateCount = await page.getByText("点击生成").count();
const noImageCount = await page.getByText("无图").count().catch(() => 0);
const itemLikeCount = (bodyText.match(/円|원|¥|₩|บาท|đ/g) || []).length;

console.log(
  JSON.stringify(
    {
      images: imagePaths,
      firstFoundMs,
      firstChineseMs,
      lastFound,
      marks,
      uploadReports,
      clickGenerateCount,
      noImageCount,
      itemLikeCount,
      hasCart: /购物车/.test(bodyText),
      hasWaiter: /店员/.test(bodyText),
      bodySample: bodyText.slice(0, 1200),
    },
    null,
    2,
  ),
);

await browser.close();
