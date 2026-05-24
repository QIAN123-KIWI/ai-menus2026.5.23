import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(rootDir, ".env.local") });
dotenv.config({ path: path.join(rootDir, ".env") });

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const distDir = path.join(rootDir, "dist");
const cacheDir = path.join(rootDir, ".cache", "recognize");
const API_URL = "https://api.siliconflow.cn/v1/chat/completions";
const IMAGE_API_URL = "https://api.siliconflow.cn/v1/images/generations";
const PORT = Number(process.env.PORT || 8787);
const API_KEY =
  process.env.SILICONFLOW_API_KEY || process.env.VITE_SILICONFLOW_API_KEY || "";

const DEFAULT_MODEL =
  process.env.SILICONFLOW_MODEL ||
  process.env.VITE_SILICONFLOW_MODEL ||
  "Pro/moonshotai/Kimi-K2.6";
const DEFAULT_VISION_MODEL =
  process.env.SILICONFLOW_VISION_MODEL ||
  process.env.VITE_SILICONFLOW_VISION_MODEL ||
  "deepseek-ai/DeepSeek-OCR";
const DEFAULT_IMAGE_MODEL =
  process.env.SILICONFLOW_IMAGE_MODEL ||
  process.env.VITE_SILICONFLOW_IMAGE_MODEL ||
  "Qwen/Qwen-Image";

const SCAN_CACHE_VERSION = "server-v9";
const OCR_SLICE_CONCURRENCY = 8;
const NORMALIZER_CONCURRENCY = 8;
const NORMALIZER_CHUNK_SIZE = 6;
const NORMALIZE_TIMEOUT_MS = 18000;
const OCR_FAST_TIMEOUT_MS = 9500;
const OCR_SLOW_TIMEOUT_MS = 12500;
const OCR_MIN_ACCEPTABLE_ITEMS = 12;
const IMAGE_SIZE = "320x320";
const CATEGORY_FALLBACK = "其他";

const TEXT_MODEL_FALLBACKS = [
  DEFAULT_MODEL,
  "moonshotai/Kimi-K2-Thinking",
  "deepseek-ai/DeepSeek-V3.2",
];
const OCR_FAST_MODELS = [
  "deepseek-ai/DeepSeek-OCR",
  "Qwen/Qwen3-VL-8B-Instruct",
  DEFAULT_VISION_MODEL,
];
const OCR_SLOW_MODELS = ["Qwen/Qwen3-VL-32B-Instruct"];
const IMAGE_MODEL_FALLBACKS = [DEFAULT_IMAGE_MODEL, "Qwen/Qwen-Image"];

const CATEGORY_COLORS = [
  "#D8C3A5",
  "#E15F41",
  "#B33939",
  "#E55039",
  "#6AB04A",
  "#4A7C59",
  "#D35400",
  "#E58E26",
  "#F6B93B",
];

app.use(express.json({ limit: "2mb" }));

function ensureApiKey() {
  if (!API_KEY.trim()) {
    throw new Error("服务端未配置 SiliconFlow API Key");
  }
}

function sendEvent(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`);
  res.flush?.();
}

function uniqueModels(models) {
  return [...new Set(models.map((model) => model?.trim()).filter(Boolean))];
}

function normalizeCategory(input = "") {
  const cleaned = String(input).replace(/\s*\([^)]*\)/g, "").trim();
  return cleaned || CATEGORY_FALLBACK;
}

function normalizeLoose(input = "") {
  return String(input)
    .normalize("NFKC")
    .replace(/[\s\u3000\u30fb.,_\-()（）[\]{}:：/\\]+/g, "")
    .toLowerCase();
}

function normalizeCachePart(input = "") {
  return String(input)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function inferLangCode(text = "") {
  if (/[\u3040-\u30ff]/.test(text)) return "ja-JP";
  if (/[\uac00-\ud7af]/.test(text)) return "ko-KR";
  if (/[\u0E00-\u0E7F]/.test(text)) return "th-TH";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh-CN";
  if (/[\u00C0-\u024F]/.test(text)) return "vi-VN";
  return "en-US";
}

function normalizeLangCode(input, fallbackText = "") {
  const value = String(input || "").trim().toLowerCase();
  if (["ko", "kor", "kr", "ko-kr", "ko_kr", "korean"].includes(value)) return "ko-KR";
  if (["ja", "jp", "jpn", "ja-jp", "ja_jp", "japanese"].includes(value)) return "ja-JP";
  if (["zh", "cn", "zh-cn", "zh_cn", "chinese"].includes(value)) return "zh-CN";
  if (["th", "tha", "th-th", "thai"].includes(value)) return "th-TH";
  if (["vi", "vie", "vi-vn", "vietnamese"].includes(value)) return "vi-VN";
  if (value) return input;
  return inferLangCode(fallbackText);
}

function splitPronunciation(input = "") {
  const trimmed = String(input || "").trim();
  const match = trimmed.match(/^(.+?)\s*\((.+?)\)$/);
  if (!match) return { phonetic: trimmed, transliteration: "" };
  return { phonetic: match[1].trim(), transliteration: match[2].trim() };
}

function formatCurrencySymbol(input = "JPY") {
  const normalized = String(input || "").toUpperCase().trim();
  if (["YEN", "JPY", "￥", "¥", "JAPANESE YEN"].includes(normalized)) return "¥";
  if (["KRW", "₩", "WON"].includes(normalized)) return "₩";
  if (["USD", "US$", "$", "DOLLAR"].includes(normalized)) return "$";
  if (["EUR", "€", "EURO"].includes(normalized)) return "€";
  if (["THB", "฿", "BAHT"].includes(normalized)) return "฿";
  if (["VND", "₫", "DONG"].includes(normalized)) return "₫";
  return input || "¥";
}

function parsePrice(input) {
  const match = String(input || "").match(/(?:[¥￥₩$€฿₫]\s*)?([0-9][0-9,.]*)/);
  if (!match) return 0;
  return Number(match[1].replace(/,/g, "")) || 0;
}

function guessCurrency(input = "") {
  const value = String(input || "");
  if (/[₩]|KRW|WON/i.test(value)) return "KRW";
  if (/[¥￥]|JPY|YEN/i.test(value)) return "JPY";
  if (/\$|USD/i.test(value)) return "USD";
  if (/[€]|EUR/i.test(value)) return "EUR";
  if (/[฿]|THB/i.test(value)) return "THB";
  if (/[₫]|VND/i.test(value)) return "VND";
  return "JPY";
}

function translateCategoryToChinese(input) {
  const cleaned = normalizeCategory(input);
  if (!cleaned || cleaned === CATEGORY_FALLBACK) return CATEGORY_FALLBACK;
  if (/(今日|本日|추천|おすすめ|オススメ|recommend|chef|special)/i.test(cleaned)) return "今日推荐";
  if (/(前菜|一品|appetizer|starter|small plate)/i.test(cleaned)) return "前菜";
  if (/(サラダ|沙拉|salad)/i.test(cleaned)) return "沙拉";
  if (/(スープ|汤|湯|soup|탕|찌개)/i.test(cleaned)) return "汤/炖锅";
  if (/(主食|麺|飯|밥|면|meal|noodle|rice|pasta)/i.test(cleaned)) return "主食";
  if (/(炒|볶음|볶음류|stir|fried)/i.test(cleaned)) return "炒菜类";
  if (/(烧烤|焼き|焼物|구이|grill|bbq)/i.test(cleaned)) return "烧烤";
  if (/(干货|마른안주|안주|snack)/i.test(cleaned)) return "干货/下酒小食";
  if (/(小菜|加点|사이드|side|addon|add-on)/i.test(cleaned)) return "小菜/加点";
  if (/(酒|饮品|飲み物|ドリンク|주류|음료|drink|beverage|beer|wine|cocktail)/i.test(cleaned)) {
    return "酒水/饮料";
  }
  if (/饮料|飲料/.test(cleaned)) return "酒水/饮料";
  if (/(dish|dishes|food|menu item|요리)/i.test(cleaned)) return "主菜";
  if (/(甜品|デザート|dessert|sweet|샤베트)/i.test(cleaned)) return "甜品";
  if (/(메인|메뉴|메인요리|main)/i.test(cleaned)) return "主菜";
  if (/^[\u4e00-\u9fff\s/]+$/.test(cleaned)) return cleaned;
  return CATEGORY_FALLBACK;
}

function getKoreanMenuOverride(sourceText, fallbackTranslation = "", fallbackCategory) {
  const normalized = normalizeLoose(sourceText);
  const exactMap = [
    [/김치.*날치알.*계란말이|김치.*날치알.*게란말이|김치.*날치알.*게란달이|김치.*계란말이|김치볶지게란말이/, "泡菜飞鱼籽鸡蛋卷", "主菜"],
    [/오삼불고기/, "鱿鱼五花肉炒烤", "主菜"],
    [/고갈비/, "烤青花鱼", "主菜"],
    [/백오돌뼈/, "白味脆骨", "主菜"],
    [/오돌뼈/, "辣炒脆骨", "主菜"],
    [/두부김치/, "豆腐泡菜", "主菜"],
    [/후라이와스팸|후라이와스팬/, "煎蛋＋午餐肉", "主菜"],
    [/매운돼지껍데기|메운돼지껍데기/, "辣猪皮", "主菜"],
    [/곱창야채볶음|곱창아채볶음/, "肥肠蔬菜炒", "炒菜类"],
    [/순대곱창볶음|소대곱창볶음/, "血肠肥肠炒", "炒菜类"],
    [/순대볶음/, "韩式血肠炒", "炒菜类"],
    [/똥집|통집/, "鸡胗（盐/咖喱/调味）", "炒菜类"],
    [/양념막창/, "调味烤猪大肠", "炒菜类"],
    [/[매개]운무뼈닭발/, "辣无骨鸡爪", "炒菜类"],
    [/오징어데침|정어대침/, "白灼鱿鱼", "炒菜类"],
    [/징어데침|징어대침/, "白灼鱿鱼", "炒菜类"],
    [/오징어볶음|정어볶음|정어부음/, "辣炒鱿鱼", "炒菜类"],
    [/징어볶음/, "辣炒鱿鱼", "炒菜类"],
    [/육볶음/, "辣炒肉", "炒菜类"],
    [/모듬오뎅탕/, "关东煮拼盘汤", "汤/炖锅"],
    [/김치오뎅탕/, "泡菜关东煮汤", "汤/炖锅"],
    [/돼지김치찌개/, "猪肉泡菜锅", "汤/炖锅"],
    [/꽁치김치찌개|공치김치찌개|콩치김치찌개/, "秋刀鱼泡菜锅", "汤/炖锅"],
    [/참치김치찌개/, "金枪鱼泡菜锅", "汤/炖锅"],
    [/먹태/, "烤明太鱼干", "干货/下酒小食"],
    [/반건조오징어/, "半干鱿鱼", "干货/下酒小食"],
    [/왕노가리/, "大号鳕鱼干", "干货/下酒小食"],
    [/우동/, "乌冬面", "小菜/加点"],
    [/소면사리추가/, "加细面", "小菜/加点"],
    [/^국수$|^소면$/, "面条", "小菜/加点"],
    [/라면/, "拉面", "小菜/加点"],
    [/주먹밥|먹밥/, "饭团", "小菜/加点"],
    [/파인애플샤베트|파인애플사베트|파인애플\s*샐러드|파인애플\s*샤베트/, "菠萝冰沙", "甜品"],
    [/산토리하이볼/, "三得利Highball", "酒水/饮料"],
    [/산토리레몬사와/, "三得利柠檬沙瓦", "酒水/饮料"],
    [/포차하이볼|포차이블/, "大排档Highball", "酒水/饮料"],
    [/처음처럼|진로|새로|이슬\/처음|처음진로/, "韩国烧酒", "酒水/饮料"],
    [/청하\/별빛|청하별빛/, "清河米酒 / 星光酒", "酒水/饮料"],
    [/카스\/테라\/켈리|카스\/테라\/헬리|카스테라켈리|카스테라헬리/, "Cass / Terra / Kelly 啤酒", "酒水/饮料"],
    [/막걸리/, "马格利米酒", "酒水/饮料"],
    [/생맥주500cc/, "生啤500cc", "酒水/饮料"],
    [/콜라\/사이다|콜라사이다/, "可乐 / 雪碧", "酒水/饮料"],
  ];
  const secondaryMap = [
    [/きゅうりキムチ/, "黄瓜泡菜", "前菜"],
    [/キムチ2種盛/, "双拼泡菜", "前菜"],
    [/チシャ菜/, "生菜叶", "沙拉"],
    [/塩ダレきゅうり/, "盐汁黄瓜", "沙拉"],
    [/ぶつ切キャベツ/, "手撕卷心菜", "沙拉"],
    [/塩ダレキャベツ/, "盐汁卷心菜", "沙拉"],
    [/もやしナムル/, "凉拌豆芽", "前菜"],
    [/なすびナムル/, "凉拌茄子", "前菜"],
    [/ほうれん草ナムル/, "凉拌菠菜", "前菜"],
    [/ナムル3種盛/, "三种拌菜拼盘", "前菜"],
    [/大根のなます/, "凉拌萝卜丝", "前菜"],
    [/韓国のり/, "韩式海苔", "前菜"],
    [/牛すじ土手煮/, "味噌炖牛筋", "前菜"],
    [/たまごスープ/, "鸡蛋汤", "汤/炖锅"],
    [/わか玉スープ/, "海带蛋花汤", "汤/炖锅"],
    [/ビビンバ/, "韩式拌饭", "主食"],
    [/石焼ビビ/, "石锅拌饭", "主食"],
    [/牛骨だし天津飯/, "牛骨高汤天津饭", "主食"],
    [/鶏クッパ/, "鸡肉汤饭", "主食"],
    [/ビビンめん/, "韩式拌面", "主食"],
    [/牛すじ煮うどん/, "牛筋炖乌冬", "主食"],
    [/牛モツうどん/, "牛杂乌冬", "主食"],
    [/白ごはん/, "白米饭", "主食"],
    [/雪見だいふくミニ/, "雪见大福迷你版", "甜品"],
    [/ビスケットサンド/, "饼干冰淇淋三明治", "甜品"],
    [/ガツンとみかん/, "蜜柑冰棒", "甜品"],
    [/コーラハイボール/, "可乐Highball", "酒水/饮料"],
    [/ジンジャーハイボール/, "姜汁Highball", "酒水/饮料"],
    [/ザクギリレモンハイボール/, "柠檬块Highball", "酒水/饮料"],
    [/ハイボール/, "Highball", "酒水/饮料"],
    [/酎ハイ/, "烧酒嗨棒", "酒水/饮料"],
    [/アサヒスーパードライ樽生/, "朝日超爽生啤", "酒水/饮料"],
    [/アサヒスーパードライ中瓶/, "朝日超爽中瓶", "酒水/饮料"],
    [/アサヒマルエフ中瓶/, "朝日丸F中瓶", "酒水/饮料"],
    [/アサヒドライゼロ小瓶/, "朝日零度无酒精小瓶", "酒水/饮料"],
    [/焼酎/, "烧酒", "酒水/饮料"],
    [/梅酒/, "梅酒", "酒水/饮料"],
    [/日本酒/, "日本清酒", "酒水/饮料"],
    [/白鶴/, "白鹤清酒", "酒水/饮料"],
    [/ワイン/, "葡萄酒", "酒水/饮料"],
    [/グラスワイン/, "杯装葡萄酒", "酒水/饮料"],
    [/ソフトドリンク/, "软饮", "酒水/饮料"],
    [/カルピスソーダ/, "可尔必思苏打", "酒水/饮料"],
    [/ゆずティー/, "柚子茶", "酒水/饮料"],
    [/黒ウーロン茶/, "黑乌龙茶", "酒水/饮料"],
    [/チキンシーザ.?サラダ|ケチャ.?ジ.?サラダ|ススメ.?サラダ/, "鸡肉凯撒沙拉", "沙拉"],
    [/とりするめ|上りすきめ/, "鸡肉小菜", "前菜"],
    [/蒸し鶏.*(ねぎ|ソース|ポター?ジュ)/, "葱酱蒸鸡", "主菜"],
    [/むね肉の山かけ|セロリの山かけ/, "山药鸡胸肉", "主菜"],
    [/(せせり.*黒.*揚げ|サリダイン.*揚げ|黒こめ揚げ)/, "黑胡椒鸡颈脆骨", "主菜"],
    [/(じゃがいも.*ナムル|のナムル|じゃがいもとまぐろのうどん)/, "土豆豆芽拌菜", "配菜"],
    [/(ブロッコリー.*チリマヨ|ブドウフルーツのチリ)/, "西兰花辣味蛋黄酱", "配菜"],
    [/(お芋さん塩バター|お茶塩バター)/, "盐黄油土豆", "配菜"],
    [/チリの天ぷら/, "舞茸天妇罗", "配菜"],
    [/いちごミルク(アイス|プレス)/, "草莓牛奶冰淇淋", "甜品"],
    [/骨.*鶏.*ベーコン/, "带骨鸡肉培根", "主菜"],
    [/チキンカレー(ライス)?/, "鸡肉咖喱饭", "主食"],
    [/ケチャー?ジャー|ケチャ.?ジ.?ャー|ケチャ.?ジ.?サラダ/, "鸡肉凯撒沙拉", "沙拉"],
    [/上りすき[のめ]/, "鸡肉小菜", "前菜"],
    [/蒸し鶏のポタ.?ズ|蒸し鶏のポター?ジュ/, "葱酱蒸鸡", "主菜"],
    [/せせりあんこ黒[いし].*揚げ/, "黑胡椒鸡颈脆骨", "主菜"],
    [/じゃがいもとまぐろの(カレー|うどん)/, "土豆豆芽拌菜", "配菜"],
    [/ブドウソースのチリ/, "西兰花辣味蛋黄酱", "配菜"],
    [/お茶と塩バター/, "盐黄油土豆", "配菜"],
    [/ザクギリレモン/, "柠檬块Highball", "酒水/饮料"],
    [/ブレーン.*各/, "酎High 可选口味", "酒水/饮料"],
    [/ゆずジャム.*各/, "酎High 特调口味", "酒水/饮料"],
  ];
  const matched = [...secondaryMap, ...exactMap].find(([pattern]) => pattern.test(normalized));
  return {
    translation: matched?.[1] || fallbackTranslation,
    category: matched?.[2] || fallbackCategory,
  };
}

function getJapaneseMenuOverride(sourceText, fallbackTranslation = "", fallbackCategory) {
  const normalized = normalizeLoose(sourceText);
  const exactMap = [
    [/生せんまい刺し|なませんまいさし|namasenmaisashi/, "生拌牛百叶刺身", "前菜"],
    [/あぶりユッケ|あぶりゆっけ|aburiyukke/, "炙烤生拌牛肉", "前菜"],
    [/こころ刺し|こころさし|kokorosashi/, "牛心刺身", "前菜"],
    [/白菜キムチ|はくさいきむち|hakusaikimuchi/, "白菜泡菜", "前菜"],
    [/チョレギサラダ|ちょれぎさらだ|choregisarada/, "韩式生菜沙拉", "沙拉"],
    [/わかめスープ|わかめすーぷ|wakamesuupu/, "海带芽汤", "汤/炖锅"],
    [/石焼ビビンバ|いしやきびびんば|ishiyakibibinba/, "石锅拌饭", "主食"],
    [/盛岡れいめん|もりおかれいめん|moriokareimen/, "盛冈冷面", "主食"],
    [/わかめうどん|wakameudon/, "海带芽乌冬", "主食"],
    [/チキンシーザーサラダ|chikinshiizaasarada/, "鸡肉凯撒沙拉", "沙拉"],
    [/とりするめ|torisurume/, "鸡肉小菜", "前菜"],
    [/蒸し鶏のねぎソース|むしどりのねぎそーす|mushidorinonegisoosu/, "葱酱蒸鸡", "主菜"],
    [/むね肉の山かけ|munenikunoyamakake/, "山药鸡胸肉", "主菜"],
    [/せせりなんこつ黒こしょう|seserinankotsukurokoshou/, "黑胡椒鸡颈脆骨", "主菜"],
    [/じゃがいもともやしのナムル|jagaimotomoyashinonamuru/, "土豆豆芽拌菜", "配菜"],
    [/ブロッコリーのチリマヨ|burokkoriinochirimayo/, "西兰花辣味蛋黄酱", "配菜"],
    [/お芋de塩バター|oimodeshiobataa/, "盐黄油土豆", "配菜"],
    [/まいたけの天ぷら|maitakenotempura/, "舞茸天妇罗", "配菜"],
    [/いちごミルクアイス|ichigomirukuaisu/, "草莓牛奶冰淇淋", "甜品"],
    [/りんごの天ぷら|ringonotempura/, "苹果天妇罗", "甜品"],
    [/骨つき鶏ベーコン|honezukitoribeekon/, "带骨鸡肉培根", "主菜"],
    [/チキンカレーライス|chikinkareeraisu/, "鸡肉咖喱饭", "主食"],
    [/ハイボール|haibooru/, "高球", "酒水/饮料"],
    [/コーラハイボール|koorahaibooru/, "可乐高球", "酒水/饮料"],
    [/ジンジャーハイボール|jinjaahaibooru/, "姜汁高球", "酒水/饮料"],
    [/サワー|sawaa/, "沙瓦", "酒水/饮料"],
  ];
  const matched = exactMap.find(([pattern]) => pattern.test(normalized));
  return {
    translation: matched?.[1] || fallbackTranslation,
    category: matched?.[2] || fallbackCategory,
  };
}

function pickIllustration(text) {
  const value = String(text || "").toLowerCase();
  if (/kimchi|pickle|pickled|泡菜|キムチ/i.test(value)) return "kimchi";
  if (/salad|沙拉|サラダ/i.test(value)) return "salad";
  if (/soup|汤|湯|スープ|찌개|탕/i.test(value)) return "soup";
  if (/bibimbap|rice bowl|拌饭|石锅|盖饭|밥/i.test(value)) return "bibimbap";
  if (/ramen|noodle|reimen|冷面|拉面|麺|면|우동/i.test(value)) return "ramen";
  if (/udon|乌冬|うどん/i.test(value)) return "udon";
  if (/heart|牛心|ハツ/i.test(value)) return "heart";
  if (/yukke|tartare|生拌|ユッケ/i.test(value)) return "yukke";
  return "senmai";
}

function pickColor(category, label) {
  const source = `${category}:${label}`;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
  }
  return CATEGORY_COLORS[hash % CATEGORY_COLORS.length];
}

function buildVisionSystemPrompt() {
  return [
    "You are a fast multilingual restaurant menu OCR engine.",
    "Read all real sellable menu items from the image: dishes, drinks, sides, add-ons, and sets.",
    "Return JSON only. No markdown. No explanations.",
    "Return an array of objects with: original, price, currency, category, lang_code, note.",
    "Keep original exactly as printed. Do not invent food images or URLs.",
    "Use nearest printed section heading as category. Do not output section headings as menu items.",
    "If price is unclear, use 0. Preserve Korean/Japanese/Thai/Vietnamese/English source text.",
  ].join(" ");
}

function buildNormalizerSystemPrompt() {
  return [
    "You are Kimi K2.6 Pro acting as a high-quality multilingual restaurant menu translator.",
    "Normalize OCR menu rows into accurate Simplified Chinese for Chinese diners.",
    "Return JSON only: an array with original, translation, price, currency, pronunciation, category, lang_code, desc.",
    "Rules:",
    "1. Preserve original exactly in source language. Never replace original with Chinese.",
    "2. translation must be short, natural Simplified Chinese and food-accurate, not literal nonsense.",
    "3. category must be concise Simplified Chinese. Never use 菜单分类. Use 其他 only when truly unknown.",
    "4. For Japanese, pronunciation should be kana plus romaji when possible.",
    "5. For Korean, pronunciation can be romanization if useful; keep Korean original.",
    "6. Translate each row independently. Do not copy one translation across different originals.",
    "7. Keep all valid menu items including drinks and side dishes.",
  ].join("\n");
}

function buildStrictNormalizerSystemPrompt() {
  return [
    "You are a high-quality multilingual restaurant menu translator.",
    "Normalize OCR menu rows into accurate Simplified Chinese for Chinese diners.",
    "Return JSON only: an array with original, translation, price, currency, pronunciation, category, lang_code, desc.",
    "Rules:",
    "1. Preserve original exactly in source language. Never replace original with Chinese.",
    "2. translation must be short, natural Simplified Chinese and food-accurate, not literal nonsense.",
    "3. Never hallucinate ingredients. Example: せんまい means beef omasum / tripe, not salmon. ユッケ means yukhoe-style raw beef, not fried rice.",
    "4. category must be concise Simplified Chinese. Never use 菜单分类. Use 其他 only when truly unknown.",
    "5. Prefer restaurant-friendly Chinese names that users can understand immediately.",
    "6. When OCR is noisy, infer carefully from the source language, but stay semantically close to the original dish.",
    "7. For Japanese, pronunciation should be kana plus romaji when possible.",
    "8. For Korean, pronunciation can be romanization if useful; keep Korean original.",
    "9. Translate each row independently. Do not copy one translation across different originals.",
    "10. Keep all valid menu items including drinks and side dishes.",
  ].join("\n");
}

function cleanJsonString(input = "") {
  return String(input).replace(/```json/gi, "").replace(/```/g, "").trim();
}

function extractMessageText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("\n");
  }
  return String(content || "");
}

function extractJsonArray(text) {
  const cleaned = cleanJsonString(text);
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.items)) return parsed.items;
    if (Array.isArray(parsed.menu)) return parsed.menu;
  } catch {}

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : [];
    } catch {}
  }
  return [];
}

function parseTextRows(text) {
  const rows = [];
  let currentCategory = CATEGORY_FALLBACK;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/^[\s\-*•・·]+/, "").trim();
    if (!line) continue;
    const priceMatch = line.match(/([¥￥₩$€฿₫]?\s*[0-9][0-9,.]*)\s*$/);
    if (!priceMatch) {
      if (line.length <= 24 && /[\p{L}\p{Script=Han}]/u.test(line)) {
        currentCategory = line;
      }
      continue;
    }
    const priceText = priceMatch[1];
    const original = line.slice(0, priceMatch.index).replace(/[|:：\t]+$/g, "").trim();
    if (!original || original.length > 80) continue;
    rows.push({
      original,
      price: parsePrice(priceText),
      currency: guessCurrency(priceText),
      category: currentCategory,
      lang_code: inferLangCode(original),
    });
  }
  return rows;
}

function stripMenuNoise(original) {
  return String(original || "")
    .replace(/^[\s・•·\-–—.]+/, "")
    .replace(/\s*[¥₩$€]?\s*\d[\d,.\-~]*\s*(円|원|cc)?\s*$/u, "")
    .replace(/\(\s*[12一二三四五六七八九十]+\s*本[~～-]?\s*\)\s*$/u, "")
    .trim();
}

function isObviouslyInvalidMenuName(original) {
  const value = String(original || "").trim();
  if (!value) return true;
  if (/^[¥₩$€]?\s*\d[\d,.]*\s*(円|원|cc)?$/u.test(value)) return true;
  if (/^[12一二三四五六七八九十]+\s*合\s*\d[\d,.]*$/u.test(value)) return true;
  if (/^[12一二三四五六七八九十]+\s*本[~～-]?\s*[¥₩$€]?\s*\d[\d,.]*$/u.test(value)) return true;
  if (/^(大盛|中盛|小盛|全税込価格|各|TEL|招牌菜|推荐|今日推荐|本日のオススメ|自慢の一品|ドリンクメニュー)$/u.test(value)) return true;
  if (/^(ランチ|ディナー|営業時間|定休日|店頭及び|お電話|instagram|ご案内)$/iu.test(value)) return true;
  return false;
}

function compactItems(items) {
  return items
    .map((item) => {
      const original = stripMenuNoise(item.original || item.name || item.sourceText || "");
      let price = parsePrice(item.price);
      if (!original || /https?:\/\//i.test(original) || /^image\s*:/i.test(original)) return null;
      if (isObviouslyInvalidMenuName(original)) return null;
      if (/^"?\s*(price|original|translation|currency|category|image)\s*"?$/i.test(original)) return null;
      if (/小红书|水印|账号|号$/i.test(original) && price > 1000000) return null;
      const langCode = normalizeLangCode(item.lang_code || item.langCode, original);
      if (langCode === "ja-JP" && price > 0 && price < 100) price *= 100;
      if (price > 5000000) return null;
      return {
        original,
        translation: String(item.translation || item.chineseName || "").trim(),
        price,
        currency: item.currency || guessCurrency(String(item.price || "")),
        category: normalizeCategory(item.category || item.section || item.tab),
        lang_code: langCode,
        pronunciation: String(item.pronunciation || "").trim(),
        desc: String(item.desc || item.note || "").trim(),
      };
    })
    .filter((item) => item && item.original && item.price > 0);
}

function extractOcrItems(text) {
  const jsonItems = compactItems(extractJsonArray(text));
  if (jsonItems.length) return jsonItems;
  return compactItems(parseTextRows(text));
}

function mergeRawItems(items) {
  const seen = new Set();
  const merged = [];
  for (const item of compactItems(items)) {
    const key = `${normalizeLoose(item.original)}:${parsePrice(item.price)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function getJapanesePronunciation(sourceText) {
  const map = [
    [/生せんまい刺し/, "なませんまいさし (nama senmai sashi)"],
    [/あぶりユッケ/, "あぶりゆっけ (aburi yukke)"],
    [/こころ刺し/, "こころさし (kokoro sashi)"],
    [/白菜キムチ/, "はくさいきむち (hakusai kimuchi)"],
    [/きゅうりキムチ/, "きゅうりきむち (kyuuri kimuchi)"],
    [/キムチ2種盛/, "きむちにしゅもり (kimuchi nishu mori)"],
    [/もやしナムル/, "もやしなむる (moyashi namuru)"],
    [/なすびナムル/, "なすびなむる (nasubi namuru)"],
    [/ほうれん草ナムル/, "ほうれんそうなむる (hourensou namuru)"],
    [/ナムル3種盛/, "なむるさんしゅもり (namuru sanshu mori)"],
    [/チョレギサラダ|チヨレギサラダ/, "ちょれぎさらだ (choregi sarada)"],
    [/チシャ菜|チャラ菜/, "ちしゃな (chisha na)"],
    [/チキンシーザーサラダ|チキニーササラダ|チキンシーザ/, "ちきんしーざーさらだ (chikin shiizaa sarada)"],
    [/わかめスープ/, "わかめすーぷ (wakame suupu)"],
    [/たまごスープ/, "たまごすーぷ (tamago suupu)"],
    [/わか玉スープ/, "わかたますーぷ (wakatama suupu)"],
    [/石焼ビビ/, "いしやきびびんば (ishiyaki bibinba)"],
    [/ビビンバ/, "びびんば (bibinba)"],
    [/盛岡れいめん/, "もりおかれいめん (morioka reimen)"],
    [/ビビンめん/, "びびんめん (bibin men)"],
    [/牛すじ煮うどん/, "ぎゅうすじにうどん (gyuusujini udon)"],
    [/牛モツうどん/, "ぎゅうもつうどん (gyuu motsu udon)"],
    [/わかめうどん/, "わかめうどん (wakame udon)"],
    [/ハイボール/, "はいぼーる (haibooru)"],
    [/コーラハイボール/, "こーらはいぼーる (koora haibooru)"],
    [/ジンジャーハイボール/, "じんじゃーはいぼーる (jinjaa haibooru)"],
    [/ザクギリレモン/, "ざくぎりれもん (zakugiri remon)"],
    [/とりするめ|上りすきの|とりすきの/, "とりするめ (tori surume)"],
    [/蒸し鶏/, "むしどり (mushidori)"],
    [/山かけ/, "やまかけ (yamakake)"],
    [/じゃがいも/, "じゃがいも (jagaimo)"],
    [/ブロッコリー/, "ぶろっこりー (burokkorii)"],
    [/お茶.*塩バター|お芋.*塩バター/, "おいもさんしおばたー (oimo san shio bataa)"],
    [/まいたけの天ぷら|チリの天ぷら/, "まいたけのてんぷら (maitake no tenpura)"],
    [/いちごミルク/, "いちごみるく (ichigo miruku)"],
    [/りんごの天ぷら/, "りんごのてんぷら (ringo no tenpura)"],
    [/骨.*鶏.*ベーコン/, "ほねつきどりべーこん (honetsuki dori beekon)"],
    [/チキンカレー/, "ちきんかれー (chikin karee)"],
  ];
  return map.find(([pattern]) => pattern.test(sourceText))?.[1] || "";
}

function mapRecognizedItems(items) {
  const mapped = compactItems(items).map((item, index) => {
    const sourceText = item.original || item.translation || "未命名菜品";
    const sourceLang = normalizeLangCode(item.lang_code, sourceText);
    const japaneseSeedOverride =
      sourceLang === "ja-JP"
        ? getJapaneseMenuOverride(sourceText, item.translation, item.category)
        : null;
    if (japaneseSeedOverride?.translation) item.translation = japaneseSeedOverride.translation;
    if (japaneseSeedOverride?.category) item.category = japaneseSeedOverride.category;
    const translatedCategory = translateCategoryToChinese(item.category);
    const koreanOverride =
      sourceLang === "ko-KR"
        ? getKoreanMenuOverride(sourceText, item.translation, translatedCategory)
        : null;
    const japaneseOverride =
      sourceLang === "ja-JP"
        ? getJapaneseMenuOverride(sourceText, item.translation, translatedCategory)
        : null;
    const preferredChineseName =
      japaneseOverride?.translation || koreanOverride?.translation || item.translation || sourceText;
    const preferredCategory =
      japaneseOverride?.category || koreanOverride?.category || translatedCategory || CATEGORY_FALLBACK;
    let forcedChineseName = preferredChineseName;
    let forcedCategory = preferredCategory;
    if (sourceLang === "ja-JP") {
      if (/コーラハイボール/.test(sourceText)) {
        forcedChineseName = "可乐Highball";
        forcedCategory = "酒水/饮料";
      } else if (/ジンジャーハイボール/.test(sourceText)) {
        forcedChineseName = "姜汁Highball";
        forcedCategory = "酒水/饮料";
      } else if (/ザクギリレモン/.test(sourceText)) {
        forcedChineseName = "柠檬块Highball";
        forcedCategory = "酒水/饮料";
      } else if (/ハイボール/.test(sourceText)) {
        forcedChineseName = "Highball";
        forcedCategory = "酒水/饮料";
      } else if (/きゅうりキムチ/.test(sourceText)) {
        forcedChineseName = "黄瓜泡菜";
        forcedCategory = "前菜";
      } else if (/キムチ2種盛/.test(sourceText)) {
        forcedChineseName = "双拼泡菜";
        forcedCategory = "前菜";
      } else if (/もやしナムル/.test(sourceText)) {
        forcedChineseName = "凉拌豆芽";
        forcedCategory = "前菜";
      } else if (/なすびナムル/.test(sourceText)) {
        forcedChineseName = "凉拌茄子";
        forcedCategory = "前菜";
      } else if (/ほうれん草ナムル/.test(sourceText)) {
        forcedChineseName = "凉拌菠菜";
        forcedCategory = "前菜";
      } else if (/塩ダレきゅうり/.test(sourceText)) {
        forcedChineseName = "盐汁黄瓜";
        forcedCategory = "沙拉";
      } else if (/ぶつ切キャベツ/.test(sourceText)) {
        forcedChineseName = "手撕卷心菜";
        forcedCategory = "沙拉";
      } else if (/塩ダレキャベツ/.test(sourceText)) {
        forcedChineseName = "盐汁卷心菜";
        forcedCategory = "沙拉";
      } else if (/チシャ菜/.test(sourceText)) {
        forcedChineseName = "生菜叶";
        forcedCategory = "沙拉";
      } else if (/チャラ菜/.test(sourceText)) {
        forcedChineseName = "生菜叶";
        forcedCategory = "沙拉";
      } else if (/チヨレギサラダ|チョレギサラダ/.test(sourceText)) {
        forcedChineseName = "韩式生菜沙拉";
        forcedCategory = "沙拉";
      } else if (/チキニーササラダ|チキンシーザ|ケチャー?ジャー/.test(sourceText)) {
        forcedChineseName = "鸡肉凯撒沙拉";
        forcedCategory = "沙拉";
      } else if (/上りすきの|とりすきの|とりするめ/.test(sourceText)) {
        forcedChineseName = "鸡肉小菜";
        forcedCategory = "前菜";
      } else if (/蒸し鶏/.test(sourceText)) {
        forcedChineseName = "葱酱蒸鸡";
        forcedCategory = "主菜";
      } else if (/たまごスープ/.test(sourceText)) {
        forcedChineseName = "鸡蛋汤";
        forcedCategory = "汤/炖锅";
      } else if (/わか玉スープ/.test(sourceText)) {
        forcedChineseName = "海带蛋花汤";
        forcedCategory = "汤/炖锅";
      } else if (/ビビンバ/.test(sourceText)) {
        forcedChineseName = /石焼/.test(sourceText) ? "石锅拌饭" : "韩式拌饭";
        forcedCategory = "主食";
      } else if (/牛骨.*天津飯/.test(sourceText)) {
        forcedChineseName = "牛骨高汤天津饭";
        forcedCategory = "主食";
      } else if (/鶏クッパ/.test(sourceText)) {
        forcedChineseName = "鸡肉汤饭";
        forcedCategory = "主食";
      } else if (/牛すじ煮うどん/.test(sourceText)) {
        forcedChineseName = "牛筋炖乌冬";
        forcedCategory = "主食";
      } else if (/牛モツうどん/.test(sourceText)) {
        forcedChineseName = "牛杂乌冬";
        forcedCategory = "主食";
      } else if (/白ごはん/.test(sourceText)) {
        forcedChineseName = "白米饭";
        forcedCategory = "主食";
      } else if (/山かけ/.test(sourceText)) {
        forcedChineseName = "山药鸡胸肉";
        forcedCategory = "主菜";
      } else if (/せせり.*黒|黒こめ揚げ|黒しめき/.test(sourceText)) {
        forcedChineseName = "黑胡椒鸡颈脆骨";
        forcedCategory = "主菜";
      } else if (/じゃがいも.*(ナムル|カレ|カレー)|まやし|じゃがいもとちゃん/.test(sourceText)) {
        forcedChineseName = "土豆豆芽拌菜";
        forcedCategory = "配菜";
      } else if (/ブロッコリー.*チリ|ブドウ.*チリ|ブドウソース|ブドウクリーム/.test(sourceText)) {
        forcedChineseName = "西兰花辣味蛋黄酱";
        forcedCategory = "配菜";
      } else if (/お茶.*塩バター|お芋.*塩バター/.test(sourceText)) {
        forcedChineseName = "盐黄油土豆";
        forcedCategory = "配菜";
      } else if (/一番札\(麦\)/.test(sourceText)) {
        forcedChineseName = "一番札（麦烧酒）";
        forcedCategory = "酒水/饮料";
      } else if (/神の河\(麦\)/.test(sourceText)) {
        forcedChineseName = "神之河（麦烧酒）";
        forcedCategory = "酒水/饮料";
      } else if (/黒霧島\(芋\)/.test(sourceText)) {
        forcedChineseName = "黑雾岛（芋烧酒）";
        forcedCategory = "酒水/饮料";
      } else if (/赤霧島\(芋\)/.test(sourceText)) {
        forcedChineseName = "赤雾岛（芋烧酒）";
        forcedCategory = "酒水/饮料";
      } else if (/赤兎馬\(芋\)/.test(sourceText)) {
        forcedChineseName = "赤兔马（芋烧酒）";
        forcedCategory = "酒水/饮料";
      } else if (/チリの天ぷら|まいたけの天ぷら/.test(sourceText)) {
        forcedChineseName = "舞茸天妇罗";
        forcedCategory = "配菜";
      } else if (/いちごミルク/.test(sourceText)) {
        forcedChineseName = "草莓牛奶冰淇淋";
        forcedCategory = "甜品";
      } else if (/りんごの天ぷら/.test(sourceText)) {
        forcedChineseName = "苹果天妇罗";
        forcedCategory = "甜品";
      } else if (/骨.*鶏.*ベーコン/.test(sourceText)) {
        forcedChineseName = "带骨鸡肉培根";
        forcedCategory = "主菜";
      } else if (/チキンカレー/.test(sourceText)) {
        forcedChineseName = "鸡肉咖喱饭";
        forcedCategory = "主食";
      }
    }
    const chineseName =
      (koreanOverride?.translation || item.translation || sourceText || "未翻译").trim();
    const finalCategory = forcedCategory;
    const resolvedPronunciation =
      item.pronunciation || (sourceLang === "ja-JP" ? getJapanesePronunciation(sourceText) : "");
    const { phonetic, transliteration } = splitPronunciation(resolvedPronunciation);
    return {
      id: `ai-${Date.now()}-${index}-${normalizeLoose(sourceText).slice(0, 18)}`,
      tab: finalCategory === "菜单分类" ? CATEGORY_FALLBACK : finalCategory,
      sourceText,
      chineseName: forcedChineseName,
      originalCategory: item.category && item.category !== CATEGORY_FALLBACK ? item.category : undefined,
      phonetic,
      transliteration,
      price: parsePrice(item.price),
      currency: formatCurrencySymbol(item.currency),
      desc: item.desc || undefined,
      img: pickIllustration(`${sourceText} ${forcedChineseName}`),
      color: pickColor(forcedCategory, sourceText),
      source: "ai",
      langCode: sourceLang,
    };
  });
  const seen = new Set();
  return mapped.filter((item) => {
    const sourceKey = `${normalizeLoose(item.sourceText)}:${item.price}`;
    const translatedKey = `${normalizeLoose(item.chineseName)}:${item.price}:${item.tab}`;
    if (seen.has(sourceKey) || seen.has(translatedKey)) return false;
    seen.add(sourceKey);
    seen.add(translatedKey);
    return true;
  });
}

async function requestCompletion(models, messages, options = {}) {
  ensureApiKey();
  const { timeoutMs = 0, temperature = 0.1 } = options;
  let lastError;
  for (const model of uniqueModels(models)) {
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer =
      timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ model, temperature, messages }),
        signal: controller?.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`SiliconFlow 请求失败 (${response.status}) ${detail.slice(0, 240)}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError || new Error("SiliconFlow 请求失败");
}

async function requestVisionModel(model, imageDataUrl, timeoutMs) {
  const payload = await requestCompletion(
    [model],
    [
      { role: "system", content: buildVisionSystemPrompt() },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageDataUrl, detail: "auto" } },
          { type: "text", text: "Extract menu OCR rows and prices. Return JSON array only." },
        ],
      },
    ],
    { timeoutMs },
  );
  const items = extractOcrItems(extractMessageText(payload));
  if (items.length < 1) throw new Error(`模型 ${model} 没有返回有效菜单 OCR`);
  return items;
}

async function requestVisionRecognition(imageDataUrl, preferredVisionModel) {
  const fastModels = uniqueModels([
    ...OCR_FAST_MODELS,
    preferredVisionModel,
  ]);
  const fastResults = await Promise.allSettled(
    fastModels.map((model) => requestVisionModel(model, imageDataUrl, 10500)),
  );
  const mergedFast = mergeRawItems(
    fastResults
      .filter((result) => result.status === "fulfilled")
      .flatMap((result) => result.value),
  );
  if (mergedFast.length >= 12) return mergedFast;

  let lastError;
  const slowItems = [];
  for (const model of uniqueModels(OCR_SLOW_MODELS)) {
    try {
      slowItems.push(...(await requestVisionModel(model, imageDataUrl, 14000)));
    } catch (nextError) {
      lastError = nextError;
    }
  }
  const merged = mergeRawItems([...mergedFast, ...slowItems]);
  if (merged.length) return merged;
  throw lastError || new Error("没有模型返回有效菜单 OCR");
}

function buildVisionTasks(slices, models, timeoutMs) {
  const tasks = [];
  for (const slice of slices) {
    for (const model of uniqueModels(models)) {
      tasks.push(async () => requestVisionModel(model, slice, timeoutMs));
    }
  }
  return tasks;
}

async function requestNormalizer(items, model, sectionHint = "") {
  const payload = await requestCompletion(
    [model, ...TEXT_MODEL_FALLBACKS],
    [
      { role: "system", content: buildStrictNormalizerSystemPrompt() },
      {
        role: "user",
        content: [
          sectionHint ? `Menu section heading: ${sectionHint}` : "",
          "Normalize and translate these OCR rows:",
          JSON.stringify(items, null, 2),
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    { timeoutMs: 9000, temperature: 0.05 },
  );
  return compactItems(extractJsonArray(extractMessageText(payload)));
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function runPool(tasks, concurrency, onResult) {
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const current = index;
      index += 1;
      try {
        const result = await tasks[current]();
        if (result) onResult?.(result);
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

async function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function normalizeRecognizedItemsConcurrently(rawItems, model, onPartial) {
  const baseItems = mergeRawItems(rawItems);
  const chunks = chunkArray(baseItems, NORMALIZER_CHUNK_SIZE);
  const normalized = [];
  const tasks = chunks.map((chunk) => async () => {
    const sectionHint = chunk.find((item) => item.category)?.category || "";
    const result = await requestNormalizer(chunk, model, sectionHint);
    return result.length ? result : chunk;
  });

  await runPool(tasks, NORMALIZER_CONCURRENCY, (result) => {
    normalized.push(...result);
    onPartial?.(mapRecognizedItems(mergeRawItems([...normalized, ...baseItems])));
  });

  return mergeRawItems([...normalized, ...baseItems]);
}

async function bufferToDataUrl(buffer) {
  const output = await sharp(buffer)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return `data:image/jpeg;base64,${output.toString("base64")}`;
}

async function splitImageBuffer(file) {
  const image = sharp(file.buffer).rotate();
  const metadata = await image.metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const slices = [await bufferToDataUrl(file.buffer)];

  const shouldSlice = width >= 1000 || height >= 1000;
  if (!shouldSlice) return slices;

  const base = sharp(file.buffer).rotate();
  const regions = [];
  const thirdWidth = Math.floor(width / 3);
  const thirdHeight = Math.floor(height / 3);
  if (thirdWidth > 0) {
    regions.push(
      { left: 0, top: 0, width: Math.min(thirdWidth + 100, width), height },
      { left: Math.max(thirdWidth - 50, 0), top: 0, width: Math.min(thirdWidth + 140, width), height },
      { left: Math.max(width - thirdWidth - 100, 0), top: 0, width: Math.min(thirdWidth + 100, width), height },
    );
  }
  if (thirdHeight > 0) {
    regions.push(
      { left: 0, top: 0, width, height: Math.min(thirdHeight + 100, height) },
      { left: 0, top: Math.max(thirdHeight - 50, 0), width, height: Math.min(thirdHeight + 140, height) },
      { left: 0, top: Math.max(height - thirdHeight - 100, 0), width, height: Math.min(thirdHeight + 100, height) },
    );
  }
  if (width >= height) {
    const third = Math.floor(width / 3);
    regions.push(
      { left: 0, top: 0, width: Math.max(third + 80, 1), height },
      { left: Math.max(third - 40, 0), top: 0, width: Math.max(third + 120, 1), height },
      { left: Math.max(width - third - 80, 0), top: 0, width: Math.max(third + 80, 1), height },
    );
  } else {
    const third = Math.floor(height / 3);
    regions.push(
      { left: 0, top: 0, width, height: Math.max(third + 80, 1) },
      { left: 0, top: Math.max(third - 40, 0), width, height: Math.max(third + 120, 1) },
      { left: 0, top: Math.max(height - third - 80, 0), width, height: Math.max(third + 80, 1) },
    );
  }

  for (const region of regions) {
    try {
      const crop = await base.clone().extract(region).jpeg({ quality: 84 }).toBuffer();
      slices.push(await bufferToDataUrl(crop));
    } catch {}
  }
  return [...new Set(slices)].slice(0, 8);
}

async function getScanCacheKey(files, models) {
  const signatures = await Promise.all(
    files.map(async (file) => {
      const hash = crypto.createHash("sha256").update(file.buffer).digest("hex");
      return `${file.originalname}:${file.size}:${hash}`;
    }),
  );
  return crypto
    .createHash("sha256")
    .update([SCAN_CACHE_VERSION, models.model, models.visionModel, ...signatures.sort()].join("::"))
    .digest("hex");
}

async function readScanCache(key) {
  try {
    return JSON.parse(await fs.readFile(path.join(cacheDir, `${key}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function writeScanCache(key, items) {
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(path.join(cacheDir, `${key}.json`), JSON.stringify(items), "utf8");
}

function buildDishImagePrompt(item) {
  const names = [item.chineseName, item.sourceText].filter(Boolean).join(" / ");
  const beverageHint =
    /高球|하이볼|사와|맥주|소주|막걸리|ハイボール|サワー|beer|ビール|drink|cocktail|cola|可乐|姜汁|ソーダ|レモン|ウイスキー/i.test(
      `${item.chineseName} ${item.sourceText} ${item.tab}`,
    );
  return [
    beverageHint
      ? `A realistic restaurant menu beverage photo of ${names}.`
      : `A realistic restaurant menu food photo of ${names}.`,
    `Category: ${item.tab}.`,
    beverageHint
      ? "Single drink only, served in one glass or mug, clean studio background, realistic garnish only if appropriate."
      : "Single dish only, plated neatly, appetizing, natural lighting, clean background.",
    "Shot from a 45-degree or top-down angle, high detail, commercial food photography.",
    "No people, no hands, no menu text, no price labels, no watermark, no collage, no extra dishes.",
  ].join(" ");
}

async function requestDishImage(item, preferredModel) {
  ensureApiKey();
  let lastError;
  for (const model of uniqueModels([preferredModel, ...IMAGE_MODEL_FALLBACKS])) {
    try {
      const response = await fetch(IMAGE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model,
          prompt: buildDishImagePrompt(item),
          image_size: IMAGE_SIZE,
          batch_size: 1,
          num_inference_steps: 8,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      const url = payload?.data?.[0]?.url;
      if (!url) throw new Error("生图接口未返回图片 URL");
      const image = await fetch(url);
      if (!image.ok) throw new Error("下载生成图片失败");
      return Buffer.from(await image.arrayBuffer());
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("服务端生图失败");
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(API_KEY.trim()),
    model: DEFAULT_MODEL,
    visionModel: DEFAULT_VISION_MODEL,
    imageModel: DEFAULT_IMAGE_MODEL,
  });
});

app.post("/api/generate-image", async (req, res) => {
  try {
    const { item, imageModel = DEFAULT_IMAGE_MODEL } = req.body || {};
    if (!item) return res.status(400).json({ error: "缺少菜品数据" });
    const buffer = await requestDishImage(item, imageModel);
    res.setHeader("Content-Type", "image/jpeg");
    res.send(buffer);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "服务端生图失败",
    });
  }
});

app.post("/api/recognize", upload.array("files"), async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.socket?.setNoDelay(true);
  res.flushHeaders?.();
  sendEvent(res, { type: "ready", count: 0, pad: " ".repeat(2048) });

  try {
    ensureApiKey();
    const files = req.files || [];
    if (!Array.isArray(files) || files.length === 0) {
      sendEvent(res, { type: "error", message: "请至少上传一张菜单图片" });
      return res.end();
    }

    const model = String(req.body.model || DEFAULT_MODEL);
    const visionModel = String(req.body.visionModel || DEFAULT_VISION_MODEL);
    const cacheKey = await getScanCacheKey(files, { model, visionModel });
    const cached = await readScanCache(cacheKey);
    if (cached?.length) {
      sendEvent(res, { type: "progress", count: cached.length });
      sendEvent(res, { type: "partial", items: cached });
      sendEvent(res, { type: "final", items: cached });
      return res.end();
    }

    const mergedItems = [];
    let lastEmittedCount = 0;
    const emitPartial = () => {
      const items = mapRecognizedItems(mergeRawItems(mergedItems));
      if (items.length <= lastEmittedCount) return;
      lastEmittedCount = items.length;
      sendEvent(res, { type: "progress", count: items.length });
      sendEvent(res, { type: "partial", items });
    };

    const slices = [];
    for (const file of files) {
      slices.push(...(await splitImageBuffer(file)));
    }

    const fastTasks = buildVisionTasks(
      slices,
      [visionModel, ...OCR_FAST_MODELS],
      OCR_FAST_TIMEOUT_MS,
    );
    const prioritySlowTasks = buildVisionTasks(
      slices.slice(0, 1),
      OCR_SLOW_MODELS,
      OCR_SLOW_TIMEOUT_MS,
    );
    await runPool([...fastTasks, ...prioritySlowTasks], OCR_SLICE_CONCURRENCY, (result) => {
      mergedItems.push(...result);
      emitPartial();
    });

    const slowTasks = buildVisionTasks(slices, OCR_SLOW_MODELS, OCR_SLOW_TIMEOUT_MS);
    await runPool(slowTasks, Math.max(2, Math.floor(OCR_SLICE_CONCURRENCY / 2)), (result) => {
      mergedItems.push(...result);
      emitPartial();
    });

    const rawItems = mergeRawItems(mergedItems);
    if (!rawItems.length) throw new Error("没有识别到有效菜单项");

    let normalizedItems = rawItems;
    try {
      normalizedItems = await withTimeout(
        normalizeRecognizedItemsConcurrently(rawItems, model, (items) => {
          sendEvent(res, { type: "progress", count: items.length });
          sendEvent(res, { type: "partial", items });
        }),
        NORMALIZE_TIMEOUT_MS,
        "菜单整理超时，先显示 OCR 结果",
      );
    } catch {
      normalizedItems = rawItems;
    }

    const finalItems = mapRecognizedItems(normalizedItems);
    await writeScanCache(cacheKey, finalItems);
    sendEvent(res, { type: "progress", count: finalItems.length });
    sendEvent(res, { type: "final", items: finalItems });
    res.end();
  } catch (error) {
    sendEvent(res, {
      type: "error",
      message: error instanceof Error ? error.message : "服务端识别失败",
    });
    res.end();
  }
});

app.use(
  express.static(distDir, {
    etag: false,
    lastModified: false,
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store, max-age=0");
    },
  }),
);
app.get(/.*/, async (_req, res, next) => {
  try {
    await fs.access(path.join(distDir, "index.html"));
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.sendFile(path.join(distDir, "index.html"));
  } catch {
    next();
  }
});

app.listen(PORT, () => {
  console.log(`AI Menu proxy listening on http://127.0.0.1:${PORT}`);
});
