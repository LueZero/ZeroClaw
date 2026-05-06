# 多使用者並行 Session 測試報告（opencode / faq-bot）

- 採集時間：2026-04-29T00:30:07.221Z
- API：http://localhost:3000
- 使用者數：2
- 牆鐘時間：**19231 ms**
- 各使用者總耗時加總：**38187 ms**
- **重疊比 = sum/wall = 1.99**（>1 代表有並行；理想接近 N=2）
- 第一個事件抵達時間最大差距：**160 ms**

## 各使用者明細

### concurrent-1777422587881-u0
- session：`89f2f213-8782-48c9-991c-48eef4daf5ab`
- container：`null`
- 結束狀態：**done**
- firstEvent 延遲：11878 ms
- 總耗時：19231 ms
- 事件總數：4
- 事件分佈：agent.chunk=3, agent.done=1
- 前 5 事件（相對於 send 的時間）：agent.chunk@+11878ms  |  agent.chunk@+19167ms  |  agent.chunk@+19167ms  |  agent.done@+19231ms

### concurrent-1777422587940-u1
- session：`7b3408d9-889d-425e-bf56-0b834b309458`
- container：`null`
- 結束狀態：**done**
- firstEvent 延遲：11718 ms
- 總耗時：18956 ms
- 事件總數：4
- 事件分佈：agent.chunk=3, agent.done=1
- 前 5 事件（相對於 send 的時間）：agent.chunk@+11718ms  |  agent.chunk@+18637ms  |  agent.chunk@+18932ms  |  agent.done@+18956ms

## 判定
- 是否確實並行（overlapRatio > 1.3）：✅ 是
- 是否未排隊（firstEventStagger < minDur*0.8）：✅ 是