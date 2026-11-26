# 设计：工作还在进行时，新来的话怎么办

状态：草案（v1），2026-11-26。待评审，尚未实现。

这份文档回答一个问题：一件交给 worker 的工作还没做完，同一个人又说了一句话，系统应该怎么处理。

---

## 1. 现状

Brain 这一层已经有答案：对话走"推到下一轮"，连发的几条合成一轮（见 `src/brain/runner.ts` 的 `#batch`）。Brain 自己不会被 worker 堵住，新消息来了立刻起一轮。

worker 这一层缺两种处理。一件沙箱任务在跑的时候，模型能做的只有：

| 能做的 | 工具 |
|---|---|
| 直接回答（问进度、问别的） | `work_status`、`send_message` |
| 并行另起一件，互不相干 | `hand_over(continue_from: null)` |
| 停掉 | `cancel_work` |

想"接着正在跑的那件做"会被拒绝（`Tasks.dispatch`：`has not ended yet`）；想往正在跑的任务里加一句话，没有任何通道。

后果是真实使用里会见到的：对同一件事的补充，要么让人等，要么另起一件从头克隆的任务，两件各改各的，互相看不到。

## 2. 用词

行业里这几个动作的叫法基本一致，本文沿用，不另造词：

| 叫法 | 含义 | 出处 |
|---|---|---|
| **steer** | 把话送进正在跑的那一轮；agent 在下一个安全点读到；不中止正在执行的动作，不另起一轮 | pi 的 `steer` 命令、OpenClaw 的 `steer` 模式、Kiro、Copilot SDK |
| **follow-up**（queue） | 等当前这件做完，再作为下一件处理 | pi 的 `follow_up`、OpenClaw 的 `followup` |
| **collect** | 等当前这轮做完，把攒下的几条合成一轮 | OpenClaw 的 `collect`；Anthropic 文章里的 "merge them into a single run" |
| **interrupt** | 中止当前这件，改做最新的这句 | OpenClaw 的 `interrupt` |

Anthropic《Building always-on agents》对运行中来的事件只说了一句："push it to the next run, fold it into the current run, or interrupt and restart"，没有给选择建议，也没有讲后台任务。本文把这三种落到 worker 这一层。

"merge" 一词在业内指 collect（连发合一轮），不指 steer。本文不用它称呼 steer。

## 3. 设计原则

1. **由模型选，代码只保下限。** 新来的话属于哪一种，是判断题，不是规则题。代码保证的是：谁能这么做、做了之后状态是准的、做不成时说清楚为什么。
2. **写在 worker 契约上，不写在沙箱上。** 能不能 steer、能不能排在后面，是 worker 自己声明的能力；Brain 的校验对所有 worker 一样。
3. **复用已有的东西。** follow-up 复用任务接续（`continue_from`、`task_follows`、快照）；steer 复用沙箱里已有的扩展和它回调任务的通道。不引入新的进程模型。
4. **做不成不静默降级。** steer 送不到（任务已结束）就告诉模型，由它改走接续；不在代码里偷偷换一种处理。

## 4. 五种处理

| 意图 | 处理 | 工具 | 结果怎么回来 | 状态 |
|---|---|---|---|---|
| 无关的新事 | **new**：并行另起一件 | `hand_over(continue_from: null)` | 各回各的 | 已有 |
| 不要了 | **cancel** | `cancel_work` | 回一句已停 | 已有 |
| 现在就告诉它 | **steer**：送进正在跑的那件 | `tell_work(work_id, message)`（新） | 只回一次结果，含补充的内容 | 本文 |
| 做完再接着做 | **follow-up**：排在后面，前一件成功后从它留下的工作区启动 | `hand_over(continue_from: <在跑的那件>)` | 两件各回一次 | 本文 |
| 方向错了，停下改做这个 | **interrupt** | 见 §7 | — | 本文不做，留接口 |

collect 属于 Brain 这层，已经有，不在本文范围。

模型怎么选，写进部署的指引（`src/workers.md`），由评测盯住（§8）：

- 补充细节、纠正还没做到的部分 → steer。
- "做完之后再……"、明显是下一步 → follow-up。
- 和那件事无关 → new。
- 分不清指的是哪一件 → 问。

## 5. follow-up：排在一件没做完的工作后面

### 5.1 行为

`hand_over` 的 `continue_from` 指向一件**还没结束**的工作时，不再拒绝，而是写下一件新的任务，状态为 `queued`：

- 不占租户的沙箱名额，不启动 worker。
- 记入 `task_follows`（已有的表），与任务同一处写入。
- 算进本会话的并发上限（`scope_active_tasks`），可以被 `cancel_work` 取消，在工作列表里显示为"排在 <前一件> 之后"。
- 工具当场回给模型 `status: "queued"`，模型据此告诉对方"等那件做完后接着做"。

前一件结束时（`Tasks.event` 收到它的终态汇报）：

| 前一件怎么结束 | 排队的那件 |
|---|---|
| succeeded | 转为 `dispatching` 并启动，走现有的接续路径（worker 向前一件要快照） |
| failed / lost / cancelled | 不启动；记为 failed，原因写明"它要接着做的那件没有做成"，并叫醒一轮，由模型告诉对方、由对方决定 |

排队的那件启动失败（比如前一件没能留下快照）同样记 failed 并叫醒一轮。

### 5.2 校验

与现有接续完全相同，在写入之前做：worker 声明了 `goes_on`；前一件在本会话、是同一个 worker 的、由同一个唯一明确的交办人交办；本轮是那个人自己的一轮。

区别只有一条：前一件的状态允许是进行中（`dispatching | unconfirmed | running | needs_input | queued`），不再要求 succeeded。因此可以排成一串。

### 5.3 时限与名额

任务的寿命、`accept_by`、看门狗都从"它被写下"算起。排队的那件在排队期间不该消耗这些，所以转为 `dispatching` 时把 `created_at` 重置为当时。它的 bounds 仍是写下时固定的那一份（`task_bounds`）。

租户名额在启动时才申请；申请不到（名额满）按现有规则处理。

排队本身要有上限，否则前一件永远不结束时它永远挂着：排队超过前一件的寿命上限加一个余量，由 `settle` 记为 failed 并叫醒一轮。

### 5.4 需要存的

- `tasks.status` 多一个值 `queued`。
- 启动时要用的 options 在写下时存起来（一张自己的小表 `task_queued(task_id, options)`，启动后删除；用独立的表是为了迁移可以重放）。

### 5.5 取舍：另起一件，还是让同一件接着干

pi 自带 `follow_up`：同一个进程做完当前的再处理下一句，不用恢复工作区。没有选它，理由：

- 第一件的结果应当先回给人。同一个进程接着干，结果只在最后回一次。
- 寿命、模型调用次数、审批各算各的，不串。
- 对不是 pi 的 worker 也成立：契约上只要求"能从前一件留下的东西接着做"。

代价是多一次恢复工作区（实测几秒）。

## 6. steer：把话送进正在跑的工作

### 6.1 契约

`Worker` 增加一项可选能力：

```ts
/**
 * 把一句话交给一件正在进行的工作。worker 说清楚结果：
 * taken 表示它收下了、会在下一个安全点读到；ended 表示那件已经结束，没有东西可告诉。
 * 抛错表示不知道有没有收下。
 */
tell?(env, id, message): Promise<{ state: "taken" } | { state: "ended" }>;
```

没有这一项的 worker 不能被 steer，工具说明里告诉模型哪些可以。

### 6.2 Brain

新工具 `tell_work(work_id, message)`。校验在调用 worker 之前：

- 那件工作在本会话、由同一个唯一明确的交办人交办、本轮是那个人自己的一轮（与接续同一条规则）。
- 状态是 `running` 或 `needs_input`。`queued` 的还没开始，不 steer：改它的 brief 不在本文范围，模型应取消后重新交办。`dispatching` / `unconfirmed` 的回"还没确认开始，稍后再试"。
- worker 有 `tell`。

结果：

- `taken` → 记一条审计（`task.told`，只记任务编号和长度，不记内容），回给模型"已收下，它会在下一步之前读到"。
- `ended` → 回给模型"它已经结束了；如果还要做，接着它做"，不自动转成接续。

`tell_work` 的调用按 `call_id` 幂等：同一次调用重放不会送两遍（见 6.3 的编号）。

### 6.3 沙箱

**任务侧**（`TaskSandbox`）：

- 新 RPC `tell(id, text)`：任务处于活动状态时把 `{ id, text, at }` 追加到 `state.notes`（上限若干条、每条限长；超出则拒绝并说明），返回 `taken`；否则返回 `ended`。`id` 是 Brain 给的调用编号，重复的 `id` 不再追加。
- `callback("notes")`：扩展来取时，返回还没取走的 notes，并记下"已交到扩展手里"。

**容器侧**（`container/gate.ts`，已有的扩展，它已经在用 `http://brain.internal/callback/<kind>` 回调任务）：

- 在 `turn_end`（一步的工具调用都执行完之后）取一次 notes；有就用 `pi.sendUserMessage(text, { deliverAs: "steer" })` 投递。
- 在 `agent_before_settle`（agent 准备结束前）再取一次；有就投递并让它继续一步。这样最后一刻到的话不会丢。
- 投递的文字带固定的前言，说明这是交办人在工作进行中补充的话。

选扩展而不是把 pi 改成 RPC 模式（`--mode rpc` 的 `steer` 命令），因为现在是一次性进程加文件收尾的模型，检查点、恢复、看门狗都建在上面；换成长驻的 RPC 进程是另一件大事，本文不碰。

### 6.4 "收下"不等于"读到"

`taken` 只表示任务存下了这句话。它被 agent 读到，要等下一个 `turn_end`。两者之间可能发生：

| 情况 | 处理 |
|---|---|
| agent 正卡在一个长命令或等审批上 | 命令结束或审批答复后的那一步读到。对人说的是"已告诉它，它做完手上这一步会看到" |
| 任务在读到之前结束了（已过最后一次取的时机） | 任务收尾时发现还有没被取走的 notes：在结果里附一句"有一句补充没来得及处理"，Brain 据此叫模型告诉对方，由对方决定是否接着做 |
| 容器丢了，从检查点恢复 | notes 存在任务状态里，不在容器里；没被取走的照常在下一步投递。已取走但那一步没进检查点的，恢复后重投（记"已投递"要等那一步之后的检查点） |

### 6.5 取舍：审批

steer 进去的话沿用那件任务已有的批准（比如已经批准过推送）。接受它，理由：只有当初交办的那个人能 steer，批准也是他给的；一句补充就把批准清零，会让人被反复问。

需要评审确认的是这条下限够不够：长期批准（standing）是按"这件任务、这类动作"给的，steer 改变的是任务在做什么，不改变它能碰什么仓库、能做哪类动作。

## 7. interrupt：本文不做

"停下，改做这个"现在要两步：`cancel_work` 再 `hand_over`，而且被取消的任务不留快照，已做的部分丢掉。

要做成一步，需要取消时也拍一份快照（现在只有成功结束才拍），再允许接着一件被取消的任务。这改的是"什么样的结束可以被接着做"，影响比前两项大，单独立项。本文只保证不堵路：`task_follows` 和 `tell` 都不假设前一件一定成功。

在那之前，纠正方向用 steer（"别做 A 了，改做 B"）。agent 在下一步之前读到，已经做的不会回滚。

## 8. 评测

`eval/cases.ts` 增加一组，工作列表里有一件在跑的沙箱任务：

| 场景 | 期望 |
|---|---|
| "顺便把 xx 也改了" | `tell_work` 那件 |
| "等它做完再帮我提个 PR" | `hand_over(continue_from: 那件)` |
| "另外帮我看下 <别的仓库>" | `hand_over(continue_from: null)` |
| "算了不用做了" | `cancel_work` |
| "做得怎么样了" | `work_status` 或直接答 |
| 两件都在跑，"把那个也改了"分不清 | 问 |
| `tell_work` 回 ended | 告诉对方并改走接续，不假装送到了 |

## 9. 实施顺序

1. **follow-up**：只动 Brain（`tasks.ts`、`schema.ts`、`runner.ts` 的工作列表、工具说明）。不动沙箱镜像。
2. **steer**：契约、`tell_work`、`TaskSandbox.tell`、`gate.ts`。要重建镜像；部署后必须在真实容器上实测一次（只有那里能证明话真的到了 agent）。
3. **指引与评测**：`src/workers.md` 和上面那组用例，对真实模型跑。

每步一个 PR，测试先行。

## 10. 请评审重点看

1. follow-up 排队期间不占租户名额、启动时才申请，名额满时的行为是否可接受。
2. 排队的任务重置 `created_at` 是否会破坏别处对"任务何时被交办"的假设（审计、列表、30 天清理）。
3. steer 的"收下"与"读到"之间那三种情况（6.4），尤其是恢复后的重投会不会让 agent 把同一句话读两遍、以及读两遍是否可接受。
4. steer 沿用已有批准（6.5）这条下限。
5. `turn_end` / `agent_before_settle` 两个时机在 pi 0.87.1 的 `--mode json` 一次性运行里是否都会触发、`agent_before_settle` 里投递后是否真的会再走一步。这一条我只读了文档，没有跑过。
6. 有没有更小的做法能达到同样的体验。
