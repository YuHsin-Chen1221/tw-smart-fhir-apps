# 健保藥品資料

`nhi-index.json`（約 1 MB，已收錄於 repo）是精簡索引，App 直接使用，**一般開發不需下載原始檔**。

只有在要「重建索引」時，才需下載 96 MB 的健保署原始檔 `nhi_drug_full.csv`（此檔不收錄於 repo）。

## 重建步驟

**① 下載原始檔到本資料夾**（單行指令，Windows / macOS / Linux 皆適用）

在 `packages/nhi-data/data/` 目錄下執行：

```
curl -L -o nhi_drug_full.csv "https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-E41001-001"
```

> ⚠️ Windows PowerShell 使用者：請用**整行一條**指令，不要用反斜線 `\` 換行（PowerShell 不支援，會導致網址被截斷而出現 `Bad hostname`）。
> 若 `curl` 有問題，也可直接用瀏覽器開啟上面網址下載，另存為 `nhi_drug_full.csv` 放到本資料夾。

**② 於 repo 根目錄執行重建**

```
npm run build-nhi-index
```

> 注意 script 名稱是 `build-nhi-index`（不是 `build-index`）。

## 資料集資訊

- 名稱：健保用藥品項查詢項目檔
- 來源：政府資料開放平臺 dataset 23715（衛生福利部中央健康保險署）
- 授權：政府資料開放授權條款
- 更新：每月
- 規模：約 224,455 筆 → 索引 156 種成分 / 54 藥理類別
