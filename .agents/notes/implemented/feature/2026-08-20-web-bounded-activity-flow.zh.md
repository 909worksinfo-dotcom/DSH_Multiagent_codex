# Agent Note: Web Chat 中有界的执行过程

Status: implemented

[English](2026-08-20-web-bounded-activity-flow.md) | 中文

## Problem

上下文注入、Think、todo 更新和工具活动等重复过程行可能占据会话列的大部分空间，而读者通常只需要看到当前几行。把这些行当作与普通文本记录同级的内容，会让中间正文和交付产物更难浏览。

展示层不能根据显示文案或工具名推断重要性。Conversation Node 是彼此独立的插件贡献；任何视觉分组都必须保留其稳定 key、展开交互、生命周期更新、分页锚点和持久内容。

## Decision

`ChatConversationViewNode` 提供可选的 `flow: 'activity'` 标记。业务 Definition 在投影节点属于执行过程而非对话产出时选择加入。内建上下文行、纯 reasoning Assistant 步骤，以及包括 Read、Bash、terminal、code、Cordis、Web 和文件变更在内的执行工具都会加入。已完成的 `write`、`edit`、`grep` 和 `glob` 调用可以收敛为轮次摘要；其他工具则在限高分组内保留完整 keyed renderer 和详情界面。面向用户的提问和计划评审仍使用普通节点；Assistant 正文、图片与其他产出 block、重试、命令、交互提示、用户消息和轮次产出同样保持普通节点。

`ChatSnapshotBuilder` 把标记变化视为结构变化，并根据可见顺序派生不可变的 `ChatSnapshot.flow`。它只组合连续的 activity 节点；每个普通节点都会分隔前后过程段。规范节点、Location、持久事件和节点稳定 key 均不改变。React 遍历这份由 builder 拥有的投影，不重新解释事件，也不扫描相邻节点。

每段 activity 在一个高 88px、可聚焦的纵向滚动视口中渲染。其子 `ChatNodeSeat` 仍逐个保留 key，并沿用既有 renderer 与展开行为。读者位于末端时，视口会跟随子项增加与高度变化；读者向上滚动后暂停跟随，直到视口再次到达末端。跟随会立即完成，避免长 activity 段在动画期间让最新行停留在视口之外。

## Verification

组件覆盖固定语义分类、重要 Assistant 正文对连续分组的切分、上下文与 Think 展开项保留、三行限高几何、仅在末端跟随、读者滚动后暂停跟随、工具结算期间的 keyed identity，以及既有 Chat 前插和页面跟随锚点。组装后的 Web 回放与真实模型浏览器录制在完整插件图中验证该行为。

## Alternatives considered

**在 React 中根据本地化标签或工具名推断 activity。** 否决，因为文案不是稳定的业务判别项，而且 Chat renderer 不得扫描相邻 Node 或重新解释事件。

**把低优先级行替换成一份有损摘要。** 否决，因为上下文正文、reasoning 展开项、todo 变化与工具详情仍有阅读价值，并且必须逐项可访问。

**只压缩已关闭轮次的工具摘要。** 否决，因为这样仍会让上下文、reasoning、todo 和运行中工具组成的最大重复实时序列铺满整列。

**把全部过程行放进一个会话级视口。** 否决，因为重要产出必须保留文本记录顺序，并把其前后的 activity 分成独立过程段。

## Consequences

长执行序列只占少数几行，而重要正文与交付产物保留既有完整 UI 和顺序。读者可以滚动或展开每一条保留的过程行，实时跟随也不会覆盖对更早活动的查看。

嵌套纵向视口为 activity 段增加了第二个滚动目标。可聚焦区域和受控 overscroll 会明确该目标；activity Definition 必须把标记限制在值得采用紧凑展示的行上。
