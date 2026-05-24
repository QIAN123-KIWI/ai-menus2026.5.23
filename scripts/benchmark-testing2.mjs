import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const rootDir = process.cwd();
const testDir = path.resolve(rootDir, "..", "测试2");
const cacheDir = path.join(rootDir, ".cache", "recognize");
const benchmarkScript = path.join(rootDir, "scripts", "benchmark-recognize.mjs");

const model = process.argv[2] || "Pro/moonshotai/Kimi-K2.6";
const visionModel = process.argv[3] || "deepseek-ai/DeepSeek-OCR";

async function clearCache() {
  await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
}

async function listImages() {
  const entries = await fs.readdir(testDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
    .map((entry) => path.join(testDir, entry.name))
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

async function runOne(imagePath) {
  await clearCache();
  const { stdout } = await execFileAsync(
    process.execPath,
    [benchmarkScript, imagePath, model, visionModel],
    { cwd: rootDir, maxBuffer: 1024 * 1024 * 8 },
  );
  return JSON.parse(stdout.trim());
}

const images = await listImages();
const results = [];
for (const imagePath of images) {
  const result = await runOne(imagePath);
  results.push({
    file: path.basename(imagePath),
    ...result,
  });
}

const summary = {
  model,
  visionModel,
  files: results,
};

console.log(JSON.stringify(summary, null, 2));
