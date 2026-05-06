---
name: troubleshoot
description: Zeroclaw 常見錯誤的快速排查清單（容器、Copilot quota、port 占用）
---

# Zeroclaw Troubleshoot Skill

當使用者描述「跑不起來」「容器啟動失敗」「沒回應」時，依序檢查下列項目。

## 1. API server 沒啟動
```bash
docker logs zeroclaw-api --tail 200
```
常見：
- `JWT_SECRET is required` → `.env` 補上
- `EADDRINUSE :3000` → 改 `API_PORT` 或關掉占用程序

## 2. Agent 容器啟動逾時（120s）
- 缺 base image：先跑 `docker images | grep zeroclaw/agent-base`
- 沒 build：`./scripts/start.sh` 會 build；或單獨 `docker compose --profile build up agent-base-opencode-build`

## 3. Copilot 回 402 (`premium_interactions`)
- 訂閱方案沒額度 → 設 BYOK：
  ```bash
  OPENAI_API_KEY=sk-...
  BYOK_BASE_URL=https://api.openai.com/v1
  ```

## 4. Opencode 容器跑了但對話沒回應
- 看容器 log：`docker logs zeroclaw-{group}-{agent}`
- `boot diagnostics` 看 `config.providers()` 是否含目標 provider
- 若 `model` 解析失敗 → 檢查 `agents/<id>/opencode.json` 的 `model` 欄位

## 5. WebSocket 連不上
- 前端打的 URL 是否含 token：`ws://localhost:3000/ws?token=<jwt>`
- API server CORS：檢查 `WEB_ORIGIN` env

## 6. 對話跨容器後失憶
- 已知限制（History replay 未實作）
- 暫解：在容器存活期間完成單次任務；或調高 `CONTAINER_IDLE_TIMEOUT_SEC`
