---
name: quickstart
description: Zeroclaw 3 分鐘上手 — 從 git clone 到瀏覽器看到 Web UI 的最短路徑
---

# Zeroclaw Quickstart Skill

當使用者問「怎麼跑起來」「第一次安裝」「怎麼開始」時，套用這個流程。

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
最少需要：
```bash
# .env (專案根目錄)
JWT_SECRET=$(openssl rand -hex 32)
OPENAI_API_KEY=sk-...        # 或 ANTHROPIC_API_KEY
```

### Step 3 — 一鍵啟動
```bash
./scripts/start.sh        # macOS/Linux
./scripts/start.ps1       # Windows PowerShell
```
會做三件事：
1. 建立 docker network `zeroclaw-net`
2. Build agent base 映像（`zeroclaw/agent-base-opencode:latest` + `zeroclaw/agent-base-copilot:latest`）
3. `docker compose up -d` 啟動 `api-server` + `web-app`

## 驗證
- API：`curl http://localhost:3000/health`
- Web：開 `http://localhost`
- 預設管理員：見 `packages/api-server/scripts/seed.ts`

## 下一步
- 想新增代理人 → `agents/<id>/` 建資料夾，編輯 `AGENTS.md`，再到 `groups.yaml` 註冊
- 想了解事件流 → 讀 `docs/ARCHITECTURE.md` §4
- 想接 Telegram/Discord → 讀 `docs/ARCHITECTURE.md` §3 + `messaging/`
