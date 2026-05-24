# AI Menu Translator V2 Delivery Checklist

## Purpose

This checklist turns the product requirements into an execution and verification list so development, local regression, and Tencent Cloud deployment all use the same pass/fail standard.

## Scope

- Local web flow must pass before cloud deployment.
- Tencent Cloud deployment is not considered complete until `/api/health` and real image recognition both pass.
- Performance is measured from the moment the upload request is sent, not from cached results.

## Hard Constraints

### Recognition speed

- [ ] First usable Chinese menu item appears within `5-8s` for normal images.
- [ ] First usable Chinese menu item appears within `<=15s` for complex images.
- [ ] During recognition, `已找到 N` updates at least twice for non-trivial menus.
- [ ] The UI shows translated items incrementally and does not wait for full-image completion.
- [ ] Multiple uploaded images can be processed concurrently.

### Translation quality

- [ ] Every non-Chinese menu item shown to the user has a Chinese dish name.
- [ ] Japanese items keep `中文 + 原文 + 假名 + 罗马音`.
- [ ] Korean items keep `中文 + 原文`.
- [ ] Common dining terms are translated naturally: `Highball`, `大阪烧`, `牛丼`, `生拌牛百叶`, `韩式血肠`, etc.
- [ ] Unit/size lines such as `1合 500`, `2合 900` are attached to the correct drink item and do not become standalone dishes.
- [ ] Raw headings, ads, store name, TEL, business hours, tax text, and slogan copy never enter the dish list.

### Classification

- [ ] Visible category labels are Chinese.
- [ ] Categories come from menu structure or model inference, not a fixed hard-coded set.
- [ ] Dirty fallback categories such as `菜单分类`, `招牌菜`, `今日推荐` are hidden unless they are truly the menu's real category.
- [ ] A dish does not first appear in a temporary bucket and then appear again in its final category.
- [ ] Switching categories never drops already recognized valid dishes.

### Deduplication

- [ ] Same-dish duplicates from OCR slices are merged.
- [ ] Same-dish duplicates across multiple photos are merged.
- [ ] Minor OCR variations are normalized before dedupe where possible.
- [ ] When duplicates merge, the kept version prefers:
  - [ ] Better Chinese translation
  - [ ] Better source text
  - [ ] Kana / romaji when applicable
  - [ ] More reliable price
  - [ ] More reliable category

### Multi-photo behavior

- [ ] Uploading new photos appends to the existing menu by default.
- [ ] Existing menu is cleared only when the user explicitly clicks clear/re-import.
- [ ] Gallery multi-select works.
- [ ] Camera capture import works.
- [ ] Duplicate photos do not create duplicate dishes.

### Images

- [ ] Auto image generation is off by default.
- [ ] Text recognition never waits for image generation.
- [ ] Missing image tiles show `无图 / 点击生成`.
- [ ] Clicking a missing image tile triggers single-dish image generation only for that dish.
- [ ] Generated images are cached and reused on the next identical dish.
- [ ] Image generation failure never breaks ordering flow.

### Cart and waiter page

- [ ] Cart supports add / minus / clear.
- [ ] Currency layout follows local convention.
- [ ] Waiter page defaults to original-language text for confirmation.
- [ ] Waiter page still keeps Chinese assistance without replacing the original.
- [ ] Speech synthesis uses the menu's original language.

### Security and deployment

- [ ] Public deployment uses a backend proxy and does not expose the model API key in the frontend bundle.
- [ ] Local web regression passes before Tencent Cloud deployment.
- [ ] Tencent Cloud `/api/health` returns `ok: true`.
- [ ] Tencent Cloud can complete the full recognition flow on real images.

## Streaming Contract

- [ ] Backend emits `ocr_partial`.
- [ ] Backend emits `translated_partial`.
- [ ] Backend emits `final_cleaned`.
- [ ] Frontend counts `已找到 N` using translated usable dishes, not raw OCR line count.
- [ ] If `final_cleaned` fails, the last translated partial still remains visible.

## Test Matrix

### Local script regression

- [ ] `测试2\\微信图片_20260523190125_550_12.jpg`
- [ ] `测试2\\微信图片_20260523190126_551_12.jpg`
- [ ] `测试2\\微信图片_20260523190127_552_12.jpg`
- [ ] `测试2\\9.jpg`
- [ ] `测试2\\0.jpg`

For each image, capture:

- [ ] `first Chinese ms`
- [ ] `translated count progression`
- [ ] `final count`
- [ ] `duplicate count`
- [ ] `untranslated count`
- [ ] `dirty heading count`

### Local browser regression

- [ ] Single image upload
- [ ] Multiple image upload in one batch
- [ ] Add more photos without clearing old menu
- [ ] Clear and re-import
- [ ] Click `无图` to generate one image
- [ ] Waiter page original-language display
- [ ] Speech button

### Tencent Cloud regression

- [ ] `/api/health`
- [ ] Single image upload
- [ ] Multiple image upload
- [ ] Incremental translated items visible during recognition
- [ ] Waiter page flow
- [ ] Image generation click flow

## Current Known Gaps

- [ ] Dense or complex images still sometimes take too long before the first Chinese item appears.
- [ ] Final item completeness on large menus still needs improvement.
- [ ] Real browser upload flow needs to be re-verified after every streaming or dedupe change.
- [ ] Tencent Cloud function path still needs to be finalized and regression-tested.
