# always-on-agents

一个跑在 Cloudflare 上的 always-on agent：平时休眠，被事件唤醒，无人值守地行动，跨多次运行保持状态。多租户，支持单聊、群聊和代码仓库（CI）三种场景，耗时的工作派给沙箱里的 coding agent。

设计依据是 Anthropic 的文章 [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents)。架构和各项决定的理由见 [docs/architecture.md](docs/architecture.md)。

## 目录

```
src/
  index.ts              入口 Worker：鉴权、路由，本身不存状态
  events.ts             作用域、事件、身份的定义
  registry.ts           租户注册表（一个 Durable Object）
  brain/                Brain：每个作用域一个 Durable Object
    agent.ts              inbox、定时器、run 循环、任务、outbox
    schema.ts             表结构和迁移
    tools.ts              模型可用的工具
    prompt.ts             系统提示词
  model/openai.ts       模型客户端
  connectors/           每个外部系统一个：入站验证、身份、出站投递
    console.ts            HTTP 通道，用于联调和部署验证
    github.ts             GitHub webhook 和评论
    github-app.ts         按安装、按仓库签发 GitHub 令牌
    feishu.ts             飞书机器人
  workers/sandbox/      沙箱 worker：每个任务一个 Durable Object 加一个容器
    task.ts               容器生命周期、回报、审批、检查点
    outbound.ts           容器唯一的出口：放行规则、加凭据、挂起待批准的推送
container/              打进沙箱镜像的脚本
test/                   测试（跑在 Workers 运行时里，模型和沙箱用替身）
docs/                   架构文档
docs/spikes/            早期实验的记录（代码已归档到 git 历史）
```

## 本地运行

需要 Node、pnpm，以及一个 Docker 兼容的运行时（沙箱镜像要构建）。Apple 芯片上用 Colima 时要开 Rosetta：

```bash
colima start --cpu 4 --memory 6 --vm-type vz --vz-rosetta
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock

cp .dev.vars.example .dev.vars   # 填 OPENAI_API_KEY 和 ADMIN_KEY
pnpm install
pnpm test                        # 不需要 Docker 和 key
pnpm dev --port 8797
```

建一个租户，然后和它说话：

```bash
B=http://localhost:8797
curl -X POST $B/v1/admin/tenants -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"id":"acme","name":"Acme"}'      # 返回租户的 API key，只显示一次

curl -X POST $B/v1/console/users/alice/messages -H "authorization: Bearer $TENANT_KEY" \
  -H 'content-type: application/json' -d '{"text":"30 秒后提醒我喝水"}'
curl "$B/v1/console/users/alice/messages?after=0&wait=25" -H "authorization: Bearer $TENANT_KEY"

curl $B/v1/admin/scopes/acme:user:alice -H "authorization: Bearer $ADMIN_KEY"  # 看这个作用域的内部状态
```

群聊用 `/v1/console/chats/<chat>/messages`，请求体里带 `"user"`。

## 部署

需要 Workers Paid 套餐和 R2。

```bash
wrangler r2 bucket create always-on-agent-checkpoints
wrangler secret put OPENAI_API_KEY
wrangler secret put ADMIN_KEY
wrangler secret put GITHUB_APP_ID            # 以下四项：接 GitHub App 时需要
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_BOT_HANDLE        # App 的 slug，人们用 @它 来称呼 agent
wrangler secret put GITHUB_BOT_EMAIL         # 提交用的邮箱：<bot 用户 id>+<slug>[bot]@users.noreply.github.com
wrangler deploy
```

接飞书时，事件订阅的请求地址要用自定义域名（`wrangler.jsonc` 里的 `routes`）：飞书的服务器访问不到 `*.workers.dev`。

接 GitHub App 时，装好 App 后要把安装登记到租户，之后这个安装发来的 webhook 才会被接受（之前的一律 401，可以在 App 的 Advanced 页重新投递）：

```bash
curl -X POST $B/v1/admin/tenants/acme/github-installations -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"installation_id":"<id>"}'
```

## 现状

已在 Cloudflare 上端到端验证：对话、记忆、定时器主动提醒、租户隔离、群聊隔离、派活给沙箱、带确认码的审批、长任务、运行中部署、容器丢失后续跑；GitHub 用一个私有测试仓库和一个真实的 GitHub App 跑通了从 PR 评论派活到批准后 push 的整条链路；飞书用一个真实应用跑通了单聊收发。

还没有和真实系统联调的部分：飞书的群聊和审批，以及豆包（未实现）。详见架构文档的"尚未完成"和"验证过什么"。
