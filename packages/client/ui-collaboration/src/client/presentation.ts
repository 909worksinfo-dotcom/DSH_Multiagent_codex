import { collaborationCopy as copy } from './language.ts'
import type {
  CollaborationArtifactStatus, CollaborationLanguage, CollaborationQualityGateStatus,
  CollaborationRunSnapshot, CollaborationTimelineEvent,
} from './types.ts'

const ARTIFACT_RECEIPT = /^Artifact "(.+)" is (draft|review|accepted|superseded) at version (\d+)\.$/u
const QUALITY_RECEIPT = /^Quality gate "(.+)" (pending|passed|failed): ([\s\S]+)$/u
const ZH_METADATA = new Map<string, string>([
  ['collaboration-research-analysis', '深度研究与证据分析'],
  ['collaboration-product-solution', '产品方案设计'],
  ['collaboration-software-development', '软件开发与验证'],
  ['collaboration-peer-review', '协作质疑与同行评审'],
  ['Lead Agent', '总协调、裁决与最终验收'],
  ['Complete and review the stated objective', '完成并评审用户提出的任务目标'],
  ['Claims are traceable to evidence', '关键结论可追溯到证据'],
  ['Uncertainty and contradictions are explicit', '明确标注不确定性与矛盾'],
  ['Every proposal maps to a user problem', '每项方案均对应具体用户问题'],
  ['Failure and acceptance states are testable', '失败状态与验收状态均可测试'],
  ['The requested behavior is verified', '已验证用户要求的行为'],
  ['Failure and boundary behavior are covered', '已覆盖失败与边界行为'],
  ['Evidence Researcher', '证据研究专家'],
  ['Market Analyst', '市场分析专家'],
  ['Competitive Intelligence Analyst', '竞品情报专家'],
  ['Policy and Regulatory Analyst', '政策与监管专家'],
  ['Data Analyst', '数据分析专家'],
  ['Technical Analyst', '技术分析专家'],
  ['Research Risk Reviewer', '调研风险评审专家'],
  ['Synthesis Reviewer', '综合评审专家'],
  ['Product Solution Analyst', '产品方案专家'],
  ['User Researcher', '用户研究专家'],
  ['Product Strategist', '产品策略专家'],
  ['Interaction Designer', '交互设计专家'],
  ['Workflow Architect', '工作流架构专家'],
  ['Metrics Designer', '指标设计专家'],
  ['Technical Feasibility Reviewer', '技术可行性评审专家'],
  ['Risk and Acceptance Reviewer', '风险与验收专家'],
  ['Implementation Engineer', '实现工程师'],
  ['Test Engineer', '测试工程师'],
  ['System Architect', '系统架构师'],
  ['Security Reviewer', '安全评审专家'],
  ['Performance Engineer', '性能工程师'],
  ['Reliability Engineer', '可靠性工程师'],
  ['Frontend and Accessibility Reviewer', '前端与无障碍评审专家'],
  ['Code Quality Reviewer', '代码质量评审专家'],
  ['Research', '调研'],
  ['Analyze', '分析'],
  ['Design', '设计'],
  ['Plan', '规划'],
  ['Implement', '实现'],
  ['Test', '测试'],
  ['Review', '评审'],
  ['Deploy', '部署'],
])

const EN_METADATA = new Map<string, string>([
  ['collaboration-research-analysis', 'Deep research and evidence analysis'],
  ['collaboration-product-solution', 'Product solution design'],
  ['collaboration-software-development', 'Software development and verification'],
  ['collaboration-peer-review', 'Collaborative challenge and peer review'],
])

/** Localize stable runtime participant identifiers without mutating durable identities. */
export function collaborationParticipantName(
  name: string,
  role: 'lead' | 'expert',
  language: CollaborationLanguage,
  expertRole?: string,
): string {
  if (role === 'lead' || /^(?:lead|lead agent)$/iu.test(name)) {
    return language === 'zh' ? '主协调智能体' : 'Lead'
  }
  if (!/^expert(?:[-_ ].*)?$/iu.test(name)) {
    return collaborationDisplayText(name, language)
  }
  const assignedRole = expertRole?.trim()
  if (assignedRole !== undefined && assignedRole !== '') {
    return collaborationDisplayText(assignedRole, language)
  }
  return language === 'zh' ? '协作专家' : 'Collaborating expert'
}

/** Resolve one public participant name from the authoritative run roster. */
export function collaborationRunParticipantName(
  run: CollaborationRunSnapshot,
  name: string,
  role: 'lead' | 'expert',
  language: CollaborationLanguage = run.language,
): string {
  const assignedRole = role === 'expert'
    ? run.experts.find(expert => expert.name === name)?.role
    : undefined
  return collaborationParticipantName(name, role, language, assignedRole)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** Replace leaked stable identifiers in public prose without mutating durable events. */
function publicParticipantReferences(
  content: string,
  run: CollaborationRunSnapshot,
  language: CollaborationLanguage,
): string {
  const replacements = [
    { source: run.lead.name, target: collaborationRunParticipantName(run, run.lead.name, 'lead', language) },
    ...run.experts.flatMap((expert) => {
      const target = collaborationRunParticipantName(run, expert.name, 'expert', language)
      const ordinal = /^expert[-_ ]?(\d+)/iu.exec(expert.name)?.[1]
      return [
        { source: expert.name, target },
        ...(ordinal === undefined ? [] : [
          { source: `专家${ordinal}`, target },
          { source: `Expert ${ordinal}`, target },
        ]),
      ]
    }),
  ].filter(value => value.source !== value.target)
    .sort((left, right) => right.source.length - left.source.length)

  return replacements.reduce((text, { source, target }) => {
    const pattern = new RegExp(`(^|[^a-z0-9-])${escapeRegExp(source)}(?=$|[^a-z0-9-])`, 'giu')
    return text.replace(pattern, (_match, prefix: string) => `${prefix}${target}`)
  }, content)
}

/** Localize safe built-in metadata while preserving user-authored text. */
export function collaborationDisplayText(text: string, language: CollaborationLanguage): string {
  if (language !== 'zh') return EN_METADATA.get(text) ?? text
  const direct = ZH_METADATA.get(text)
  if (direct !== undefined) return direct
  const objectivePart = /^Objective part (\d+)$/u.exec(text)
  return objectivePart === null ? text : `目标分段 ${objectivePart[1] ?? ''}`
}

/**
 * Localize deterministic runtime receipts without rewriting agent-authored prose.
 * The durable event remains untouched; only known machine templates are projected.
 */
export function collaborationEventContent(
  event: CollaborationTimelineEvent,
  language: CollaborationLanguage,
): string {
  const artifact = ARTIFACT_RECEIPT.exec(event.content)
  if (event.kind === 'artifact' && artifact !== null) {
    const [, title = '', status = 'draft', version = '1'] = artifact
    return copy(language, 'timeline.receipt.artifact', {
      title,
      status: copy(language, `artifact.status.${status as CollaborationArtifactStatus}`),
      version,
    })
  }

  const quality = QUALITY_RECEIPT.exec(event.content)
  if (event.kind === 'review' && quality !== null) {
    const [, name = '', status = 'pending', summary = ''] = quality
    return copy(language, 'timeline.receipt.quality', {
      name: collaborationDisplayText(name, language),
      status: copy(language, `quality.status.${status as CollaborationQualityGateStatus}`),
      summary,
    })
  }

  return event.content
}

/** Localize a public event and deterministically hide internal participant identifiers. */
export function collaborationRunEventContent(
  event: CollaborationTimelineEvent,
  run: CollaborationRunSnapshot,
  language: CollaborationLanguage = run.language,
): string {
  return publicParticipantReferences(collaborationEventContent(event, language), run, language)
}
