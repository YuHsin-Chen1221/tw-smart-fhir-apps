# 台灣 SMART on FHIR 應用程式

兩個以繁體中文與健保規範打造的 SMART on FHIR 應用程式，於衛生福利部
**臺灣醫療資訊標準大平台**（thas.mohw.gov.tw）實測通過。

| App | 說明 | port |
|---|---|---|
| **台灣血脂 CDS** (`apps/lipid-cds`) | 依台灣血脂治療指引與健保給付規定，即時風險分層與 LDL 目標對照 | 後端 8801 / 前端 5301 |
| **健保智慧申報** (`apps/nhi-claim`) | EHR 處方即時轉換為健保申報格式（藥品代號・支付價・ATC），產出 FHIR Claim | 後端 8802 / 前端 5302 |

## 共用套件
- `packages/nhi-data` — 健保用藥品項查詢項目檔索引（官方藥品代號・支付價・ATC・給付章節）
- `packages/smart-client` — SMART OAuth（discovery/PKCE/token/refresh）+ FHIR 正規化
- `packages/ui` — 共用視覺

## 快速開始
```bash
npm install
npm run build-nhi-index   # 首次需下載健保藥品檔（見 packages/nhi-data/data/README.md）
```

**啟動 App（一條指令同時起前後端）：**
```bash
npm run dev:lipid    # 血脂 CDS  → 前端 http://localhost:5301
npm run dev:claim    # 智慧申報  → 前端 http://localhost:5302
```
啟動後在瀏覽器打開對應的**前端**網址（5301 / 5302）。
後端（8801 / 8802）為 API，不需直接開啟。

> 若只想單獨起後端：`npm run dev:lipid:backend` / `npm run dev:claim:backend`

## 資料來源
- 健保用藥品項查詢項目檔（政府資料開放平臺 dataset 23715，政府資料開放授權條款）
- 臨床指引：2022 台灣高血壓、高血脂及糖尿病治療指引；2019 ESC/EAS Dyslipidaemias

## 免責
臨床決策參考工具，不構成醫療建議；申報點數為試算，非實際核付金額。實際給付以健保署最新公告為準。
