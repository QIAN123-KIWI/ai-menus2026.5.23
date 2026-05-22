export type AppPage = "menu" | "cart" | "waiter";

export type FoodIllustration =
  | "senmai"
  | "yukke"
  | "heart"
  | "kimchi"
  | "salad"
  | "soup"
  | "bibimbap"
  | "ramen"
  | "udon";

export type MenuItem = {
  id: string;
  tab: string;
  sourceText: string;
  chineseName: string;
  phonetic?: string;
  transliteration?: string;
  price: number;
  currency: string;
  img: FoodIllustration;
  photoUrl?: string;
  color: string;
  desc?: string;
  source: "sample" | "ai";
  langCode: string;
};

export type RawRecognizedMenuItem = {
  original: string;
  translation?: string;
  price?: number | string;
  currency?: string;
  note?: string;
  desc?: string;
  category?: string;
  lang_code?: string;
  pronunciation?: string;
};

export type RecognizedMenuItem = {
  original: string;
  translation: string;
  pronunciation?: string;
  price?: number | string;
  currency?: string;
  desc?: string;
  category?: string;
  lang_code?: string;
};

export type ScanStatus = "idle" | "processing" | "finished" | "error";

export type Settings = {
  apiKey: string;
  model: string;
  visionModel: string;
  imageModel: string;
};
