# 2026.5.22 ai菜单V2

一个面向餐厅菜单图片的多语言识别、中文翻译和点餐展示工具。

## 功能

- 上传菜单图片，识别菜名、价格、分类和原文。
- 中文名优先展示，同时保留日文原文、假名和罗马音。
- 支持购物车和“给店员看”的点餐确认页。
- 没有图片时先显示菜单文字，后台异步生成菜品示意图。
- 支持 GitHub Pages 在线部署。

## 本地启动

```bash
npm install
npm run dev
```

## 环境变量

复制 `.env.example` 为 `.env.local`，填入自己的 SiliconFlow API Key。

```bash
VITE_SILICONFLOW_API_KEY=your_key
VITE_SILICONFLOW_MODEL=Qwen/Qwen3-14B
VITE_SILICONFLOW_VISION_MODEL=Qwen/Qwen3-VL-8B-Instruct
VITE_SILICONFLOW_IMAGE_MODEL=Kwai-Kolors/Kolors
```

`.env.local` 不会提交到 GitHub。线上使用时，可以在页面右上角设置里填写 API Key，浏览器会保存在本机。

## 发布到 GitHub Pages

推送到 `main` 分支后，GitHub Actions 会自动构建并部署到 GitHub Pages。
