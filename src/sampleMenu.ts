import type { FoodIllustration, MenuItem } from "./types";

const YEN = "\u00A5";
const TAB = "\u4ECA\u65E5\u63A8\u8350";

const rows: Array<{
  jp: string;
  cn: string;
  kana: string;
  romaji: string;
  price: number;
  img: FoodIllustration;
  color: string;
}> = [
  {
    jp: "\u30C1\u30AD\u30F3 \u30B7\u30FC\u30B6 \u30B5\u30E9\u30C0",
    cn: "\u9E21\u8089\u51EF\u6492\u6C99\u62C9",
    kana: "\u3061\u304D\u3093 \u3057\u30FC\u3056\u30FC \u3055\u3089\u3060",
    romaji: "chikin shiizaa sarada",
    price: 1000,
    img: "salad",
    color: "#6AB04A",
  },
  {
    jp: "\u3068\u308A\u3059\u308B\u3081",
    cn: "\u9E21\u8089\u5C0F\u83DC",
    kana: "\u3068\u308A\u3059\u308B\u3081",
    romaji: "tori surume",
    price: 450,
    img: "senmai",
    color: "#D8C3A5",
  },
  {
    jp: "\u84B8\u3057\u9D8F\u306E\u306D\u304E\u30BD\u30FC\u30B9",
    cn: "\u8471\u9171\u84B8\u9E21",
    kana: "\u3080\u3057\u3069\u308A\u306E\u306D\u304E\u305D\u30FC\u3059",
    romaji: "mushidori no negi soosu",
    price: 800,
    img: "senmai",
    color: "#4A7C59",
  },
  {
    jp: "\u3080\u306D\u8089\u306E\u5C71\u304B\u3051",
    cn: "\u5C71\u836F\u9E21\u80F8\u8089",
    kana: "\u3080\u306D\u306B\u304F\u306E\u3084\u307E\u304B\u3051",
    romaji: "muneniku no yamakake",
    price: 650,
    img: "senmai",
    color: "#D8C3A5",
  },
  {
    jp: "\u305B\u305B\u308A\u306A\u3093\u3053\u304F\u9ED2\u3053\u3057\u3087\u3046\u63DA\u3052",
    cn: "\u9ED1\u80E1\u6912\u70B8\u9E21\u9888\u8089",
    kana: "\u305B\u305B\u308A\u306A\u3093\u3053\u304F\u304F\u308D\u3053\u3057\u3087\u3046\u3042\u3052",
    romaji: "seseri nankoku kuro koshou age",
    price: 500,
    img: "senmai",
    color: "#B33939",
  },
  {
    jp: "\u3058\u3083\u304C\u3044\u3082\u3068\u30E2\u30E4\u30B7\u306E\u30CA\u30E0\u30EB",
    cn: "\u571F\u8C46\u8C46\u82BD\u51C9\u62CC\u83DC",
    kana: "\u3058\u3083\u304C\u3044\u3082\u3068\u3082\u3084\u3057\u306E\u306A\u3080\u308B",
    romaji: "jagaimo to moyashi no namuru",
    price: 450,
    img: "kimchi",
    color: "#E55039",
  },
  {
    jp: "\u30D6\u30ED\u30C3\u30B3\u30EA\u30FC\u306E\u30C1\u30EA\u30DE\u30E8",
    cn: "\u8FA3\u5473\u86CB\u9EC4\u9171\u897F\u5170\u82B1",
    kana: "\u3076\u308D\u3063\u3053\u308A\u30FC\u306E\u3061\u308A\u307E\u3088",
    romaji: "burokkorii no chiri mayo",
    price: 600,
    img: "salad",
    color: "#6AB04A",
  },
  {
    jp: "\u304A\u828B\u3055\u3093 \u5869\u30D0\u30BF\u30FC",
    cn: "\u76D0\u9EC4\u6CB9\u70E4\u85AF",
    kana: "\u304A\u3044\u3082\u3055\u3093 \u3057\u304A\u3070\u305F\u30FC",
    romaji: "oimo san shio bataa",
    price: 600,
    img: "bibimbap",
    color: "#D35400",
  },
  {
    jp: "\u307E\u3044\u305F\u3051\u306E\u5929\u3077\u3089",
    cn: "\u821E\u8338\u5929\u5987\u7F57",
    kana: "\u307E\u3044\u305F\u3051\u306E\u3066\u3093\u3077\u3089",
    romaji: "maitake no tenpura",
    price: 600,
    img: "bibimbap",
    color: "#E58E26",
  },
  {
    jp: "\u3044\u3061\u3054\u30DF\u30EB\u30AF\u30A2\u30A4\u30B9",
    cn: "\u8349\u8393\u725B\u5976\u51B0\u6DC7\u6DCB",
    kana: "\u3044\u3061\u3054\u307F\u308B\u304F\u3042\u3044\u3059",
    romaji: "ichigo miruku aisu",
    price: 300,
    img: "soup",
    color: "#F6B93B",
  },
  {
    jp: "\u308A\u3093\u3054\u306E\u5929\u3077\u3089",
    cn: "\u82F9\u679C\u5929\u5987\u7F57",
    kana: "\u308A\u3093\u3054\u306E\u3066\u3093\u3077\u3089",
    romaji: "ringo no tenpura",
    price: 500,
    img: "bibimbap",
    color: "#E15F41",
  },
  {
    jp: "\u9AA8\u3064\u304D\u9D8F\u30D9\u30FC\u30B3\u30F3(2\u672C~)\u00A5250~",
    cn: "\u5E26\u9AA8\u9E21\u8089\u57F9\u6839",
    kana: "\u307B\u306D\u3064\u304D\u3069\u308A\u3079\u30FC\u3053\u3093",
    romaji: "honetsuki dori beekon",
    price: 250,
    img: "senmai",
    color: "#B33939",
  },
  {
    jp: "\u30C1\u30AD\u30F3\u30AB\u30EC\u30FC\u30E9\u30A4\u30B9",
    cn: "\u9E21\u8089\u5496\u55B1\u996D",
    kana: "\u3061\u304D\u3093\u304B\u308C\u30FC\u3089\u3044\u3059",
    romaji: "chikin karee raisu",
    price: 600,
    img: "bibimbap",
    color: "#D35400",
  },
];

export const SAMPLE_MENU: MenuItem[] = rows.map((row, index) => ({
  id: `blackboard-sample-${index + 1}`,
  tab: TAB,
  sourceText: row.jp,
  chineseName: row.cn,
  originalCategory: "\u672C\u65E5\u306E\u30AA\u30B9\u30B9\u30E1",
  phonetic: row.kana,
  transliteration: row.romaji,
  price: row.price,
  currency: YEN,
  img: row.img,
  color: row.color,
  source: "sample",
  langCode: "ja-JP",
}));
