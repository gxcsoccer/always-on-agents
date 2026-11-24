# 把 worker 做成一个统一的概念

状态：草案，2026-11-25。先定方向，再分步实现。

## 1. 现在的样子

agent 能把事情交出去做的地方有两处，是两套互不相干的机制：

| | 沙箱 | 豆包工作 |
|---|---|---|
| 模型看到的 | `dispatch_task` / `task_status` / `cancel_task` | 一个 connector 工具 `doubao_ask` |
| 记录在哪 | Brain 的 `tasks` 表 | connector 自己的 Durable Object 里 |
| 结果怎么回来 | worker 主动汇报，成为收件事件 | Brain 的"等待中的请求"定时去问 |
| 接着做 | 没有（设计见 [task-continuation](task-continuation.zh-CN.md)） | 有，靠这个工具自己的一套规则 |
| 能不能换 | 写死，类型只有 `sandbox` | 在 connector 列表里加减，按聊天应用配对启用 |

后果是真实使用里见到的：先让豆包调研，紧接着追问，模型把追问派给了沙箱。在它眼里这是两个无关的工具，"上一件事是谁做的、追问该找谁"不是它能统一去想的问题。每加一个能干活的地方，就要再写一套记录、一套等待、一套接续规则。

## 2. 目标

- 一个概念：**worker**，能接一件事、过一阵子给出结果的地方。沙箱是内置的一个，豆包工作是插件提供的一个，以后可以再加，不动 Brain。
- 一份记录：每件交出去的事（**工作**）由 Brain 统一记着：交给了谁、替谁、在哪个对话里、现在怎样、接的是哪一件。
- 一组工具，一套接续规则：模型看到"有哪些 worker、各自擅长什么""这个人最近交出去过哪些事"，由它决定交给谁、接哪一件。代码只保证下限。

## 3. 方案

### 3.1 worker 的契约

```ts
interface Worker {
  name: string;                 // "sandbox"、"doubao"
  description: string;          // 给模型看：擅长什么、不能做什么
  /** 以谁的名义做事。"person" 的要本人授权，并且只在本人自己的对话里可用。 */
  acts_as: "agent" | "person";
  /** 这条消息的作者在这里能不能用它（比如运营方是否为这个聊天应用配对过）。 */
  offered?(env, event): Promise<boolean>;
  /** 开始一件事，或接着 `from` 那一件做。可以回答"需要本人先授权"。 */
  start(context, work: { id; brief; from?: WorkRef }): Promise<Started | NeedsAuthorisation | Refused>;
  /** 没有人会来汇报的 worker：Brain 到时候来问。会主动汇报的不实现。 */
  look?(env, work: WorkRef): Promise<{ state: "not_yet"; again_in_ms } | { state: "done"; result } | { state: "gone" }>;
  cancel?(env, work: WorkRef): Promise<void>;
}
```

worker 由 connector 插件提供（`Connector.workers`），和现在 connector 提供工具的方式一样；沙箱由 Brain 自带。授权回调、管理接口等仍是那个 connector 的事。

### 3.2 Brain 这一侧

- `tasks` 表扩成通用的工作记录：加 `worker`（已有这一列，目前恒为 `sandbox`）、`person`、`parent`（接的是哪一件）、`ref`（worker 自己那边的指向，比如豆包的会话）。状态机不变：每件工作只结束一次，接着做永远是一件新的工作，指向它的上一件。
- 两种取结果的方式并存，都落到同一条记录上：会汇报的走现有的 worker 事件；要去问的走现有的"等待中的请求"（截止、重试、过期提示都已经有了）。
- 工具合成一组：`hand_over(worker, title, brief, continue_from?)`、`work_status`、`cancel_work`。审批问题（`answer_task`）不变，只有会提问的 worker 用到。
- 提示里给模型两样东西：可用的 worker 和各自的说明；这个人在这个对话里最近的几件工作（编号、交给了谁、标题、状态）。追问接哪一件、交给谁，由模型判断。

### 3.3 代码保证的下限（不靠提示）

- 只能接**本人、本对话**里的工作；不跨人、不跨对话、不跨 worker；上一件的审批和授权不带过来。
- `acts_as: "person"` 的 worker：开一件新的事要本人在这条消息里说了要交给它；接着做要么本人回复的就是那件事的答复，要么本人写这句话时看到的最后一条答复就是它（PR #54 的规则，原样搬过来成为通用规则）。
- 本人标了引用就不猜；分不清就不发。

## 4. 分步

1. **契约和记录**：加 `Worker` 契约、工作记录的新列；沙箱改为按契约接入。行为不变，测试不变。
2. **豆包改为 worker**：`doubao_ask` 的逻辑搬到 `start` / `look`，它自己 Durable Object 里的工作记录并入 Brain 的记录（授权和令牌仍在它那里）。对外行为不变。
3. **一组工具和统一接续**：换成 `hand_over` 等三个工具，提示里列出 worker 和最近的工作；旧工具名下线。
4. **沙箱的接着做**：按 [task-continuation](task-continuation.zh-CN.md) 的快照方案实现，接在同一个 `continue_from` 上。

每步一个 PR，测试先行，Codex 复核。第 1、2 步不改变用户看到的行为，第 3 步起才变。

## 5. 不做

- 不做多个 worker 之间的编排、互相转交。
- 不做通用任务队列；并发上限、沙箱名额照旧。
- 不改审批、不改授权模型。

## 6. 代价和要定的事

- 第 2 步要迁移已有的豆包工作记录（最多保留三小时，可以等它们自然结束再切）。
- 模型的工具从"每个 worker 各一个"变成"一个工具选 worker"。好处是加 worker 不加工具、接续规则只有一套；代价是 worker 的说明要写得让模型选得准，需要真实使用来调。
- **要用户定的**：（1）是否同意合成一组工具（建议同意）；（2）PR #54 是否先合并作为过渡（建议合并：它的规则在第 3 步原样成为通用规则）；（3）第 4 步排在什么时候。
