# Agent Note: 可审阅的逐智能体模型选择

Status: implemented

[English](2026-08-31-reviewed-per-expert-model-selection.md) | 中文

## Problem

主协调智能体使用会话默认路由，每名协作专家只能继承主协调智能体路由或使用蓝图路由。规划界面虽然能展示专家路由，但用户无法为主协调智能体和每名专家分配日常会话中的不同 Provider 与模型，而且只保存在客户端显示层的偏好无法跨越替代草案、冷恢复或专家首轮执行

## Decision

协作方案确认页会为已保留的 Lead 加载 `session.models`，因此 Provider 分组、模型名称、说明与思考强度均来自日常会话使用的同一 Host 目录。主协调智能体与每名专家都拥有独立选择器，存在未应用模型修改时会禁止确认执行

应用模型修改时会先创建不可变的替代协作草案，成功后再取消旧草案。创建请求携带一条主协调智能体路由和精确 `slot-N` 专家选择，技能调整与自由文本方案修改也会继续携带当前 plan 已保留的模型路由

Host 会在编排前通过 `ctx.llm.resolveCallConfig` 解析每条提交的 Provider、模型与可选思考强度。持久化 Task Profile 保存规范化后的主协调智能体路由，Team Plan 保存逐席位专家路由，安全规划投影只展示这些保留值，不暴露凭据或 adapter 配置。确认执行会在组队前重新安装已审阅的主协调智能体路由，包括冷恢复场景

ExpertRuntime 让已审阅选择优先于蓝图与 Lead 路由。精确选择会进入不可变 binding foundation 的摘要，在首条 prompt 准入前安装到 child scope，并在恢复和替换时复用，同时仍由 blueprint execution budget 决定 Token 上限

该功能发布前创建的 plan 与 binding 继续可读，因为新增选择字段均为可选字段，原有继承行为保持不变

## Verification

Planner 测试覆盖主协调智能体与合法逐席位持久化，以及越界席位拒绝。Runtime 测试证明已审阅专家路由会从专家首轮开始覆盖蓝图与 Lead 设置。Host carrier 测试覆盖两类结构化协议字段，客户端运行时测试覆盖日常模型目录复用和请求转发，GUI 测试覆盖主协调智能体与专家独立选择、未应用修改时禁止确认以及替代 plan 提交

严格 TypeScript 工程构建与聚焦协作测试覆盖 schema 回放、运行时绑定、Host 传输、客户端编排和 React 规划界面

## Alternatives considered

**组队后再切换 child session。** 这种方式能影响后续轮次，却可能让专家首条 prompt 使用错误路由，而且已审阅 plan 无法证明预期执行配置

**只把模型选择保存在 React state。** 视觉实现简单，但刷新、替代草案、恢复和重试都会丢失选择，界面会声称运行时从未提交的配置

**把模型选择写入自由文本调整要求。** 这种方式可复用现有修改框，但 Provider 与模型标识会依赖自然语言解析，也无法复用日常会话的精确校验约定

**把 Lead 选择复制给全部专家。** 这种方式保留原行为，却无法满足逐专家分配模型的需求，也会让各专业角色的成本与能力选择产生不必要耦合

## Consequences

用户现在可以在执行前，为主协调智能体和每名计划专家分别选择 Provider、模型和受支持的思考强度。协作创建协议与持久 profile schema 新增主协调智能体选择，持久 plan schema、客户端运行时端口与专家 provisioning 请求继续保存精确专家选择。现有权限、工具、技能、任务执行和旧任务回放行为保持不变
