# Security / 安全

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting for this repository ("Report a vulnerability" under the Security tab). Include what an attacker could do, the steps that show it, and the commit you tested.

Reports about any of the following are especially welcome:

- one tenant reading or changing another tenant's data;
- an action being approved that the entitled person did not approve, or was not shown;
- the sandbox reaching a network address or a credential it should not;
- a forged or replayed request being accepted by a connector.

The design assumptions these rest on are described in [docs/architecture.md](docs/architecture.md) and [docs/approvals.md](docs/approvals.md). Known limitations are listed in [docs/status.md](docs/status.md); a report that shows one of them is worse than described is still useful.

## 报告安全问题

请不要用公开的 issue 报告安全问题。请使用本仓库的 GitHub 私密漏洞报告功能（Security 标签页下的“Report a vulnerability”），并说明攻击者能做到什么、复现步骤，以及你测试的提交。

以下几类报告尤其欢迎：

- 一个租户读到或改动了另一个租户的数据；
- 某个动作在有权批准的人没有批准、或者没有看到的情况下被批准了；
- 沙箱访问到了它不该访问的网络地址或凭据；
- 伪造或重放的请求被某个 connector 接受了。

这些性质所依赖的设计假设见 [docs/architecture.zh-CN.md](docs/architecture.zh-CN.md) 和 [docs/approvals.zh-CN.md](docs/approvals.zh-CN.md)。已知限制列在 [docs/status.zh-CN.md](docs/status.zh-CN.md)；如果你发现其中某一项比描述的更严重，同样值得报告。
