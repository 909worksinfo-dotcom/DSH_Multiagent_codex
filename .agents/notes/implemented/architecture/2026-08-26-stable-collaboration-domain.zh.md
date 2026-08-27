# Agent Note: 稳定协作领域基础

Status: implemented

[English](2026-08-26-stable-collaboration-domain.md) | 中文

## Problem

实验性 Agent Teams 服务把 continuable child 执行与显式启用的 roster、mailbox 和任务板组合在 `ctx.agentTeams` 下，其历史成员容量规则、代码专用 write scope、提示词选定组队以及 `team/*` 记录无法强制天然多智能体产品需求，并且会迫使稳定调用方依赖实验性包

产品需要一个稳定持久权威，专家组合、自动规划、Host 传输和浏览器投影才能依赖协作状态，这个权威必须表达组队失败与恢复，同时不能假装 P1 已经创建挂载技能的专家运行时

## Decision

[`@deepseek-ai/dsh-agent-team`](../../../../packages/collaboration/agent-team/README.md)通过 `ctx.teamRuns` 拥有稳定 TeamRun 状态，[`@deepseek-ai/dsh-tool-agent-team`](../../../../packages/collaboration/tool-agent-team/README.md)是该服务之上的模型可见命令适配器，绝不存储第二份 TeamRun 状态，两个包都保持独立于 `agent-loop`

稳定领域使用 `collaboration/*` Session event，不读取或写入实验性服务的 `team/*` 记录，迁移期间两种实现可以存在于同一个构建中，但不共享状态、Context key 或隐式兼容行为

## Durable authority

Lead Session event log 是唯一 TeamRun 权威，fold 按 TeamRun id 选择记录、校验当前 payload version、拒绝无效转换和不连续任务 revision，并忽略从其他 Root TeamRun 继承的记录，TeamRun 状态、创建尝试、成员审计行、任务和公开消息都从该日志重建

协作记录是 required-on-read Session 事实，因为丢弃它们会改变组队、任务或公开历史重建，不认识稳定事件类型的 reader 会拒绝日志，而不是静默恢复残缺状态

## Formation and capacity

每个 TeamRun 记录复杂度和精确计划专家数，简单计划需要一名专家，中等计划接受两至四名，复杂计划接受五至八名，Lead 是隐式成员且不计入专家容量

专家创建以独立持久转换记录 begin、success 和 failure，active 与 provisioning 专家总数不能超过八，失败尝试保留身份和错误以供审计、释放 active 槽并继续计入十二次尝试预算，名称与 attempt id 不可变且不能复用

TeamRun 只有在精确计划专家数全部成功后才进入 active，无法达到该数量的组队进入 `formation_failed`，任何命令都不能激活或完成 Lead-only 运行，P2 负责把这些转换绑定到真实 ExpertBlueprint 和 subagent 生命周期

active 专家在执行中失败时，同一个失败转换会撤销该专家的成员权限并释放槽位，同时保留任务、消息和审计身份，处于 active phase 的 TeamRun 会投影为 `blocked`，直到 Lead 使用新的不可变身份完成替补并恢复精确计划人数，随后重新投影为 `running`，Lead 进入 `completing` 后不再允许新增或成功组队，但仍持久记录迟到的 active 专家失败，从而阻断精确团队完成并要求 Lead 将运行终止为 failed

## Tasks and public messages

任务保留 compare-and-set revision 与无环依赖图，通用建议性 `resourceScopes` 报告 active owner 冲突，但不声称提供文件系统锁、权限授予或合并保证

公开协作消息使用类型化 intent、author 与 target 身份、可选 task 和关系引用、JSON-compatible content、字面 public visibility 以及幂等 event identity，稳定领域拒绝 private-reasoning 和 chain-of-thought 消息类型，而不是依赖浏览器过滤

## Relationship to the product proposal

本决策实现[天然多智能体协作提案](../../proposed/architecture/2026-08-26-natural-multi-agent-collaboration.md)的领域基础，[专家 runtime](2026-08-26-expert-blueprint-runtime-binding.md)与[自动组队](2026-08-26-automatic-team-formation.md)决策消费本领域以实现不可变能力绑定、任务画像、团队规划、Host RPC 和权威浏览器投影，有边界讨论控制与 Lead 质量门仍属于后续阶段

实验性 Agent Teams 实现只继续服务其已有显式示例直至迁移完成，新稳定代码依赖 `@deepseek-ai/dsh-agent-team`，绝不依赖实验性包

## Verification

包测试通过正常、边界、非法和恢复序列回放复杂度区间、槽位释放、active 专家替补、权限撤销、尝试耗尽、组队失败、任务 CAS 与 DAG 规则、资源冲突、消息可见性、幂等性和 TeamRun 隔离，仓库类型、Lint、包、生成文档与翻译检查包含两个稳定包

## Alternatives considered

**只重命名实验性包而不改变状态模型**：否决，因为失败记录仍会消耗容量，组队仍由提示词驱动，稳定包名还会掩盖不兼容的产品语义

**复用 `ctx.agentTeams` 与 `team/*` 记录**：否决，因为迁移期间两代实现不能安全共存，旧 reader 还可能把新生命周期事实误解为历史显式启用团队模型

**在领域包中创建真实专家运行时**：否决，因为 ExpertBlueprint revision、preset digest、skill 与插件解析以及 subagent descriptor 绑定属于 P2，领域记录经过校验的转换，适配器拥有外部生命周期

**在 Host 或浏览器投影中保存协作状态**：否决，因为投影不能拥有持久重放、compare-and-set revision、组队恢复或跨调用方一致性

## Consequences

P1 建立稳定且可重放的基础，使后续阶段无需导入实验性代码或修改 `agent-loop` 即可消费，容量、组队失败、任务和公开消息隐私成为运行时不变式，而不是提示词约定

仓库暂时同时包含实验性和稳定团队实现，composition 必须显式选择目标服务，任何调用方都不能把两者的事件或 Context key 当作可互换内容，P1 有意停在执行 ExpertBlueprint-bound child 或暴露浏览器可见协作状态之前
