# ZeroClaw Agent Platform — 設計理念

> 版本：0.4.0
> 日期：2026-05-01
>
> 本文件說明 ZeroClaw 平台的**設計目的、核心理念與方法論**。
> 實作細節、程式碼導讀與檔案對應請見 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 目錄

1. [為什麼要做這個平台](#1-為什麼要做這個平台)
2. [設計原則](#2-設計原則)
3. [核心設計方法](#3-核心設計方法)
4. [關鍵設計決策](#4-關鍵設計決策)
5. [邊界與取捨](#5-邊界與取捨)
6. [未來演進方向](#6-未來演進方向)

---

## 1. 為什麼要做這個平台

### 1.1 解決的問題

AI 代理人（Agent）的開發與部署存在三個斷層：

- **開發體驗斷層**：開發者用 SDK 原生工具（Copilot CLI、Opencode CLI）開發代理人，但要部署成「服務」時必須自行處理容器化、多租戶隔離、通道接入等基礎設施。
- **使用者觸及斷層**：代理人只能透過 CLI 或 IDE 使用，無法讓非技術用戶從 Web、Telegram、Slack 等日常工具直接存取。
- **管理營運斷層**：多個代理人各自獨立運行，缺乏統一的群組管理、Session 追蹤、健康監控與閒置回收機制。

### 1.2 平台定位

ZeroClaw 是一個**多租戶 AI 代理人營運平台**，讓開發者：

- 用 SDK 原生方式開發代理人（不學新格式）
- 放進一個資料夾就完成部署
- 用戶透過 Web UI 或六種通訊軟體直接對話
- 平台負責容器隔離、Session 管理、健康監控

**一句話定位**：把「一個資料夾」變成「一個可營運的 AI 服務」。

### 1.3 非目標

本平台刻意不做以下事項：

- **不自建 LLM 推理**：依賴外部 LLM API（OpenAI / Anthropic / GitHub Copilot），平台只負責代理人的編排與營運。
- **不做計費系統**：LLM 成本由使用者自行管理 API Key。
- **不做跨主機調度**：第一版限定單機 Docker，不支援 Kubernetes。
- **不發明配置格式**：代理人定義完全沿用 SDK 原生慣例，平台層零侵入。

---

## 2. 設計原則

### 2.1 資料夾即代理（Folder-as-Agent）

**核心理念**：一個 `agents/<name>/` 資料夾就是一個完整的代理人。不需要向平台「註冊」，不需要填表單，不需要 API 呼叫。平台啟動時掃描資料夾、偵測 SDK 類型、自動上線。

**為什麼**：
- 降低認知負擔：開發者只需理解 SDK 原生文件結構
- 版本控制友好：代理人定義就是純檔案，可用 Git 管理
- 可攜性：同一個資料夾在 CLI 開發環境和 ZeroClaw 平台上都能運行

### 2.2 SDK 原生優先（SDK-Native First）

**核心理念**：平台不發明新的配置格式。代理人內部結構（指令、工具、技能、子代理、權限）**完全遵循該 SDK 的原生慣例**。

**方法**：
- Opencode 代理人 → `opencode.json` + `.opencode/agents/` + `.opencode/skills/`
- Copilot 代理人 → `AGENTS.md` + `.mcp.json` + `skills/`
- SDK 類型由**檔案指紋自動偵測**（有 `opencode.json` 就是 Opencode、有 `AGENTS.md` 就是 Copilot），開發者不需要額外標記。

**例外**：Copilot SDK 缺乏子代理與 Hook 的檔案慣例（只支援程式化 API），平台補上 `.agents/<name>.md` 與 `hooks/*.ts` 慣例，且 **frontmatter 格式刻意對齊 Opencode**，使跨 SDK 的心智模型一致。

### 2.3 容器隔離（Container Isolation）

**核心理念**：每個代理人運行在獨立的 Docker 容器內。容器之間互相隔離，單一代理人的崩潰或資源耗盡不影響其他代理人。

**設計選擇**：
- 每個 (group, agent) 共用一個容器（key = `(groupId, agentId)`），內部以 `sdkSessionId` 多路復用，避免為每個使用者開獨立容器
- `group.container.maxSessions` 限制同一容器內最多並行 SDK session 數
- 代理人資料夾**預設唯讀掛載**（`:ro`），防止 LLM 操作改寫代理人定義。
- 容器是「無狀態執行單元」：所有需要持久化的資訊（Session、訊息紀錄）存在 API Server 端的資料庫，容器銷毀不丟資料。
- **容器重啟後自動回放歷史**（T-1 History Replay）：`AgentProvider.injectHistory()` 在新 SDK session 建立後將 DB 中最近 50 筆訊息注入，恢復對話脈絡。

### 2.4 群組管理（Group-based Organization）

**核心理念**：代理人以「群組」為單位組織。群組定義成員、容器資源、路由策略與通道綁定。

**為什麼不直接管理單一代理人**：
- 業務場景通常是「團隊」而非單一助手：客服團隊有 FAQ、工單、升級三個代理人
- 群組層級控制資源分配（CPU / 記憶體 / Session 上限）
- 通道綁定以群組為單位（一個 Telegram 群對應一個代理人群組）

### 2.5 統一事件抽象（Unified Event Abstraction）

**核心理念**：不同 SDK 的串流事件格式差異極大（Copilot 用 JSON-RPC 40+ 事件、Opencode 用 SSE），但對 API Server 和前端而言，代理人的行為只有幾種：輸出文字、呼叫工具、請求審批、切換子代理、完成。

**方法**：定義統一的 `AgentEvent` 型別，由各 SDK 的 Adapter 負責轉譯。上游（前端、Webhook）完全不感知底層 SDK 差異。

### 2.6 雙進程容器架構（Dual-Process Container）

**核心理念**：容器內採「SDK 進程 + Runtime Wrapper」雙進程結構。

**為什麼不直接暴露 SDK 進程**：
- Opencode Server 只 listen `127.0.0.1`，且 SSE 事件需在容器內訂閱
- Copilot SDK 沒有獨立 server，是 in-process API
- Runtime Wrapper 統一對外暴露 `:7080` 介面，將 SDK 原生協議轉為正規化的 `AgentEvent` 格式
- 生命週期管理：收到 `SIGTERM` 時可 graceful shutdown（abort prompt → 銷毀 session → 退出）

---

## 3. 核心設計方法

### 3.1 多通道接入（v0.3 重構）

**設計目的**：同一個代理人群組可同時服務 Web、Telegram、WhatsApp、Discord、Slack、Teams 六個通道，每個頻道可獨立配置不同的 agent、sessionMode 與 engageMode。

**方法**：
- **訊息正規化**：各平台 Adapter 將原生訊息轉為統一的 `IncomingMessage`（含 `threadId`, `isMention`, `isGroup`）
- **MessagingGroup**：DB-managed 的頻道實體，取代舊的 `groups.yaml.channels` 靜態配置，支援動態增刪與 admin API 管理
- **MessagingGroupAgent（Wiring）**：MessagingGroup 與 agent 的連接，帶 `engageMode`、`sessionMode`、`engagePattern`
- **Pairing flow**：管理員產生 4-digit code → 使用者在聊天室傳送 code → 自動建立 MessagingGroup + Wiring
- **EngageMode**：`pattern`（regex）/ `mention`（@mention）/ `mention-sticky`（@mention 啟動、thread 黏著）
- **SessionMode**：`per-user`（預設）/ `per-thread` / `shared` / `agent-shared`

**Web 與通訊軟體的差異**：Web 支援即時串流（逐 token）、工具可視化、中斷生成等富互動；通訊軟體受限於平台 API，採完整回覆模式、純文字摘要。

### 3.2 代理人路由

**設計目的**：同一群組內有多個代理人時，需要決定由誰回應。

**三種模式**：
- **explicit**：使用者自行選擇 / 切換代理人（Web UI 下拉選單、通訊軟體 `@mention`）
- **auto**：用 LLM 分類器分析訊息意圖，自動分派給最適合的代理人
- **round-robin**：依序輪流分配（測試用途）

所有模式都支援 `fallback` 設定，分派失敗時回退到預設代理人。

### 3.3 容器檔案系統

**設計目的**：在安全隔離與代理人自主性之間取得平衡。

**預設行為**：代理人資料夾唯讀掛載（`/workspace/agent:ro`），防止 LLM 改寫自身定義。

**自主建構能力**：當代理人需要建立新代理人（如嚮導型的 scaffold-agent 技能）時，管理員可在 `groups.yaml` 啟用 `mountAgentsDir: true`，額外掛載整個 `agents/` 目錄為可寫（`/workspace/agents`）。

**設計原則**：
- **預設安全、選擇性開放**：一般代理人唯讀，只有明確聲明的群組才獲得寫入能力
- **利用既有機制**：Docker bind mount 本身就是即時雙向映射，不需額外同步 daemon
- **職責分離**：`/workspace/agent`（自身定義，唯讀）與 `/workspace/agents`（平台擴展，可寫）路徑不衝突

**放棄的替代方案**：加 API endpoint 代寫檔案（破壞「資料夾即代理」理念）、writable staging + 搬移腳本（多一層間接層，增加故障點）、將 agent mount 改為 RW（安全風險過高）。

### 3.4 Base Image + Dockerfile 擴充

**設計目的**：讓代理人零配置即可運行，同時支援進階定製。

**方法**：
- 提供兩個通用 Base Image（Copilot / Opencode），包含 SDK 環境與 Runtime Wrapper
- 代理人不需要 Dockerfile，直接用 Base Image 啟動
- 需要額外工具（docker CLI、kubectl、向量資料庫）時，在代理人資料夾放 `Dockerfile`，`FROM` 繼承 Base Image 後擴充
- Image tag 用內容 hash，Dockerfile 或代理檔案沒變則不 rebuild

### 3.5 Session 管理（v0.3 多路復用）

**設計目的**：追蹤使用者與代理人之間的對話狀態，並支援多個 SDK session 共用同一個容器。

**關鍵設計**：
- 所有 Session 狀態存在 API Server 端的 SQLite，不依賴容器記憶體
- **per-user 模式（預設）**：`(userId, groupId, agentId, messagingGroupId)` 四元組唯一對應一個 Session
- **容器共用**：同一 (group, agent) 的所有 Session 共用一個容器（`zeroclaw-{group}-{agent}`），容器內以 `sdkSessionId` 區分
- `ContainerManager.attachSession / detachSession` 管理每個容器的活躍 SDK sessions；GC 等 `sdkSessions.size === 0` 後才停容器
- **ContainerPool 持久化**：容器資訊存入 DB；重啟後 `adoptFromDb()` 交叉比對 docker ps 重新接管存活容器，不浪費已啟動的容器
- 容器失效（崩潰或健康檢查失敗）時，SessionManager 自動遷移：重新取得容器 → 建立 SDK Session → 更新映射

### 3.6 SDK 抽象層

**設計目的**：讓 API Server 不感知底層是 Copilot 還是 Opencode。

**方法**：
- 定義 `AgentProvider` 統一介面（createSession / sendMessage / abort / switchAgent / approve）
- `CopilotAdapter`：JSON-RPC over TCP 協議
- `OpencodeAdapter`：HTTP + SSE 協議
- 兩者將 SDK 原生事件轉為統一的 `AgentEvent`，上游無差異

**擴充性**：未來新增 SDK 只需實作 `AgentProvider` 介面 + 對應 Base Image。

### 3.7 公開 SDK 全部機制（Agent Loop）

**設計目的**：不做 SDK 的「簡化封裝」，而是完整公開 SDK 的所有能力。

**必須公開的機制**：
- 工具執行 + 權限閘門（Pre/Post Hook、Permission Gate）
- 子代理自動推論與手動切換
- 技能（Skills）與 MCP 伺服器
- 串流事件（逐 token 輸出）
- 人工審批與互動式問答（Elicitation）
- Session 中斷與恢復

**Opencode 缺失的補齊**：Opencode SDK 不支援 hooks 與子代理自動編排，由容器內的 Runtime 層攔截 SDK 事件補齊，對外介面保持一致。

### 3.8 通訊通道層 — Adapter 自註冊

**設計目的**：讓多個通訊平台以外掛方式接入，不污染主流程。

**核心理念**：
- **Adapter 自註冊**：每個 `messaging/<platform>-adapter.ts` 在 import 時進 registry，新增平台不動 `main.ts`
- **三種連線模式統一介面**：webhook / polling / gateway 都實作同一個 `MessagingAdapter`，路由共用一份 `processIncomingMessages`
- **Thread 顯式宣告**：adapter 自己宣告 `supportsThreads`（Slack / Discord / Teams 是、Telegram / WhatsApp 否），由 group 決定是否納入 session key

> 各平台對齊 nanoclaw 程度與連線細節見 [ARCHITECTURE.md §4.5](ARCHITECTURE.md#45-通訊平台連線模式)

### 3.9 通道接入體驗 — 互動式 Pairing

**設計目的**：消除「先找 chatId 寫進 yaml 才能用」的門檻。

**核心理念**：admin 建立 4 位數 code → 在目標 chat 傳這 4 個數字 → 平台寫入綁定表，免改 yaml。所有 messaging 平台共用同一條路徑。

**狀態**：✅ 已實作（SQLite-backed、platform-agnostic）

> 流程細節見 [ARCHITECTURE.md §4.6](ARCHITECTURE.md#46-互動式-pairing-與-chat-bindings)

### 3.10 存取控制 — Permissions / Access Gate

**設計目的**：避免公開 bot 被陌生人濫用 LLM quota，同時保留「公開 FAQ bot」選項。

**三段策略**（每 group 自選）：
- `strict`（預設）：只有 `members` 清單裡的 external_id 能用
- `approval`：陌生人首訊暫存，admin 批准後放行
- `public`：完全開放

---

## 4. 關鍵設計決策


### 4.1 架構層

| 決策 | 選擇 | 理由 |
|------|------|------|
| 後端框架 | Fastify | 效能優於 Express、內建 TS + WebSocket 支援 |
| 前端框架 | React + Vite + Zustand | 生態成熟、輕量狀態管理、HMR 快 |
| 資料庫 | PostgreSQL（預設）+ SQLite（fallback） | 雙驅動架構；PostgreSQL 用於生產，SQLite 供本機開發；`DB_DRIVER` env 切換 |
| 容器管理 | 純 Docker API (dockerode) | 單機場景足夠、不引入 K8s 複雜度 |
| API ↔ Container 拓撲 | Docker-out-of-Docker | API Server 掛 `docker.sock` 控制宿主機 daemon |
| 前端部署 | 獨立 nginx 容器 | 與 API Server 解耦，可獨立更新 |
| Monorepo 工具 | pnpm workspace | 既有專案慣例 |

### 4.2 功能層

| 決策 | 選擇 | 理由 |
|------|------|------|
| 代理人路由 | 三模式（explicit / auto / round-robin） | explicit 最簡、auto 最智能、round-robin 供測試 |
| 訊息持久化 | 全部入庫（user + assistant text） | 支援歷史查詢、稽核、未來 replay |
| 通訊平台 | 六平台全做 | Web + TG + WA + Discord + Slack + Teams |
| `.zeroclaw.json` | 可省略 | 缺檔時用資料夾名稱當 displayName |
| 工具執行紀錄 | 不入庫 | 工具軌跡由 WS 即時取，DB 只存文字內容 |

### 4.3 安全層

| 決策 | 選擇 | 理由 |
|------|------|------|
| Agent 資料夾掛載 | 預設唯讀；`mountAgentsDir: true` 時額外掛載可寫 agents/ | 安全與自主性平衡（見 §3.3） |
| 認證 | JWT bearer (jose) | 輕量、無外部依賴 |
| Webhook 驗證 | 各平台原生簽章 | TG secret、WA HMAC、Discord ed25519、Slack signing、Teams Bearer JWT |
| 訊息稽核 | 全對話入庫 | 合規與除錯需求 |

### 4.4 Copilot SDK 平台慣例

Copilot SDK 原生只支援程式化 API 定義子代理與 Hook，缺乏檔案慣例。平台補上：

| 慣例 | 用途 | 設計考量 |
|------|------|---------|
| `.agents/<name>.md` | 子代理定義 | frontmatter 格式對齊 Opencode，降低跨 SDK 認知成本 |
| `hooks/*.ts` | Hook 實作 | Runtime 啟動時 dynamic import，綁定到 SDK hooks |

---

## 5. 邊界與取捨

### 5.1 已知限制

| 限制 | 影響 | 接受原因 |
|------|------|---------|
| 單機 Docker | 無法水平擴展 | 第一版優先簡單；多機需替換容器註冊中心 |
| Copilot quota 限制 | premium_interactions 歸零時 402 | BYOK 解法（設定 `OPENAI_API_KEY` 繞過） |
| Discord/Slack 仍需公開 URL | 無 Gateway/Socket Mode 時需暴露 webhook 端點 | 待實作 T-32 |

> 以下項目已在 v0.3/v0.4 完成，不再列為限制：
> - ✅ 容器重啟後 SDK 失憶 → History Replay（T-1）
> - ✅ Per-session 並行鎖（T-2）
> - ✅ ContainerPool in-memory → DB 持久化（T-4）
> - ✅ PostgreSQL 實作（T-11）
> - ✅ Session 生命週期限制（T-3）

### 5.2 刻意不做

| 項目 | 理由 |
|------|------|
| 平台自創配置格式 | 違反 §2.2 SDK 原生優先原則 |
| 容器內代理人定義可寫（預設） | 違反 §2.3 安全隔離原則 |
| API 驅動的代理人建立 | 違反 §2.1 資料夾即代理原則 |
| SDK 能力簡化封裝 | 違反 §3.7 公開全部機制原則 |
| 多機容器調度 | 第一版非目標，避免過度工程 |

---

## 6. 未來演進方向

### 6.1 短期（待實作）

- **Image build cache 策略**：用內容 hash 或 git commit hash 判斷是否需要 rebuild
- **Discord Gateway WSS**（T-32）：用 WebSocket 取代 webhook，免公開 URL
- **Slack Socket Mode**（T-32）：同上
- **openDM adapter 實作**：Discord / Slack / Teams 主動發起 DM

### 6.2 中期（規劃中）

- **LLM API Key 集中管理**：從環境變數升級至 Vault / Secret Manager
- **容器網路白名單**：控制代理人容器的出口存取
- **Per-user / per-platform Rate Limiting**：限流策略
- **跨平台帳號綁定**：通訊軟體用戶綁定 Web 帳號（schema 已預留 `users.external_ids`）
- **MessagingAdapter Plugin 機制**：動態載入新平台 Adapter

### 6.3 長期（願景）

- **多機部署**：引入容器註冊中心（PostgreSQL 已就緒）
- **新 SDK 支援**：透過 `AgentProvider` 介面擴充
- **UI 國際化（i18n）**

---

## 相關文件

- [ARCHITECTURE.md](ARCHITECTURE.md) — 實作細節、程式碼導讀、檔案對應
