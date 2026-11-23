# 设计：`BrainAgent` 模块化拆分与内部架构抽象

状态：拆分已完成（代码搬移在 PR #19–#25、#27、#28；#26 只改文档；2026-11-23），`agent.ts` 从约 2,800 行降到 452 行。下文保留为当时的草案；实际做法与草案的差别见下。

> **实施结果**
>
> - 实际拆出的文件：`store.ts`、`timers.ts`、`requests.ts`（即草案中的 `continuations.ts`）、`outbox.ts`、`revisions.ts`、`tasks.ts`、`approval.ts`（即草案中的 `approval-rules.ts`）、`run-tools.ts`、`runner.ts`。每一步一个 PR，均经 Codex 复核。第一步 #19（`requests.ts`）没有改测试，靠规整后逐行比对和当时已有的 339 个测试保证行为不变，`Requests` 的专门测试是之后补的；从 #20 起，每一步先写该部件的单元测试并确认失败，再搬代码，并用变异检查确认测试能抓住被搬动的行为。
> - 每个部件是 `new Part(store, host)`，依赖通过显式 `host` 接口传入；唤醒时间由 `Timers`、`Requests`、`Outbox`、`Tasks` 实现 `Wakes.nextWakeAt(now)` 报告（4.3 的调度部分已做）。
> - **未做**（纯搬移以外的改动，留待需要时再单独做）：4.1 的 JSON 列类型化解析（`Row` 仍是 `Record<string, any>`）；4.3 的清理声明化（`#housekeeping` 仍在 `agent.ts`）；4.4 的 `RunContext`（`outside` 集合由 `BrainAgent` 持有、各部件共用）；4.5 的 `notices.ts` 与会话 `locale`（`NOTICES` 在 `outbox.ts`，仍按最后一条消息是否含汉字判定语言）。

这份文档回答一个问题：在不改变现有外部 RPC 契约、不削弱单线程 SQLite 事务一致性和安全不变量的前提下，如何将已经膨胀到 2,700+ 行的 `src/brain/agent.ts` 拆分为职责清晰、可独立单测、易于演进的内部模块，为后续功能（如 [task-continuation.zh-CN.md](task-continuation.zh-CN.md)）腾出干净的扩展面。

---

## 1. 现状诊断

`src/brain/agent.ts` 目前约 2,710 行，单个 `BrainAgent` 类同时承载了 5 套彼此交织的状态机与大量辅助逻辑：

| 区域 | 现行号区间（约） | 行数 | 承载内容 |
|---|---|---|---|
| 常量、类型、DO 生命周期、收件箱、唤醒循环、定时与清理 | 1–403 | ~400 | `ingest`、`alarm`、`#wakeBy`、`#rearm`、`#housekeeping`、`#fireTimers` |
| 单轮执行引擎与上下文管理 | 404–860 | ~455 | `#claim`、`#execute`、`#finish`、`#actingFor`、`#forgetOutside`、`#transcript` |
| 可靠发件箱 | 861–1049 | ~190 | `#enqueueMessage`、`#flushOutbox`、`#attempt`、`#reconcileClosed` |
| 工具宿主绑定 | 1050–1202 | ~150 | `#toolHost` |
| 挂起续办与回答重开（`continuations` & `answers`） | 1203–1818 | **~615** | `#wait`、`#resume`、`#gate`、`#mayCancel`、`#reopenAnswer`、`#guards` |
| Worker 任务与审批流程 | 1819–2305 | **~485** | `#dispatchTask`、`#answerTask`、`#cancelTask`、`taskEvent`、`#deciders` |
| 版本控制、未决问题收敛、管理查询与纯函数 | 2306–2710 | ~405 | `#revise`、`#standing`、`#reconcile`、`#refreshStanding`、`#settleQuestions`、`inspect`、`readDecision` |

当前结构带来的 5 个具体痛点：
1. **核心安全逻辑与 I/O / SQL 高度耦合**：例如 `#answerTask`（约 200 行）把外部回源查询、SQL 捞取候选消息、审批判定规则、落库与 Worker RPC 全部揉在一个方法里，审查与单测成本高。
2. **弱类型 `Row = Record<string, any>` 与重复 `JSON.parse` 泛滥**：`inbox.data`、`task.pending`、`outbox.receipt`、`outbox.target` 等 JSON 列在全文件被反复手写断言解析，字段演进极易遗漏。
3. **调度核心被业务细节反向侵入**：`#rearm()`（第 304–328 行）和 `#housekeeping()`（第 343–373 行）直接写死了对 7 张子域表的 SQL 查询，每新增一种等待或清理机制都要修改中心调度器。
4. **单次运行的临时状态挂在类字段上**：`readonly #outside = new Set<string>()` 作为内存态挂在 `BrainAgent` 实例上，一旦拆分模块，隐式实例态会成为循环依赖的根源。
5. **系统文案混在状态机中且语言判定脆弱**：`NOTICES`（第 86–94 行）硬编码在 `agent.ts` 顶部，且 `#notice()`（第 887–890 行）仅检查会话最后一条消息是否含汉字来猜中英文——用户只发链接、回 `"ok"` 或点卡片时立刻误切英文，同时审批提示（第 2228 行）仍为纯英文，造成中英混杂。

---

## 2. 重构原则

1. **绝不破坏单线程 SQLite 同步事务模型**：不把一个 `BrainAgent` DO 拆成多个 DO，也不为每张表套一层异步 Repository 抽象。所有子模块共享同一个底层 `BrainStore`，随时可以在一次 `store.transactionSync(...)` 内原子修改多张表。
2. **按“状态机子域”竖着切，不按 MVC / Service / DAO 横着切**：优先隔离高内聚的子域（版本管理、审批规则、挂起续办、任务管理、发件箱），让每个文件都有清晰的所有权和单一变更原因。
3. **对齐项目已验证的纯函数模式**：延续 `src/brain/follow-up.ts` 的做法——把安全/决策规则抽成零 I/O、零 DB 依赖的纯函数，和副作用执行层分开。
4. **严格单向依赖（DAG），零循环引用**：底层底座 → 纯规则与基础子域 → 业务子域 → 执行引擎 → `BrainAgent` 薄壳编排。
5. **外部契约 100% 兼容**：`BrainAgent` 的所有 public RPC 方法签名保持不变；现有测试依赖的导出（`readDecision`、`readTiedDecision`、`wantsStanding`、`messageText`）在 `src/brain/agent.ts` 中保持 re-export，保证重构期间无需大改测试。

---

## 3. 目标模块拓扑与依赖图

拆分后的 `src/brain/` 目录结构：

```text
src/brain/
├── agent.ts            (~300 行)  DO 薄壳：constructor / alarm / #rearm / RPC 入口 / 组装子模块
├── store.ts            (~180 行)  SQLite 底座、meta/audit/log、统一类型化 Row 与 JSON 解析器
├── revisions.ts        (~200 行)  外部消息版本跟踪、standing/reconcile/refreshStanding
├── approval-rules.ts   (~220 行)  纯函数审批规则引擎（对齐 follow-up.ts）
├── follow-up.ts        (已有)     纯函数追问重开规则引擎
├── notices.ts          (~90 行)   面向用户的系统文案收口（带参模板）与会话 locale 推断
├── outbox.ts           (~260 行)  可靠发件箱：入队、投递重试、对账、撤回清理
├── continuations.ts    (~480 行)  挂起等待（continuations）、回答重开（answers）与外发门禁（gate）
├── tasks.ts            (~450 行)  Worker 任务派发/回报/取消、审批执行编排、unsettled 收敛
├── runner.ts           (~480 行)  单轮执行引擎（claim/execute/finish/RunContext/toolHost）
├── timers.ts           (~80 行)   定时器触发（#fireTimers）与下次到期时间计算
├── schema.ts           (已有)     SQLite Schema 与 Migrations
├── tools.ts            (已有)     模型工具定义与参数校验
└── prompt.ts           (已有)     系统提示词构建
```

### 依赖关系（严格无环 DAG）

```text
                     ┌────────────────────────┐
                     │        agent.ts        │  (DO 入口 / alarm 编排 / inspect)
                     └───────────┬────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          ▼                      ▼                      ▼
    ┌───────────┐         ┌─────────────┐        ┌────────────┐
    │ runner.ts │────────▶│  tasks.ts   │        │ timers.ts  │
    └─────┬─────┘         └──────┬──────┘        └─────┬──────┘
          │                      │                     │
          ▼                      │                     │
  ┌──────────────────┐           │                     │
  │ continuations.ts │           │                     │
  └───────┬──────────┘           │                     │
          │                      ▼                     │
          ├──────────────▶┌─────────────┐              │
          │               │  outbox.ts  │              │
          │               └──────┬──────┘              │
          ▼                      │                     │
   ┌──────────────┐              │                     │
   │ revisions.ts │              │                     │
   └──────┬───────┘              │                     │
          │                      │                     │
          └──────────┬───────────┴─────────────────────┘
                     ▼
              ┌─────────────┐       纯函数层（无任何状态依赖）：
              │  store.ts   │       - approval-rules.ts
              └─────────────┘       - follow-up.ts
                                    - notices.ts / prompt.ts / tools.ts
```

> 关键边界说明：
> - `outbox.ts` 需要调用“外发门禁校验”（原 `#gate`），可通过回调接口注入（由 `agent.ts` 装配时把 `continuations.gate` 注入给 `outbox`），避免 `outbox.ts` 反向依赖 `continuations.ts`。
> - `tasks.ts` 和 `continuations.ts` 彼此完全独立，均只向下依赖 `outbox`、`revisions`、`store` 和各自的纯规则模块。

---

## 4. 五项核心架构抽象

### 4.1 统一数据底座与类型化 JSON 解析（`store.ts`）

抽离 `BrainStore` 封装对 `DurableObjectStorage` 与 `SqlStorage` 的底层访问：

```ts
export class BrainStore {
  readonly sql: SqlStorage;
  readonly storage: DurableObjectStorage;
  readonly scopeName: string;
  readonly scope: Scope;

  transaction<T>(fn: () => T): T;
  rows<T = Record<string, unknown>>(query: string, ...bindings: SqlStorageValue[]): T[];
  exec(query: string, ...bindings: SqlStorageValue[]): void;
  meta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  audit(actor: string, action: string, detail: Record<string, unknown>): void;
  log(event: string, detail: Record<string, unknown>): void;
  insertEvent(event: InboundEvent): boolean;
}
```

同时集中定义数据库中所有 JSON 列的**显式接口与解析函数**，消灭散落全文件的 `JSON.parse(...) as { ... }`：
- `InboxData` / `parseInboxData(row)`
- `parsePrincipal(row)`
- `TaskPending` / `TaskIntent` / `parseTaskPending(row)`
- `parseTarget(row)` / `parseReceipt(row)` / `parseApprovalQuestion(row)`

### 4.2 纯函数审批规则引擎（`approval-rules.ts`）

效仿 `src/brain/follow-up.ts`，将目前 `#answerTask` 中混在 I/O 里的所有审批判定规则抽为无副作用的纯函数：

```ts
export interface ApprovalContext {
  decision: "allow" | "deny";
  sharedScope: boolean;            // 非 user scope（群聊/仓库）
  pending: { id: string; code: string; ask?: string; truncated?: boolean; standingOffered?: boolean };
  requestedBy: string | null;
  receivedReplies: ReplyFact[];    // 经过 reconcile 后的已读回复
  receivedUnresolved: boolean;
  queuedReplies: ReplyFact[];      // 经过 reconcile 后仍在 inbox 排队的回复
  queuedUnresolved: boolean;
  usedEventIds: Set<number>;       // 已被其他问题消费过的回复 id
  decidedByLaterSpeech: (eventId: number) => boolean; // 是否在原频道/当前频道之后改口
}

export type ApprovalVerdict =
  | { ok: true; decidingEventId: number; decidedBy: string; standing: boolean }
  | { ok: false; error: string };

export function evaluateApproval(ctx: ApprovalContext): ApprovalVerdict;
```

同时把 `readDecision`、`readTiedDecision`、`wantsStanding`、`quotes`、`isAbout`、`isTiedTo`、`saysAbout` 全部迁入 `approval-rules.ts`。

`tasks.ts` 中的 `answerTask()` 随之简化为清晰的三段式管道：
1. **收集与回源核验（I/O）**：若 `decision === "allow"`，执行 `revisions.refreshStanding(...)` + 校验提问原文未被篡改；
2. **纯规则裁决（同步、无副作用）**：构造 `ApprovalContext`，调用 `evaluateApproval(ctx)`；
3. **落库与投递（副作用）**：持久化 `answering` intent → 调 Worker `answer()` RPC → 标记结果并关闭审批卡片。

### 4.3 调度与清理的声明式接口（解耦 `#rearm` 与 `#housekeeping`）

定义一个极轻量的子系统协议：

```ts
export interface ScheduledSubsystem {
  /** 返回该子系统下一次最早需要被唤醒的时间戳（ms）；无待办则返回 null。 */
  nextWakeAt(now: number): number | null;
}
```

每个子模块各自实现 `nextWakeAt(now)`：
- `runner`：`active_run.retry_at` 或 `inbox` 存在 `pending` 时的 `now + 200`；
- `timers`：`MIN(due_at)`；
- `outbox`：最早的 `pending` / `reconciling` `next_at`；
- `tasks`：`unsettled` 表最早的 `next_at`；
- `continuations`：`answers` 最早过期时间、`continuations` 最早 `until / check_at`；
- `agent` 自身：每日 `housekeeping_at`。

`BrainAgent.#rearm()` 由此收敛为不到 10 行代码：
```ts
async #rearm(): Promise<void> {
  const now = Date.now();
  const times = this.#subsystems
    .map((s) => s.nextWakeAt(now))
    .filter((t): t is number => t !== null);
  if (times.length === 0) return;
  await this.ctx.storage.setAlarm(Math.max(Math.min(...times), now + 50));
}
```
未来新增任何定时/过期机制（例如任务快照生命周期或新类型的等待），不再需要修改 `BrainAgent.#rearm()`。

### 4.4 显式单次运行上下文（`RunContext`）

用 `RunContext` 取代挂在 `BrainAgent` 类上的内存态（如 `readonly #outside = new Set<string>()`）以及到处透传的 `runId`：

```ts
export class RunContext {
  readonly runId: string;
  readonly sessionId: string;
  readonly sessionKey: string;
  /** 本次调用中尚未落库的“读过外部不可信文本”标记。 */
  outsideTainted = false;
  /** 本次 run 绑定的挂起续办记录（若为 resume run）。 */
  readonly carried?: Continuation;
}
```

- `RunContext` 在 `runner.execute(runId)` 开始时创建，随 `#toolHost(ctx)` 向下传递，run 结束即销毁；
- 消除类实例级别的隐式状态残留，也避免在多个子模块之间传递 `Set<string>`。

### 4.5 系统文案收口与稳定的会话 `locale` 判定（`notices.ts`）

将所有不经 LLM、直接面向用户发送的确定性系统消息从核心状态机剥离到纯函数模块 `src/brain/notices.ts`：

1. **统一收口并支持带参模板**：
   - 收拢原 `NOTICES`（`withheld` / `notSent` / `notAnswered` / `limit` / `which` / `unchecked` / `invite`）以及 `tasks.ts` 中的审批提示文案（如暂停待批、过长不可批准、如何回复确认码），消除“系统通知发中文、审批提问发英文”的割裂体验。
   - 支持轻量参数化渲染（例如带上请求或任务简述），避免用户并行问了多件事时收到笼统的“你之前让我做的事我没能完成”而不知所指。
2. **修复“只看最后一条消息有没有汉字”的脆弱语言猜测**：
   - 在 `sessions` 表增加可选的持久化 `locale` 列（或优先读取 connector 上报的用户语言）；
   - 需要基于消息文本推断 `locale` 时，回看最近若干条（如 5–10 条）**人类发出的消息**，先剔除 URL、确认码（`approve/deny CODE`）和纯数字/标点后再做语言识别，并区分日文假名避免误判为中文；
   - 一旦识别出明确的会话语言就记在 `sessions.locale` 上，后续即使最后一句只发了纯链接、`"ok"` 或点击了审批卡片，也不会突然切回英文。
3. **语义与呈现分离**：核心业务只传递系统语义键与结构化上下文，不拼装面向用户的自然语言字符串。

---

## 5. 跨模块事务边界核对

拆分时必须特别守住以下 4 处跨表原子事务，保证依然在**同一个 `store.transaction(...)`** 中提交：

1. **`#claim()`（`runner.ts`）**：`sessions`（查/建/更新 `target`）+ `inbox`（标记 `claimed`）+ `runs`（插入）+ `items`（追加 user 消息）+ `meta`（设 `active_run`）必须原子提交。
2. **`#resume()`（`continuations.ts`）**：外部 `await holds(...)` 结束后，二次校验 `continuations` + 更新 `status = 'resuming'` + 更新 `inbox` + 插入 `runs` + 追加 `items` + 设置 `meta.active_run` 必须原子提交。
3. **`#dispatchTask()`（`tasks.ts`）**：写入 `tasks`（`dispatching`）+ 写入看门狗 `timers`（`watch_${id}`）+ 写入 `audit` 必须原子提交（先落库再向 Registry 抢 slot、再调 Worker `start()`）。
4. **`#fireTimers()`（`timers.ts`）**：将到期定时器写入 `inbox` + 更新 `timers` 下次触发时间或 `done` 必须原子提交。

因为所有子模块共享同一个 `BrainStore`，上述事务均无需分布式锁或补偿逻辑，直接沿用现有 `store.transaction(...)` 即可。

---

## 6. 分阶段重构路线图（4 个独立 PR）

严禁一次性大重写。建议按“从纯逻辑到有状态、从低耦合到核心”拆成 4 个小 PR，每个 PR 结束后 `pnpm check`（`tsc --noEmit && vitest run`）必须全绿：

### PR 1：抽出 `store.ts`、`revisions.ts`、`approval-rules.ts`
- 建立 `BrainStore` 与核心 JSON 解析器（第一批覆盖 `inbox.data`、`principal`、`task.pending`）。
- 抽出 `Revisions`（`revise`、`standing`、`reconcile`、`refreshStanding`、`saidSinceWhereTyped`）。
- 抽出 `approval-rules.ts`（纯函数 `evaluateApproval` + `readDecision` / `readTiedDecision` / `wantsStanding`），`agent.ts` 保留 re-export。
- **收益**：立刻把最复杂、最敏感的 `#answerTask` 拍平，并为审批规则补齐零 mock 单元测试。

### PR 2：抽出 `continuations.ts`
- 将 `agent.ts` 第 1203–1818 行整块（`continuations` + `answers` + `guards` + `reopenAnswer` + `gate`）迁入 `continuations.ts`。
- 保留 `BrainAgent.conditionReported` 作为 1 行委托入口。
- **收益**：`agent.ts` 立刻减少约 600 行，且与任务/审批逻辑彻底解耦。

### PR 3：抽出 `outbox.ts`、`timers.ts`、`tasks.ts`、`notices.ts`
- 抽出 `Outbox`（注入 `gate` 回调，避免循环依赖）、`Timers`、`Tasks`（含 `unsettled` 收敛与审批卡片关闭）。
- 抽出 `notices.ts` 统一收口系统通知与审批提示文案，并改进会话 `locale` 推断逻辑。
- 落地 `ScheduledSubsystem` 接口，简化 `BrainAgent.#rearm()`。
- **衔接点**：完成 PR 3 后，[task-continuation.zh-CN.md](task-continuation.zh-CN.md) 的 Brain 侧改造可直接写在清爽的 `tasks.ts` 里，不再往巨型 `agent.ts` 堆砌新代码。

### PR 4：抽出 `runner.ts`，收敛 `agent.ts` 为薄壳
- 抽出 `Runner`（`claim`、`execute`、`finish`、`toolHost`、`actingFor`、`transcript`）并引入 `RunContext` 消除类上的 `#outside` 内存态。
- 最终 `src/brain/agent.ts` 收敛至 ~300 行，一眼可读完整个 DO 的生命周期、RPC 入口与模块装配关系。

---

## 7. 有意不做的事情

1. **不引入 ORM / Query Builder**：Cloudflare Durable Object 内置的同步 `SqlStorage` 直接写参数化 SQL 既清晰又零开销；只需用 `store.ts` 统一类型化解析 JSON 字段即可，不需要重型 ORM。
2. **不引入内部 EventBus / PubSub**：子模块之间直接显式方法调用，调用链清晰可追踪，IDE 一键跳转定义，避免“发了个事件不知道谁处理”的隐式控制流。
3. **不把 `BrainAgent` 拆成多个 Durable Object**：同一个 scope 的收件箱、会话、审批、发件箱放在同一个 DO 的同一张 SQLite 里，是整个系统强一致性与简单性的基石，绝不为了代码行数拆分布式事务。
4. **不引入重型 i18n 框架**：面向用户的系统固定文案总量在十来条量级，用纯 TypeScript 模块 `notices.ts`（带类型校验的模板函数）即可获得完整的编译期检查和零运行时依赖。
