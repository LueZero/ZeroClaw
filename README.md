# ZeroClaw Agent Platform

> Multi-tenant AI agent runtime — folder-as-agent · group routing · multi-channel ingress · dual-SDK (Copilot / Opencode) · Docker-isolated execution.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.x-orange.svg)](https://pnpm.io/)

ZeroClaw「是一個可獨立執行的 AI 代理人」，自動偵測 SDK（Copilot / Opencode）、自動容器化、依群組路由，串接 Web/Telegram/WhatsApp/Discord/Slack/Teams。

---

## ✨ 主要特性

| 能力 | 說明 |
|---|---|
| **資料夾即代理** | `agents/<name>/` 內放 `opencode.json` 或 `AGENTS.md`，平台自動偵測 SDK |
| **容器隔離** | 每個 (group × agent) 對應一個 Docker 容器，命名決定性、不重複 spawn |
| **群組路由** | `groups.yaml` 集中管理代理人分群、預設 agent、auto-routing |
| **多通道** | 同一 SessionManager 同時服務 Web / WS / Webhook（Telegram、WhatsApp、Discord、Slack、Teams） |
| **雙 SDK** | 同 group 可混用 Copilot 與 Opencode 代理 |
| **Agent Loop** | 公開 SDK 全部機制：hooks / MCP / skills / sub-agents / permissions / events |
| **延遲啟動** | Session 建立時不啟容器，第一則訊息才啟動，閒置自動 GC |
| **健康監控** | 容器 unhealthy 自動標記、Session 自動遷移 |
| **History Replay** | 容器重啟/遷移後自動回放最近 50 筆對話，agent 不失憶 |
| **MessagingGroup 管理** | Web UI 完整 CRUD wirings + 4 位數 pairing code 綁定通訊頻道 |
| **動態 Group 設定** | `/admin/groups` 即時調整代理人群組顯示名稱 / 描述 / 圖示 / 啟用狀態，無需重啟（v0.4.2） |
| **雙 DB 驅動** | PostgreSQL（推薦）/ SQLite 可切換，`DB_DRIVER` env 控制 |

---

## 🏗 架構速覽

```
┌────────────────────────────────────────────────┐
│  Web App (React + Vite)                        │
└──────────────────┬─────────────────────────────┘
                   │ HTTP + WebSocket
┌──────────────────▼─────────────────────────────┐
│  API Server (Fastify)                          │
│  ├─ REST  /api/{auth,groups,sessions,admin}    │
│  ├─ WS    /ws         (event 串流推送)          │
│  └─ Webhooks /webhook/{telegram,whatsapp,...}  │
│                                                │
│  SessionManager → ContainerManager             │
│         │                │                     │
│         ▼                ▼                     │
│  AgentProvider     Docker daemon               │
│  ├─ Copilot (JSON-RPC TCP)                     │
│  └─ Opencode (HTTP + SSE)                      │
└──────────────────┬─────────────────────────────┘
                   ▼
        ┌──────────────────────┐
        │  Agent Containers    │
        │  zeroclaw-{g}-{a}    │
        └──────────────────────┘
```

完整文件：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/DESIGN.md](docs/DESIGN.md) 

---

## 📦 專案結構

```
zeroclaw/
├── agents/                       # 你的代理人定義（資料夾即代理）
│   ├── faq-bot/                  # Opencode 代理（含 opencode.json）
│   └── code-reviewer/            # Copilot 代理（含 AGENTS.md）
├── images/                       # Base 容器映像
│   ├── agent-base.opencode/      # Opencode runtime
│   └── agent-base.copilot/       # Copilot runtime
├── packages/
│   ├── shared/                   # 共用型別 / 事件 / 錯誤
│   ├── api-server/               # 後端：Fastify + WS + Webhook
│   └── web-app/                  # 前端：React + Vite
├── groups.yaml                   # 群組與通道配置
├── docker-compose.yml
├── docs/
│   ├── DESIGN.md                 # 原始設計規格（部分章節已被 ARCHITECTURE 取代）
│   ├── ARCHITECTURE.md           # 目前實作架構（含設計決議）
│   └── REQUIREMENTS.md            # 需求與實作狀態總覽（含技術規格）
└── scripts/                      # 啟停腳本（.sh + .ps1 雙格式）
```

---

## 🚀 快速開始

### 必要條件

- **Node.js ≥ 20**
- **pnpm 10.x**（`npm i -g pnpm`）
- **Docker** + **Docker Compose**（部署模式）
- 至少一組 LLM 認證：
  - Opencode：`opencode providers login`（推薦）
  - 或直接設定 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`

### 1. 取得程式碼

```bash
git clone https://github.com/<your-org>/zeroclaw.git
cd zeroclaw
pnpm install
```

### 2. 設定環境變數

```bash
cp .env.example .env
# 編輯 .env 填入 JWT_SECRET 與 LLM 金鑰
```

關鍵變數：

| 變數 | 必填 | 說明 |
|---|---|---|
| `JWT_SECRET` | ✅ | 至少 32 字元的隨機字串 |
| `OPENCODE_AUTH_DIR` | Opencode 用 | 宿主機 `auth.json` 所在目錄（先執行 `opencode providers login`）|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | 二選一 | 直接設金鑰 |
| `HOST_AGENTS_DIR` | Docker 部署用 | 宿主機 `agents/` 絕對路徑（讓 API server 能掛載到子容器）|
| `DB_DRIVER` | — | `postgres`（預設）或 `sqlite` |
| `DATABASE_URL` | PostgreSQL 用 | 連線字串，Docker 內預設 `postgres://zeroclaw:zeroclaw-dev@zeroclaw-postgres:5432/zeroclaw` |
| `SQLITE_PATH` | SQLite 用 | 檔案路徑（預設 `data/platform.db`） |
| `TELEGRAM_BOT_TOKEN` 等 | 通訊軟體 | 對應通道才需填 |

### 3. 開發模式（不用 Docker，host 直跑）

```bash
pnpm dev          # 並行啟動 api-server (3000) + web-app (5173)
```

> ⚠️ host 模式下，agent 容器仍需要 Docker daemon（API server 透過 Docker socket 啟動子容器）。

開啟 http://localhost:5173 即可登入。

### 4. 部署模式（全 Docker）

```bash
# Linux / macOS
./scripts/start.sh

# Windows PowerShell
./scripts/start.ps1
```

腳本會：
1. 建立 `zeroclaw-net` Docker network
2. Build base 映像（`agent-base-opencode`、`agent-base-copilot`）
3. Build 並啟動 `api-server`、`web-app`

完成後：
- Web： http://localhost:5173
- API： http://localhost:3000/healthz

停止：

```bash
./scripts/stop.sh        # or stop.ps1
```

### 5. 撰寫第一個代理人

```bash
mkdir -p agents/my-bot/.opencode/agents
cat > agents/my-bot/opencode.json <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "agents": ["primary"]
}
JSON
cat > agents/my-bot/.opencode/agents/primary.md <<'MD'
---
mode: primary
description: My first ZeroClaw agent
---
You are a helpful assistant.
MD
```

把 `my-bot` 加進 `groups.yaml`：

```yaml
groups:
  - id: default
    agents: [my-bot]
    routing: { mode: explicit }
    container:
      baseImage: zeroclaw/agent-base-opencode:latest
      maxSessions: 10
```

`pnpm dev` 後在 Web App 即可選到 `my-bot` 開始對話。

---

## ⚠️ 注意事項

| 項目 | 說明 |
|---|---|
| **DB 預設改 PostgreSQL** | v0.4 起 `DB_DRIVER` 預設 `postgres`。本機開發不想裝 PG 可改 `DB_DRIVER=sqlite` |
| **`groups.yaml` 不再宣告 channels** | 通訊頻道配置全部走 DB + Web UI / Admin API。舊的 `channels:` 欄位會被 schema 拒絕 |
| **Docker 網路** | 容器間通訊使用 `zeroclaw-net` 外部網路，`DATABASE_URL` 內 hostname 需用 `zeroclaw-postgres`（非 `localhost`） |
| **History Replay** | 容器重啟後自動回放最近 50 筆訊息，不可調超過 200。replay 失敗不阻斷新對話 |
| **Admin 管理頁** | `/admin` 總覽 + `/admin/groups` 代理人群組調整 + `/admin/messaging-groups` 頻道管理。需 admin 角色 JWT |

---

## 📡 通訊平台配置

ZeroClaw 內建 5 個 messaging adapter：**Telegram / WhatsApp / Discord / Slack / Teams**。
共用流程：① 在 `.env` 填憑證 → ② 透過 Web UI 或 pairing code 綁定頻道 → ③ webhook 模式 adapter 需把 webhook 指向 `https://<your-domain>/webhooks/<platform>`。Telegram 預設走 polling，**不需要公開 URL**。

> webhook 模式部署本機可用 [ngrok](https://ngrok.com/) / [cloudflared](https://github.com/cloudflare/cloudflared) 暴露 `:3000` 取得 https URL。

### 共通：通訊頻道綁定

> **v0.3 起，`groups.yaml` 的 `channels` 欄位已移除。** 通訊頻道配置全部改用 DB + Web UI / Admin API，不再需要編輯 yaml。`groups.yaml` 只保留 group / agent / routing / container 設定。

綁定通訊頻道有三種方式：

#### 方式 A：互動式 Pairing code（推薦）

1. Web UI `/admin/messaging-groups` → 「產生綁定 code」
2. 在 modal 選 group / agent / engageMode / sessionMode
3. 取得 4 位數 code（例如 `4729`）
4. 在目標 chat 傳送 `4729` → bot 回覆「✅ 已綁定」

或用 API：
```bash
curl -X POST http://localhost:3000/api/pairings \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"groupId":"support","platform":"telegram"}'
```

#### 方式 B：Web UI 直接建

admin 已知 chatId，在 `/admin/messaging-groups` 手動新增 messaging group + wiring，立即生效。

#### 方式 C：首次 @bot 自動建

使用者首次 @bot → 自動建立 messaging group（待設定）→ admin 後台快速加 wiring。

> Code 不過期、單次使用。同一 (groupId, platform) 再建立新 code 會自動 invalidate 上一筆。

### Telegram

**預設用 polling 模式（免公開 URL，跟 nanoclaw 一樣只填 token 就能用）。**

| 項目 | 值 |
|---|---|
| `.env` | `TELEGRAM_BOT_TOKEN`（必填）；`TELEGRAM_MODE`（預設 `polling`，可改 `webhook`）；`TELEGRAM_WEBHOOK_SECRET`（webhook 模式才需要）|
| polling 模式 | 啟動後 adapter 自動跑 `getUpdates` 迴圈；不需要 ngrok / 公開 URL；啟動時會自動 `deleteWebhook` 避免衝突 |
| webhook 模式 | `POST https://<domain>/webhooks/telegram`；自行 `curl -F "url=..." -F "secret_token=..." https://api.telegram.org/bot<TOKEN>/setWebhook` |

### WhatsApp（Meta Cloud API）

| 項目 | 值 |
|---|---|
| `.env` | `WHATSAPP_ACCESS_TOKEN`、`WHATSAPP_VERIFY_TOKEN`、`WHATSAPP_PHONE_NUMBER_ID`、`WHATSAPP_APP_SECRET` |
| Verify URL | `GET https://<domain>/webhooks/whatsapp`（Meta 後台首次驗證會 GET，回 challenge）|
| Webhook URL | `POST https://<domain>/webhooks/whatsapp`（HMAC-SHA256 用 `WHATSAPP_APP_SECRET` 驗）|
| 設定位置 | Meta for Developers → 你的 App → WhatsApp → Configuration |

### Discord（Interactions endpoint）

| 項目 | 值 |
|---|---|
| `.env` | `DISCORD_BOT_TOKEN`、`DISCORD_PUBLIC_KEY` |
| Interactions URL | `POST https://<domain>/webhooks/discord`（Discord 用 Ed25519 簽章，adapter 會驗）|
| 設定位置 | Discord Developer Portal → 你的 Application → General Information → Interactions Endpoint URL |

### Slack（Events API）

| 項目 | 值 |
|---|---|
| `.env` | `SLACK_BOT_TOKEN`（`xoxb-…`）、`SLACK_SIGNING_SECRET` |
| Events URL | `POST https://<domain>/webhooks/slack`（首次會送 `url_verification`，adapter 自動回 challenge；之後以 `v0=` HMAC-SHA256 驗）|
| 設定位置 | api.slack.com → 你的 App → Event Subscriptions / OAuth & Permissions（給 bot scope: `chat:write`、`app_mentions:read` 等）|

### Microsoft Teams（Azure Bot Service）

| 項目 | 值 |
|---|---|
| `.env` | `TEAMS_APP_ID`、`TEAMS_APP_PASSWORD`、`TEAMS_APP_TENANT_ID`（SingleTenant 必填，MultiTenant 留空）|
| Messaging endpoint | `POST https://<domain>/webhooks/teams`（Bot Framework 會帶 `Authorization: Bearer <JWT>`）|
| 設定位置 | Azure Portal → Azure Bot resource → Configuration → **Messaging endpoint** |
| 前置作業 | Azure App Registration 取得 Application (client) ID + Client secret，並於 Azure Bot 安裝到 Teams channel |

### 啟用條件與行為

- adapter **只在對應 env 都填齊時才註冊**；未填的 adapter 不會佔用 webhook 路由
- 只填一半（例如 Teams 只填 `TEAMS_APP_ID` 但沒填 `TEAMS_APP_PASSWORD`）→ 不會註冊
- adapter 註冊後，啟動 log 會印 `Telegram adapter registered` / `Teams adapter registered` …
- Group 沒掛該平台的 channel → 訊息收到後會被丟棄（webhook 仍回 200 避免重送）

---

## 🧪 測試

```bash
pnpm test           # 各 package 單元測試（vitest）
pnpm test:e2e       # 端到端整合測試
pnpm typecheck      # 全工作區型別檢查
pnpm lint
```

---

## 📚 文件索引

| 文件 | 用途 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 目前實作架構與設計決議（§3.3 動態 Group override、§4.7 Messaging Group 參數詳解、§13 索引表） |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | 需求與實作狀態總覽（含技術規格、T-1~T-23 TODO、驗收標準） |
| [docs/DESIGN.md](docs/DESIGN.md) | 原始設計規格（架構決策、SDK 抽象、Container Pool、Group routing） |

---

## 🛣️ Roadmap

**已完成（v0.3 ~ v0.4.2）**：
- [x] History Replay（容器重啟/遷移後自動回放對話）
- [x] Per-session 並發鎖
- [x] ContainerPool 持久化（容器狀態寫 DB）
- [x] PostgreSQL 完整支援 + 雙驅動切換
- [x] MessagingGroup + Wiring Web UI 完整 CRUD
- [x] Session 生命週期限制（閒置超時、訊息上限、自動清理）
- [x] Auto-seed 預設 wiring（首次 @bot 自動綁定）（v0.4.1）
- [x] 動態 Group 設定 Web UI（displayName / icon / enabled 即時調整）（v0.4.2）

**進行中 / 計畫中**：
- [ ] Discord Gateway WSS（免公開 URL）
- [ ] Slack Socket Mode
- [ ] Image build content hash cache
- [ ] Rebuild / Restart Admin API
- [ ] OAuth / SSO 取代 dev-login
- [ ] OpenTelemetry 觀測層
- [ ] Rate limiting

---

## 🤝 參與貢獻

1. Fork → 建立 feature branch
2. `pnpm install && pnpm typecheck && pnpm test`
3. 提 PR；commit message 建議遵循 [Conventional Commits](https://www.conventionalcommits.org/)
4. CI 通過後 review、merge

回報問題請使用 GitHub Issues，附上：
- 復現步驟
- `pnpm typecheck` / `pnpm test` 輸出
- 容器 log（`docker logs zeroclaw-{group}-{agent}`）

---

## 📜 授權

[MIT](LICENSE) — 可商用、可修改、可再散布。

---

## 🙏 致謝

- 基於 [NanoClaw](https://github.com/qwibitai/nanoclaw.git) 設計演進而來
- Copilot SDK：[@github/copilot-sdk](https://github.com/github/copilot-sdk)
- Opencode SDK：[@opencode-ai/sdk](https://www.npmjs.com/package/@opencode-ai/sdk)
- Web 後端：[Fastify](https://fastify.dev/)
- 前端：[React](https://react.dev/) + [Vite](https://vitejs.dev/)
