# Agent Note: 仅在子智能体执行期间计入专家超时

Status: implemented

[English](2026-08-28-serial-expert-active-execution-timeout.md) | 中文

## 问题

专家 runtime 把 provisioning 时创建的绝对 deadline 当成 roster member 的完整生命周期。在串行协作中，专家会在 Lead 与其他专家持有 baton 时保持 idle，之后再接收评审或验收请求。这段正常等待会耗尽全部 timeout，导致已经提交并验收资产的贡献者在下一条消息唤醒时立即被标记为 failed，活跃 roster 因而低于团队人数要求

## 决策

持久化 `deadlineAt` 继续约束初始 prompt 准入。后续工作使用从不可变 blueprint 重新解析的确切 `timeoutMs`，并只计入每个 whole-agent `running` 区间。`agent/status` 转为 `running` 时开启 timer，转为 `idle` 时清除 timer，dispose 或成员失败时同时清除 timer 与缓存预算。pre-step 校验会重新解析 binding，在 runtime 重载后补建缺失 timer，并在模型进入前拒绝已经过期的活跃执行区间

deadline 到期时，只有 child 仍处于 `running` 才会取消并标记失败。timer callback 与 idle 或终态转换发生竞争时只清理自身，不修改 TeamRun membership

## 备选方案

**统一提高所有 blueprint timeout。** 不予采用，因为串行 idle 时间仍与执行时间耦合，任务足够长时只会在更大的阈值上复现同类问题

**专家已有 accepted artifact 后忽略其 failed 状态。** 不予采用，因为这会隐藏 runtime 失败，也无法安全授权后续评审轮次。已验收证据与当前执行可用性仍是两个独立事实

**跨所有区间记录累计活跃时间 ledger。** 本次 Demo 不采用，因为产品约定每次只分配一条有界消息，并要求下一次 activation 前重新规划。持久化 aggregate token 与 time ledger 仍属于独立预算能力

## 影响

专家可以在串行任务的完整等待期内保持 idle 而不丢失成员资格，真正卡死的活跃执行仍会在配置 timeout 到期时关闭式失败。已有不可变任务历史不会被改写。runtime 重载后，已经处于 running 的 child 会在下一次 pre-step 获得替代 timer，不重建此前已经过去的进程内时间
