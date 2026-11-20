# always-on-agents

[English](README.md) | **简体中文**

一个跑在 Cloudflare 上的 always-on agent：平时休眠，被事件唤醒，无人值守地行动，并且记得自己做过什么。它支持多租户，能在单聊、群聊和代码仓库里工作，耗时的事交给沙箱里的 coding agent 去做。

设计依据是 Anthropic 的文章 [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents) 和其中的五个原语：事件收件箱、定时器、记忆、权限、发件箱。

```
飞书 / GitHub / 控制台 / 定时器 / worker 回报
        │
   入口 Worker             验证、认出租户、确定作用域，立刻返回
        │ ingest()
┌───────▼────────────────────────────────────────────┐
│ Brain（每个作用域一个 Durable Object）                │
│ SQLite: inbox · sessions · items · memory · timers  │
│         · tasks · outbox · runs · audit             │
│ alarm(): 触发定时器 → 投递发件箱 → 执行 run           │
└───┬────────────────────────────────────┬───────────┘
    │ 派活 / 答复 / 取消                   │ 投递
┌───▼──────────────────────────┐   ┌─────▼──────────────┐
│ TaskSandbox（每个任务一个）    │   │ Connector           │
│ 容器里跑 coding agent，        │   │ 控制台 · GitHub ·   │
│ 只有一个受管控的出口            │   │ 飞书                │
└───────────────────────────────┘   └────────────────────┘
```

## 它能做什么

- **每个作用域一个 Brain。** 一个用户、一个群、一个仓库各有自己的 Durable Object，收件箱、记忆、发件箱都是独立的，作用域之间不共享任何东西。
- **事件进，消息出。** 所有触发都先写进收件箱，再在一次很短的 run 里处理。run 被崩溃或部署打断后，会从停下的地方接着做。
- **定时器和记忆。** agent 可以提醒、跟进，并跨对话保留笔记。
- **沙箱 worker。** 耗时的工作交给容器里的 coding agent。容器里没有任何凭据，只有一个出口：一个只放行模型接口和 git 的代理。
- **审批由代码判定。** 会离开沙箱的动作（`git push`）会被拦下，直到有人批准具体的分支和提交。模型只负责传话，规则在模型之外强制执行。
- **Connector。** 一个纯 HTTP 的控制台、GitHub（webhook 或 GitHub App）、飞书（长连接或 webhook，带审批卡片）。

## 文档

| | |
|---|---|
| [架构](docs/architecture.zh-CN.md) | 各部分如何配合，以及为什么这样设计 |
| [审批](docs/approvals.zh-CN.md) | 谁能批准什么，规则在哪里强制 |
| [Connector](docs/connectors.zh-CN.md) | 控制台、GitHub、飞书的接入方法和行为 |
| [运维](docs/operations.zh-CN.md) | 部署、配置、管理接口、各项上限 |
| [现状](docs/status.zh-CN.md) | 验证过什么，已知的限制 |

## 快速开始

需要 Node 22.12 或更高版本、pnpm，以及一个兼容 Docker 的运行时（沙箱镜像在本地构建）。Apple 芯片上用 Colima 时要开 Rosetta：

```bash
colima start --cpu 4 --memory 6 --vm-type vz --vz-rosetta
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
```

```bash
pnpm install
pnpm test                        # 不需要 Docker，也不需要任何密钥
cp .dev.vars.example .dev.vars   # 填 OPENAI_API_KEY 和 ADMIN_KEY
pnpm dev --port 8797
```

另开一个终端，建一个租户，然后和 agent 说话：

```bash
B=http://localhost:8797
ADMIN_KEY=...     # 你写在 .dev.vars 里的那个值

# 输出里的 "api_key" 就是租户的 API key，只显示这一次。
curl -X POST $B/v1/admin/tenants -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"id":"acme","name":"Acme"}'
TENANT_KEY=...    # 上面返回的 api_key

curl -X POST $B/v1/console/users/alice/messages -H "authorization: Bearer $TENANT_KEY" \
  -H 'content-type: application/json' -d '{"text":"30 秒后提醒我喝水"}'

# 长轮询取回复，包括 agent 主动发来的提醒。
curl "$B/v1/console/users/alice/messages?after=0&wait=25" -H "authorization: Bearer $TENANT_KEY"

# 查看这个作用域的内部状态。
curl $B/v1/admin/scopes/acme:user:alice -H "authorization: Bearer $ADMIN_KEY"
```

部署以及接入 GitHub、飞书，见[运维](docs/operations.zh-CN.md)和 [Connector](docs/connectors.zh-CN.md)。

## 目录结构

```
src/
  index.ts              入口 Worker：鉴权和路由，本身不存状态
  events.ts             作用域、事件、身份的定义
  agent.config.ts       这个部署启用哪些 connector，信任哪些
  registry.ts           租户、密钥、应用登记（一个 Durable Object）
  brain/                Brain：每个作用域一个 Durable Object
    agent.ts              收件箱、定时器、run 循环、任务、发件箱
    schema.ts             表结构和迁移
    tools.ts              模型可以调用的工具
    prompt.ts             系统提示词
  model/openai.ts       模型客户端
  connectors/           每个外部系统一个：验证、识别身份、投递
    types.ts              connector 接口的定义
    console.ts            HTTP 通道，用于开发和验证
    github.ts             GitHub webhook 和评论
    github-app.ts         按安装、按仓库签发令牌
    feishu.ts             飞书的事件、卡片和消息
    feishu-link.ts        飞书长连接（每个应用一个 Durable Object）
    feishu-frame.ts       长连接的帧格式
  workers/sandbox/      沙箱 worker：每个任务一个 Durable Object 加一个容器
    task.ts               容器生命周期、回报、审批、检查点
    outbound.ts           容器唯一的出口
container/              打进沙箱镜像的脚本
test/                   测试，跑在 Workers 运行时里
docs/                   文档
```

## 现状

agent 已经在 Cloudflare 上运行，并对真实的 GitHub 和飞书应用做过端到端验证。它还是很新的软件：在依赖它之前请先读[现状](docs/status.zh-CN.md)，尤其是已知限制那一节。

## 参与贡献

见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。安全问题请按 [SECURITY.md](SECURITY.md) 报告。

## 许可证

[MIT](LICENSE)
