# Spike：自建沙箱 worker agent（pi）

验证一件事：一个 Durable Object 带一个沙箱容器，容器里用无界面模式跑 [pi](https://pi.dev) 这个 coding agent，能不能满足 worker agent 的要求——干完主动回报、容器里没有真实凭据、高危操作能停下来等人批准、长任务不被回收。

结构照搬 Cloudflare 官方示例（`sandbox-sdk/examples/coding-agents/pi`），加了三样：

- **回报**：容器内的 `report` 命令经 Worker 拦截的假域名 `brain.internal` 把消息投回任务。进程退出时由包装脚本自动回报，不依赖模型自觉。
- **审批**分两层，答复都存在任务的 DO 里，不在容器的文件系统里：
  - 会出网的动作（目前是 `git push`）在出站代理上拦。代理按请求本身判断，不看命令怎么写，请求被挂起直到有人答复。
  - 不出网的动作（目前是 `rm -r`）由一个 pi 扩展（`gate.ts`）拦，靠匹配命令文本，只能防误操作。
- **检查点**：每次进度回报后和每次 alarm 时，把任务目录打包存到 R2。容器丢失后自动起一个新容器，还原目录，让 pi 接着原会话继续。
- **记录**：冷启动耗时、每次回报、每次 alarm 检查、token 用量和花费都记在任务上。

先后试过三个 agent。Claude Code 版验证到模型调用前，后来没有 Anthropic key 没继续。Codex 版被 OpenAI 拒绝：开了"ChatGPT 订阅附赠每月 API 额度"权益的组织不能用 API key 跑 Codex。pi 用同一个 OpenAI key 可以正常调用。

## 文件

| 文件 | 作用 |
|---|---|
| `src/index.ts` | 路由、`TaskSandbox`（每任务一个 DO）、`Outbound`（容器唯一的出口） |
| `container/report.mjs` | 容器内的回报命令 |
| `container/gate.ts` | pi 扩展：不出网的高危命令的通知、等待、放行或拦截 |
| `Dockerfile` | Node + git + pi（固定版本）+ 沙箱 shim |

## 运行

本地跑容器需要 Docker 兼容的运行时和 buildx 插件。Apple 芯片上要开 Rosetta：

```bash
colima start --cpu 4 --memory 6 --vm-type vz --vz-rosetta
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock

cp .dev.vars.example .dev.vars     # 填 OPENAI_API_KEY 和 SPIKE_KEY
pnpm install
pnpm dev --port 8798               # 首次会构建镜像，要几分钟
```

模型在 `wrangler.jsonc` 的 `MODEL` 里改，要是 pi 的 openai 目录里有、你的 key 也能用的模型。

部署到 Cloudflare 需要 Workers Paid 套餐，同样要本地 Docker 来构建镜像：

```bash
wrangler secret put OPENAI_API_KEY
wrangler secret put SPIKE_KEY
pnpm deploy
```

下面用 `$B` 表示地址，`$K` 表示 `key=<SPIKE_KEY>`。

```bash
# 1. 不调模型的检查
ID=$(curl -s -X POST "$B/tasks?$K" -d '{}' | jq -r .id)
curl -s -X POST "$B/tasks/$ID/probe?$K"

# 2. 普通任务
curl -s -X POST "$B/tasks?$K" -H 'content-type: application/json' \
  -d '{"prompt":"Create hello.txt containing the word hi, then report progress."}'
curl -s "$B/tasks/<id>?$K"          # 看 phase、runs、inbox

# 3. 审批：克隆直接放行，push 在代理处挂起，phase 变成 needs_input
curl -s -X POST "$B/tasks?$K" -H 'content-type: application/json' \
  -d '{"prompt":"Clone https://github.com/octocat/Hello-World.git, commit a file named note.txt in it, then run: git push origin HEAD"}'
curl -s -X POST "$B/tasks/<id>/answer?$K" -H 'content-type: application/json' \
  -d '{"decision":"deny","reason":"not your repository"}'

# 5. 续跑：任务跑到一半时销毁容器，看它能否自己恢复
curl -s -X POST "$B/tasks/<id>/kill-container?$K"

# 4. 长任务：超过 10 分钟，看 checks 是否每分钟一条、容器是否一直在
curl -s -X POST "$B/tasks?$K" -H 'content-type: application/json' \
  -d '{"prompt":"Run the shell command `sleep 100` eight times, strictly one command per tool call. After each one, run report progress with the count so far."}'
```

## 结果

本地实测：Colima + Rosetta，pi 0.87.1，模型 `gpt-6-sol`，真实 OpenAI key，在 `wrangler dev` 下跑。部署后的结果见下一节。

| # | 问题 | 结果 |
|---|---|---|
| 1 | 容器能起来、agent 能跑吗 | 能。容器就绪约 1.3–4.1 秒（镜像已缓存） |
| 2 | 真实任务能完成吗，花多少 | 能。建文件并回报：8.6 秒，3 轮，约 0.004 美元 |
| 3 | 容器里有真实 key 吗 | 没有。只有占位值和本任务的回报凭证 |
| 4 | 没放行的域名访问得了吗 | 访问不了，`example.com` 返回 403 |
| 5 | Worker 能给发往 OpenAI 的请求加上 key 吗 | 能。容器带着占位值请求模型列表，返回 200 |
| 6 | 容器能主动回报吗，凭证不对会被拒吗 | 能回报；凭证不对返回 403 |
| 7 | 模型会按要求调用 `report progress` 吗 | 会。每个任务都调了，长任务 8 次一次不少 |
| 8 | 进程退出后多久被发现，靠什么 | 靠包装脚本的回报，不到 1 秒。所有成功的任务都是回报先于 alarm 发现 |
| 9 | 高危命令会被拦住吗 | 会。`rm -rf` 在执行前被扩展停住；`git push` 在代理处被挂起。任务都变成 `needs_input` |
| 9a | 换个写法能绕过 push 的审批吗 | 不能。用 `G=git; $G pu$(echo sh)` 这种写法，扩展完全没识别出来，代理照样拦下 |
| 9b | 读操作要审批吗 | 不要。`git clone` 直接放行 |
| 9c | github.com 上非 git 的地址能访问吗 | 不能，返回 403 并记到任务上 |
| 10 | 拒绝后 agent 怎么做 | push 收到 403，agent 没有重试，在最终答复里如实说明被拒 |
| 11 | 批准后能继续吗 | 能。`rm -rf build` 批准后执行；push 批准后请求到达 GitHub（没配 token，被 GitHub 拒绝） |
| 12 | 答复错了对象会怎样 | 带着别的调用 ID 的答复被拒绝，原命令继续挂起 |
| 13 | 10 分钟以上的任务会被回收吗 | 不会。13 分 56 秒的任务跑完，41 次 alarm 检查容器都在，约 0.015 美元 |
| 14 | 任务中途部署会怎样 | 加了重连逻辑后能跑完，见下面"踩到的坑" |
| 15 | 容器被销毁后能续跑吗 | 能。五步任务在第 3 步时销毁容器：20 秒内发现，1.2 秒起好新容器并还原，pi 接着原会话把剩下的做完。检查点约 12–25 KB，每次约 90 毫秒 |
| 15a | 续跑会重复做事吗 | 会。已回报完成的第 2 步被重做了一遍，第 1 步没有。检查点之后的工作按"至少一次"对待 |
| 16 | 模型调用失败能判成失败吗 | 用 Claude Code 和 Codex 时验证过；pi 版没有专门测 |
| 17 | 在 Cloudflare 上的冷启动、保活、部署行为 | 已测，见下一节 |

## 部署到 Cloudflare 后的结果

2026-11-19 部署到 Workers（Paid 套餐，R2 已启用），同样的测试重跑了一遍。

| 问题 | 本地 | Cloudflare |
|---|---|---|
| 容器就绪时间 | 1.3–4.1 秒 | 首次 14.3 秒（拉镜像），之后 0.8–1.0 秒 |
| 探针五项（无真实 key、域名拦截、加 key、回报、凭证校验） | 通过 | 通过 |
| 普通任务 | 通过 | 通过，约 0.004 美元 |
| 扩展拦 `rm -rf`，批准后继续 | 通过 | 通过 |
| 代理拦伪装写法的 push，挂起 45 秒后拒绝 | 通过 | 通过 |
| 13 分钟长任务 | 通过 | 通过，41 次 alarm 检查容器都在 |
| 任务运行中重新部署 | 修复后通过 | 通过。部署时有两个任务在跑，都完整跑完 |
| 销毁容器后续跑 | 通过 | 通过。恢复耗时 1.1 秒，已回报的第 3 步被重做一遍 |
| 检查点 | 约 90 毫秒 | 约 0.7–1.2 秒，12–24 KB |

线上没有再出现新的问题。"任务中途部署"在线上是带着重连逻辑测的，没有单独验证去掉重连后线上会不会断。

## 踩到的坑

**1. `exec()` 返回的进程号在本地不是容器内的进程号。**
官方示例把 `exec()` 返回的 `pid` 写进文件，之后用 `kill -0` 判断 agent 是否还活着。本地跑时这个进程号对不上，于是第一次 alarm 就把一个正常运行的任务判成了丢失。任务跑不到一个 alarm 周期时看不出来，所以短任务全部通过，长任务必挂。现在改成由包装脚本自己写 `$$`。部署环境下官方写法是否成立没有验证。

**2. Worker 重新加载后，容器的出站通道会断。**
任务运行中改代码触发重载（相当于一次部署），容器和 agent 进程都还在，但模型调用报 `Connection error`，回报也发不出去。原因是出站拦截挂在旧的 DO 实例上。现在 DO 构造时如果发现容器在运行，就重新注册拦截并重设空闲超时；alarm 间隔从 60 秒缩到 20 秒，让这个重连尽快发生。修复后"三次 `sleep 30`、中途重载"的任务完整跑完。重连之前那段时间里的模型调用仍会失败，靠 pi 自己的重试扛过去，这一点并不稳。

**3. 出站拦截的注册顺序有讲究。**
"全部拦截"会接管在它之后注册的所有域名。备份组件有自己的内部域名，必须在"全部拦截"之前先登记（`DirectoryBackup.intercept()`），否则它的上传会落进我们的代理被拒掉。

**4. 镜像里自带的目录不能整体还原。**
还原检查点是用改名的方式替换目录。对镜像里就有的 `/workspace` 这样做会报跨设备错误（EXDEV）。任务的文件现在都放在运行时创建的 `/workspace/job` 下面。

**5. Codex 不能用这个 OpenAI key。**
见上文。

## 已知限制

- 检查点是在 agent 还在跑的时候拍的，可能拍到写了一半的文件。一个任务最多恢复 2 次。
- push 的批准只精确到仓库，有效 2 分钟，没有看推的是哪个分支。分支信息在请求体里，可以解析出来，还没做。
- 不出网的高危命令仍然只有进程内扩展这一层，靠正则匹配，防不了有意绕过。
- 代理把 push 请求挂起等答复，最长 50 分钟。生产环境能挂多久没有验证。
- 回报内容是容器说了算的。它只应被当作进度信息，不应被当作任务成功的证明。
- 等待答复期间容器一直开着计费，最长 55 分钟。
- 出站代理只放行模型接口的 `POST .../responses` 和 `GET .../models`，但没有限制用哪个模型、花多少钱。
