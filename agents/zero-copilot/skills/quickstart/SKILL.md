---
name: quickstart
description: Zeroclaw 3 分鐘上手 — 從 git clone 到瀏覽器看到 Web UI 的最短路徑
---

# Zeroclaw Quickstart Skill

當使用者問「怎麼跑起來」「第一次安裝」「怎麼開始」時套用。

## 前置需求
- Docker Desktop（執行中）
- Node.js 22+
- pnpm 9+
- 至少一組 LLM 金鑰：`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / 或 GitHub Copilot 訂閱

## 三步上手

### Step 1 — 安裝依賴
```bash
pnpm install
```

### Step 2 — 設定環境變數
```bash
# .env (專案根目錄)
JWT_SECRET=<32-byte hex>
OPENAI_API_KEY=sk-...
```

### Step 3 — 一鍵啟動
```bash
./scripts/start.sh        # macOS/Linux
./scripts/start.ps1       # Windows
```
腳本會：
1. 建立 `zeroclaw-net` docker network
2. Build agent base 映像（opencode + copilot）
3. `docker compose up -d` 啟動 API server + Web app

## 驗證
- API：`curl http://localhost:3000/health`
- Web：開 `http://localhost`

## 常用後續指令
- 看 API 日誌：`docker logs -f zeroclaw-api`
- 看 agent 容器：`docker ps --filter name=zeroclaw-`
- 重啟單一服務：`docker compose restart api-server`
- 完整關閉：`./scripts/stop.sh` / `./scripts/stop.ps1`

## 新增代理人
1. `agents/<your-id>/` 建資料夾
2. 寫 `AGENTS.md`（主指令）+ `.nanoclaw.json`（UI 顯示）
3. Opencode 走 `opencode.json`；Copilot 走 `.mcp.json` + `.agents/<n>.md`
4. 在 `groups.yaml` 把 `<your-id>` 加到某個 group 的 `agents` 清單
5. 重啟 API server（會熱重載 yaml；若新建 base image 才需重 build）
