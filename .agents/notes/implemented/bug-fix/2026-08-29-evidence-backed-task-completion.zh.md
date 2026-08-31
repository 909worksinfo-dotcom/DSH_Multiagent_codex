# Agent Note: 基于证据的任务完成

Status: implemented

[English](2026-08-29-evidence-backed-task-completion.md) | 中文

## Problem

任务账本同时驱动中间任务清单和右侧协作面板。Enforced task 曾可在专家负责人仅写出 review 状态资产时进入 `completed`，无需先把该资产回交 Lead 或获得接收。因此两个界面会在专家执行或 Lead 评审仍在进行时提前展示完成，下游任务也可能基于未经验证的工作变为 ready

持久 run 是不可变审计记录。部分历史 run 已包含这种提前完成状态，因此只修正命令路径仍会在查看这些记录时暴露错误完成信息

## Decision

Enforced task 只有一个基于证据的完成提交点。负责人必须是 active expert，该负责人必须公开向 Lead 回交同时精确引用 task 与 artifact 的资产，Lead 必须接收该专家本人资产，最后由 Lead 执行 task 的 `complete` 迁移。专家尝试完成、缺少回交、资产引用不匹配或资产仍为 review 状态时都会拒绝操作且不改变任务 revision

Lead 与专家提示词保持相同顺序。专家提交证据并交回控制权，但不完成任务。Lead 阅读并接收精确证据后确认任务完成，再继续质量门、裁决和最终交付

客户端会为不可变历史 run 派生安全展示状态。Enforced task 的原始状态即使是 `completed`，也只有在存在负责人本人 accepted artifact 和精确回交 Lead 的公开消息时才展示为完成；否则两个任务清单均显示执行中，进度计数也使用该修正投影。Legacy protocol run 保留原任务迁移语义

## Verification

领域测试覆盖专家完成被拒绝、Lead 在无证据时被拒绝、资产未回交时被拒绝、资产已回交但未接收时被拒绝，以及接收后由 Lead 成功完成。适配器与提示词测试锁定执行顺序，客户端 runtime 测试覆盖错误历史完成和具有回交与接收证据的有效完成。更大范围的协作测试、类型检查、网页构建和本地浏览器验证覆盖受影响的执行与展示链路

## Alternatives considered

**只依赖模型提示词，不增加领域不变式** 不予采用，因为延迟或错误的工具调用仍可持久化虚假完成状态并提前解锁下游工作

**把 review 状态资产视为完成** 不予采用，因为 review 明确代表尚未解决，不能证明 Lead 已收到或接收该工作

**只修复两个界面** 不予采用，因为账本仍然存在语义错误，依赖任务仍会从未经验证的 blocker 启动

**重写历史 TeamRun 事件** 不予采用，因为 Session journal 是不可变审计来源。投影兼容可以防止界面过度宣告，同时不改变持久证据

## Consequences

两个任务清单都把 `completed` 用作经过验证的状态，而非乐观进度信号。依赖任务会一直保持阻塞，直到 Lead 接收精确专家证据并提交完成。错误历史记录仍可回放但采用保守展示，未启用协议的 legacy run 保持原有行为
