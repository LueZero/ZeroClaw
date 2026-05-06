# ZeroClaw 架構說明

> 版本：0.4.4
> 日期：2026-05-02
>
> 本文件是 [DESIGN.md](DESIGN.md) 的**實作對應版**：以「資料流 + 檔案地圖 + 對應關係」說明目前 codebase 的實際組成，不重述設計動機。

## 目錄

| 章節 | 內容摘要 |
|---|---|
| [1. 拓樸總覽](#1-拓樸總覽) | 整體部署形狀、容器網路、外部依賴 |
| [2. 套件分工](#2-套件分工) | monorepo 各 package 的職責切分 |
| [3. API Server 模組地圖](#3-api-server-內部模組地圖) | 主要型別、`groups.yaml` 結構、動態 Group override |
| [4. 資料流](#4-資料流) | 訊息處理完整路徑（GC、遷移、Pairing、Wiring fan-out） |
| [5. 容器 Runtime](#5-容器-runtime) | Opencode / Copilot SDK runtime、容器命名與 Image 擴充 |
| [6. 持久化](#6-持久化) | DB schema（SQLite + PostgreSQL 雙驅動）、容器內狀態 |
| [7. 認證與授權](#7-認證與授權) | JWT、角色、Webhook 平台簽章驗證 |
| [8. 觀測](#8-觀測) | 結構化 log、Diagnostics endpoints |
| [9. 部署](#9-部署) | Docker Compose 服務、啟停腳本、環境變數 |
| [10. 設計決議](#10-設計決議已固化) | 架構決策、功能範圍、安全性、擴展性 |
| [11. 已知限制與待辦](#11-已知限制與待辦) | 目前限制 + TODO 項目 |
| [12. 相關文件](#12-相關文件) | DESIGN.md 等參考文件 |
| [13. 索引表](#13-索引表快速查找) | 原始碼 → 章節、API endpoints、環境變數速查 |

---

## 1. 拓樸總覽

```
┌──────────────────────────────────────────────────────────────────────┐
│ Browser / Telegram / WhatsApp / Discord / Slack / Teams            │
└──────────────────┬─────────────────────────────────┬─────────────────┘
                   │ HTTP + WebSocket                │ Webhook
                   ▼                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│ API Server (Fastify · :3000)                                         │
│                                                                      │
│  routes/rest.ts ─────┐    routes/ws.ts ──┐    routes/webhooks.ts ─┐  │
│                      ▼                   ▼                        ▼  │
│             ┌─────────────────────────────────────────────────────┐  │
│             │  SessionManager (session/session-manager.ts)        │  │
│             │   - createOrGet / handleMessage / switchAgent       │  │
│             │   - resolveMessagingSession (platform 路由)         │  │
│             │   - migrate (containerId 失效時)                    │  │
│             └────────┬───────────────────────────┬────────────────┘  │
│                      ▼                           ▼                   │
│        ┌───────────────────────┐   ┌─────────────────────────┐       │
│        │ ContainerManager      │   │ AgentProvider           │       │
│        │ (container/...)       │   │ (agent/agent-provider)  │       │
│        │ - acquire(group,agent)│   │ - Copilot: JSON-RPC TCP │       │
│        │ - launchContainer     │   │ - Opencode: HTTP + SSE  │       │
│        │ - attachSession/      │   │                         │       │
│        │   detachSession       │   │                         │       │
│        │ - GC + Health         │   │                         │       │
│        └──────────┬────────────┘   └────────────┬────────────┘       │
│                   │ docker.sock                 │                    │
│                   ▼                             │                    │
│            ┌────────────────────────┐           │                    │
│            │ DbStore (db/index.ts)  │           │                    │
│            │ PostgreSQL (預設)      │           │                    │
│            │ / SQLite (fallback)    │           │                    │
│            │ users / sessions /     │           │                    │
│            │ messages / containers /│           │                    │
│            │ messaging_groups /     │           │                    │
│            │ messaging_group_agents │           │                    │
│            └────────────────────────┘           │                    │
└─────────────────────────────────────────────────┼────────────────────┘
                                                  ▼ Docker network: zeroclaw-net
                       ┌──────────────────────────────────────────────┐
                       │ Agent Container  zeroclaw-{group}-{agent}    │
                       │ ┌────────────────────────────────────────┐   │
                       │ │ runtime/index.js                       │   │
                       │ │  Opencode: HTTP :7080 → opencode SDK   │   │
                       │ │  Copilot:  TCP :7080 → @github/copilot │   │
                       │ └─────┬──────────────────────────────────┘   │
                       │       ▼                                      │
                       │  /workspace/agent   (RO bind: agents/<id>/)  │
                       │  /workspace/agents  (RW bind: agents/)  ⁽¹⁾  │
                       └──────────────────────────────────────────────┘

⁽¹⁾ 僅 `mountAgentsDir: true` 的 group 才會掛載 `/workspace/agents`（可寫）。
```

---

## 2. 套件分工

| Package | 角色 | 對外 |
|---|---|---|
| [packages/shared](../packages/shared/) | 型別 / 錯誤 / 事件 / WS 協議 | 被 api-server、web-app、容器 runtime（透過事件型別）共用 |
| [packages/api-server](../packages/api-server/) | Fastify 後端 | HTTP :3000、WS `/ws`、Webhook `/webhook/*` |
| [packages/web-app](../packages/web-app/) | React + Vite 前端 | nginx :80（容器內），dev :5173 |
| [images/agent-base.opencode](../images/agent-base.opencode/) | Opencode runtime base image | 容器內 :7080 HTTP+SSE |
| [images/agent-base.copilot](../images/agent-base.copilot/) | Copilot runtime base image | 容器內 :7080 JSON-RPC TCP |

---

## 3. API Server 內部模組地圖

```
packages/api-server/src/
├── main.ts                          # Fastify bootstrap、依賴注入
├── config/
│   ├── env.ts                       # 環境變數 schema (zod)
│   ├── groups-loader.ts             # 載入 groups.yaml
│   └── groups-schema.ts             # GroupConfig zod 驗證
├── auth/
│   └── auth-service.ts              # JWT 簽發 / 驗證、user 管理
├── agent/
│   ├── agent-detector.ts            # 偵測資料夾 → opencode | copilot
│   ├── agent-registry.ts            # AgentMetadata 記憶體索引
│   ├── agent-provider.ts            # AgentProvider 介面
│   ├── copilot-provider.ts          # JSON-RPC over TCP 實作
│   └── opencode-provider.ts         # HTTP + SSE 實作
├── container/
│   └── container-manager.ts         # Docker 容器生命週期 + key 單飛鎖
├── db/
│   ├── index.ts                     # DB factory（依 DB_DRIVER 選 PostgreSQL 或 SQLite）
│   ├── db-store.ts                  # SQLite 實作（better-sqlite3）
│   └── pg-store.ts                  # PostgreSQL 實作（pg.Pool）
├── session/
│   ├── session-manager.ts           # 主要協調者：DB × Container × Provider
│   └── auto-router.ts               # routing.mode='auto' 的 LLM 分類器
├── messaging/
│   ├── adapter.ts                   # 共用介面（含 start/stop）
│   ├── message-processor.ts         # webhook 與 polling 共用的路由 helper
│   ├── telegram-adapter.ts          # Telegram Bot API（polling 預設 / webhook 可選）
│   ├── whatsapp-adapter.ts
│   ├── discord-adapter.ts
│   ├── slack-adapter.ts
│   ├── teams-adapter.ts
│   └── stubs.ts                     # 測試用空實作
└── routes/
    ├── rest.ts                      # REST：/api/auth /api/groups /api/sessions /api/admin
    ├── ws.ts                        # WS：/ws — 串流 AgentEvent
    └── webhooks.ts                  # /webhook/{platform}
```

### 3.1 主要型別

| 型別 | 來源 | 流經 |
|---|---|---|
| `IncomingMessage` | shared/types.ts | webhook / WS / REST → SessionManager |
| `AgentEvent` | shared/events.ts | Provider → SessionManager → WS / Webhook 回送 |
| `SessionRecord` | shared/types.ts | DbStore ↔ SessionManager |
| `AgentMetadata` | shared/types.ts | agent-detector → registry → SessionManager |
| `GroupConfig` | shared/types.ts | groups-loader → SessionManager / ContainerManager |

### 3.2 `groups.yaml` 結構與參數

`groups.yaml` 是 **agent group 的單一設定來源**，由 [groups-loader.ts](../packages/api-server/src/config/groups-loader.ts) 啟動載入、[groups-schema.ts](../packages/api-server/src/config/groups-schema.ts) 用 zod 驗證。**通訊頻道（channels）已於 v0.3 移除**，全部改走 DB + Web UI（`/admin/messaging-groups`）。

#### 載入順序

```
main.ts
  └─ createGroupsRegistry(GROUPS_FILE)
       1. fs.readFile(yaml)
       2. yaml.parse → GroupsYamlSchema (zod)
       3. validateGroupsSemantics  ← defaultAgent / fallback 必須在 agents 內
       4. groups.filter(g => g.enabled)   ← list() / get() 預設只回傳 enabled=true
```

#### 參數有序總覽

> 表格欄位依 yaml 中**實際出現順序**排列；勾選 ✅ 表示有實作消費；❌ 已移除；⚠️ schema 接受但無實作。

##### 頂層

| # | 欄位 | 必填 | 用途 | 消費點 |
|---|---|---|---|---|
| 1 | `version` | ✅ | schema 版本，固定為 `1` | `GroupsYamlSchema` |
| 2 | `groups[]` | ✅ | group 清單，至少 1 筆 | 全系統 |

##### `groups[].` 群組層

| # | 欄位 | 必填 | 預設 | 用途 | 消費點 | Override? |
|---|---|---|---|---|---|---|
| 1 | `id` | ✅ | — | kebab-case 唯一 ID；嵌入容器名 `zeroclaw-{id}-{agentId}` | container-manager 命名 / DB FK | ❌ yaml-only |
| 2 | `displayName` | ✅ | — | UI 顯示名 | `NewSessionButton`、`MessagingGroupsPage` 下拉 | ✅ 即時 |
| 3 | `description` | — | — | UI 副標 / tooltip | `GroupList.title`、`NewSessionButton` 副字 | ✅ 即時 |
| 4 | `icon` | — | `📁` | UI emoji 圖示 | `GroupList`、`NewSessionButton` | ✅ 即時 |
| 5 | `enabled` | — | `true` | 停用後不出現在 `list()`/`get()` | [groups-loader.ts L57-58](../packages/api-server/src/config/groups-loader.ts) | ✅ 即時 |
| 6 | `agents[]` | ✅ | — | 此 group 下可用的 agent id 清單（對應 `agents/<id>/`），至少 1 個 | session-manager / agent-detector 比對 | ❌ yaml-only |
| 7 | `defaultAgent` | — | `agents[0]` | 沒指定 agent 時的預設；auto-seed wiring 也用這個 | session-manager L165、message-processor auto-seed | ✅ 即時 |
| 8 | `container` | ✅ | — | 容器配置（見下，部分可 override） | container-manager | 部分 |
| 9 | `routing` | ✅ | — | 路由策略（見下，全部可 override） | session-manager | ✅ 即時 |

##### `groups[].container.` 容器層

| # | 欄位 | 必填 | 預設 | 用途 | 消費點 | Override? |
|---|---|---|---|---|---|---|
| 1 | `baseImage` | ✅ | — | 容器映像 tag；無 custom Dockerfile 時直接使用 | `ensureAgentImage` | ❌ yaml-only |
| 2 | `maxSessions` | ✅ | — | **單一容器內並發 SDK session 上限**（v0.3 後語意；不是容器數） | container-manager 拒絕新 session | ✅ 即時 |
| 3 | `mountAgentsDir` | — | `false` | true 時掛 `agents/` RW 進容器（給代理人自建新代理人，例如 scaffold-agent skill） | `buildBinds` | ❌ yaml-only |
| 4 | `resources.cpus` | — | `env.DEFAULT_CONTAINER_CPUS` | dockerode `NanoCpus` | `parseCpus` | ❌ yaml-only |
| 5 | `resources.memory` | — | `env.DEFAULT_CONTAINER_MEMORY` | dockerode `Memory` | `parseMemory` | ❌ yaml-only |
| 6 | `env` | — | `{}` | 額外注入容器的環境變數（與全域 LLM key 合併） | container-manager `Env` | ❌ yaml-only |
| 7 | `volumes` | — | `[]` | 額外 bind mount 字串（dockerode `Binds` 格式 `host:guest[:ro]`） | `buildBinds` | ❌ yaml-only |

> ❌ **已移除**：`idleTimeoutSeconds`（v0.4.1）— GC 實際讀全域 env `CONTAINER_IDLE_TIMEOUT_SEC`（[container-manager.ts L358](../packages/api-server/src/container/container-manager.ts)），per-group 設定無作用。yaml / schema / shared types / scaffold-agent skill 模板皆同步清除。

##### `groups[].routing.` 路由層

| # | 欄位 | 必填 | 用途 | 消費點 | Override? |
|---|---|---|---|---|---|
| 1 | `mode` | ✅ | `explicit`：前端 / API 必須指定 agentId / `auto`：LLM 分類器決定 / `round-robin`：輪流（測試用） | session-manager L127-154 | ✅ 即時 |
| 2 | `fallback` | — | 找不到 agent 時退回的 agent id；必須在 `agents[]` 內 | session-manager L129/154 | ✅ 即時 |
| 3 | `autoClassifierModel` | — | `mode=auto` 時用哪個 LLM 模型 | [auto-router.ts](../packages/api-server/src/session/auto-router.ts) | ✅ 即時 |

#### 完整範例（來自 repo 根目錄 [groups.yaml](../groups.yaml)）

```yaml
version: 1
groups:
  - id: zero-opencode
    displayName: Zero (Opencode)
    description: Zeroclaw 快速上手嚮導 — Opencode SDK 版
    icon: "🧭"
    enabled: true
    agents: [zero-opencode]
    defaultAgent: zero-opencode
    container:
      baseImage: zeroclaw/agent-base-opencode:latest
      maxSessions: 50
      mountAgentsDir: true
      resources:
        cpus: "1.0"
        memory: 512m
    routing:
      mode: explicit
      fallback: zero-opencode
```

### 3.3 動態 Group 設定 (Web UI Override)

> **v0.4.2 新增、v0.4.3 擴充**。允許 Admin 透過 Web UI 即時調整多個欄位，無需修改 yaml 重啟。

#### 3.3.1 設計原則 — 哪些欄位可 override

| 欄位 | 所屬層 | 可 override？ | 生效方式 | 理由 |
|---|---|---|---|---|
| `displayName` | 群組層 | ✅ 即時 | `groups.reload()` | 純展示文字，影響面有限 |
| `description` | 群組層 | ✅ 即時 | `groups.reload()` | 同上 |
| `icon` | 群組層 | ✅ 即時 | `groups.reload()` | 同上 |
| `enabled` | 群組層 | ✅ 即時 | `groups.reload()` | 停用旗標可快速切換，無需重啟 |
| `defaultAgent` | 群組層 | ✅ 即時 | `groups.reload()` | 只改預設 agent 指向，不影響容器 |
| `container.maxSessions` | 容器層 | ✅ 即時 | `groups.reload()` | 只調上限數字，不重建容器 |
| `routing.mode` | 路由層 | ✅ 即時 | `groups.reload()` | 下一筆新 session 生效 |
| `routing.fallback` | 路由層 | ✅ 即時 | `groups.reload()` | 同上 |
| `routing.autoClassifierModel` | 路由層 | ✅ 即時 | `groups.reload()` | 同上 |
| `agents[]` | 群組層 | ❌ yaml-only | 重啟 api-server | 涉及 agent 目錄掃描與映像建置 |
| `container.baseImage` | 容器層 | ❌ yaml-only | 重啟 api-server | 改 image 需停舊容器重建 |
| `container.mountAgentsDir` | 容器層 | ❌ yaml-only | 重啟 api-server | 容器啟動時掛載點已固定 |
| `container.resources.*` | 容器層 | ❌ yaml-only | 重啟 api-server | CPU/Memory 需重新建立容器才能生效 |
| `container.env` / `volumes` | 容器層 | ❌ yaml-only | 重啟 api-server | 同上 |

#### 3.3.2 資料表 `group_overrides`

| 欄位 | 型別 | 說明 |
|---|---|---|
| `group_id` | `TEXT PK` | 對應 `groups.yaml` 中 `groups[].id` |
| `display_name` | `TEXT NULL` | `NULL` = 不 override，沿用 yaml |
| `description` | `TEXT NULL` | 同上 |
| `icon` | `TEXT NULL` | 同上 |
| `enabled` | `BOOLEAN NULL` | 同上 |
| `default_agent` | `TEXT NULL` | 同上 |
| `max_sessions` | `INTEGER NULL` | 同上（對應 `container.maxSessions`）|
| `routing_mode` | `TEXT NULL` | 同上（對應 `routing.mode`）|
| `routing_fallback` | `TEXT NULL` | 同上（對應 `routing.fallback`）|
| `routing_auto_classifier_model` | `TEXT NULL` | 同上（對應 `routing.autoClassifierModel`）|
| `updated_at` | `TIMESTAMP` | 最近一次修改時間 |

> SQLite 與 PostgreSQL 雙驅動同步維護此表（`packages/api-server/src/db/db-store.ts` / `pg-store.ts`）。
> 欄位為後向相容 migration：啟動時若欄位不存在，自動執行 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`。

#### 3.3.3 合併流程（`groups-loader.applyOverride`）

```
yaml file ─┐
           ├─► applyOverride(base, override) ─► merged GroupConfig ─► in-memory groups map
DB row  ───┘
```

合併規則：
- 任一欄位為 `NULL` → 沿用 yaml 值。
- 非 `NULL` → 以 DB 為準覆蓋。
- `routing.*` 三個欄位任一有值時，建立新 routing 物件（展開 base.routing + 套用 override）。
- `routingFallback === null` 表示「明確清除 fallback」，而非「不 override」。

#### 3.3.4 API 與 hot reload

| Endpoint | 行為 |
|---|---|
| `GET  /api/admin/groups` | 回傳所有 group（含 `enabled=false`），附 `hasOverride` / `override` 欄位，以及 `mountAgentsDir` / `cpuLimit` / `memoryLimit` 唯讀欄位 |
| `PATCH /api/admin/groups/:id` | body 任意子集（9 個 overridable 欄位，見 §3.3.1）→ `upsertGroupOverride` → `groups.reload()` |
| `DELETE /api/admin/groups/:id/override` | 清空整筆 override → `reload()` |

`reload()` 會重新讀取 yaml 與 DB、重建 in-memory map，無需重啟 process；Chat 端下次 `GET /api/groups` 即可看到新值。

#### 3.3.5 Web UI

`/admin/groups` 頁（`packages/web-app/src/pages/GroupsAdminPage.tsx`）採 **master-detail 佈局**：

```
┌──────────────┬────────────────────────────────────────────┐
│ 左側 sidebar │ 右側 detail panel                          │
│              │  ┌─ Display ──────────────────────────┐   │
│ 📁 群組一   │  │ displayName / description /         │   │
│ 📁 群組二   │  │ icon / enabled (✅ 可改)            │   │
│ 🚀 群組三   │  ├─ Routing ─────────────────────────-┤   │
│              │  │ routingMode / defaultAgent /        │   │
│              │  │ fallback / autoClassifierModel       │   │
│              │  │ (✅ 可改)                           │   │
│              │  ├─ Container ───────────────────────-┤   │
│              │  │ baseImage / maxSessions /           │   │
│              │  │ mountAgentsDir / cpuLimit /         │   │
│              │  │ memoryLimit                         │   │
│              │  │ (maxSessions ✅ 可改；其餘 ❌ 唯讀) │   │
│              │  ├─ Agents ──────────────────────────-┤   │
│              │  │ chip 清單 + 預設標記 (❌ 唯讀)      │   │
│              │  └────────────────────────────────────┘   │
└──────────────┴────────────────────────────────────────────┘
```

- sidebar：icon + 名稱 + id + OFF/OV badge（有 override 時顯示）。
- detail：髒資料偵測（表單有改動才顯示 Save / Cancel）；有 override 時顯示「Reset to yaml」。
- yaml-only 欄位以灰底 readonly 方塊顯示，無法輸入。

---

## 4. 資料流

### 4.1 一般訊息（同容器活著）

```
1. WS / Webhook 收到 IncomingMessage
2. routes/* → SessionManager.handleMessage(sessionId, msg)
3. session.status === 'pending' → ensureContainer
   ├─ ContainerManager.acquire(group, agent, sessionId)
   │     └─ 容器存在 → 直接回傳；不存在 → launchContainer
   └─ AgentProvider.createSession → 拿到 sdkSessionId
4. DbStore.saveMessage(userMsg)
   DbStore.updateSession(messageCount +1)   ← T-10: user 訊息立即 +1
5. AgentProvider.sendMessage(sdkSessionId, { text }) → AsyncIterable<AgentEvent>
6. for await event:
     - chunk: 累積 assistantContent
     - tool.call / tool.result: 透傳給 WS（不入庫）
     - approval.required: 透傳
     - done: DbStore.saveMessage(assistantMsg) + updateSession.messageCount +1
   yield event 給 routes/* → 回送
```

### 4.2 容器命名與 Session 多路復用（v0.3）

容器名稱：`zeroclaw-{groupId}-{agentId}`，**每個 (group, agent) pair 共用一個容器**，容器內可承載多個 SDK session（多路復用）。

```
ContainerManager.acquire(group, agent):
  key = `${groupId}::${agentId}`

  1. containers.get(key) 有 running → isReady probe → 通過直接 return
  2. inflight.get(key) 已有 promise → await 同一個（單飛鎖）
  3. 否則 launchContainer:
     a. docker.listContainers filter name=${containerId}
        - found running → adopt
        - found stopped → remove({force:true}) → 重建
        - not found → 正常建立
     b. createContainer 拋 'already in use' → 再次查 → adopt
     c. waitForReady(120s)
     d. db.upsertContainer(entry.instance)   ← ContainerPool 持久化

容器入口使用 attachSession(containerId, sdkSessionId) / detachSession:
  sdkSessions = Set<string>   ← 取代舊的 activeSessions: number
  GC 條件：sdkSessions.size === 0 且 idle > CONTAINER_IDLE_TIMEOUT_SEC

啟動時 adoptFromDb():
  讀 db.listPersistedContainers() → 交叉比對 docker ps
  → 存活的直接裝入 containers Map（避免重啟遺失容器）
```

→ **每個 (group, agent) 一個容器**：多個使用者對同一 agent 共享同一個容器，SDK session 在容器內隔離。
→ `group.container.maxSessions` 現在指「每個容器最多幾個並發 SDK session」。

### 4.3 容器失效 → Session 遷移

`session-manager.ts` `handleMessage` 會檢查：

```
findContainerEntry(session.containerId) === undefined  → 容器消失
entry.instance.status === 'unhealthy'                  → 健康檢查失敗 3 次
```

兩種情況都觸發 migrate：重新 `acquire` 一個容器、`createSession` 拿新 `sdkSessionId`、更新 `sessions.container_id` 與 `sessions.sdk_session_id`。

> ✅ **已實作 History Replay**（T-1）：遷移後 `replayHistory()` 將 DB 中最近 50 筆訊息透過 `AgentProvider.injectHistory()` 注入新 SDK session，恢復對話脈絡。

### 4.4 健康檢查

`startGc()` 啟動兩個 timer：

| Timer | 週期 | 作用 |
|---|---|---|
| GC | 60s | `sdkSessions.size === 0 && idle > CONTAINER_IDLE_TIMEOUT_SEC` → stop |
| Health | 30s | `provider.isReady()` 失敗 ≥ 3 次 → 標 `unhealthy`、觸發 `onUnhealthy` callback |

### 4.5 通訊平台連線模式

各 adapter 與外部平台之間的連線方式不同；介面以 `MessagingAdapter` 統一，但運作模式分三類（與 nanoclaw 對齊）：

| 平台 | 連線模式 | 進入點 | 是否需要公開 URL |
|---|---|---|---|
| **Telegram** | polling（預設）/ webhook | `adapter.start()` 跑 `getUpdates` 迴圈／`POST /webhooks/telegram` | polling 否；webhook 是 |
| **WhatsApp** | webhook | `POST /webhooks/whatsapp`（GET 走 `verifyWebhook` 回 challenge） | 是 |
| **Slack** | webhook | `POST /webhooks/slack`（首次 `url_verification` 回 challenge） | 是 |
| **Discord** | webhook（Interactions endpoint） | `POST /webhooks/discord` | 是 |
| **Teams** | webhook | `POST /webhooks/teams`（Bot Framework Activity） | 是 |

`MessagingAdapter` 的 `start?(runtime)` / `stop?()` 為可選方法：webhook 模式 adapter 不實作；polling/gateway 模式 adapter 在 `start()` 內維持迴圈或長連線，收到訊息後透過 `runtime.onMessages()` 餵進共用的 [`message-processor.ts`](../packages/api-server/src/messaging/message-processor.ts)，**不論 polling 或 webhook，路由邏輯只有一份**（找 group → 建 session → 跑 agent loop → `adapter.send()` 回送）。

> **TODO**：Discord 在 nanoclaw 是 Gateway WebSocket（`wss://gateway.discord.gg`），可避免公開 URL；目前 zeroclaw 仍使用 webhook，列為後續強化項。Slack/Teams/WhatsApp 平台官方 API 沒有等價的 long-polling 機制，維持 webhook 設計。

### 4.6 互動式 Pairing 與 MessagingGroup（v0.3）

v0.3 以 `messaging_groups` + `messaging_group_agents` 資料表取代舊的 `chat_bindings` + `groups.yaml.channels`，實現動態管理。

```
Admin                Web/REST              API Server                Chat
  │  POST /api/pairings        │                     │                  │
  │  { groupId, agentId,       │                     │                  │
  │    platform, engageMode,   │                     │                  │
  │    sessionMode }           │                     │                  │
  ├──────────────────────────► │  pairing.create()   │                  │
  │                            ├────────────────────►│ INSERT pairings  │
  │  ◄── { code: "4729" }      │                     │                  │
  │                                                                     │
  │ （告知使用者輸入 4729）                                                │
  │                                                                     │
  │                                              ┌──────── 4729 ───────┤
  │                                              │ message-processor    │
  │                                              │ pairing.tryConsume   │
  │                                              │ → upsertMessagingGroup
  │                                              │ → addMessagingGroupAgent
  │                                              └─ adapter.send("✅") ─►│
```

**MessagingGroup 運作流程**（`message-processor.ts routeInbound`）：

```
1. 4 位數 code → pairing.tryConsume → 建立 MessagingGroup + Wiring → 跳出
2. 計算 effectiveThreadId（依 adapter.supportsThreads）
3. db.getMessagingGroup(platform, platformChatId) → 找到 MessagingGroup
   - 未找到 + isMention + unknownSenderPolicy='allow' → auto-create
   - **同時 auto-seed 預設 wiring**（v0.4.1 首次 @bot 路徑；v0.4.4 起也包含 REST `POST /api/admin/messaging-groups` 路徑）：採 `groups.list()[0]` 第一個 group + 其 `defaultAgent ?? agents[0]`，
     `engageMode='mention-sticky'`（threaded 群組）或 `'pattern' '.'`（DM-only/私訊），
     `sessionMode='per-user'`、`ignoredMessagePolicy='accumulate'`，達成 zero-touch 接入。
4. mg.deniedAt 存在 → 丟棄
5. /agents → 列出可用 agents
6. db.listMessagingGroupAgents(mgId) → wirings
7. auth.getOrCreatePlatformUser → 取得 sender userId
8. 對每個 wiring 執行 evaluateEngage:
   - pattern: text.match(engagePattern)
   - mention: isMention required
   - mention-sticky: isMention OR 既有 session
9. sessions.resolveMessagingSession → findOrCreate DB session
10. runAgentAndReply → sessions.handleMessage → stream → adapter.send
```

**SessionMode（D3 決策，預設 per-user）**：

| 模式 | Key | 說明 |
|---|---|---|
| `per-user` | (group, agent, mg, platformUserId) | 每人獨立 session |
| `per-thread` | (group, agent, mg, thread, platformUserId) | 依訊息串分 session |
| `shared` | (group, agent, mg) | 全頻道共用一個 session |
| `agent-shared` | (group, agent) | 跨所有頻道共用 |

**EngageMode**：

| 模式 | 說明 |
|---|---|
| `pattern` | regex 匹配才啟動 |
| `mention` | 必須 @mention |
| `mention-sticky` | @mention 建立 session；後續同 thread 直接接續 |

關鍵實作：
- [packages/api-server/src/messaging/pairing.ts](../packages/api-server/src/messaging/pairing.ts) — `create / tryConsume / status`；`tryConsume` 呼叫 `db.upsertMessagingGroup` + `db.addMessagingGroupAgent`
- [packages/api-server/src/messaging/message-processor.ts](../packages/api-server/src/messaging/message-processor.ts) — `routeInbound` 包含完整路由邏輯
- [packages/api-server/src/db/db-store.ts](../packages/api-server/src/db/db-store.ts) — `messaging_groups` + `messaging_group_agents` + `containers` 表，`findMessagingSession` 支援動態 sessionMode SQL

### 4.7 Messaging Group / Wiring 參數詳解（`/admin/messaging-groups`）

Web UI 管理頁提供 messaging group + wiring 的完整 CRUD。以下說明各參數的作用與平台差異。

#### Messaging Group 參數

| 參數 | 型別 | 說明 |
|---|---|---|
| `platform` | `string` | 通訊平台名稱：`telegram` / `slack` / `discord` / `whatsapp` / `teams` |
| `platformChatId` | `string` | 該平台上的聊天/頻道唯一 ID。Telegram: chat id (數字)；Slack: channel id (`C0123ABC`)；Discord: channel/thread id；WhatsApp: phone number；Teams: conversation id |
| `isGroup` | `boolean` | `true` = 群組/頻道，`false` = 私訊 (DM)。影響 router 是否強制升級 `per-thread` |
| `unknownSenderPolicy` | `'allow' \| 'drop'` | 未註冊使用者的訊息政策（預設 `allow`，schema 預留） |
| `deniedAt` | `string \| null` | 封鎖時間戳。封鎖後該 chat 所有訊息被忽略 |

#### Wiring 參數

> ⚠️ **術語澄清**：本節 `groupId` 指的是 `groups.yaml` 中定義的「**代理人邏輯群組 (Agent Group)**」，內含 routing / container / 多個 agent 設定，**與通訊軟體的「群組頻道」（如 Telegram 群組、Slack channel）完全是兩個概念**。後者由 `Messaging Group` (`isGroup=true`) 表示。Web UI 表單中該欄位顯示為「代理人群組 (Agent Group)」並附 tooltip。

| 參數 | 型別 | 預設值 | 說明 |
|---|---|---|---|
| `groupId` | `string` | — (必填) | 對應 `groups.yaml` 中定義的 **agent group** id，決定使用哪組 agent / routing / container 設定 |
| `agentId` | `string` | — (必填) | 該 agent group 下的 agent id，決定用哪個 AI 代理人回覆 |
| `engageMode` | `'pattern' \| 'mention' \| 'mention-sticky'` | `pattern`（auto-seed 時依平台調整：threaded 群組 = `mention-sticky`、其餘 = `pattern`） | 觸發模式。決定什麼條件下這個 wiring 的 agent 會被喚起 |
| `engagePattern` | `string \| null` | `'.'` | 僅 `engageMode=pattern` 時有效。`'.'` = 永遠觸發（全收）；`'^/dev'` = 只回應 `/dev` 前綴指令 |
| `sessionMode` | `'per-user' \| 'per-thread' \| 'shared' \| 'agent-shared'` | `per-user` | 會話隔離粒度。見下方平台差異說明 |
| `ignoredMessagePolicy` | `'drop' \| 'accumulate'` | **`accumulate`**（v0.4.1 起；含 auto-seed 與 Web UI 表單） | 未觸發時的處理策略。`drop` = 忽略；`accumulate` = 存入 session 做為 context 但不喚起 agent |

#### Auto-seed 預設 wiring（v0.4.1 + v0.4.4）

**两個觸發路徑均會自動 seed**：

| 路徑 | 實作位置 | 版本 |
|---|---|---|
| 首次 @bot 自動建立（通訊平台） | `message-processor.ts routeInbound` | v0.4.1 |
| Admin Web UI 手動新增 | `REST POST /api/admin/messaging-groups` | v0.4.4 |

Seed 规則（兩路徑共用）：
- `groupId` = `groups.list()[0].id`（`groups.yaml` 順序第一個 enabled agent group）
- `agentId` = 該 group 的 `defaultAgent ?? agents[0]`
- `engageMode` = 平台為 `discord`/`slack`/`teams` 且 `isGroup=true` → `'mention-sticky'`；其餘（DM、Telegram 群組）→ `'pattern'` + `engagePattern='.'`
- `sessionMode` = `'per-user'`
- `ignoredMessagePolicy` = `'accumulate'`

如未設定任何 group → log warn、不 seed（chat 不會回覆，需 admin 進 Web UI 手動建立）。Admin 後續可在 `/admin/messaging-groups` 修改或新增 wiring。

#### 通訊軟體 vs Web 平台差異

| 行為 | 通訊軟體 (Telegram/Slack/Discord/WhatsApp/Teams) | Web 聊天 (`/chat`) |
|---|---|---|
| session 建立 | 由 router 自動建立（依 sessionMode 查找或新建） | 使用者手動點「新對話」 |
| session 查詢 key | `(group, agent, mg, thread?, platformUserId?)` | `(userId, groupId, agentId)`，每次新建 |
| engage 判定 | 依 wiring 的 `engageMode` + `engagePattern` | 不適用（直接進入 agent） |
| thread 支援 | 依平台：Slack/Discord/Teams 支援；Telegram/WhatsApp 不支援 | 不適用 |
| sessionMode 強制升級 | `supportsThreads=true` + `isGroup=true` → 強制 `per-thread` | 不適用 |

#### 各平台 sessionMode 實際效果

| sessionMode | Telegram (DM) | Telegram (群組) | Slack (channel) | Discord (channel) |
|---|---|---|---|---|
| `per-user` | 一個 user 一個 session | 每個 user 各自獨立 session | 每個 user 各自獨立 session | 每個 user 各自獨立 session |
| `per-thread` | 退化為 `per-user`（不支援 thread） | 退化為 `per-user` | **thread × user**：同 thread 同 user 一個 session | **thread × user** |
| `shared` | 同上（DM 只有一人） | 群組內同 user 一個 session | 頻道內同 user 一個 session | 頻道內同 user 一個 session |
| `agent-shared` | 跨所有 chat 共用 ⚠️ | 跨所有 chat 共用 ⚠️ | 跨所有 chat 共用 ⚠️ | 跨所有 chat 共用 ⚠️ |

> ⚠️ `shared` 和 `agent-shared` 會讓多用戶共用同一個對話上下文，可能導致訊息互相干擾。UI 上以紅色警告標示。

#### 常見配置範例

**DM 全收（最簡單）**：
```
engageMode: pattern, engagePattern: '.', sessionMode: per-user
```
→ 一個 user 的所有 DM 訊息都觸發，每 user 獨立對話。

**群組指令分流**：
```
wiring 1: engageMode: pattern, engagePattern: '^/dev', agent: dev-bot
wiring 2: engageMode: pattern, engagePattern: '^/qa',  agent: qa-bot
```
→ `/dev …` 找開發代理，`/qa …` 找測試代理。

**Slack mention-sticky（推薦）**：
```
engageMode: mention-sticky, sessionMode: per-thread
```
→ `@bot` 起始對話後，整個 thread 自動接續，不用每句都 @。

---

## 5. 容器 Runtime

### 5.1 Opencode（[images/agent-base.opencode/runtime/index.js](../images/agent-base.opencode/runtime/index.js)）

> SDK：`@opencode-ai/sdk` **v1.14.30**（官方版，ESM-only）。使用 `createOpencodeClient({ baseUrl })` 純 HTTP client；所有 resource 方法採 heyapi 風格 `{ path, body, query }`，預設 responseStyle 為 `'fields'`，回傳 `{ data, error, request, response }`。

- 進程啟動順序：`entrypoint.sh` 先 symlink `opencode.json` / `AGENTS.md` 到 `/workspace`、**複製** `.opencode/`（`cp -r`）→ 啟動 `opencode serve --port 54321 --hostname 127.0.0.1` → 等 server ready → 啟動本 runtime (`:7080`)
- runtime 啟動時會 dump boot 診斷資訊：`config.get()` / `project.current()` / `path.get()` / `config.providers()` / `app.agents()`
- 收到 `SIGTERM` / `SIGINT` 時執行 graceful shutdown：abort 所有 in-flight prompt → close event stream → delete opencode session → 5s 超時退出
- `POST /sessions` → `client.session.create({ body: { title: 'zeroclaw-{agentId}' } })` → `{ data }` 取 `opencodeSid`，與本端 `sdkSessionId` 對應
- `POST /sessions/:id/messages`：
  1. **先**訂閱事件流：`await client.event.subscribe()` → `{ stream }`，再開 prompt（避免漏事件）
  2. `client.session.prompt({ path: { id: opencodeSid }, body: { agent, [model], parts: [{ type: 'text', text }] } })`
     - `body.agent`：來自 API Server 的 `session.subAgent`（對應 `opencode.json` 的 `agent.{name}` block）
     - `body.model`：**預設不傳**，讓 opencode server 自行從 `opencode.json` 的 `model` / `agent.{name}.model` 解析；唯 `OPENCODE_MODEL_ID` env 明確設定時才以 `{ providerID, modelID }` 覆蓋
  3. 處理事件：
     - `message.part.updated`（`type=text`）→ 計算 delta 差量 → emit `chunk`
     - `message.part.updated`（`type=tool`）→ 映射為 `tool.call` / `tool.result`
     - `message.part.updated`（`type=step-start`）→ emit `step.start`（LLM 開始新推理步驟）
     - `message.part.updated`（`type=step-finish`）→ emit `step.finish`（含 `reasoningTokens` / `inputTokens` / `outputTokens` / `cost`）
     - `message.updated`（`role=user`）→ 記錄 userMessageId，跳過 user text parts 避免回顯
     - `message.updated`（`role=assistant`）→ 提取 `info.tokens`（含 `cache.read`、`reasoning`）更新 usage；檢查 `info.error`（`ProviderAuthError` / `UnknownError` / `MessageOutputLengthError` / `MessageAbortedError`）
     - `permission.updated` → 透傳 `approval.required` 事件給 API Server；API Server 回 `POST /sessions/:id/approval { requestId, approved, remember? }`，runtime 透過 SDK `client.postSessionIdPermissionsPermissionId({ path: { id, permissionID }, body: { response: 'once'\|'always'\|'reject' } })` 轉發給 opencode server
     - `session.error` → emit `error` 事件
  4. `session.idle` 為結束信號；prompt resolved 後仍 drain 3s 防尾段
  5. Fallback：若 SSE 未捕獲到 text，從 `prompt()` 回傳的 `result.data.parts` 提取
  6. 串流終結時 emit `done` + `usage`（從 `info.tokens`：`inputTokens = input + cache.read`，`outputTokens = output`，`reasoningTokens = reasoning`）
- `POST /sessions/:id/abort` → `client.session.abort({ path: { id } })`
- `DELETE /sessions/:id` → `client.session.delete({ path: { id } })`

### 5.2 Copilot（JSON-RPC over TCP）

- 每行一個 JSON-RPC 2.0 訊息（newline-delimited）
- Methods（client → runtime）：`session.create / close / sendMessage / abort / approval / elicit / switchAgent / ping`
- Notifications（runtime → client）：`agent.event { sdkSessionId, event }`
- 事件映射：
  - `assistant.message_delta` → `chunk`
  - `tool.execution_start/complete` → `tool.call` / `tool.result`
  - `assistant.reasoning_delta`（首次）→ `step.start`；`assistant.reasoning` → `step.finish`
  - `assistant.usage` → `lastUsage`（含 `reasoningTokens`）
  - `subagent.started/completed` → `subagent.started` / `subagent.completed`
  - `session.error` → `error`
  - `session.idle` → `done`
- Provider 端 [copilot-provider.ts](../packages/api-server/src/agent/copilot-provider.ts) 用 `Socket` + buffered line parser，每個 streaming session 對應一個 `AgentEventStream`

### 5.3 容器命名規則與 Agent 自訂映像擴充

#### 容器命名

所有 agent 容器一律命名為：

```
zeroclaw-{groupId}-{agentId}
```

設計理由：
- **每個 (group, agent) pair 必須有獨立容器**：即使共用同一個 base image，不同 agent 仍需 mount 不同的 `agents/<id>/` 資料夾、注入不同的 env，行為完全不同。
- 若用 base image 名稱命名（如 `zeroclaw-opencode`），多 agent 共用 base image 時會撞名 → 退化為 1 個全域容器，破壞隔離性，因此**容器名稱層級不採用 base image 命名**。
- 命名只受 `groupId` 與 `agentId` 影響，`API server` 重啟可決定性 adopt 既有容器（`docker ps` 名稱比對）。

#### Image Tag 規則（容器映像層級才反映 base/custom 差異）

容器名是邏輯隔離單位；映像 (`imageTag`) 才是實際打包：

| 情境 | image tag | 來源 |
|---|---|---|
| 純 base image 模式（`agent.hasCustomDockerfile=false`） | `group.container.baseImage`（如 `zeroclaw/agent-base-opencode:latest`） | `images/agent-base.opencode/` 或 `images/agent-base.copilot/` 預先 build |
| Agent 自訂擴充（`agent.hasCustomDockerfile=true`） | `zeroclaw/agent-{agentId}:latest` | `agent-detector` 偵測 `agents/<id>/Dockerfile` → `ContainerManager.ensureAgentImage` 首次需要時 `docker build` 該目錄 → 結果快取於 `builtImages` Set |

#### Agent 自訂映像擴充

要為單一 agent 加裝套件、額外二進位、客製依賴，**直接在 `agents/<agentId>/` 內新增 `Dockerfile`**（建議以該 group 的 `container.baseImage` 為 `FROM`）：

```dockerfile
# agents/my-bot/Dockerfile
FROM zeroclaw/agent-base-opencode:latest
RUN apt-get update && apt-get install -y --no-install-recommends \
      ripgrep imagemagick \
    && rm -rf /var/lib/apt/lists/*
COPY tools/ /opt/agent-tools/
ENV PATH=/opt/agent-tools:$PATH
```

流程：
1. `agent-detector` 啟動時掃描 `agents/<id>/`，發現 `Dockerfile` → `agent.hasCustomDockerfile=true`
2. `ContainerManager.acquire()` → `ensureAgentImage(group, agent)`：
   - `hasCustomDockerfile=false` → 直接回傳 `group.container.baseImage`
   - `hasCustomDockerfile=true` → 計算 tag `zeroclaw/agent-{agentId}:latest` → 若 `builtImages` 未命中且 `docker images` 不存在 → `docker build agents/<id>/`
3. 容器仍然命名為 `zeroclaw-{groupId}-{agentId}`，只是底層 image 不同

> ⚠️ 目前 image build 沒有 content hash cache（[REQUIREMENTS.md](REQUIREMENTS.md) T-5）：修改 `Dockerfile` 後 `builtImages` set 仍可能視為 hit，需手動 `docker rmi` 或重啟 API server 觸發 rebuild；後續會補 content hash 自動失效。

---

## 6. 持久化

### 6.1 資料庫（API server 內）

**雙驅動架構**：`DB_DRIVER` env 選擇 `postgres`（預設）或 `sqlite`。

- **PostgreSQL**（推薦）：`pg.Pool`，連線字串由 `DATABASE_URL` env 提供，docker-compose 內用 `zeroclaw-postgres` 容器。
- **SQLite**：`better-sqlite3`，檔案路徑由 `SQLITE_PATH` env 提供（預設 `data/platform.db`）。適合本機開發測試。

兩者實作同一個 `DbStore` 介面（全面 async），由 `db/index.ts` factory 依 `DB_DRIVER` 分派。

| 表 | 用途 | 關鍵欄位 |
|---|---|---|
| `users` | 使用者 | `id`, `role`, `external_ids` (JSON: platform → userId) |
| `sessions` | 對話 session | `session_id`, `user_id`, `group_id`, `agent_id`, `container_id`, `sdk_session_id`, `platform`, `platform_chat_id`, `thread_id`, `messaging_group_id`, `status`, `message_count` |
| `messages` | 對話內容 | `id`, `session_id`, `role`, `content`, `usage`, `created_at` |
| `pairings` | 4-digit pairing code | `code`, `group_id`, `agent_id`, `platform`, `engage_mode`, `session_mode`, `status`, `consumed_chat_id` |
| `messaging_groups` | 平台頻道/聊天室 | `id`, `platform`, `platform_chat_id`, `is_group`, `unknown_sender_policy`, `denied_at` |
| `messaging_group_agents` | 頻道↔agent 的 wiring | `messaging_group_id`, `group_id`, `agent_id`, `engage_mode`, `engage_pattern`, `session_mode`, `ignored_message_policy` |
| `containers` | ContainerPool 持久化 | `container_id`, `group_id`, `agent_id`, `image`, `status`, `started_at` |
| `group_overrides` | yaml group 動態 override（v0.4.2） | `group_id`, `display_name?`, `description?`, `icon?`, `enabled?`, `updated_at` |

> `messaging_groups` + `messaging_group_agents` 在 v0.3 取代舊的 `chat_bindings` 表。

### 6.2 容器內

| 路徑 | 內容 | 是否持久 |
|---|---|---|
| `/workspace/agent` | bind mount agent 資料夾（RO） | host |
| `/workspace/agents` | bind mount 整個 agents 目錄（RW）⁽¹⁾ | host |
| `/root/.local/share/opencode/auth.json` | bind mount RO（Opencode only） | host |
| `/.opencode/opencode.db` | opencode server 內部 DB | 容器內，**容器銷毀即消失** |
| Copilot 進程記憶體 | session 狀態 | **不持久** |

⁽¹⁾ 僅 `groups.yaml` 設定 `mountAgentsDir: true` 的 group 才掛載。用於代理人自建新代理人（scaffold-agent skill）。

→ 容器是「無狀態執行單元」，所有要保留的資訊在 API server 端 DB（PostgreSQL / SQLite）。

---

## 7. 認證與授權

- JWT bearer token（`auth-service.ts`）
- 角色：`admin` / `user`
- `/api/admin/*` 路由用 `requireAdmin(ctx)` 守衛
- WebSocket 握手帶 `Authorization` header 或 query token
- Webhook 各平台依官方簽章驗證（Telegram secret、WhatsApp HMAC、Discord ed25519、Slack signing、Teams Bearer JWT）

---

## 8. 觀測

| 來源 | 內容 | 取得方式 |
|---|---|---|
| API server log | pino structured log | `docker logs zeroclaw-api` |
| Container log | runtime stdout（line-buffered） | `docker logs zeroclaw-{group}-{agent}` |
| `/api/admin/containers` | 即時容器清單 + status | REST |
| `/api/admin/diagnostics/sessions` | 對話完整性報表 | REST|

---

## 9. 部署

### 9.1 Docker Compose 服務

| 服務 | 映像 | 用途 |
|---|---|---|
| `postgres` | `postgres:16-alpine` | PostgreSQL DB，預設啟動 |
| `api-server` | 自 build | Fastify 後端，掛 docker.sock |
| `web-app` | 自 build | nginx 靜態 |
| `agent-base-opencode-build` | profile=build only | 預先 build base 映像 |
| `agent-base-copilot-build` | profile=build only | 預先 build base 映像 |

> agent 容器**不**在 compose 裡 — 由 `ContainerManager` 動態啟動，加入 `zeroclaw-net` network。

### 9.2 啟停腳本

- `scripts/start.sh` / `scripts/start.ps1`：建 network → build base 映像 → up api-server + web-app
- `scripts/stop.sh` / `scripts/stop.ps1`：down compose（agent 容器隨 API server 結束被 GC 清掉）

### 9.3 必要環境變數

見 [README.md §快速開始](../README.md#-快速開始)。

---

## 10. 設計決議（已固化）

> 收斂自 [DESIGN.md §19 待決議事項](DESIGN.md#19-待決議事項)。下表項目已由實作確立，DESIGN.md 該節保留作為歷史紀錄。

### 10.1 架構決策

| 議題 | 決議 | 依據 |
|---|---|---|
| 前端框架 | **React 18 + Vite 5 + Zustand**（純 SPA，不上 SSR） | [packages/web-app](../packages/web-app/) |
| 開發 / 生產 DB | **PostgreSQL**（預設）+ **SQLite**（fallback）雙驅動 | [db/index.ts](../packages/api-server/src/db/index.ts)；`DB_DRIVER` env 選擇；PostgreSQL docker-compose 內建；SQLite 供本機開發 |
| 容器編排 | **純 Docker API（dockerode）**，不支援 Kubernetes | [container-manager.ts](../packages/api-server/src/container/container-manager.ts) |
| Web App 部署 | **獨立 nginx 容器**（不由 API server serve 靜態） | [docker-compose.yml](../docker-compose.yml) |
| API ↔ Container 拓撲 | **Docker-out-of-Docker**：API server 容器掛 `docker.sock` 控制宿主機 daemon | [container-manager.ts](../packages/api-server/src/container/container-manager.ts) |

### 10.2 功能範圍

| 議題 | 決議 | 依據 |
|---|---|---|
| Auto routing | **採用**：LLM 分類器（OpenAI / Anthropic 雙引擎） | [auto-router.ts](../packages/api-server/src/session/auto-router.ts) |
| 訊息持久化 | **存 DB**：所有 user/assistant text 寫入 `messages` 表；`tool_calls` 不入庫（可由 WS 即時取） | [db-store.ts](../packages/api-server/src/db/db-store.ts) |
| 通訊平台 | **五平台全做**：Telegram / WhatsApp / Discord / Slack / Teams | [messaging/](../packages/api-server/src/messaging/) |
| 管理介面 | **Web UI + Admin API**：管理員用 `/admin` 監控；`/admin/messaging-groups` 完整 CRUD；groups.yaml 僅定義 group/agent/routing/container，通訊頻道配置全部走 DB + Web UI | [AdminPage.tsx](../packages/web-app/src/pages/AdminPage.tsx)、[MessagingGroupsPage.tsx](../packages/web-app/src/pages/MessagingGroupsPage.tsx) |
| Group 設定動態化 | **混合模式**：`agents` / `container.*` / `routing.*` 仍為 yaml-only（涉及映像建置與權限）；`displayName` / `description` / `icon` / `enabled` 可透過 Web UI override（v0.4.2） | [GroupsAdminPage.tsx](../packages/web-app/src/pages/GroupsAdminPage.tsx)、[groups-loader.ts](../packages/api-server/src/config/groups-loader.ts) §3.3 |
| `.zeroclaw.json` | **可省略**：缺檔時 `displayName` fallback 到資料夾名 | [agent-detector.ts](../packages/api-server/src/agent/agent-detector.ts) |

### 10.3 安全性

| 議題 | 決議 | 依據 |
|---|---|---|
| Agent 資料夾掛載 | **預設唯讀** bind mount（`:ro`）；`mountAgentsDir: true` 時額外掛載整個 `agents/` 為可寫，供代理人自建新代理人 | [container-manager.ts](../packages/api-server/src/container/container-manager.ts) |
| 訊息稽核 | **全對話入庫**（`messages` 表） | §6.1 |
| 認證 | **JWT bearer**（`jose`），webhook 各平台原生簽章 | §7 |

### 10.4 擴展性

| 議題 | 決議 | 依據 |
|---|---|---|
| 多機部署 | **第一版單機**；多機列為未來工作（需替換 SQLite + container 註冊中心） | §9 |
| 新 SDK 擴充 | **透過 `AgentProvider` 介面**新增實作即可 | [agent-provider.ts](../packages/api-server/src/agent/agent-provider.ts) |
| 自訂工具 | **走 MCP**（`opencode.json` 的 `mcp` 欄位 / Copilot 的 `.mcp.json`），平台不另開 API | §4 |

### 10.5 Agent 資料夾慣例

| 議題 | 決議 | 依據 |
|---|---|---|
| Copilot 子代理 | **採平台慣例 `.agents/<name>.md`**（與 Opencode `.opencode/agents/` frontmatter 對齊） | [agent-detector.ts](../packages/api-server/src/agent/agent-detector.ts) |
| Copilot Hooks | **採平台慣例 `hooks/*.ts`**（runtime dynamic import） | [images/agent-base.copilot/runtime/](../images/agent-base.copilot/runtime/) |

### 10.6 仍未決議（追蹤於 [REQUIREMENTS.md](REQUIREMENTS.md) §23-§24）

- LLM API Key 管理：環境變數 ✅（暫定）vs Vault/Secret Manager
- 容器網路白名單與出口控制
- Per-user / per-platform Rate limiting 策略
- 跨平台帳號綁定流程（schema 已預留 `users.external_ids`）
- UI i18n
- MessagingAdapter 動態 plugin 機制
- Dockerfile build cache hash 策略（內容 hash vs git commit hash）
- Discord Gateway WSS / Slack Socket Mode（T-32）
- openDM adapter 實作（Discord / Slack / Teams）

---

## 11. 已知限制與待辦

| 限制 | 影響 | 對策 |
|---|---|---|
| Copilot quota（premium_interactions 0/300）會回 402 | 無法直接用 Copilot API | 設定 `OPENAI_API_KEY` + `BYOK_BASE_URL` 走 BYOK |
| Node stdout 在非 TTY fully-buffered | docker logs 看不到 chat 過程 | 已用 `setBlocking(true)` 修正 |
| `messages.tool_calls` 永遠 NULL | 工具軌跡不入庫 | 設計上不記錄；觀測由 WS 即時取 |
| Discord Gateway WSS 尚未實作 | Discord 仍需公開 URL（webhook 模式） | 列為 T-32 待實作 |
| Slack Socket Mode 尚未實作 | Slack 仍需公開 URL（webhook 模式） | 列為 T-32 待實作 |
| openDM adapter 實作缺 | Discord/Slack/Teams 無法主動發起 DM | 介面已宣告，adapter 內實作待補 |

> 以下項目已完成，不再列為限制：
> - ✅ 對話歷史 Replay（T-1，v0.4）：`AgentProvider.injectHistory()` 在容器遷移/重啟時自動回放最近 50 筆訊息
> - ✅ Per-session 並發鎖（T-2，v0.3）：`sessionLocks` Map + lock wrapper 防止同 session 亂序
> - ✅ ContainerPool 持久化（T-4，v0.3）：`containers` 表 + `adoptFromDb()` 交叉比對 docker ps
> - ✅ PostgreSQL 完整實作（T-11，v0.3）：`DB_DRIVER=postgres` 預設，`pg.Pool` 驅動，`DbStore` 全面 async
> - ✅ Session 生命週期限制（T-3，v0.3/v0.4）：idle timeout、message limit、retention days；ended session 收到新訊息時自動 reopen（容器重啟 + history replay），只有 error 狀態不可恢復

---

## 12. 相關文件

- [DESIGN.md](DESIGN.md) — 完整設計規格（含已過期或冗餘章節，部分已被本架構文件取代）
- [REQUIREMENTS.md](REQUIREMENTS.md) — 需求與實作狀態總覽（含技術規格、TODO、驗收項目）
- 程式碼導讀：從 [packages/api-server/src/main.ts](../packages/api-server/src/main.ts) 入口開始

---

## 13. 索引表（快速查找）

### 13.1 原始碼檔案 → 說明章節

| 檔案 / 路徑 | 說明 | 章節 |
|---|---|---|
| `packages/api-server/src/main.ts` | Fastify bootstrap、依賴注入順序 | §3 |
| `packages/api-server/src/config/groups-loader.ts` | `groups.yaml` 載入 + DB override merge + `reload()` | §3.2, §3.3 |
| `packages/api-server/src/config/groups-schema.ts` | zod GroupConfig schema 驗證 | §3.2 |
| `packages/api-server/src/config/env.ts` | 環境變數 schema (zod) | §9.3 |
| `packages/api-server/src/container/container-manager.ts` | Docker 容器生命週期 + Pool + GC + 健康檢查 | §4.2, §4.3, §4.4, §5.3 |
| `packages/api-server/src/session/session-manager.ts` | 主協調者：DB × Container × Provider | §4.1, §4.3 |
| `packages/api-server/src/session/auto-router.ts` | `routing.mode=auto` LLM 分類器 | §4.1 |
| `packages/api-server/src/messaging/message-processor.ts` | 平台訊息路由 + wiring fan-out + auto-seed wiring | §4.6, §4.7 |
| `packages/api-server/src/messaging/pairing.ts` | 4 位數 pairing code 建立 / 消費 | §4.6 |
| `packages/api-server/src/messaging/adapter.ts` | `MessagingAdapter` 介面定義 | §4.5 |
| `packages/api-server/src/messaging/telegram-adapter.ts` | Telegram polling / webhook | §4.5 |
| `packages/api-server/src/db/db-store.ts` | SQLite（`better-sqlite3`）驅動 | §6.1 |
| `packages/api-server/src/db/pg-store.ts` | PostgreSQL（`pg.Pool`）驅動 | §6.1 |
| `packages/api-server/src/db/index.ts` | DB factory — 依 `DB_DRIVER` env 選驅動 | §6.1 |
| `packages/api-server/src/auth/auth-service.ts` | JWT 簽發 / 驗證、user 管理 | §7 |
| `packages/api-server/src/routes/rest.ts` | 全部 REST endpoints | §4.6, §6.1 |
| `packages/api-server/src/routes/ws.ts` | WebSocket `/ws` 串流推送 | §4.1 |
| `packages/api-server/src/routes/webhooks.ts` | `/webhook/{platform}` 進入點 | §4.5 |
| `packages/api-server/src/agent/agent-detector.ts` | 資料夾掃描 → SDK 偵測 + `hasCustomDockerfile` | §3.1 |
| `packages/api-server/src/agent/copilot-provider.ts` | Copilot JSON-RPC over TCP | §5.2 |
| `packages/api-server/src/agent/opencode-provider.ts` | Opencode HTTP + SSE | §5.1 |
| `images/agent-base.opencode/runtime/index.js` | Opencode 容器 runtime（SSE event mapping、graceful shutdown） | §5.1 |
| `images/agent-base.copilot/runtime/` | Copilot 容器 runtime（JSON-RPC 協議） | §5.2 |
| `packages/web-app/src/pages/AdminPage.tsx` | Admin 後台首頁 / 導覽卡 | §9 |
| `packages/web-app/src/pages/MessagingGroupsPage.tsx` | 通訊頻道 + Wiring 管理 | §4.6, §4.7 |
| `packages/web-app/src/pages/GroupsAdminPage.tsx` | Agent Group 動態設定 override | §3.3 |
| `packages/web-app/src/store.ts` | Zustand store + API actions | §2 |
| `packages/shared/src/types.ts` | 共用型別（`IncomingMessage`、`GroupConfig`、`AdminGroupRecord`…） | §3.1 |
| `groups.yaml` | Agent group 靜態設定來源 | §3.2 |
| `docker-compose.yml` | 服務編排（postgres、api-server、web-app） | §9.1 |
| `scripts/start.sh` / `start.ps1` | 建 network → build base image → up compose | §9.2 |

### 13.2 REST API Endpoint 速查

| Method | 路徑 | 權限 | 說明 |
|---|---|---|---|
| `POST` | `/api/auth/login` | — | 登入，回傳 JWT |
| `GET` | `/api/groups` | user | 列出已啟用 group（合併 DB override） |
| `GET` | `/api/groups/:id/agents` | user | 列出 group 下的 agents |
| `POST` | `/api/sessions` | user | 建立新 session |
| `GET` | `/api/sessions` | user | 列出本使用者 sessions |
| `GET` | `/api/sessions/:id/messages` | user | 取對話訊息 |
| `POST` | `/api/sessions/:id/messages` | user | 送訊息（REST 模式） |
| `POST` | `/api/sessions/:id/abort` | user | 中斷當前回應 |
| `POST` | `/api/sessions/:id/switch` | user | 切換 agent |
| `WS` | `/ws` | user | WebSocket 串流推送（AgentEvent） |
| `GET` | `/api/admin/containers` | admin | 即時容器清單 + 狀態 |
| `GET` | `/api/admin/diagnostics/sessions` | admin | 對話完整性報表 |
| `GET` | `/api/admin/groups` | admin | 所有 group（含停用）+ override 狀態 |
| `PATCH` | `/api/admin/groups/:id` | admin | 更新 group override（`displayName` / `description` / `icon` / `enabled`） |
| `DELETE` | `/api/admin/groups/:id/override` | admin | 清除 override，還原 yaml 預設 |
| `GET` | `/api/admin/messaging-groups` | admin | 列出通訊頻道 + wirings |
| `POST` | `/api/admin/messaging-groups` | admin | 手動建立通訊頻道，建立後自動 seed 預設 wiring（同首次 @bot 觸發路徑） |
| `PATCH` | `/api/admin/messaging-groups/:mgId` | admin | 更新頻道設定（封鎖等） |
| `DELETE` | `/api/admin/messaging-groups/:mgId` | admin | 刪除頻道（cascade 刪 wirings） |
| `POST` | `/api/admin/messaging-groups/:mgId/wirings` | admin | 新增 wiring |
| `PATCH` | `/api/admin/messaging-groups/:mgId/wirings/:g/:a` | admin | 更新 wiring |
| `DELETE` | `/api/admin/messaging-groups/:mgId/wirings/:g/:a` | admin | 刪除 wiring |
| `POST` | `/api/admin/messaging-groups/:mgId/open-dm` | admin | 主動對平台使用者開 DM |
| `POST` | `/api/pairings` | admin | 產生 4 位數 pairing code |
| `POST` | `/webhook/telegram` | — | Telegram webhook 進入點 |
| `POST` | `/webhook/whatsapp` | — | WhatsApp webhook（含 GET verify challenge） |
| `POST` | `/webhook/slack` | — | Slack webhook（含 url_verification） |
| `POST` | `/webhook/discord` | — | Discord Interactions endpoint（Ed25519 驗簽） |
| `POST` | `/webhook/teams` | — | Teams Bot Framework endpoint（Bearer JWT 驗） |

### 13.3 環境變數速查

| 變數 | 預設值 | 必填 | 說明 | 章節 |
|---|---|---|---|---|
| `JWT_SECRET` | — | ✅ | JWT 簽章 secret（≥32 字元） | §7 |
| `DB_DRIVER` | `postgres` | — | `postgres` 或 `sqlite` | §6.1 |
| `DATABASE_URL` | — | PG 必填 | PostgreSQL 連線字串 | §6.1 |
| `SQLITE_PATH` | `data/platform.db` | — | SQLite 檔案路徑 | §6.1 |
| `GROUPS_FILE` | `groups.yaml` | — | groups.yaml 路徑 | §3.2 |
| `AGENTS_DIR` | `agents/` | — | agents 資料夾路徑 | §3.1 |
| `HOST_AGENTS_DIR` | — | Docker 部署 | 宿主機 `agents/` 絕對路徑（讓子容器 bind mount） | §9.1 |
| `CONTAINER_IDLE_TIMEOUT_SEC` | `1800` | — | 容器閒置 GC 倒計時（秒） | §4.4 |
| `DEFAULT_CONTAINER_CPUS` | `1.0` | — | 容器預設 CPU 配額 | §3.2 |
| `DEFAULT_CONTAINER_MEMORY` | `512m` | — | 容器預設記憶體配額 | §3.2 |
| `OPENAI_API_KEY` | — | LLM 依需 | OpenAI API key（`routing.mode=auto` 時需要） | §4.1 |
| `ANTHROPIC_API_KEY` | — | LLM 依需 | Anthropic API key | §4.1 |
| `BYOK_BASE_URL` | — | — | 自訂 LLM base URL（BYOK 模式） | §10.2 |
| `OPENCODE_AUTH_DIR` | — | Opencode 用 | 宿主機 opencode `auth.json` 所在目錄 | §5.1 |
| `TELEGRAM_BOT_TOKEN` | — | Telegram 用 | Telegram Bot token | §4.5 |
| `TELEGRAM_MODE` | `polling` | — | `polling`（預設）或 `webhook` | §4.5 |
| `WHATSAPP_ACCESS_TOKEN` | — | WhatsApp 用 | Meta Cloud API access token | §4.5 |
| `WHATSAPP_PHONE_NUMBER_ID` | — | WhatsApp 用 | Meta 電話號碼 ID | §4.5 |
| `WHATSAPP_APP_SECRET` | — | WhatsApp 用 | HMAC-SHA256 簽章驗證 secret | §4.5 |
| `DISCORD_BOT_TOKEN` | — | Discord 用 | Discord Bot token | §4.5 |
| `DISCORD_PUBLIC_KEY` | — | Discord 用 | Ed25519 簽章驗證 public key | §4.5 |
| `SLACK_BOT_TOKEN` | — | Slack 用 | `xoxb-…` Bot OAuth token | §4.5 |
| `SLACK_SIGNING_SECRET` | — | Slack 用 | HMAC-SHA256 簽章驗證 secret | §4.5 |
| `TEAMS_APP_ID` | — | Teams 用 | Azure Bot Application ID | §4.5 |
| `TEAMS_APP_PASSWORD` | — | Teams 用 | Azure Bot Client Secret | §4.5 |
| `POSTGRES_PASSWORD` | `zeroclaw-dev` | — | docker-compose PostgreSQL 密碼 | §9.1 |

