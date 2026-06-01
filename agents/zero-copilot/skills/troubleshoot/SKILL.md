---
name: troubleshoot
description: Zeroclaw 常見錯誤的排查清單（容器、Copilot quota、port 占用、WS）
---

# Zeroclaw Troubleshoot Skill

依序檢查下列項目。

## 1. API server 沒起
```bash
docker logs zeroclaw-api --tail 200
```
- `JWT_SECRET is required` → `.env` 補上
- `EADDRINUSE :3000` → 改 `API_PORT` 或關掉占用程序

## 2. Agent 容器啟動逾時（120s）
- 缺 base image：`docker images | grep zeroclaw/agent-base`
- 沒 build：`./scripts/start.sh` 會 build；或 `docker compose --profile build up agent-base-copilot-build`

## 3. Copilot 回 402（`premium_interactions 0/300`）
訂閱方案沒額度 → 改走 BYOK：
```bash
OPENAI_API_KEY=sk-...
BYOK_BASE_URL=https://api.openai.com/v1
```

## 4. Opencode 容器沒回應
- `docker logs zeroclaw-{group}-{agent}` 看 boot diagnostics
- 確認 `config.providers()` 含目標 provider
- `agents/<id>/opencode.json` 的 `model` 是否正確

## 5. WebSocket 連不上
- URL 須含 token：`ws://localhost:3000/ws?token=<jwt>`
- 檢查 `WEB_ORIGIN` env 對應前端 origin
- WS 斷線後不會中斷 agent 回覆（pub-sub 機制），重連後自動載入歷史

## 6. 跨容器後失憶
- 已知限制：history replay 未實作
- 暫解：調高 `CONTAINER_IDLE_TIMEOUT_SEC`，或在容器存活期間完成單次任務

## 7. 找不到代理人
- 確認資料夾在 `agents/<id>/`
- `groups.yaml` 該 group 的 `agents` 清單有列出 `<id>`
- 重啟 API server（或等 yaml watcher 熱重載）

## 8. 容器隔離
- 每個 agent 容器僅掛載 `/workspace/agent:ro`（唯讀）
- 不能存取其他代理人的檔案
- 若需讓代理人寫入檔案，請使用 `volumes` 配置額外可寫掛載點
