# Agent Note: 资产回执接收者完整性

Status: implemented

[English](2026-08-28-artifact-receipt-recipient-integrity.md) | 中文

## Problem

Artifact 写入会在持久资产版本旁追加一条紧凑公开 receipt。该 receipt 的目标始终是 Lead，这在专家提交工作时正确，但在 Lead 采纳或修改资产时会产生 Lead 发给 Lead 的公开记录。普通协作消息与串行路由已经拒绝自发自收，但生成式账本 receipt 使用另一条准入路径。群聊投影忠实展示了无效持久目标，包括不可变历史任务中的记录

## Decision

Artifact receipt 现在按照操作对方选择目标。专家写入时目标为 Lead，Lead 更新专家撰写的 artifact 时目标为不可变 artifact 作者，Lead 写入自有 artifact 时不设置会话目标。Artifact 所有权在不同版本间保持不变，receipt 作者仍是执行更新的精确调用者

共享账本消息构造器会在追加事件前拒绝稳定 actor 身份与作者相同的任何生成目标。这把自发自收不变式从模型消息和串行路由扩展到使用该构造器的权威 artifact、decision、review 与 controller receipt

协作界面会在投影时过滤作者与接收者相同的标签。该兼容规则不会重写持久历史，因此旧任务仍可回放和审计，但不再展示不可能的自我会话

## Verification

领域回归测试覆盖一条状态轨迹：专家提交目标为 Lead，Lead 采纳时保留专家 artifact 作者并以该专家为目标，新建 Lead 自有 artifact 时目标为空。测试还断言所有结果公开消息都不会以自身为接收者。组件回归测试会渲染一条旧自发自收 artifact receipt，并证明本地化 receipt 正文仍然可见而接收者标签不存在。受影响的领域、适配器和协作 UI 测试还覆盖相邻权限、协议预算、不可变 receipt 内容与公开投影

## Alternatives considered

**只在 UI 隐藏全部 artifact receipt 目标** 被拒绝，因为新持久事件仍然语义无效，其他消费者也会继续看到 Lead 发给 Lead 的关系

**所有 Lead artifact 更新都不设置目标** 被拒绝，因为采纳专家工作存在真实对方，专家应继续作为该公开确认的接收者展示

**重写旧 TeamRun 事件** 被拒绝，因为事件 journal 是不可变审计源。投影兼容可以修复展示，同时不改变历史证据

**让账本 receipt 复用普通消息校验器** 被拒绝，因为该校验器会有意阻止权威 ledger 操作之外的 artifact、decision 和 final-delivery kind。账本构造器中的聚焦身份不变式能够保留现有所有权边界

## Consequences

新 artifact receipt 拥有一致的方向，生成式账本记录不能再引入自身接收者，历史无效标签无需迁移即可从群聊消失。检查原始历史事件的消费者仍可看到之前的错误目标，因为持久审计记录保持不变
