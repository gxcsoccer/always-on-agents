# 设计：基于工作区快照的任务续接与结果沉淀

状态：草案（v1），2026-11-23。

这份文档回答一个问题：在保持现有 **“持久 Brain + 一次性沙箱 Worker”** 核心架构（不长期保活容器、不破坏并发与隔离）的前提下，如何解决单聊或群聊中**多任务交错、结果追问、原地续改代码**时的上下文割裂与重复劳动问题。

---

## 1. 起因与典型场景

当前系统中，Brain 持有长期状态（对话记录、记忆、任务元信息），而每次 `dispatch_task` 都会生成一个全新 `task_id`、拉起独立的 `TaskSandbox` Durable Object 与沙箱容器；任务结束后汇报一段截断在 8,000 字符以内的总结，随后容器销毁。

在“一次性派活”场景下这套设计非常稳健，但在下面两类高频交互里会暴露明显摩擦：

### 场景 A：单聊并行调研后的细节追问
1. 用户发：“帮我调研 xxx” → 启动 Worker 1。
2. 用户紧接着发：“顺便帮我调研 yyy” → 启动 Worker 2。
3. Worker 1 回来汇报了 `xxx` 的结论，用户追问：“刚才你提到的第三点里，那个边界条件在代码里具体是怎么处理的？”

现状下：
- **传话筒损失**：Worker 1 在沙箱里读了 20 个文件、跑了多条命令，但回传给 Brain 的只是压缩总结；一旦追问超出总结范围，Brain 只能起一个全新的 Worker 3，从零重新 `git clone`、重新摸索代码结构，既慢又浪费 token。
- **窗口滑出**：单聊共用一条 `private:feishu:...` 对话流（`MAX_TRANSCRIPT_ITEMS = 80`）。如果 `yyy` 讨论得很长，`xxx` 的汇报和 `task_id` 很快滑出上下文窗口；而 `buildInstructions()` 目前只向模型展示 `Tasks you have running`，已完成任务一旦结束就从系统提示词里消失了。

### 场景 B：代码修改后的连续迭代
1. 用户让 Agent 调研并在沙箱里试改一个方案（尚未 push）。
2. 看完汇报后用户说：“思路对的，把刚才的改动补上单测然后提一个分支。”

现状下，Worker 1 的本地未提交改动随着任务结束无法被后续任务接手，Worker 3 只能一切重来。

---

## 2. 设计原则

延续 [agent-core.zh-CN.md](agent-core.zh-CN.md) 的架构哲学：

1. **只持久化快照，不保活容器**：依然坚持容器用完即毁，绝不为“万一用户待会儿追问”而保留运行中的热容器。
2. **不可变快照 Fork，而非原地复用旧任务**：续接永远创建一个**新的 `task_id` 和新的 `TaskSandbox` DO**，只是以父任务的只读快照作为初始工作区。每个任务仍然拥有独立的审计、配额、审批边界与生命周期。
3. **安全与权限边界由代码强制，不靠提示词**：不能跨 `scope`、不能跨 `session_key`（尤其是不能穿透 `private:` 私聊边界）、不能换仓库、绝不继承父任务的任何审批授权（`grants` / `decisions` / `standing`）。
4. **复用现有基础设施**：`TaskSandbox` 已经内置了基于 R2（`CHECKPOINTS` 桶）的 `DirectoryBackup` 和 `pi --session-dir ... --continue` 崩溃恢复机制，本次改造直接建立在这套能力之上，不引入新组件。

---

## 3. 方案对比：为什么选“快照 Fork”而不是“原地复用旧 Task DO”？

| 维度 | 方案 A：原地唤醒旧 `TaskSandbox` DO 继续跑 | 方案 B：新建 `TaskSandbox` DO + 从父快照 Fork（**推荐**） |
|---|---|---|
| **审计与状态机** | 需要把终态（`succeeded`）重新变回 `running`，破坏 `TERMINAL_TASK` 单向状态机假设 | 每个任务状态机依然严格单向终结，完整保留 `parent_task_id` 血缘链 |
| **审批与权限隔离** | 容易残留上一轮的 `grants`、`decisions`、`standing` 授权或 `requested_by` | 子任务从零初始化，权限、请求人、模型调用次数、看门狗全部重新独立计算 |
| **分支探索能力** | 同一份任务只能线性追加，且会覆写父任务现场 | 可以从同一个调研快照 Fork 出多个并行方向（例如“按方案 A 改”和“按方案 B 改”），互不污染 |
| **失败影响范围** | 第二轮改坏会把第一轮完好的状态冲掉 | 父任务快照只读不可变，子任务失败不影响父任务记录 |
| **并发控制** | 需额外处理“同一 task 正在续跑又被操作”的锁竞争 | 天然复用现有 `MAX_ACTIVE_TASKS` 与租户 task slot 配额体系 |

---

## 4. 机制一：基于工作区快照的任务续接（`from_task_id`）

**一句话**：任务完成时落一份最终快照到 R2（包含代码目录与 `pi` 会话日志）；后续 `dispatch_task` 可传 `from_task_id`，让新容器直接从这份快照恢复并带着新问题继续对话。

### 4.1 Worker 侧：任务终结时的 Final Checkpoint

现状分析（`src/workers/sandbox/task.ts`）：
- 目前 `#checkpoint()` 只在运行中（`progress` 回调或每 20 秒的 `alarm`）触发，且受 `CHECKPOINT_MIN_INTERVAL_MS = 30s` 节流。
- 当 `pi` 正常退出进入 `#settle()` 时，**没有强制打最后一次快照**——因此最后 30 秒内的文件改动、以及 `pi` 最终回答那一轮的 session transcript，往往不在 R2 的最新 checkpoint 里。
- 目前任务完成后会保留 R2 checkpoint `PURGE_AFTER_MS`（24 小时），之后由 `#purge()` 清理。

改动设计：
1. **在 `#settle()` 确认任务结束（`succeeded`，以及可选的 `failed` 且容器仍在运行）后、发最终 `result` 回报之前**，执行一次不受 30 秒节流限制的 `#finalCheckpoint()`：
   - 备份整个 `WORKSPACE_DIRECTORY`（`/workspace/job`，涵盖 `repo/` 或 `scratch/` 以及 `task/sessions/` 下完整的 `pi` JSONL 会话文件）。
   - 如果快照成功，在 `TaskState` 上记录 `final_checkpoint: { record, at, expires_at }`（`expires_at = finished_at + PURGE_AFTER_MS`，默认 24 小时），并在发给 Brain 的 `worker.result` 事件 `body` 中附带：
     ```ts
     {
       snapshot_until: state.final_checkpoint?.expires_at,
       repository: state.repository,
       // ...现有字段
     }
     ```
   - 如果 `#finalCheckpoint()` 失败（例如 R2 短暂抖动），**绝不阻塞任务结果汇报**：记一条日志，省略 `snapshot_until` 即可，该任务退化为不可续接，用户依然能正常收到结果。
2. **容器更快释放**：一旦 `#settle()` 拿完输出并打完 final checkpoint，容器不再需要干等 30 分钟的 `INACTIVITY_TIMEOUT_MS`，可按策略缩短空闲超时或直接销毁（按需权衡调试便利性，例如生产环境直接回收、保留 24 小时 R2 快照即可）。

### 4.2 跨 Task 的只读快照恢复

现状限制：
- `TaskSandbox` 构造时把 `DirectoryBackup` 绑定在 `prefix: tasks/${ctx.id.name}/`（`src/workers/sandbox/task.ts:239-241`）。子任务拥有新的 `task_id`，无法直接用自己的 `#backups` 实例去读父任务 `tasks/${parentTaskId}/` 下的对象。

改动设计：
1. **父任务暴露受控查询方法 `snapshot()`**：
   ```ts
   // TaskSandbox
   async snapshot(): Promise<{
     record: DirectoryBackupRecord;
     repository?: string;
     cwd: string;
     expires_at: number;
   } | null>
   ```
   - 仅当 `state.phase === "succeeded"`（终态）、`state.final_checkpoint` 存在且 `Date.now() < expires_at` 时返回；否则返回 `null`。
2. **子任务 `StartInput` 扩展**：
   ```ts
   interface StartInput {
     id: string;
     prompt?: string;
     repository?: string;
     ref?: string;
     brain: string;
     /** 若为续接任务，传入父任务的只读快照来源（由 Brain 校验后解析传入）。 */
     seed?: {
       from_task_id: string;
       record: DirectoryBackupRecord;
       cwd: string;
     };
   }
   ```
3. **子任务 `#start()` 恢复流程**：
   - 当 `input.seed` 存在时：
     - **跳过 `git clone` 和 `mkdir scratch`**；
     - 使用指向父前缀 `tasks/${seed.from_task_id}/` 的临时只读 `DirectoryBackup`（仅用于 `restore`，恢复后不保留写句柄）将 `seed.record` 还原到新容器的 `WORKSPACE_DIRECTORY`（`/workspace/job`）；
     - **清理父任务的运行控制文件**，避免污染子任务的退出检测与日志解析：
       - 删除 `EXIT_CODE_PATH`、`PID_PATH`、`EVENTS_PATH`、`STDERR_PATH`、`HOOK_LOG_PATH`、`REPORT_LOG_PATH`；
       - **保留** `REPOSITORY_DIRECTORY`（或 `SCRATCH_DIRECTORY`）以及 `SESSIONS_DIRECTORY`（`pi` 的完整对话历史）。
     - 子任务之后运行期间产生的所有新 checkpoint，依然通过子任务自己的 `this.#backups` 写往 `tasks/${childTaskId}/`。恢复完成那一刻起，**父子任务彻底解耦**，父任务到期 `#purge()` 不会影响子任务。
   - **并发过期/丢失处理**：如果在 Brain 检查通过到子任务真正执行 `restore` 的极短窗口内，父快照刚好过期被 `#purge()` 删掉，子任务 `start()` 应返回明确的错误码（如 `snapshot_unavailable`），由 Brain 决定告知模型改为不带 `from_task_id` 重新派发，避免神秘报错。

### 4.3 `pi` 的 `"follow_up"` 启动模式

目前 `#launch(state, kind)` 支持 `"first"` 和 `"resume"`（容器崩溃恢复），见 `src/workers/sandbox/task.ts:1015-1037`。新增第三种模式 **`"follow_up"`**：

- 命令行参数与 `"resume"` 同样带上 `--session-dir ${SESSIONS_DIRECTORY} --continue`，让 `pi` 无缝加载父任务留下的完整工具调用历史与结论；
- 喂给 `pi` 的 prompt **不是**崩溃恢复用的 `RESUME_PROMPT`，而是：
  ```ts
  const FOLLOW_UP_PREFIX = `You are continuing from a completed task's workspace and conversation history in a fresh sandbox. Your files and prior discussion are already here; check the current workspace state if needed, then handle the follow-up request below. Earlier approvals do not carry over.`;
  // 最终输入：`${FOLLOW_UP_PREFIX}\n\n${state.prompt}`
  ```
- **防膨胀上限**：在 `TaskSandbox` 侧检查恢复后的 `SESSIONS_DIRECTORY` 总大小（或续接深度 `depth <= MAX_CONTINUATION_DEPTH`，例如 5 层）。如果父 session 过大，可选择降级为“保留工作区文件，但不传 `--continue`，改把父任务最终摘要附在 prompt 前”，防止 `pi` 上下文溢出。

### 4.4 Brain 侧：Schema、工具与强制安全不变量

#### 1. Schema 迁移（`src/brain/schema.ts` 新增 Migration #22）
在 `tasks` 表补充 4 个字段：
```sql
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
ALTER TABLE tasks ADD COLUMN repository TEXT;
ALTER TABLE tasks ADD COLUMN snapshot_until INTEGER;
ALTER TABLE tasks ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
```
- `repository`：记录任务绑定过的仓库（原来只记在 audit 和传给 worker，表里没有持久化，续接校验需要读它）。
- `snapshot_until`：收到 `worker.result` 时写入；一旦过期，Brain 无需 RPC 即可在本地 SQL 判断是否还能续接。
- `parent_task_id` / `depth`：用于血缘追踪、防无限套娃、以及调试面板展示。

#### 2. 工具定义扩展（`src/brain/tools.ts`）
`dispatch_task` 增加一个可选字段 `from_task_id`：
```ts
tool(
  "dispatch_task",
  "Hand a piece of work to a coding agent that runs in its own sandbox...",
  {
    title: { type: "string", description: "A few words, shown to people." },
    brief: { type: "string", description: "Everything the worker needs..." },
    repository: { ...nullable("string"), description: "An https://github.com/... URL to clone first, or null. Omit or match the parent when continuing from from_task_id." },
    from_task_id: { ...nullable("string"), description: "Optional id of a recently finished task in this same conversation whose workspace and prior exploration should be carried over for a follow-up. Null for a fresh sandbox." },
  },
)
```

#### 3. Brain 强制执行的 6 条安全与一致性校验（`src/brain/agent.ts` `dispatchTask`）
当 `from_task_id` 非空时，**全部由代码强制执行**：

1. **同 Scope 校验**：在当前 Brain 的 `tasks` 表按 `id = from_task_id` 查询，查不到直接拒绝。
2. **同 Session 严格隔离**：强制要求 `parent.session_key === sessionKey`。
   - 杜绝把私聊（`private:...`）里读过私人资料或代码的工作区带入群聊；
   - 杜绝群里不同话题（`thread:A` 与 `thread:B`）或不同 PR（`pr:12` 与 `pr:13`）互相串用工作区。
3. **仅允许从已终结任务 Fork**：要求 `parent.status === "succeeded"`（后续若需要可放开到明确有 final checkpoint 的 `failed`），**严禁对 `running / needs_input / dispatching` 中的任务 Fork**，避免读到半写状态或引发状态语义混乱。
4. **快照有效期与深度限制**：
   - 要求 `parent.snapshot_until != null && parent.snapshot_until > Date.now()`；
   - 要求 `(parent.depth ?? 0) < MAX_CONTINUATION_DEPTH`（如 5）；
   - 调 `TASKS.getByName(from_task_id).snapshot()` 取回实际 `record`，若返回 `null` 则报错提示模型“快照已过期，请不带 `from_task_id` 发起新任务并把必要背景写入 `brief`”。
5. **仓库一致性校验**：
   - 若父任务有 `repository`：子任务不传 `repository` 时自动继承父任务的 `repository`；若子任务传了**不同的** `repository`，直接报错拒绝（因为快照里的 `/workspace/job/repo` 已经绑定了原仓库）。
   - 若父任务无 `repository`（纯 `scratch` 目录）而子任务传了 `repository`，同样拒绝，要求开新任务。
   - 原有 `scope.kind === "repo"` 的单仓库强制校验继续生效。
6. **权限与审批彻底清零**：
   - `requested_by` 严格按当前 run 的发言人重新计算（`this.#deciders(run.id)`）；
   - 审批 `grants`、`standing`、`decisions`、`model_calls`、看门狗定时器全部从零开始；
   - 原有的 `#sawOutside(runId)` 限制（读过外部不可信文本的 run 禁止调 `dispatch_task`）保持不变。

---

## 5. 机制二：Brain 侧的近期任务索引与调研结果沉淀

只靠快照续接还不够——**如果每次追问都重起一个容器，延迟和成本依然偏高**；而且如果老任务滑出了 80 条消息窗口，模型甚至不知道有一个 `from_task_id` 可以续接。

因此配合两项极轻量的 Brain 侧改进：

### 5.1 系统提示词注入 `Recent tasks you can continue`

参考 `src/brain/prompt.ts` 中已有的 `Answers you can reopen`（第 103 行）模式，在 `PromptParts` 中新增：

```ts
/** Recently finished tasks in this conversation whose workspace snapshot is still available. */
recentTasks?: { id: string; title: string; finishedAt: number; repository?: string | null; summary?: string }[];
```

在 `buildInstructions()` 中注入一段紧凑列表（仅限当前 `session_key`、状态 `succeeded`、且 `snapshot_until > now`、按完成时间倒序最多 5 条）：

```text
Recent tasks in this conversation you can continue
These tasks finished recently and still have a workspace snapshot available. If the person follows up on one of them and you need the worker to inspect the same files or continue from its work, pass its id as from_task_id to dispatch_task.
- 8f2a... "调研 xxx 鉴权逻辑" (finished 2026-11-23T02:10:00Z, repo: owner/app)
- 3c91... "调研 yyy 缓存实现" (finished 2026-11-23T02:14:00Z, repo: owner/app)
```

这样即使单聊里穿插了几十条其他话题，Brain 依然一眼就能看见“刚刚做完的 `xxx` 和 `yyy` 分别对应哪个 `task_id`”。

> 安全注意：`title` 是 Brain 自己写下的短标题，且与 `index.md` 一样被明确标注为上下文事实而非指令，绝不注入 worker 的原始长输出到系统提示词里，以免放大间接提示词注入风险。

### 5.2 分层响应与记忆沉淀指引（`src/brain/prompt.ts`）

在 `BASE` 的 `Work that takes time` 与 `Memory` 中补充清晰的三档决策原则，让模型把算力花在刀刃上：

1. **第一档（直接答复，0 容器开销）**：追问的答案已经在刚才的 `worker.result` 或 `memory` 文件里 → 直接 `send_message` 回答，不派新任务。
2. **第二档（快照续接，`dispatch_task` + `from_task_id`）**：追问需要翻看原工作区文件、查代码细节、跑额外验证、或在未提交改动上继续迭代 → 传 `from_task_id`，省去重新 clone 和重复探索。
3. **第三档（全新任务，`dispatch_task` 且 `from_task_id: null`）**：完全独立的新主题、换了仓库、或原快照已超过 24 小时过期 → 启动干净沙箱。
4. **长调研主动沉淀**：对于耗时长、结论丰富、未来可能反复提及的调研结果，引导 Brain 把精炼结论写入 `memory/notes/<topic>.md` 并在 `index.md` 留一行索引（严格沿用现有规则：永远只记录事实结论，绝不把 worker 报告里的内容写入 `instructions.md`）。

---

## 6. 现有代码改动清单

| 文件 | 改动内容 |
|---|---|
| `src/workers/sandbox/task.ts` | 1. `#settle()` 结束前新增 `#finalCheckpoint()`（绕过 30s 节流），在 `worker.result` 中上报 `snapshot_until` 与 `repository`；<br>2. 新增 `snapshot()` 只读 RPC；<br>3. `StartInput` 新增 `seed`，`#start()` 支持从父快照还原并清理运行控制文件；<br>4. `#launch()` 新增 `"follow_up"` 模式（`--continue` + `FOLLOW_UP_PREFIX` + 新 `brief`）。 |
| `src/brain/schema.ts` | 新增 Migration #22：为 `tasks` 表添加 `parent_task_id`、`repository`、`snapshot_until`、`depth`。 |
| `src/brain/tools.ts` | `ToolHost.dispatchTask` 与 `TOOLS` 中 `dispatch_task` 新增可选参数 `from_task_id: string | null`。 |
| `src/brain/agent.ts` | 1. `dispatchTask()` 实现 6 条安全/一致性校验并拉取父任务 `snapshot()` 传给子任务 `start()`；<br>2. `workerEvent()` 收到 `result` 时持久化 `snapshot_until`；<br>3. 组装 `PromptParts` 时查询当前 `session_key` 下最近 5 条可续接的 `recentTasks`；<br>4. `inspect()` 展示 `parent_task_id` 与 `snapshot_until` 便于排查。 |
| `src/brain/prompt.ts` | 1. `PromptParts` 新增 `recentTasks` 并在 `buildInstructions()` 渲染；<br>2. 更新 `Work that takes time` 指引三档响应策略（直答 / `from_task_id` 续接 / 新起任务）。 |

---

## 7. 分阶段实施与验收计划

### Step 1：Worker 侧快照与 `follow_up` 能力
- 实现 `#finalCheckpoint()`、`snapshot()`、`seed` 恢复、清理父运行控制文件、`"follow_up"` 模式。
- **验收**：
  - 任务 1 在 `scratch/` 写下文件并结束 → `snapshot()` 返回有效 record；
  - 任务 2 携带 `seed` 启动 → 能直接看到任务 1 写的文件，且 `pi` 记着任务 1 的探索过程，无需重新探索；
  - 任务 1 执行 `#purge()` 删掉自己的 R2 对象后，任务 2 自己运行和 checkpoint 完全不受影响；
  - 任务 1 的 `grants` / `decisions` / `model_calls` 未泄露到任务 2。

### Step 2：Brain 侧协议、安全校验与提示词
- 完成 Schema Migration #22、`dispatch_task(from_task_id)` 校验、`recentTasks` 注入。
- **验收（单元测试）**：
  - 同 session 内 `succeeded` 且未过期任务 → 允许续接，`depth = parent.depth + 1`；
  - 跨 `session_key`（如 `thread:A` → `thread:B`，或 `private:feishu:...` → `chat`）→ 明确拒绝；
  - 父任务仍在 `running` / `needs_input` → 拒绝；
  - 父任务快照已过期（`snapshot_until <= now`）或 `snapshot()` 返回 `null` → 拒绝并给出清晰降级提示；
  - 试图在续接时更换 `repository` → 拒绝；
  - 达到 `MAX_CONTINUATION_DEPTH` → 拒绝。

### Step 3：真实单聊端到端验收
- 在飞书单聊中复现完整故事：
  1. 连发“调研 xxx”和“调研 yyy”（两个 Worker 并行）；
  2. `xxx` 返回后，分别测试：
     - **浅追问**（结果里已有答案）→ Brain 直接回复，不启新沙箱；
     - **深追问**（需要看代码细节或接着改）→ Brain 自动传 `from_task_id` 续接 `xxx`，新沙箱跳过 `git clone` 直接在原工作区继续。

---

## 8. 有意不做的事情

为了控制复杂度与成本，当前设计明确**不做**以下内容：

1. **不做热容器保活池**：快照存 R2 成本极低，按需冷启容器恢复工作区即可，避免内存账单和僵尸容器问题。
2. **不做运行中实时插话（mid-run steering）**：正在执行的 Worker 不接收中途追问（仍只通过 `answer_task` 处理审批或 `cancel_task` 取消），避免把审批状态机与并发消息搅在一起。
3. **不做跨会话 / 跨仓库续接**：`from_task_id` 严格限定在同一个 `scope` + 同一个 `session_key` + 同一个 `repository` 内，守住隐私与数据流向底线。
4. **不做自动无限延长快照保留期**：统一沿用 `PURGE_AFTER_MS`（24 小时）；超过 24 小时默认视作新任务，依靠 `memory/` 文件沉淀长期知识。
