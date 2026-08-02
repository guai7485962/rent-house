---
description: 讀 STATUS.md 並回報 rent_house 目前進度與下一步
---

請讀 `STATUS.md`（只讀這一份），然後用繁體中文回報：

1. **現在做到哪** — 已上線的範圍、HEAD 與 `origin/main` 的差距、有沒有未 push 的 commit
2. **下一步是什麼** — 以及它的驗收條件在哪個檔案
3. **有沒有在等我決策的事**
4. **有沒有阻塞或環境限制**

接著跑 `git status --porcelain` 與 `git log --oneline origin/main..HEAD`，
確認 `STATUS.md` 寫的狀態與 repo 實際狀態一致；**若不一致，明確指出哪裡對不上**
（`STATUS.md` 可能沒跟上最後一個 commit）。

不要通讀 `工作日誌.md` 或 `docs/工作日誌-封存.md`。需要細節時用 grep 查特定日期或
工作項編號，例如 `rg -n "CAFE-19" docs/一樓寵物咖啡廳-工作分解.md`。
