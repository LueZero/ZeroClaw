# ZeroClaw — 需求與實作狀態總覽

> 版本：v0.5.0（2026-05-07）
> 對應文件：[ARCHITECTURE.md](ARCHITECTURE.md)、[DESIGN.md](DESIGN.md)
> 本文件為唯一需求來源，合併自原 `TODO.md` 與 `SPEC-multi-session-multiplex.md`（兩者已刪除）。

---

## 目錄

| § | 章節 | 說明 |
|---|---|---|
| [變更紀錄](#變更紀錄) | 版本 changelog | v0.1.0 ~ v0.4.2 |
| [1. 專案目標 / 非目標](#1-專案目標--非目標) | 目標 G1~G5、排除範圍 | |
| [2. 條列式需求 — 狀態一覽](#2-條列式需求--狀態一覽) | T-1~T-23 完整狀態（✅ / ❌）| |
| [3. 核心模型](#3-核心模型) | 三層 ID 架構、資料表 DDL | |
| [4. Engage Mode](#4-engage-mode) | pattern / mention / mention-sticky | |
| [5. Session Mode](#5-session-mode) | per-user / per-thread / shared / agent-shared | |
| [6. Fan-out 與未觸發訊息策略](#6-fan-out-與未觸發訊息策略) | drop / accumulate | |
| [7. 各平台串接規格](#7-各平台串接規格) | Adapter 解析責任、Webhook / Polling / Gateway、openDM | |
| [8. SessionManager 改動](#8-sessionmanager-改動) | `resolveMessagingSession` + `ensureContainer` | |
| [9. ContainerManager 改動](#9-containermanager-改動) | key 語意 + GC + maxSessions | |
| [10. Adapter 介面擴充](#10-adapter-介面擴充) | `supportsThreads` / `openDM?` / `IncomingMessage` 欄位 | |
| [11. Router 重寫](#11-router-重寫) | `message-processor.ts` 完整流程虛擬碼 | |
| [12. 需要移除的舊邏輯](#12-需要移除的舊邏輯) | `chat_bindings`、yaml channels、shortSessionId | |
| [13. Admin API 端點](#13-admin-api-端點) | 全部 `/api/admin/*` endpoints + pairing | |
| [14. 綁定流程](#14-綁定流程) | 方式 A Pairing / 方式 B Web UI / 方式 C 首次 @bot | |
| [15. 代理人切換機制](#15-代理人切換機制) | 指令前綴 / `/agent` 指令 / Web UI | |
| [16. Web UI 改動清單](#16-web-ui-改動清單) | MessagingGroupsPage 設計（已實作）| |
| [17. 通訊軟體互動案例](#17-通訊軟體互動案例) | 4 個端對端場景說明 | |
| [18. 資料持久化設計](#18-資料持久化設計) | `DbStore` 雙驅動 + PostgreSQL docker-compose | |
| [19. ContainerPool 持久化](#19-containerpool-持久化t-4) | T-4 方案與 `adoptFromDb` 流程 | |
| [20. 容器重啟歷史 replay](#20-容器重啟歷史-replayt-1) | T-1 `injectHistory` 實作 | |
| [21. 受影響檔案](#21-受影響檔案) | 各檔案改動摘要（19 個檔案）| |
| [22. 驗收](#22-驗收) | G1~G5 驗收條件 ✅ / ❌ | |
| [23. 開放議題](#23-開放議題) | O-2~O-5 未決議項目 | |
| [24. 未實作需求詳細說明](#24-未實作需求詳細說明) | T-5~T-32 詳細說明（含已完成項） | |
| [25. 已完成需求技術細節](#25-已完成需求技術細節) | T-1~T-11 完成後記錄 | |

---

## 變更紀錄

- **v0.5.0**（2026-05-07）：
  - **T-5 Image build cache content hash**：`ensureAgentImage` 改用 `computeContextHash(contextDir)` 計算 agent 目錄所有檔案的 SHA-256 hash（前 12 字元作 tag）；tag 格式從 `zeroclaw/agent-{id}:latest` 改為 `zeroclaw/agent-{id}:{hash}`；Docker daemon 有對應 image → 跳過 build；檔案內容變更 → 自動 rebuild。
  - **T-6 Rebuild API**：新增 `POST /api/admin/agents/:agentId/rebuild`（admin only）；清除 `builtImages` 快取 + 刪除舊 image + 重新 build + 重啟所有使用該 agent 的容器。`ContainerManager` 新增 `rebuildImage(agent, group)` 方法。
  - **T-32 Discord Gateway WSS**：Discord adapter 新增 Gateway 模式（`DISCORD_MODE=gateway`）；實作完整 IDENTIFY / HEARTBEAT / DISPATCH / RESUME / RECONNECT 流程；使用 Node.js 22 原生 `WebSocket`（不需額外套件）；指數退避重連（1s→2s→…→60s）；READY 事件自動取得 bot user ID。
  - **openDM 三平台實作**（§3.8）：Discord `POST /users/@me/channels { recipient_id }`；Slack `conversations.open { users }`；Teams `POST /v3/conversations { bot, members }`。
- **v0.4.4**（2026-05-02）：
  - **修正 `POST /api/admin/messaging-groups` 未 auto-seed wiring 的問題**（T-20 補完）：透過 Admin Web UI 手動新增 Messaging Group 時，REST endpoint 現在同樣自動 seed 預設 wiring（邏輯與 `message-processor.ts` 首次 @bot 路徑完全對齊）。平台為 `discord`/`slack`/`teams` 且 `isGroup=true` → `mention-sticky`；其餘 → `pattern '.'`；`sessionMode=per-user`、`ignoredMessagePolicy=accumulate`。
- **v0.4.3**（2026-05-02）：
  - **Group Override 擴充至 9 欄**：`group_overrides` 表新增 5 個欄位（`default_agent` / `max_sessions` / `routing_mode` / `routing_fallback` / `routing_auto_classifier_model`）；`db-store` / `pg-store` 同步 migration（後向相容 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`）；`groups-loader.applyOverride` 一併全部新欄位 merge 邏輯；`rest.ts` PATCH body / GET response 全面擴充。
  - **`/admin/groups` UI 全面重設計**：master-detail 佈局（左側 sidebar 群組清單 + 右側 4 section）；顯示全部欄位（含 yaml-only 唯讀）：Display（可改）/ Routing（可改）/ Container（maxSessions 可改，baseImage / mountAgentsDir / cpuLimit / memoryLimit 唯讀）/ Agents（chip 唯讀）；髒資料偵測（有改動才顯示 Save / Cancel）；Reset to yaml 按鈕。
  - **修正 web-app Admin page 跑版問題**：外層加 `height: 100vh; overflow: hidden`；登出按鈕移至 header。
- **v0.4.2**（2026-05-02）：
  - **動態 Group 設定 Override**（T-23）：新增 `group_overrides` 表 + Admin API `/api/admin/groups`（GET / PATCH / DELETE override）+ Web UI `/admin/groups` 頁面。可動態調整 4 個「安全欄位」：`displayName`、`description`、`icon`、`enabled`；PATCH 後 `groups.reload()` hot reload 重建 in-memory `groups` map。`agents` / `container.*` / `routing.*` 仍為 yaml-only，需重啟生效。
  - **移除無效欄位** `container.idleTimeoutSeconds`：yaml / `groups-schema.ts` / `shared/types.ts` / scaffold-agent skill 模板同步清理；GC 實際讀全域 env `CONTAINER_IDLE_TIMEOUT_SEC`。
  - **`groups.yaml` 參數文件化**：ARCHITECTURE.md §3.2 補上有序參數表（頂層 / groups / container / routing）與載入順序說明。
- **v0.4.1**（2026-05-02）：
  - **Auto-seed 預設 wiring**（T-20）：首次 @bot 自動建立 `messaging_groups` 時，同步以 `groups.list()[0]` + `defaultAgent` 寫入預設 wiring（threaded 群組 → `mention-sticky`，其餘 → `pattern '.'`，`sessionMode='per-user'`、`ignoredMessagePolicy='accumulate'`）。Zero-touch 接入。
  - **`ignoredMessagePolicy` 預設改 `accumulate`**：包含 auto-seed 路徑與 Web UI 「新增 Wiring」表單；admin 可手動改回 `drop`。
  - **Web UI 文案修正**：MessagingGroupsPage（`/admin/messaging-groups`）的「群組」欄位改為「代理人群組 (Agent Group)」並附 tooltip，避免與通訊軟體的「群組頻道」混淆。
  - **架構文件補完**：ARCHITECTURE.md §5.3 新增「容器命名規則 + Agent 自訂映像擴充」，說明 `agents/<id>/Dockerfile` 自訂映像流程與 `image_tag` 對應規則；釐清為何容器名仍維持 `zeroclaw-{group}-{agent}`、不採 base image 命名。
- **v0.4.0**（2026-05-01/02）：
  - History Replay（T-1）：`AgentProvider.injectHistory()` 在容器遷移/重啟時自動回放最近 50 筆訊息
  - db.saveMessage 修復（T-10）：user/assistant messageCount 分開 +1
  - AbortController 修復（T-10c）：signal 傳入 parseSseStream
  - DB 預設改 PostgreSQL、docker-compose DATABASE_URL 修正
  - Session auto-reopen：ended session 收到新訊息時自動恢復為 active（不再拋錯），只有 error 狀態不可恢復
- **v0.3.0**（2026-05-01）：
  - MessagingGroup / Wiring DB 架構、EngageMode、SessionMode
  - ContainerPool 持久化（T-4）、container per-(group,agent) 多路復用
  - 5 platform adapter 更新（threadId / isMention / isGroup）
  - message-processor routeInbound 重寫
  - PostgreSQL docker-compose 支援 + PostgreSQL driver 完整實作（T-11）
  - DbStore 介面全面 async
  - `/agent <id>` / `/agent off` 指令
  - Web UI messaging-groups 管理頁完整 CRUD
  - Per-session 並發鎖（T-2）、`evaluateEngage` mention-sticky async 修復
  - 三種綁定流程（pairing code / Web UI / 首次 @bot）
  - 三種切換代理人機制（指令前綴 / `/agents` `/agent` slash commands / Web UI）
  - `per-user` 升為預設 sessionMode；O-6 platformUserId 正式升為主規格
- **v0.2.0**（2026-05-01）：
  - chat_bindings 既有資料 0 筆 → 直接 DROP，不寫 migration
  - 加入 Discord Gateway WSS / Slack Socket Mode（adapter `start()` 主動連線）
  - 加入 `MessagingAdapter.openDM?()`（Discord/Slack/Teams）
  - 徹底移除 `groups.yaml.channels`：全 admin API + Web UI 配置
  - 新增 Web UI 改動清單（messaging-groups 管理頁）
  - 新增通訊軟體互動案例
- **v0.1.0**（2026-05-01）：初版草案

---

## 1. 專案目標 / 非目標

### 1.1 目標

| # | 目標 | 說明 |
|---|---|---|
| G1 | 容器多路復用 | 同 `(group, agent)` 全平台僅 1 個容器，內部 multiplex N 個 SDK session |
| G2 | 動態代理人路由 | 通訊軟體支援在同 chat 綁多個 agent，用 `@mention` / 指令前綴 / regex 觸發 |
| G3 | 平台串接對齊 | supportsThreads / isMention / isGroup / threadId / engage_mode / session_mode / openDM / Gateway 主動連線 |
| G4 | 清除舊邏輯 | 移除 `chat_bindings` / `groups.yaml.channels` / 容器 per-session 命名 / 不再使用的 admin 端點 |
| G5 | Admin Web UI | messaging-groups + wirings 完整 CRUD |

### 1.2 非目標

- 不重寫容器 runtime（opencode/copilot 雙進程）。
- 不做 setup CLI（nanoclaw `setup/channels/*` 風格）— 列為後續工作。
- 不做 access gate / unknown_sender_policy / channel_request_gate 行為（schema 預留欄位，行為一律放行）。

> 以下原列非目標已在後續版本完成：
> - ~~不改 AgentProvider 介面~~ → v0.4 新增 `injectHistory?()` optional method
> - ~~不做歷史 replay~~ → v0.4 完成 T-1 History Replay
> - ~~不重新設計訊息持久化~~ → v0.3 已新增 PostgreSQL 驅動，v0.4 設為預設。雙驅動架構（PostgreSQL + SQLite）

---

## 2. 條列式需求 — 狀態一覽

### 2.1 核心功能（已完成）

| ID | 需求 | 狀態 | 版本 | 實作說明 |
|----|------|------|------|----------|
| T-1 | 對話歷史 replay（跨容器復活） | ✅ | v0.4 | `AgentProvider.injectHistory()` optional method；`SessionManager.replayHistory()` 在 ensureContainer / migration / stale-session 三處呼叫；最近 50 筆 user/assistant 訊息回放 |
| T-2 | Per-session 並發鎖 | ✅ | v0.3 | `sessionLocks: Map<sessionId, Promise<void>>`；`handleMessage` 改為 lock wrapper，實際邏輯移至 `handleMessageBody`；同一 session 排隊處理 |
| T-3 | Session 生命週期限制 | ✅ | v0.3 | `MAX_SESSIONS_PER_USER`(20)、`SESSION_IDLE_TIMEOUT_SEC`(1800)、`SESSION_MAX_MESSAGES`(200)、`SESSION_RETENTION_DAYS`(30)；lifecycle timer 定期清理；ended session 收到新訊息時自動 reopen |
| T-4 | ContainerPool 持久化 | ✅ | v0.3 | `containers` 表；launch 時 upsert、invalidate/stop 時 remove；啟動時 DB + `docker ps` 交叉驗證 adopt |
| T-10 | db.saveMessage bug | ✅ | v0.4 | user/assistant `messageCount` 分開 +1，修正只有 count 累加但 messages 表未寫入的問題 |
| T-10c | Opencode event stream AbortController | ✅ | v0.4 | signal 傳入 `parseSseStream`，取代 duck-typing `closeStream()` 三段 fallback |
| T-11 | PostgreSQL 完整遷移 | ✅ | v0.3 | `pg-store.ts` 完整實作、`DbStore` 介面全面 async、`createDb()` factory 依 `DB_DRIVER` env 選擇驅動 |
| T-20 | Auto-seed 預設 wiring + ignoredMessagePolicy 預設 accumulate | ✅ | v0.4.1~0.4.4 | **兩個觸發路徑均已實作**：(1) `message-processor.ts`：通訊平台首次 @bot 自動建立 `messaging_groups` 時 seed；(2) `rest.ts POST /api/admin/messaging-groups`：Admin Web UI 手動新增時同樣 seed（v0.4.4 修正）。seed 規則：第一個 enabled group + `defaultAgent ?? agents[0]`；threaded 平台（discord/slack/teams）+ `isGroup=true` → `mention-sticky`；其餘 → `pattern '.'`；`sessionMode=per-user`、`ignoredMessagePolicy=accumulate`。Web UI 「新增 Wiring」表單預設 `ignoredMessagePolicy=accumulate` |
| T-21 | Web UI 「群組」欄位文案釐清 | ✅ | v0.4.1 | MessagingGroupsPage 改顯示「代理人群組 (Agent Group)」+ tooltip；ARCHITECTURE.md §4.7 補術語澄清 |
| T-22 | Agent 自訂 Dockerfile 擴充文件化 | ✅ | v0.4.1 | ARCHITECTURE.md §5.3 新增說明：實作早已存在（`agent.hasCustomDockerfile` + `ensureAgentImage`），僅補文件 |
| T-23 | 動態 Group 設定 Override（Web UI 可改 9 個欄位） | ✅ | v0.4.2~0.4.3 | `group_overrides` 表（SQLite + PG 雙驅動）+ `DbStore.{listGroupOverrides,getGroupOverride,upsertGroupOverride,deleteGroupOverride}` + `groups-loader` merge 邏輯與 `reload()` + Admin API GET/PATCH/DELETE `/api/admin/groups` + Web UI `/admin/groups` master-detail 頁面。**可 override**：`displayName` / `description` / `icon` / `enabled` / `defaultAgent` / `maxSessions` / `routingMode` / `routingFallback` / `routingAutoClassifierModel`。**yaml-only（唯讀顯示）**：`agents[]` / `baseImage` / `mountAgentsDir` / `resources.*` / `env` / `volumes` |
| T-5 | Image build cache content hash | ✅ | v0.5.0 | `computeContextHash` 遞迴 hash agent 目錄所有檔案（SHA-256 前 12 字元作 tag）；Docker daemon 有對應 image → 跳過 build |
| T-6 | Rebuild API | ✅ | v0.5.0 | `POST /api/admin/agents/:agentId/rebuild`（admin only）；清除快取 + 刪除舊 image + 重新 build + 重啟容器 |

### 2.2 平台串接（部分完成）

| ID | 需求 | 狀態 | 版本 | 實作說明 |
|----|------|------|------|----------|
| §3.5 | Telegram adapter | ✅ | v0.3 | `getMe` 拿 botUsername、`isMention` / `isGroup` / `threadId=null` |
| §3.5 | WhatsApp adapter | ✅ | v0.3 | `isMention=true`（DM-only）、`isGroup=false` |
| §3.5 | Slack adapter (webhook) | ✅ | v0.3 | `thread_ts → threadId`、`app_mention` → `isMention` |
| §3.5 | Discord adapter (webhook) | ✅ | v0.3 | `mentions` → `isMention`、thread/channel id |
| §3.5 | Teams adapter | ✅ | v0.3 | `entities[].mentioned` → `isMention`、`conversation.id` → `threadId` |
| T-32 | Discord Gateway WSS | ✅ | v0.5.0 | WSS `wss://gateway.discord.gg`；IDENTIFY / HEARTBEAT / RESUME / RECONNECT 完整實作；`DISCORD_MODE=gateway\|webhook` env 控制 |
| §3.7 | Slack Socket Mode | ❌ | — | WSS Socket Mode，需 `xapp-…` app-level token |
| §3.8 | openDM (Discord/Slack/Teams) | ✅ | v0.5.0 | Discord: `POST /users/@me/channels`；Slack: `conversations.open`；Teams: `POST /v3/conversations` |

### 2.3 Admin / API（部分完成）

| ID | 需求 | 狀態 | 版本 | 實作說明 |
|----|------|------|------|----------|
| §9 | messaging-groups CRUD API | ✅ | v0.3 | `GET/POST/DELETE /api/admin/messaging-groups`、wiring `GET/POST/PATCH/DELETE` |
| §13 | Web UI messaging-groups 管理頁 | ✅ | v0.3 | MessagingGroupsPage：群組列表、wiring CRUD、pairing code 產生、封鎖/解封 |
| §16.2 | `/agents` `/agent` 指令 | ✅ | v0.3 | message-processor 攔截保留指令，列出/切換/關閉全收 agent |
| T-6 | Rebuild API | ✅ | v0.5.0 | `POST /api/admin/agents/:agentId/rebuild` 強制 rebuild image + 重啟容器 |
| T-8 | 完整管理 API | ❌ | — | restart / PUT groups 線上改 yaml + 熱重載 |

### 2.4 尚未實作

| ID | 需求 | 優先級 | 說明 |
|----|------|--------|------|
| T-7 | 跨平台帳號綁定 (user 層) | 🟡 中 | `POST /api/users/me/bind { platform, externalId }` + verification flow |
| T-8 | 完整管理 API | 🟡 中 | restart / rebuild / PUT groups 線上改 yaml + 熱重載 |
| T-9 | Partial assistant message 落盤 | 🟡 中 | 每 N 個 chunk 或 5 秒 upsert 部分內容，避免中途錯誤丟整段 |
| T-12 | OAuth / SSO | 🟢 低 | 取代 dev-login；GitHub / Google OIDC |
| T-13 | 容器 metrics / Prometheus | 🟢 低 | `/metrics` endpoint |
| T-14 | 檔案上傳 API | 🟢 低 | `POST /api/uploads` |
| T-15 | UI i18n | 🟢 低 | 字串抽取到 JSON 語言檔 |
| T-16 | MessagingAdapter plugin 動態載入 | 🟢 低 | adapters 自動 glob + 註冊 |
| T-17 | LLM API Key 管理 | 🔒 安全 | Vault / AWS Secrets Manager 待決 |
| T-18 | 容器網路 egress 白名單 | 🔒 安全 | iptables sidecar 或自訂 network 待決 |
| T-19 | Rate limiting | 🔒 安全 | token bucket 策略待決 |

---

## 3. 核心模型

### 3.1 三層 ID 架構

```
┌─────────────────────────────────────────────────────────────────────┐
│ 容器層      Container  key=(groupId, agentId)             1 個      │
│ ────────────────────────────────────────────────────────────────    │
│ SDK 層      SDK Session  per sessionId                    N 個      │
│ ────────────────────────────────────────────────────────────────    │
│ 應用層      zeroclaw sessions 表 row                                │
│            web:        per click "新對話"   （userId, groupId, agent）│
│            messaging:  per (group, agent, mg, thread, sessionMode)  │
└─────────────────────────────────────────────────────────────────────┘
```

- **容器命名**：`zeroclaw-{groupId}-{agentId}`（去掉現行的 `-{sessionShort}` 後綴，唯一性 1:1，API server 重啟可 adopt）
- **SDK Session**：容器內 multiplex，`session.create / sendMessage / closeSession` 全部走 sdkSessionId 隔離；不同使用者彼此看不到對方對話
- **maxSessions**：容器內 SDK session 上限（`group.container.maxSessions`）；達上限時新 session 拒絕（與既有錯誤型別 `containerLaunchFailed` 一致）

### 3.2 資料表 Schema

| 表 | 角色 |
|---|---|
| `messaging_groups` | 一個 chat/頻道/DM = 1 列；`(platform, platform_chat_id)` 唯一 |
| `messaging_group_agents` | wiring：在此 chat 內由哪個 `(group, agent)` 接 + engage 規則 + session 模式 |
| `sessions` | 所有 session（web + messaging）；含 `messaging_group_id` / `thread_id` / `platform_user_id` |
| `containers` | 持久化容器狀態；啟動時與 `docker ps` 交叉驗證 |
| `messages` | 所有對話訊息 |

#### messaging_groups DDL

```sql
CREATE TABLE messaging_groups (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  platform_chat_id TEXT NOT NULL,
  is_group INTEGER NOT NULL DEFAULT 0,         -- 1=group/channel, 0=DM
  unknown_sender_policy TEXT NOT NULL DEFAULT 'allow',  -- 預留：allow|drop|approval
  denied_at TEXT,                               -- 預留
  created_at TEXT NOT NULL,
  UNIQUE(platform, platform_chat_id)
);
```

#### messaging_group_agents DDL

```sql
CREATE TABLE messaging_group_agents (
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  engage_mode TEXT NOT NULL,                   -- pattern|mention|mention-sticky
  engage_pattern TEXT,                          -- regex；'.' = always
  session_mode TEXT NOT NULL DEFAULT 'per-user',  -- per-user|per-thread|shared|agent-shared
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',  -- drop|accumulate
  created_at TEXT NOT NULL,
  PRIMARY KEY (messaging_group_id, group_id, agent_id)
);
```

#### sessions 補欄位

```sql
ALTER TABLE sessions ADD COLUMN platform_chat_id TEXT;
ALTER TABLE sessions ADD COLUMN thread_id TEXT;
ALTER TABLE sessions ADD COLUMN messaging_group_id TEXT;
ALTER TABLE sessions ADD COLUMN platform_user_id TEXT;
CREATE INDEX sessions_messaging_lookup
  ON sessions(group_id, agent_id, messaging_group_id, thread_id, platform_user_id)
  WHERE platform != 'web';
```

#### containers DDL

```sql
CREATE TABLE IF NOT EXISTS containers (
  container_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  image_tag TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);
```

---

## 4. Engage Mode（觸發模式）

| 模式 | 觸發條件 | 適用情境 |
|---|---|---|
| `pattern` | regex 比對。`'.'` = 永遠觸發；regex 壞掉 → fail-open | 指令前綴：`^/dev`、DM 全收：`.` |
| `mention` | `incoming.isMention === true`（adapter 解析 `@bot` / `<@U…>`） | 群組內必須 @ 才回 |
| `mention-sticky` | isMention=true **OR** 該 thread 已有 session（黏著該 thread） | Slack/Discord thread 持續對話 |

- regex 壞掉 fail-open 是刻意設計：讓 admin 在 chat 內看到回應後自修，不要靜默吞掉訊息。

---

## 5. Session Mode（會話模式）

| 模式 | session 查詢 key | 說明 |
|---|---|---|
| `per-user`（**預設**） | `(group, agent, mg, platformUserId)` | 同 chat 內每個 user 獨立 session — **DM 和群組通用預設** |
| `per-thread` | `(group, agent, mg, thread, platformUserId)` | threaded 平台的進階隔離：thread × user 雙維度 |
| `shared` | `(group, agent, mg)` | 整個 chat 共用一個 session（客服共看上下文時選用；**⚠️ 多 user 會互相干擾**） |
| `agent-shared` | `(group, agent)` | 跨 chat 跨 user 完全共用（極少用，⚠️ 文件警告） |

**Router 規則**：
- 若 `adapter.supportsThreads === true` AND `mg.is_group === 1` AND `wiring.sessionMode !== 'agent-shared'`：強制升為 `per-thread`（會帶 platformUserId 維度）
- Pairing 預設值：DM-only 平台 → `per-user`；threaded 平台 → `per-thread`
- `shared` / `agent-shared` 需明確選擇，UI 顯示紅色警告

### 5.1 platformUserId 維度（O-6 已正式升為主規格）

- `sessions` 表的 `platform_user_id TEXT` 欄位強制寫入
- `resolveMessagingSession` lookup key 加上 `platformUserId` 維度（**僅當** `sessionMode !== 'agent-shared'`）
- 這樣同 chat 內多 user 自然分流，不會互相干擾

---

## 6. Fan-out 與未觸發訊息策略

router 對每則 incoming 評估**全部** wiring：

| 狀況 | 行為 |
|---|---|
| 命中 | 該 wiring 的 (group, agent) 進入 agent loop（獨立 session、獨立回應） |
| 未命中 + `ignoredMessagePolicy = 'accumulate'` | 寫入該 wiring 對應 session 為 user message，但不喚起 agent（context 累積，下次 engage 時可見） |
| 未命中 + `ignoredMessagePolicy = 'drop'` | 略過 |

---

## 7. 各平台串接規格

### 7.1 Adapter 解析責任

| 資訊 | 由誰填 | 用途 |
|---|---|---|
| `incoming.isMention` | adapter 端解析（含 bot 自身 username/userId 比對） | engage_mode='mention' / 'mention-sticky' 觸發 |
| `incoming.isGroup` | adapter | router 強制 per-thread 的判斷 |
| `incoming.threadId` | adapter（不支援 thread → null） | session 索引 |
| adapter 屬性 `supportsThreads` | adapter | router 拋棄 threadId / 升 per-thread |

### 7.2 各平台規則

| Platform | supportsThreads | isMention 規則 | threadId | isGroup | 連線模式 |
|---|---|---|---|---|---|
| Telegram | false | `@{botUsername}` 或 reply_to bot | null | `chat.type !== 'private'` | polling ✅ / webhook ✅ |
| WhatsApp | false | true（DM-only） | null | false | webhook only |
| Slack | true | `<@{botUserId}>` 或 `app_mention` | `thread_ts ?? ts` | `channel_type !== 'im'` | webhook ✅ / socket ❌ |
| Discord | true | mentions 含 bot id | thread.id ?? channel.id | `guild_id != null` | webhook ✅ / gateway ❌ |
| Teams | true | entities[].mentioned | conversation.id | `conversationType==='channel'` | webhook only |

### 7.3 Connection Mode（webhook / polling / gateway）

各平台的主動連線模式由 adapter 在 `start?(runtime)` 中實作；webhook-only 平台略過此方法。

| Platform | 預設模式 | 環境變數 | webhook 端點 | 主動連線 |
|---|---|---|---|---|
| Telegram | polling | `TELEGRAM_MODE=polling\|webhook` | `POST /webhooks/telegram` | `getUpdates` long-poll（既有） |
| Discord | **gateway**（待實作） | `DISCORD_MODE=gateway\|webhook` | `POST /webhooks/discord` | WSS `wss://gateway.discord.gg`（HELLO → IDENTIFY → HEARTBEAT → DISPATCH） |
| Slack | **socket**（待實作） | `SLACK_MODE=socket\|webhook` | `POST /webhooks/slack` | WSS（Socket Mode、需要 app-level token `xapp-…`） |
| WhatsApp | webhook | — | `POST /webhooks/whatsapp` | 不支援 |
| Teams | webhook | — | `POST /webhooks/teams` | 不支援 |

Gateway / Socket Mode 啟動時將 `TELEGRAM_BOT_TOKEN` / `DISCORD_BOT_TOKEN` / `SLACK_APP_TOKEN` 等視為必填；缺欄位時 fall back 到 webhook 模式並 logger.warn。

### 7.4 openDM（cold DM）

`MessagingAdapter.openDM?(userHandle: string): Promise<string>` — 回傳該 user 對應的 DM `chatId`，供 host 主動發起冷 DM（approval 通知、pairing 反向流程、agent 主動推送）。

| Platform | 是否實作 | 實作方式 |
|---|---|---|
| Telegram | 不需要 | userId === chatId，直接 send |
| WhatsApp | 不需要 | phone number === chatId |
| Discord | ❌ 待實作 | `POST /users/@me/channels { recipient_id }` → `id` |
| Slack | ❌ 待實作 | `conversations.open { users }` → `channel.id` |
| Teams | ❌ 待實作 | `POST /v3/conversations { bot, members }` → `id` |

---

## 8. SessionManager 改動

### 8.1 新方法 resolveMessagingSession

```ts
resolveMessagingSession(args: {
  userId: string;
  groupId: string;
  agentId: string;
  messagingGroupId: string;
  threadId: string | null;
  platform: Platform;
  platformChatId: string;
  platformUserId: string;
  sessionMode: 'per-user' | 'per-thread' | 'shared' | 'agent-shared';
}): Promise<SessionRecord>
```

依 sessionMode 計算 lookup key：
- `agent-shared`: `(group, agent)`（platform 維度忽略）
- `shared`: `(group, agent, mg, platformUserId)`
- `per-thread`: `(group, agent, mg, thread, platformUserId)`
- `per-user`: `(group, agent, mg, platformUserId)`

`db.findMessagingSession({...})` 命中 → return；否則建立 `status='pending'` 新 row。

### 8.2 既有 createOrGet

保留供 web 使用，每次都 `randomUUID()`（與目前一致）。

### 8.3 ensureContainer / handleMessage 改動

- `containers.acquire(group, agent)` 拿掉 sessionId 參數
- `containers.attachSession(containerId, sdkSessionId)` 帶上 sdkSessionId
- 容器失效遷移邏輯不變（migrate 時重新 `acquire` 同個容器名 + `provider.createSession` 取新 sdkSessionId）

---

## 9. ContainerManager 改動

| 項目 | 現況 | 改後 |
|---|---|---|
| key | `groupId::agentId::sessionId` | `groupId::agentId` |
| 容器名 | `zeroclaw-{g}-{a}-{shortSession}` | `zeroclaw-{g}-{a}` |
| `acquire(group, agent, sessionId)` | 簽名含 sessionId | `acquire(group, agent)` |
| Entry | `instance/provider/docker` | + `activeSdkSessions: Set<string>` |
| `attachSession(containerId)` | 計數 +1 | `attachSession(containerId, sdkSessionId)` 加入 set |
| `detachSession(containerId)` | 計數 -1 | `detachSession(containerId, sdkSessionId)` set.delete |
| GC 條件 | `idleSec > T && sessionCount === 0` | `idleSec > T && activeSdkSessions.size === 0` |
| `maxSessions` 語意 | 同 (group, agent) 容器數上限 | 容器內 SDK session 上限（回到原意） |
| `restart(containerId, group, agent, sessionId)` | 含 sessionId | `restart(containerId, group, agent)` |

廢棄：`shortSessionId()`、`agentScopeOf()`。

---

## 10. Adapter 介面擴充

[adapter.ts](../packages/api-server/src/messaging/adapter.ts)：
```ts
export interface MessagingAdapter {
  readonly platform: Platform;
  readonly supportsThreads: boolean;            // 新增
  // ...既有方法
  start?(runtime: MessagingAdapterRuntime): Promise<void>;   // 已存在；Discord/Slack 補實作
  stop?(): Promise<void>;
  openDM?(userHandle: string): Promise<string>; // 新增（optional）
}
```

[shared/types.ts](../packages/shared/src/types.ts) `IncomingMessage`：
```ts
export interface IncomingMessage {
  // ...
  threadId?: string | null;    // 新增
  isMention?: boolean;         // 新增
  isGroup?: boolean;           // 新增
}
```

各 adapter 補完 parsing（§7.2 表格）。Telegram adapter 在 `start()` 時跑 `getMe` 拿 botUsername 並快取。Discord/Slack 在 `start()` 啟動 Gateway/Socket Mode WSS（§7.3）。

---

## 11. Router 重寫

[message-processor.ts](../packages/api-server/src/messaging/message-processor.ts) 流程：

```
processIncomingMessages(adapter, messages):
  for incoming of messages:
    # (1) pairing 短路
    if pairing.tryConsume(text, platform, chatId).matched:
      adapter.send(✅ 綁定成功訊息); continue

    # (2) thread 政策
    if !adapter.supportsThreads: incoming.threadId = null

    # (3) messaging_group 解析 / 自動建立
    mg = db.getMessagingGroup(platform, chatId)
    if !mg:
      if !incoming.isMention: continue                         # 沒 @ 不開 row
      mg = db.upsertMessagingGroup(platform, chatId, isGroup)

    wirings = db.listMessagingGroupAgents(mg.id)
    if wirings.length === 0:
      if incoming.isMention:
        logger.warn('no_agent_wired', mg.id)
      continue

    # (4) sender 解析
    user = auth.getOrCreatePlatformUser(platform, platformUserId, ...)

    # (5) fan-out
    for wiring of wirings:
      group = groups.get(wiring.groupId);  if (!group) continue
      agent = agents.tryGet(wiring.agentId); if (!agent) continue

      engages = evaluateEngage(wiring, incoming.text, incoming.isMention, mg.is_group, threadId, db)

      effectiveSessionMode =
        adapter.supportsThreads && mg.is_group && wiring.sessionMode !== 'agent-shared'
          ? 'per-thread' : wiring.sessionMode

      if engages:
        session = sessions.resolveMessagingSession({user, group, agent, mg, thread, sessionMode})
        void runAgentAndReply(adapter, incoming, session.sessionId)

      else if wiring.ignoredMessagePolicy === 'accumulate':
        session = sessions.resolveMessagingSession({...})
        db.saveMessage({sessionId, role:'user', content: incoming.text})
        # 不啟 agent loop
```

`evaluateEngage` 完全照 [nanoclaw router.ts](../../nanoclaw/src/router.ts) `evaluateEngage`。

---

## 12. 需要移除的舊邏輯

| 項目 | 位置 | 處置 |
|---|---|---|
| `chat_bindings` 表 | db-store.ts | 啟動時直接 `DROP TABLE IF EXISTS chat_bindings`（DB 確認 0 筆，無 migration 需求） |
| `getChatBinding` / `listChatBindings` / `deleteChatBinding` / `upsertChatBinding` | db-store.ts | 刪除 |
| `GET /api/bindings` / `DELETE /api/bindings/:platform/:chatId` | rest.ts | 刪除（被新 admin API 取代） |
| `groups.yaml.channels` 欄位 + `ChannelConfigSchema` | groups-schema.ts | **刪除**：全部改用 admin API + Web UI 配置 |
| `message-processor.ts` 內「yaml channels 精確匹配」與 `chat_bindings` fallback 兩條路徑 | message-processor.ts | 刪除：執行期只查 `messaging_groups` |
| `containers.acquire` 內 maxSessions 改回容器內語意 | container-manager.ts | 邏輯改寫 |
| 容器命名 `shortSessionId` 後綴 + helper | container-manager.ts | 移除 |
| `agentScopeOf` helper | container-manager.ts | 移除 |
| `restart(containerId, group, agent, sessionId)` 簽名 | container-manager.ts | 拿掉 sessionId |
| `routing.mode === 'round-robin'` | groups-schema.ts + session-manager.ts | **保留**（不刪，實作便宜） |

**配置單一來源 = DB**：admin 透過 Web UI / API 建立 `messaging_groups` + wirings；無 yaml 路徑可同步。`groups.yaml` 只保留 group / agent / routing / container 設定，不再宣告 channels。

---

## 13. Admin API 端點

| Method | Path | Body / Response |
|---|---|---|
| `GET` | `/api/admin/messaging-groups` | `[{id, platform, platformChatId, isGroup, wirings:[{groupId,agentId,engageMode,engagePattern,sessionMode,ignoredMessagePolicy}]}]` |
| `POST` | `/api/admin/messaging-groups` | `{platform, platformChatId, isGroup}` → 手動建立（通常由 pairing / 首訊自動建） |
| `PATCH` | `/api/admin/messaging-groups/:mgId` | `{unknownSenderPolicy?, denied?}` |
| `DELETE` | `/api/admin/messaging-groups/:mgId` | 204（cascade 刪 wirings + sessions 解除關聯） |
| `GET` | `/api/admin/messaging-groups/:mgId/wirings` | `[wiring...]` |
| `POST` | `/api/admin/messaging-groups/:mgId/wirings` | `{groupId, agentId, engageMode, engagePattern?, sessionMode?, ignoredMessagePolicy?}` → 201 + wiring |
| `PATCH` | `/api/admin/messaging-groups/:mgId/wirings/:groupId/:agentId` | 同上欄位（部分更新） |
| `DELETE` | `/api/admin/messaging-groups/:mgId/wirings/:groupId/:agentId` | 204 |
| `POST` | `/api/admin/messaging-groups/:mgId/open-dm` | `{userHandle}` → 呼叫 adapter.openDM，回 `{chatId}`（用於主動發起 DM） |
| `POST` | `/api/pairings` | `{groupId, platform, agentId?, engageMode?, engagePattern?, sessionMode?}` → 回傳 4 位數 code |

### 13.1 Pairing 預設值

- `agentId`：group.defaultAgent ?? group.agents[0]
- `engageMode`：DM-only platform (Telegram/WhatsApp) → `'pattern'` + `'.'`；group platform (Slack/Discord/Teams) → `'mention-sticky'`
- `sessionMode`：`'per-thread'`（router 會在 supportsThreads=false 自動退化為 `'shared'`）

`tryConsume` 命中時：
1. `upsertMessagingGroup(platform, chatId, isGroup)`
2. `addMessagingGroupAgent(mgId, groupId, agentId, opts)`
3. 回覆訊息：`✅ 已綁定到群組「{groupId}」由代理人 {agentId} 接收。如要新增其他代理人，請在管理介面操作。`

---

## 14. 綁定流程

### 方式 A：Pairing code（互動式，最常用）

```
admin 後台：
  1. /admin/messaging-groups → 「產生綁定 code」
  2. 在 modal 選：group, agent, engageMode, pattern, sessionMode
  3. POST /api/pairings → 回傳 code "4729"
  4. 把 4729 給目標使用者

使用者：
  1. 在目標 chat 私訊 bot 打 "4729"
  2. bot 回 "✅ 已綁定到 {group} / {agent}"
  3. 之後任何訊息都走 wiring 路由
```

### 方式 B：Web UI 直接建（admin 知道 chatId）

admin 手上已有 chatId（例：Slack `C0123ABC`），直接在 Web UI 建 messaging_group + wiring。
無 code 步驟，立即生效。

### 方式 C：首次 @bot 升級給 admin（最佳零摩擦體驗）

```
使用者首次在新 chat 打 "@bot 在嗎？"
  → router 找不到 wiring
  → bot 自動回：
    "嗨！這個 chat 還沒設定代理人。請管理員在後台設定後就能回覆您了。"
  → Admin 後台「待審 chat」列表出現此 chat（messaging_group row 已建立，agentCount=0）
  → Admin 點「快速設定 wiring」一鍵完成
  → 使用者下一句訊息立即被路由
```

實作：`messaging_groups` 在首次 `isMention` 時自動建立（已在 §11 router 定義）；`GET /api/admin/messaging-groups?hasWirings=false` 列出待審 chat。

---

## 15. 代理人切換機制

### 15.1 機制 1：指令前綴（admin 配置多 wiring）

Admin 建多個 wiring + 不同 engage pattern：
```
wiring(dev-bot, pattern='^/dev')
wiring(qa-bot,  pattern='^/qa')
```
使用者打 `/dev 看 PR` → dev-bot 接；打 `/qa 跑測試` → qa-bot 接。切換完全透過訊息前綴，無需特殊指令。

### 15.2 機制 2：保留指令 `/agents` / `/agent`

Bot 內建系統指令（router 在 pairing 短路之前攔截，不路由給任何 agent）：

| 指令 | 行為 | 狀態 |
|---|---|---|
| `/agents` | 列出此 chat 可用的所有 wired agents | ✅ |
| `/agent <agentId>` | 切換 chat 的「預設全收 agent」（在 DB 中把舊 `pattern='.'` wiring 標 inactive，建新 wiring `pattern='.'`） | ✅ |
| `/agent off` | 關閉全收 agent（訊息需明確 @ 才回覆） | ✅ |

保留指令 pattern：`^/(agents?|agent\s+\S+)$`（case-insensitive）

### 15.3 機制 3：Web UI（admin 操作，立即生效）

Admin 在 `/admin/messaging-groups` 修改 wiring：任意增刪改，不需 reload。✅

### 15.4 agent 切換時的 session 行為

- 新 wiring（不同 agentId）= 新 session（新 SDK session + 新容器，如有需要）
- 舊 session 繼續存在 DB；使用 `/agent off` 再 `/agent oldBot` 可恢復舊 session（resumeSession 邏輯：根據 lookup key 找到 existing session）
- 若舊 session 的容器已回收 → 容器重啟 + history replay（§20）

---

## 16. Web UI 改動清單

### 16.1 頁面結構

新頁面：`/admin/messaging-groups`（admin only，路由保護沿用既有 `requireAdmin`）。✅

```
┌─ Messaging Groups ──────────────────────────────────────────────┐
│ [+ 新增 Messaging Group]   [刷新]                                │
│                                                                  │
│  Platform   ChatId               IsGroup  Wirings  Actions       │
│  ────────   ──────────────────   ───────  ───────  ─────────     │
│  telegram   123456789            DM       1        [展開] [刪除] │
│  ▼ 展開 ─────────────────────────────────────────────────────    │
│    Group     Agent      Engage Mode      Pattern    Session Mode │
│    cs-team   alice      pattern          .          per-thread   │
│    [+ 新增 wiring]  [編輯]  [刪除 wiring]                         │
│  slack      C0123ABC            Channel  2        [展開] [刪除]  │
└──────────────────────────────────────────────────────────────────┘
```

### 16.2 互動細節

- **新增 Messaging Group 表單**：`platform`（下拉）、`platformChatId`（input）、`isGroup`（checkbox）→ POST `/api/admin/messaging-groups`
- **新增 wiring 表單**（在展開區內）：
  - `groupId`（下拉，從 `/api/groups` 拉）
  - `agentId`（下拉，依 groupId 動態載 `/api/groups/:id/agents`）
  - `engageMode`（下拉：pattern / mention / mention-sticky）
  - `engagePattern`（input，僅 engageMode=pattern 時顯示；預設 `.`，附 hint「`.` = 永遠觸發；`^/dev` = 指令前綴」）
  - `sessionMode`（下拉：per-thread / shared / agent-shared，預設 per-thread）
  - `ignoredMessagePolicy`（下拉：drop / accumulate，預設 drop）
- **`'.'` pattern 警告**：若該 mg 已有另一個 `pattern='.'` 的 wiring，跳 confirm 視窗：「此 chat 已有全收 agent，新增後兩個 agent 都會收到所有訊息，確定？」
- **Pairing 整合**：頁面頂部加「產生 4 位數綁定 code」按鈕 → 開 modal 選 group + agent + engage 設定 → POST `/api/pairings` → 顯示 code 給 admin 在 chat 輸入
- **open-dm 動作**：每個 wiring 旁加「主動 DM」按鈕（僅 Discord/Slack/Teams 顯示）→ 輸入 userHandle → POST open-dm → 顯示結果

### 16.3 store.ts 新 state

```ts
interface State {
  // ...既有
  messagingGroups: MessagingGroup[];
  loadMessagingGroups(): Promise<void>;
  createMessagingGroup(...): Promise<void>;
  deleteMessagingGroup(id: string): Promise<void>;
  addWiring(mgId: string, wiring: WiringInput): Promise<void>;
  updateWiring(...): Promise<void>;
  removeWiring(mgId: string, groupId: string, agentId: string): Promise<void>;
}
```

### 16.4 路由 + 導覽

App.tsx 加 `<Route path="/admin/messaging-groups" element={<MessagingGroupsPage />} />`；admin layout 側欄加連結。

---

## 17. 通訊軟體互動案例

### 案例 1：Telegram 1 對 1 私訊（最簡單）

**目標**：A 使用者私訊 bot，整段對話都由 `alice` 代理人處理。

**admin 配置**：
```
MessagingGroup:
  platform        = telegram
  platformChatId  = 123456789      (A 的 telegram user id；pairing 流程會自動填)
  isGroup         = false

Wiring:
  group         = customer-service
  agent         = alice
  engageMode    = pattern
  engagePattern = .                (永遠觸發 — DM 沒有 @ 概念)
  sessionMode   = per-thread       (router 自動退化為 shared，因為 supportsThreads=false)
```

**互動序列**：
```
A → bot:  你好               → router: 命中 wiring(alice) → resolveMessagingSession
                                      → 找不到 session → 建 sess-001
                                      → containers.acquire(cs-team, alice) → 啟容器 c-cs-alice
                                      → provider.createSession() → sdk-001
                                      → agent loop → 回覆

A → bot:  幫我看訂單         → router: 命中 wiring(alice) → resolveMessagingSession
                                      → 找到 sess-001 (key: cs-team+alice+mg-1+null)
                                      → 容器已存在 c-cs-alice、sdk-001 仍活著
                                      → 直接 sendMessage(sdk-001) → 回覆
```

**容器數**：1（`zeroclaw-cs-team-alice`）| **SDK session 數**：1

---

### 案例 2：Telegram 群組（多成員、多代理人指令分流）

**目標**：在 Telegram 群組內，`@bot /dev …` 找開發代理、`@bot /qa …` 找測試代理；其他訊息忽略。

**admin 配置**：
```
MessagingGroup:
  platform        = telegram
  platformChatId  = -100123456789  (group chat id)
  isGroup         = true

Wiring 1:
  group         = engineering
  agent         = dev-bot
  engageMode    = pattern
  engagePattern = ^/dev\b
  sessionMode   = shared           (整群共用一個 session)

Wiring 2:
  group         = engineering
  agent         = qa-bot
  engageMode    = pattern
  engagePattern = ^/qa\b
  sessionMode   = shared
```

**互動序列**：
```
A → group: 大家好                  → router: 兩個 wiring 都不命中 → drop
A → group: /dev 看 PR-123          → router: wiring(dev-bot) 命中 → sess-A-dev → 容器 c-eng-dev
                                            wiring(qa-bot) 不命中 → 略過
                                   → dev-bot 在群組回覆
B → group: /qa 跑回歸測試           → router: wiring(qa-bot) 命中 → sess-B-qa → 容器 c-eng-qa
                                   → qa-bot 在群組回覆
```

**容器數**：2（`zeroclaw-engineering-dev-bot` + `zeroclaw-engineering-qa-bot`）| **SDK session 數**：依 wiring + user 而定

> ⚠️ sessionMode='shared' 在 group chat 多 user 場景下有干擾風險。由於 O-6 已升為主規格，`shared` 模式的 lookup key 現在也包含 `platformUserId`，同 chat 多 user 會自然分流。

---

### 案例 3：Slack thread mention-sticky（最佳體驗）

**目標**：Slack 頻道內 `@nano` 起頭問問題後，整個 thread 由同一個 agent 回覆，不用每訊息都 @。

**admin 配置**：
```
MessagingGroup:
  platform        = slack
  platformChatId  = C0123ABCD       (channel id)
  isGroup         = true

Wiring:
  group         = customer-service
  agent         = alice
  engageMode    = mention-sticky
  sessionMode   = per-thread        (router 強制；Slack supportsThreads=true)
```

**互動序列**：
```
A 在 channel: 大家好                      → router: 沒 isMention → drop
A 在 channel: @nano 幫我查訂單            → router: isMention=true、threadId=ts-1
                                          → wiring(alice) 命中 → sess-A-thread1 → 容器 c-cs-alice
                                          → alice 在 thread 內回覆 (replyToMessageId=ts-1)
A 在同 thread: 那訂單金額多少？           → router: isMention=false，但...
                                          → mention-sticky：findSession(alice, mg, threadId=ts-1) 命中
                                          → 仍視為 engaged → sess-A-thread1
                                          → alice 繼續回
B 在 channel: @nano 我也要查              → router: isMention=true、threadId=ts-99（新 thread）
                                          → wiring(alice) 命中 → sess-B-thread99 (新 SDK session)
                                          → alice 回（同容器、不同 SDK session）
```

**容器數**：1（`zeroclaw-customer-service-alice`）| **SDK session 數**：2

---

### 案例 4：admin 主動發起冷 DM（openDM）

**目標**：未來做 approval flow — admin 主動發 DM 通知某 Discord 使用者。

**admin 操作**：
```
Web UI → Messaging Groups → 找到 discord wiring → 「主動 DM」按鈕
  輸入 userHandle = 987654321 (Discord user id)
  POST /api/admin/messaging-groups/mg-discord-1/open-dm { userHandle: '987654321' }
```

**後端流程**：
```
rest.ts:
  adapter = registry.get('discord')
  if (!adapter.openDM) → 400 "platform does not support openDM"
  chatId = await adapter.openDM('987654321')
        // 內部呼叫 POST https://discord.com/api/v10/users/@me/channels { recipient_id: '987654321' }
        // 回 { id: 'C-DM-XXX' }
  return { chatId: 'C-DM-XXX' }
```

**容器數**：開 DM 不啟容器；之後若該 user 回應 → 走標準 router 流程 → 啟容器。

---

## 18. 資料持久化設計

### 18.1 DB 驅動抽象

現有 `DbStore` 介面已與實作分離。`DB_DRIVER=sqlite|postgres` env（預設 `postgres`）：✅

```ts
// db/index.ts
export function createDb(env: Env): DbStore {
  if (env.DB_DRIVER === 'postgres' && env.DATABASE_URL) {
    return createPgDbStore(env.DATABASE_URL);
  }
  return createSqliteDbStore(env.SQLITE_PATH);
}
```

`createSqliteDbStore` = 原 `createDbStore`（rename）；`createPgDbStore` 用 `pg` 套件實作相同介面。
`DbStore` 介面全面 async ✅。`main.ts` 改用 `createDb`；所有 call site 全部加 `await`。

### 18.2 PostgreSQL docker-compose service

```yaml
postgres:
  image: postgres:16-alpine
  container_name: zeroclaw-postgres
  networks: [zeroclaw-net]
  environment:
    POSTGRES_DB: zeroclaw
    POSTGRES_USER: zeroclaw
    POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-zeroclaw-dev}
  volumes:
    - ./data/postgres:/var/lib/postgresql/data
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U zeroclaw"]
    interval: 5s
    timeout: 5s
    retries: 5
```

api-server service 加：
```yaml
DATABASE_URL: ${DATABASE_URL:-postgres://zeroclaw:zeroclaw-dev@zeroclaw-postgres:5432/zeroclaw}
DB_DRIVER: ${DB_DRIVER:-postgres}
```

### 18.3 Migration 策略

SQLite：`better-sqlite3` 同步 DDL + `IF NOT EXISTS`（既有模式，繼續沿用）。
PostgreSQL：`db.exec()` 改為 `pool.query()`；同樣用 `IF NOT EXISTS` 保冪等。

---

## 19. ContainerPool 持久化（T-4）

### 19.1 問題

`ContainerManager.containers` 是 in-memory `Map`；API server 重啟後容器清單流失。

### 19.2 方案

`containers` 表（DDL 見 §3.2）由 `DbStore` 管理：

- `launchContainer` 成功後呼叫 `db.upsertContainer(entry.instance)`
- `invalidate` / `stop` 後呼叫 `db.removeContainer(containerId)`
- API server 啟動時呼叫 `db.listContainers()` + `docker ps` 交叉驗證：
  - DB 有但 docker 沒有 → 清除 DB 記錄
  - docker 有但 DB 沒有 → 插入 DB 並 adopt 到 in-memory map

---

## 20. 容器重啟歷史 replay（T-1）

### 20.1 問題

Opencode v1.14 容器不持久化 chat history；容器重啟後 SDK session 失憶。

### 20.2 replay 實作

在 `SessionManager.ensureContainer()` / session 遷移後，新 SDK session 建立完成時：

```ts
async function replayHistoryToSession(
  provider: AgentProvider,
  sdkSessionId: string,
  sessionId: string,
): Promise<void> {
  const messages = db.listMessages(sessionId, 200); // 最多 replay 最近 200 筆
  if (messages.length === 0) return;
  await provider.injectHistory(sdkSessionId, messages);
}
```

`provider.injectHistory()` 實作：
- **Opencode**：透過 `session.prompt({ parts: [{ type: 'text', content: '<history>...</history>' }] })` 注入格式化歷史記錄
- **Copilot**：同上，或透過 `messages.create` endpoint（若支援）
- 若 provider 不支援 inject → silent skip（log warning），不阻斷新訊息

### 20.3 最大 replay 深度

`group.container.historyReplayLimit`（預設 50，最大 200）。DB 取最新 N 筆 user/assistant message，略去 system message。

---

## 21. 受影響檔案

| # | 檔案 | 動作 | 狀態 |
|---|---|---|---|
| 1 | container-manager.ts | key/簽名/GC/maxSessions | ✅ |
| 2 | session-manager.ts | 加 `resolveMessagingSession`、改 acquire 呼叫 | ✅ |
| 3 | db-store.ts | 新表、migration、CRUD、移除 chat_bindings API | ✅ |
| 4 | message-processor.ts | 重寫 router | ✅ |
| 5 | adapter.ts | `supportsThreads` | ✅ |
| 6 | telegram-adapter.ts | botUsername / isMention / isGroup | ✅ |
| 7 | whatsapp-adapter.ts | isMention=true、isGroup=false | ✅ |
| 8 | slack-adapter.ts | thread_ts、bot mention（webhook 模式） | ✅ webhook / ❌ socket mode |
| 9 | discord-adapter.ts | mentions、thread（webhook 模式） | ✅ webhook / ❌ gateway mode |
| 10 | teams-adapter.ts | mentions、conversation thread | ✅ |
| 11 | pairing.ts | 寫 messaging_groups | ✅ |
| 12 | rest.ts | 移除 /api/bindings、加 /api/admin/messaging-groups | ✅ |
| 13 | shared/types.ts | IncomingMessage / SessionRecord 加欄位、新型別 MessagingGroup / MessagingGroupAgent | ✅ |
| 14 | groups-schema.ts | **刪除** ChannelConfigSchema + GroupConfig.channels 欄位 | ✅ |
| 15 | groups-loader.ts | 移除 channels 載入邏輯 | ✅ |
| 16 | main.ts | 啟動順序：db init → DROP chat_bindings → adoptFromDb → 啟動 adapters | ✅ |
| 17 | packages/web-app/src/pages/ | 新增 MessagingGroupsPage | ✅ |
| 18 | packages/web-app/src/store.ts | 新增 messagingGroups state + CRUD action | ✅ |
| 19 | container-manager test / session-manager test | 跟著改 | ✅ session-manager 13 tests |

---

## 22. 驗收

- [x] **G1-a**：兩個 web 使用者同 group/agent 各自開 session → `docker ps` 1 個容器；2 個 SDK session
- [x] **G1-b**：兩個 Telegram 使用者打同一個 bot → 1 個容器；2 個 SDK session（不同 platformUserId 不同 session row）
- [x] **G1-c**：web 使用者 + Telegram 使用者同 group/agent → 1 個容器
- [x] **G2-a**：admin 在 same chat 加 wiring(agentA, mention) + wiring(agentB, pattern='^/dev') → user 打 `@bot` 兩個都收（mention 命中）；user 打 `/dev x` 只 agentB 收
- [x] **G2-b**：mention-sticky thread → 第二訊息（無 mention）仍由原 agent 接
- [x] **G3-a**：Telegram private chat → isGroup=false / threadId=null；Slack thread → threadId 帶；Discord thread → threadId 帶
- [x] **G3-b**：Discord 設定 `DISCORD_MODE=gateway` + bot token 後，無公開 URL 也能收訊息 ✅ v0.5.0
- [x] **G3-c**：admin 呼叫 `POST /api/admin/messaging-groups/:mgId/open-dm` 對 Discord 使用者 → 收到 bot DM ✅ v0.5.0
- [x] **G4-a**：`/api/bindings` 端點 404；`chat_bindings` 表已 DROP
- [x] **G4-b**：`groups.yaml` 內 `channels:` 欄位被 schema 拒絕（unknown key）
- [x] **G5**：admin 在 Web UI 新增 wiring → 立即生效（不需要 API server reload）
- [x] 既有測試 `pnpm test` 全綠

> **注意**：G1-a/b/c、G2-a/b、G3-a 的「程式碼路徑」在 v0.3 已實作完畢；G1/G2 的實際 docker 整合測試需啟動完整容器環境才可驗證。

---

## 23. 開放議題

| # | 議題 | 提案處置 |
|---|---|---|
| O-2 | `agent-shared` session_mode 跨平台可能讓兩個使用者撞到同一 SDK session | 文件警告；保留功能但 UI 預設 `per-thread` |
| O-3 | bot username 取得失敗時的退化 | Telegram `getMe` 失敗 → 退化成 `isMention=true on every message`（即所有訊息都當作 mention，靠 wiring 過濾） |
| O-4 | Discord Gateway 重連策略 | 指數退避（1s→2s→4s→...→max 60s）+ session resume（用 RESUME opcode 6） |
| O-5 | open-dm API 對 Telegram/WhatsApp 的行為 | 回 200 + `{chatId: userHandle}`（這兩個平台 userHandle 直接是 chatId） |

> O-1 已關閉：採「徹底移除 yaml channels、全 admin API + Web UI」（v0.2 拍板）
> O-6 已關閉：`per-user` 為預設 sessionMode，所有 messaging session lookup key 均含 `platformUserId`（除了 `agent-shared`）。已併入 §5.1。

---

## 24. 未實作需求詳細說明

### 🟡 中優先 — 完整度

#### T-5 Image build cache 用 content hash ✅（v0.5.0 已完成）
- `computeContextHash` 遞迴 hash agent 目錄所有檔案（SHA-256 前 12 字元）；tag 格式 `zeroclaw/agent-{id}:{hash}`；Docker daemon 有對應 image → 跳過 build。

#### T-6 Rebuild API ✅（v0.5.0 已完成）
- `POST /api/admin/agents/:agentId/rebuild`（admin only）；清除 builtImages 快取 + 刪除舊 image + 重新 build + 重啟所有使用該 agent 的容器。

#### T-7 跨平台帳號綁定
- 現況：`users.external_ids` JSON 欄位已存在，但 webhook 進來只會自動建匿名 user。
- 方案：`POST /api/users/me/bind { platform, externalId }` + verification flow。
- 注意：頻道層綁定（`messaging_groups` + `POST /api/pairings` 4 位數互動 code）已於 v0.3 完成；此項指 user 層的 web↔platform 帳號綁定。

#### T-8 完整管理 API
- `POST /api/admin/containers/:id/restart`
- `PUT /api/admin/groups`（線上改 yaml + 熱重載）

#### T-9 partial assistant message 落盤
- 現況：`SessionManager.handleMessage` 只在 `done` 事件 flush assistant message；中途錯誤會丟整段。
- 方案：每 N 個 chunk 或每 5 秒 upsert 一次部分內容。

#### T-32 Discord Gateway WebSocket 模式 ✅（v0.5.0 已完成）
- 完整實作 Gateway WSS：IDENTIFY / HEARTBEAT / DISPATCH(MESSAGE_CREATE) / RESUME / RECONNECT。
- 使用 Node.js 22 原生 `WebSocket`；指數退避重連（1s→60s max）；READY 自動取得 bot ID。
- `DISCORD_MODE=gateway|webhook` env 控制，webhook 模式保留不變。

### 🟢 低優先 — 增強

#### T-12 OAuth / SSO
- 取代 dev-login。GitHub / Google OIDC 為基線。

#### T-13 容器 metrics / Prometheus exporter
- `/metrics` endpoint：active_sessions, active_containers, image_build_count, llm_token_used。

#### T-14 檔案上傳 API
- Composer UI 已支援附件，後端缺 `POST /api/uploads`。

#### T-15 UI i18n
- 抽取字串到 `i18n/zh-TW.json`、`en.json`；目前介面為繁中。

#### T-16 MessagingAdapter plugin 動態載入
- 現況：`main.ts` 靜態 import 五個 adapter。
- 方案：`adapters/*.ts` 自動 glob + 註冊；外掛只需丟檔。

### 🔒 安全 / 維運（無時間表）

#### T-17 LLM API Key 管理
- 現況：純環境變數。
- 待決：是否導入 Vault / AWS Secrets Manager；若是，何時。

#### T-18 容器網路白名單
- 現況：所有 agent 容器在 `zeroclaw-net`，可任意出網。
- 待決：是否加 egress 白名單（iptables sidecar 或自訂 network）。

#### T-19 Rate limiting
- 待決：每用戶 / 每平台限速策略；是否用 token bucket（記在 SQLite）還是 Redis。

---

## 25. 已完成需求技術細節

### T-1 對話歷史 replay（v0.4 完成）
- **背景**：Opencode v1.14+ 容器內 session 預設不持久化；容器重啟或 session migration 後 SDK 端失憶。
- **方案**：API server 在 `createSession` 後，將 DB 中歷史訊息回放給新容器。
- **實作**：見 §20。

### T-2 Per-session 並發鎖（v0.3 完成）
- `SessionManager.handleMessage` 內加 `sessionLocks: Map<sessionId, Promise<void>>`。
- 新的 `handleMessage` 是 lock wrapper，實際邏輯移至 `handleMessageBody`。
- 同一 session 第二層次訊息必須等前一輪完成後才執行，消除 SDK 事件亂序問題。

### T-3 Session 限制（v0.3 完成，v0.4 增補 auto-reopen）
- `MAX_SESSIONS_PER_USER`（預設 20）：超過則拒絕建立新 session
- `SESSION_IDLE_TIMEOUT_SEC`（預設 1800）：閒置 session 自動 `status='ended'`
- `SESSION_MAX_MESSAGES`（預設 200）：單 session 訊息上限，超過自動 ended
- `SESSION_RETENTION_DAYS`（預設 30）：lifecycle timer 定期清理過期 ended/error sessions
- SessionStatus 擴充：新增 `'ended' | 'error'` 狀態
- **Auto-reopen**（v0.4）：`ended` 狀態的 session 收到新訊息時自動恢復為 `active`，容器會重啟 + history replay；只有 `error` 狀態才真正不可恢復
- lifecycle timer 在 main.ts 啟動時 `startLifecycle()`，shutdown 時 `stopLifecycle()`
- 單元測試：13 個 session-manager 測試涵蓋 max sessions、message limit、ended session auto-reopen、並發鎖

### T-4 ContainerPool 持久化（v0.3 完成）
- 見 §19。

### T-10 db.saveMessage bug（v0.4 完成）
- 現況：messages 表沒寫入但 `messageCount` 有累加；前端透過 WS 看得到，重整就消失。
- 修正：trace 到漏寫路徑，補單元測試覆蓋 user / assistant 兩條路徑。

### T-10c Opencode event stream AbortController（v0.4 完成）
- **原況**：runtime `closeStream()` 用 `stream.close?.() / stream.controller?.abort?.() / stream.stream?.return?.()` 三段 fallback。
- **改善**：改成在 `event.subscribe({ signal })` 傳 `AbortController.signal`，符合 SDK heyapi 慣例。

### T-11 PostgreSQL 完整遷移（v0.3 完成）
- `DbStore` 介面全面改為 async（`Promise<T>`）。
- `pg-store.ts` 新建：完整 PostgreSQL 實作，使用 `pg.Pool`，positional params，JSONB/TIMESTAMPTZ/BOOLEAN。
- `db/index.ts` factory：`createDb({ driver, databaseUrl, sqlitePath })` 依 `DB_DRIVER` env 選擇驅動。
- `main.ts` 改用 `createDb`；所有 call site（`rest.ts`, `ws.ts`, `session-manager.ts`, `container-manager.ts`, `message-processor.ts`, `auth-service.ts`, `pairing.ts`）全部加 `await`。


