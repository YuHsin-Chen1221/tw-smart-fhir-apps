# 健保藥品資料

`nhi-index.json`（496K，已收錄於 repo）是精簡索引，App 直接使用。

`nhi_drug_full.csv`（96MB，**不收錄於 repo**）為健保署原始檔，如需重建索引才下載：

```bash
curl -L -o nhi_drug_full.csv \
  "https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-E41001-001"
npm run build-index   # 於 tw-smart-apps 根目錄
```

- 資料集：健保用藥品項查詢項目檔（政府資料開放平臺 dataset 23715）
- 授權：政府資料開放授權條款
- 更新：每月
