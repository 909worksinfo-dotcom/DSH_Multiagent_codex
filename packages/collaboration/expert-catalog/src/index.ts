/** Immutable ExpertBlueprint registry with exact preset, skill, and plugin resolution. */

import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { TeamRunError } from '@deepseek-ai/dsh-agent-team'
import { isModelInvocable } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { digestJson, digestText } from './digest.ts'
import { ExpertBindingDigest } from './ids.ts'
import { presetPluginStates } from './plugin-rows.ts'
import type {
  Config,
  ExpertBlueprint,
  ExpertBlueprintRef,
  ResolveExpertBindingOptions,
  ResolvedExpertBinding,
  ResolvedSkillBinding,
} from './types.ts'
import { parseBlueprint } from './validation.ts'

export type * from './types.ts'
export { ExpertBindingDigest, ExpertBlueprintId } from './ids.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    expertCatalog: ExpertCatalog
  }
}

/** Build the immutable map key for one exact revision. */
function revisionKey(ref: ExpertBlueprintRef): string {
  return `${ref.id}@${String(ref.revision)}`
}

/** Recursively freeze a detached JSON-compatible configuration value. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

/** Turn unknown capability failures into the stable collaboration error. */
function unavailable(message: string, cause?: unknown): TeamRunError {
  return new TeamRunError(message, 'CAPABILITY_UNAVAILABLE', {
    retryable: false,
    ...cause === undefined ? {} : { cause },
  })
}

/** Locally configured immutable ExpertBlueprint catalog. */
export class ExpertCatalog extends Service {
  static inject = ['agentPresets', 'skills']

  /** Loader schema; exact nested validation runs before the service publishes. */
  static Config: schema<Config> = schema.object({
    blueprints: schema.array(schema.any()).default([]),
  })

  private readonly revisions = new Map<string, ExpertBlueprint>()

  /**
   * @param ctx - Cordis context carrying preset and skill registries.
   * @param config - complete local immutable blueprint revisions.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'expertCatalog')
    for (const candidate of config.blueprints ?? []) {
      let parsed: ExpertBlueprint
      try {
        parsed = deepFreeze(parseBlueprint(structuredClone(candidate)))
      } catch (cause: unknown) {
        throw new TeamRunError('ExpertBlueprint configuration is invalid', 'TEAM_INVALID_CONFIG', { cause })
      }
      const key = revisionKey(parsed.ref)
      if (this.revisions.has(key)) {
        throw new TeamRunError(`duplicate ExpertBlueprint revision "${key}"`, 'TEAM_INVALID_CONFIG')
      }
      this.revisions.set(key, parsed)
    }
  }

  /**
   * List configured immutable revisions in deployment order.
   * @returns detached blueprint references.
   */
  list(): ExpertBlueprintRef[] {
    return [...this.revisions.values()].map(value => structuredClone(value.ref))
  }

  /**
   * Read one exact configured revision without resolving external capabilities.
   * @param ref - exact immutable selector.
   * @returns a detached blueprint.
   * @throws `CAPABILITY_UNAVAILABLE` when the revision is not configured.
   */
  get(ref: ExpertBlueprintRef): ExpertBlueprint {
    const found = this.revisions.get(revisionKey(ref))
    if (found === undefined) throw unavailable(`ExpertBlueprint "${revisionKey(ref)}" is unavailable`)
    return structuredClone(found)
  }

  /**
   * Resolve one revision to the exact mountable preset, enabled plugin rows, and winning skill definitions.
   * @param ref - exact immutable selector.
   * @param options - cwd-sensitive lookup and caller cancellation.
   * @returns detached binding with a digest covering every resolved capability.
   * @throws `CAPABILITY_UNAVAILABLE` instead of omitting any missing or indeterminate capability.
   */
  async resolve(ref: ExpertBlueprintRef, options: ResolveExpertBindingOptions = {}): Promise<ResolvedExpertBinding> {
    const blueprint = this.get(ref)
    options.signal?.throwIfAborted()
    let presetContent: string
    try {
      const preset = await this.ctx.agentPresets.resolve(blueprint.preset)
      if (preset.broken !== undefined) throw new Error(preset.broken)
      presetContent = await this.ctx.agentPresets.read(preset.id)
    } catch (cause: unknown) {
      options.signal?.throwIfAborted()
      throw unavailable(`preset "${blueprint.preset}" for ExpertBlueprint "${revisionKey(ref)}" is unavailable`, cause)
    }
    options.signal?.throwIfAborted()

    let pluginStates: ReadonlyMap<string, 'enabled' | 'disabled' | 'dynamic'>
    try {
      pluginStates = presetPluginStates(presetContent)
    } catch (cause: unknown) {
      options.signal?.throwIfAborted()
      throw unavailable(`preset "${blueprint.preset}" plugin rows cannot be resolved`, cause)
    }
    for (const plugin of blueprint.plugins) {
      const state = pluginStates.get(plugin)
      if (state !== 'enabled') {
        throw unavailable(
          state === 'dynamic'
            ? `plugin "${plugin}" in preset "${blueprint.preset}" has dynamic enablement and cannot satisfy an immutable expert binding`
            : `enabled plugin "${plugin}" is unavailable in preset "${blueprint.preset}"`,
        )
      }
    }

    let scope
    try {
      scope = await this.ctx.agentPresets.standingKeyFor(blueprint.preset)
    } catch (cause: unknown) {
      options.signal?.throwIfAborted()
      throw unavailable(`preset "${blueprint.preset}" cannot be mounted`, cause)
    }
    const skills: ResolvedSkillBinding[] = []
    for (const name of blueprint.skills) {
      options.signal?.throwIfAborted()
      let skill
      try {
        skill = await this.ctx.skills.get(name, { scope, cwd: options.cwd, signal: options.signal })
      } catch (cause: unknown) {
        options.signal?.throwIfAborted()
        throw unavailable(`skill "${name}" for ExpertBlueprint "${revisionKey(ref)}" cannot be resolved`, cause)
      }
      if (skill === undefined || !isModelInvocable(skill)) {
        throw unavailable(`model-invocable skill "${name}" is unavailable in preset "${blueprint.preset}"`)
      }
      const contentDigest = digestJson({
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse ?? null,
        invocation: skill.invocation,
        source: skill.source,
        provider: skill.provider,
        resourceBase: skill.resourceBase ?? null,
        path: skill.path ?? null,
        metadata: skill.metadata ?? null,
        content: skill.content,
      })
      skills.push({
        name,
        provider: skill.provider,
        source: skill.source,
        contentDigest,
        ...skill.path === undefined ? {} : { path: skill.path },
      })
    }

    const blueprintDigest = digestJson(blueprint)
    const preset = { id: blueprint.preset, contentDigest: digestText(presetContent) }
    const bindingPayload = {
      version: 1,
      blueprint,
      blueprintDigest,
      preset,
      skills,
      plugins: blueprint.plugins,
    }
    return deepFreeze({
      ...structuredClone(bindingPayload),
      digest: ExpertBindingDigest(digestJson(bindingPayload)),
    })
  }
}

export default ExpertCatalog
