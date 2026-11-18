# Spike：用 Durable Object 驱动豆包工作 Agent

验证一件事：豆包工作的 Agent OpenAPI 没有回调，我们能不能靠 DO 的 alarm 轮询（必要时加 SSE）把它当成可靠的远程 worker。

一个单例 DO 保存 OAuth 令牌、任务，以及和豆包之间**每一次 HTTP 往来的记录**。`GET /log` 和 `GET /stats` 就是这个 spike 的产出。

## 准备

1. 在[豆包开放平台](https://open.doubao.com/console/applications)建应用，开通权限：
   `doubao:session:read`、`doubao:session:write`、`doubao:session.event:read`、`doubao:session.event:write`、`doubao:session.message:read`、`offline_access`。
2. 在应用的"安全设置"里登记重定向 URL：本地是 `http://localhost:8799/oauth/callback`，部署后是 `https://<worker 域名>/oauth/callback`。
3. IP 白名单保持关闭（Workers 出口 IP 不固定）。
4. 填凭据：
   - 本地：把 `.dev.vars.example` 复制为 `.dev.vars` 并填写。
   - 线上：`wrangler secret put DOUBAO_APP_ID`、`DOUBAO_APP_SECRET`、`SPIKE_KEY`。

## 运行

```bash
pnpm install
pnpm dev --port 8799      # 本地，出口是你自己的网络
pnpm deploy               # 线上，出口才是 Cloudflare
```

所有接口都要带 `?key=<SPIKE_KEY>`。下面用 `$B` 表示地址，`$K` 表示 key。

```bash
curl "$B/probe?key=$K"                                   # 不需要凭据
open "$B/oauth/start?key=$K"                             # 浏览器里授权
curl -X POST "$B/tasks?key=$K" -d '{"text":"查一下北京明天的天气，整理成一份文档"}'
curl "$B/tasks?key=$K"                                   # 看状态和检测耗时
curl "$B/tasks/<id>/stream?key=$K&max_ms=120000"         # 任务进行中时调用
curl "$B/stats?key=$K"
```

## 要回答的问题

| # | 问题 | 怎么测 | 结论 |
|---|---|---|---|
| 1 | 从 Cloudflare 能否连通，延迟多少 | 部署后 `/probe`、`/stats` | |
| 2 | 该用 `open.doubao.com` 还是 `open.feishu.cn` | 改 `DOUBAO_API_BASE` 各跑一遍 | |
| 3 | 令牌有效期实际是多少，刷新是否正常 | `/token`、`POST /token/refresh` | |
| 4 | 并发刷新会不会把令牌弄丢 | `POST /token/refresh?parallel=5` | |
| 5 | 建会话的响应里有没有回复消息的 ID | `/log?label=session.create` | |
| 6 | 轮询能否可靠发现终态，延迟多少 | `/tasks/:id` 的 `polls` 和 `detect_ms` | |
| 7 | 列会话接口能否代替逐任务轮询 | 任务进行中和结束后各调一次 `/sessions` | |
| 8 | SSE 线上格式是什么，帧间最长静默多久 | `/tasks/:id/stream`，加 `&raw` 看原始字节 | |
| 9 | `Last-Event-ID` 续传是否正确 | 用上一次返回的 `last_event_id` 再调一次 | |
| 10 | 同一 `uuid` 重复建会话返回什么 | `POST /tasks/:id/redispatch` | |
| 11 | 回复进行中再发消息是否 409 | `POST /tasks/:id/message` | |
| 12 | 打断后消息和会话是什么状态 | `POST /tasks/:id/interrupt` 再看 `/tasks/:id` | |
| 13 | `requires_action` 长什么样，接口能否处理 | 派一个需要审批的任务，看 `/tasks/:id` 的 `result` | |
| 14 | 长任务（10 分钟以上）期间有没有异常 | 派一个调研类任务，看 `polls` 时间线 | |
| 15 | 用户收到几条通知，会话列表里长什么样 | 人工看豆包工作客户端和飞书 | |

## 已知结果

本地（非 Cloudflare 出口）跑 `/probe`：`open.doubao.com` 和 `open.feishu.cn` 都能响应 Agent 接口路径，未带令牌时都返回 `99991661`，延迟几十毫秒。这只说明两个域名都通，不代表 Cloudflare 出口的情况。

## 下一轮（不在本次范围）

把我们的服务做成豆包插件的 MCP 工具，让豆包 Agent 干完活主动调用 `report_result`。这是文档里唯一能做到"对方主动通知"的途径，但依赖模型自觉调用，只能当加速手段，轮询仍是兜底。
