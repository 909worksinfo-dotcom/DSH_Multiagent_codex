/** Deterministic parsing for user-authored collaboration plan requirements. */

import { TeamRunError } from '@deepseek-ai/dsh-agent-team'
import type { TeamPlanRequirements } from './types.ts'

const ADJUSTMENT_MARKER = /(?:^|\n)\s*协作方案调整要求\s*[:：]\s*/gu
const COUNT_TOKEN = String.raw`(?:[1-9]\d*|[一二两三四五六七八九十]+)`
const CHINESE_NUMBERS = new Map<string, number>([
  ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5],
  ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10],
])
const SKILL_ID = /`([^`\r\n]+)`|\b([a-z][a-z0-9]*(?:[-_.][a-z0-9]+)+)\b/giu
const LOCAL_SKILL_ALIASES: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  { id: 'collaboration-research-analysis', pattern: /(?:调研分析|研究分析|research[\s_-]*analysis)/iu },
  { id: 'collaboration-peer-review', pattern: /(?:同行评审|同业评审|交叉评审|peer[\s_-]*review)/iu },
  { id: 'collaboration-product-solution', pattern: /(?:产品方案|产品设计|product[\s_-]*solution)/iu },
  { id: 'collaboration-software-development', pattern: /(?:软件开发|工程开发|software[\s_-]*development)/iu },
]

function positiveInteger(value: string, label: string): number {
  const normalized = value.trim()
  const direct = /^\d+$/u.test(normalized) ? Number(normalized) : CHINESE_NUMBERS.get(normalized)
  if (direct === undefined || !Number.isSafeInteger(direct) || direct < 1) {
    throw new TeamRunError(`${label} must be a positive integer`, 'TEAM_INVALID_ARGUMENT')
  }
  return direct
}

/** Split the immutable user objective from one or more legacy adjustment blocks. */
export function collaborationObjectiveParts(objective: string): {
  readonly objective: string
  readonly adjustment: string
} {
  const parts = objective.split(ADJUSTMENT_MARKER)
  return {
    objective: (parts[0] ?? objective).trim(),
    adjustment: parts.slice(1).map(value => value.trim()).filter(Boolean).join('\n'),
  }
}

/** Canonicalize legacy repeated review blocks without discarding any user-authored requirement. */
export function normalizeCollaborationObjective(objective: string): string {
  const { objective: base, adjustment } = collaborationObjectiveParts(objective)
  if (adjustment === '') return base
  const requirements = [...new Set(adjustment.split(/\r?\n/gu).map(value => value.trim()).filter(Boolean))]
  return `${base}\n\n协作方案调整要求：\n${requirements.join('\n')}`
}

function requestedSkillIds(clause: string): string[] {
  const values = [...clause.matchAll(SKILL_ID)]
    .map(match => (match[1] ?? match[2] ?? '').trim())
    .filter(Boolean)
  for (const alias of LOCAL_SKILL_ALIASES) {
    if (alias.pattern.test(clause)) values.push(alias.id)
  }
  return [...new Set(values)]
}

function normalizedExpertTarget(value: string): string {
  const target = value
    .replace(/^\s*(?:将|把|给|从)\s*/u, '')
    .replace(/\s*(?:的)?\s*技能(?:设置|配置)?(?:中)?\s*$/u, '')
    .replace(/\s*(?:agent|智能体)\s*$/iu, '')
    .trim()
  if (/^(?:每(?:个|名)?|所有|全部|各(?:个|名)?)专家(?:agent|智能体)?$/iu.test(target)
    || /^(?:all|each|every)\s+experts?(?:\s+agents?)?$/iu.test(target)) return 'all'
  if (target === '') throw new TeamRunError('expert skill requirement is missing its target expert', 'TEAM_INVALID_ARGUMENT')
  return target
}

function parseExpertSkillClause(clause: string): NonNullable<TeamPlanRequirements['expertSkills']>[number] | undefined {
  const english = clause.match(/^\s*(?:set|replace)\s+(.+?)\s+(?:expert\s+)?skills?\s+(?:to|with)\s+/iu)
  if (english !== null) {
    const skills = requestedSkillIds(clause.slice(english[0].length))
    if (skills.length === 0) {
      throw new TeamRunError('expert skill replacement must name at least one available skill', 'TEAM_INVALID_ARGUMENT')
    }
    return { target: normalizedExpertTarget(english[1] ?? ''), operation: 'replace', skills }
  }

  const operations: readonly { readonly pattern: RegExp; readonly operation: 'replace' | 'add' | 'remove' }[] = [
    { pattern: /(?:取消挂载|移除|删除|去掉|\bremove\b)/iu, operation: 'remove' },
    { pattern: /(?:增加|添加|新增|补充|挂载|\badd\b)/iu, operation: 'add' },
    { pattern: /(?:修改为|改为|调整为|替换为|设置为|配置为|\breplace\b|\bset\b)/iu, operation: 'replace' },
  ]
  const selected = operations
    .map(value => ({ ...value, match: value.pattern.exec(clause) }))
    .filter((value): value is typeof value & { readonly match: RegExpExecArray } => value.match !== null)
    .sort((left, right) => left.match.index - right.match.index)[0]
  if (selected === undefined) {
    if (requestedSkillIds(clause).length > 0 && /技能|skills?/iu.test(clause)) {
      throw new TeamRunError('expert skill requirement has skill ids but no supported add, remove, or replace operation', 'TEAM_INVALID_ARGUMENT')
    }
    return undefined
  }
  const target = normalizedExpertTarget(clause.slice(0, selected.match.index))
  const skillText = clause.slice(selected.match.index + selected.match[0].length)
  const skills = requestedSkillIds(skillText)
  if (skills.length === 0) {
    if (selected.operation === 'add' && target === 'all'
      && /(?:[1-9]\d*|[一二两三四五六七八九十]+)\s*个?\s*技能/u.test(skillText)) return undefined
    throw new TeamRunError('expert skill change must name at least one available skill', 'TEAM_INVALID_ARGUMENT')
  }
  return { target, operation: selected.operation, skills }
}

function taskInstruction(value: string): string {
  const instruction = value
    .replace(/^\s*(?:需要|必须|应当|应|要|改为|调整为|修改为|must|should|needs?\s+to|requires?)\s*/iu, '')
    .trim()
  if (instruction === '') {
    throw new TeamRunError('task requirement must include one visible instruction', 'TEAM_INVALID_ARGUMENT')
  }
  return instruction
}

/** Parse exact one-based task references without guessing which workstream the user intended. */
function parseTaskInstructions(adjustment: string): NonNullable<TeamPlanRequirements['taskInstructions']> {
  const parsed: NonNullable<TeamPlanRequirements['taskInstructions']>[number][] = []
  const patterns = [
    new RegExp(
      String.raw`阶段\s*(${COUNT_TOKEN})\s*(?:内|的)?\s*(?:第\s*)?0*([1-9]\d*)\s*(?:号|个)?\s*任务\s*([^\n；;]+)`,
      'giu',
    ),
    /stage\s+([1-9]\d*)\s+(?:task\s+)?0*([1-9]\d*)\s+([^\n.;]+)/giu,
  ]
  for (const pattern of patterns) {
    for (const match of adjustment.matchAll(pattern)) {
      parsed.push({
        stageOrder: positiveInteger(match[1] ?? '', 'stage order'),
        taskOrder: positiveInteger(match[2] ?? '', 'task order'),
        instruction: taskInstruction(match[3] ?? ''),
      })
    }
  }
  return parsed.filter((value, index, values) =>
    values.findIndex(candidate => JSON.stringify(candidate) === JSON.stringify(value)) === index)
}

/** Parse structural requirements that must be proven by the generated plan. */
export function parseTeamPlanRequirements(objective: string): TeamPlanRequirements | undefined {
  const { adjustment } = collaborationObjectiveParts(objective)
  if (adjustment === '') return undefined

  let minimumSkillsPerExpert: number | undefined
  const expertSkills = adjustment
    .split(/(?:\r?\n|[;；])+/gu)
    .map(value => value.trim())
    .filter(Boolean)
    .flatMap((clause) => {
      const parsed = parseExpertSkillClause(clause)
      return parsed === undefined ? [] : [parsed]
    })
    .filter((value, index, values) => values.findIndex(candidate => JSON.stringify(candidate) === JSON.stringify(value)) === index)
  const skillPatterns = [
    new RegExp(
      String.raw`每(?:个|名)专家(?:\s*(?:agent|智能体))?\s*(?:需要|必须|应当|要)?\s*(?:至少|最少)?\s*(?:挂载|配置|绑定|拥有)\s*(?:至少|最少)?\s*(${COUNT_TOKEN})\s*个?\s*技能`,
      'giu',
    ),
    /each\s+expert(?:\s+agent)?\s+(?:must\s+|should\s+)?(?:mount|have|use|bind)\s+(?:at\s+least\s+)?([1-9]\d*)\s+skills?/giu,
  ]
  for (const pattern of skillPatterns) {
    for (const match of adjustment.matchAll(pattern)) {
      const count = positiveInteger(match[1] ?? '', 'minimum skills per expert')
      minimumSkillsPerExpert = Math.max(minimumSkillsPerExpert ?? 0, count)
    }
  }

  const stageModes = new Map<number, 'serial' | 'parallel'>()
  const stagePatterns = [
    new RegExp(
      String.raw`阶段\s*(${COUNT_TOKEN})[^。；;\n]{0,24}?(串行|并行)(?:任务|阶段)?`,
      'giu',
    ),
    /stage\s+([1-9]\d*)[^.;\n]{0,24}?\b(serial|parallel)\b/giu,
  ]
  for (const pattern of stagePatterns) {
    for (const match of adjustment.matchAll(pattern)) {
      const order = positiveInteger(match[1] ?? '', 'stage order')
      const token = (match[2] ?? '').toLowerCase()
      const mode = token === '串行' || token === 'serial' ? 'serial' : 'parallel'
      const previous = stageModes.get(order)
      if (previous !== undefined && previous !== mode) {
        throw new TeamRunError(`stage ${String(order)} cannot be both serial and parallel`, 'TEAM_INVALID_ARGUMENT')
      }
      stageModes.set(order, mode)
    }
  }

  const taskInstructions = parseTaskInstructions(adjustment)

  if (minimumSkillsPerExpert === undefined && expertSkills.length === 0
    && stageModes.size === 0 && taskInstructions.length === 0) return undefined
  return {
    ...minimumSkillsPerExpert === undefined ? {} : { minimumSkillsPerExpert },
    ...expertSkills.length === 0 ? {} : { expertSkills },
    ...stageModes.size === 0
      ? {}
      : {
        stageModes: [...stageModes.entries()]
          .sort(([left], [right]) => left - right)
          .map(([order, mode]) => ({ order, mode })),
      },
    ...taskInstructions.length === 0 ? {} : { taskInstructions },
  }
}
