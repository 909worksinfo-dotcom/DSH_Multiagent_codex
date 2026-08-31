# Agent Note: Bounded execution activity in Web Chat

Status: implemented

English | [中文](2026-08-20-web-bounded-activity-flow.zh.md)

## Problem

Repeated process rows such as context injection, Think, todo updates, and tool activity can occupy most of the conversation column even though readers usually need only the current few lines. Treating those rows as ordinary transcript peers makes intermediate prose and deliverables harder to scan.

The presentation cannot infer importance from display text or tool names. Conversation Nodes are independent plugin contributions, and their stable keys, disclosures, lifecycle updates, paging anchors, and durable content must survive any visual grouping.

## Decision

`ChatConversationViewNode` has an optional `flow: 'activity'` marker. A business Definition opts in when its projected node is execution process rather than conversation output. Built-in context rows, reasoning-only Assistant steps, and execution tools—including Read, Bash, terminal, code, Cordis, Web, and file mutations—opt in. Completed `write`, `edit`, `grep`, and `glob` calls may collapse into a turn summary; every other tool retains its full keyed renderer and detail surface inside the bounded group. User-facing questions and plan review remain ordinary nodes. Assistant text, images and other output blocks, retries, commands, interaction prompts, user messages, and turn output remain ordinary nodes.

`ChatSnapshotBuilder` treats marker changes as structural and derives an immutable `ChatSnapshot.flow` from visible order. It groups only contiguous activity nodes; every ordinary node splits the run. Canonical nodes, locations, durable events, and stable node keys remain unchanged. React traverses that builder-owned projection instead of interpreting events or scanning sibling nodes.

Each activity run renders in an 88px focusable vertical viewport. Its child `ChatNodeSeat`s remain individually keyed and keep their existing renderer and disclosure behavior. The viewport follows child additions and height changes while the reader is at its end. A reader scroll away pauses following until the viewport reaches the end again. Following is immediate so a long activity run cannot leave the latest rows outside the viewport during an animation.

## Verification

Component coverage pins semantic classification, contiguous grouping around important Assistant prose, retained context and Think disclosures, three-row bounded geometry, follow-at-end behavior, paused following after reader scroll, keyed Tool identity through settlement, and existing Chat prepend and page-follow anchors. The assembled Web replay and a real-model browser recording verify the behavior in the complete plugin graph.

## Alternatives considered

**Infer activity from localized labels or tool names in React.** Rejected because copy is not a stable business discriminator and the Chat renderer may not scan sibling Nodes or reinterpret events.

**Replace low-priority rows with one lossy summary.** Rejected because context bodies, reasoning disclosures, todo transitions, and tool details remain useful and must stay individually accessible.

**Compact only closed-turn tool summaries.** Rejected because it leaves the largest repeated live sequence—context, reasoning, todo, and running tools—spread across the full column.

**Put all process rows into one session-wide viewport.** Rejected because important output must preserve transcript order and split surrounding activity into separate runs.

## Consequences

Long execution sequences occupy a few visible lines while important prose and deliverables retain their existing full UI and order. Readers can scroll or expand every retained process row, and live following does not override review of earlier activity.

The nested vertical viewport introduces a second scroll target for activity runs. Its focusable region and contained overscroll make that target explicit; activity Definitions must keep the marker limited to rows whose compact presentation justifies that interaction.
