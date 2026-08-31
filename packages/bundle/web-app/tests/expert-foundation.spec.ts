/** Shipped collaboration experts retain the complete standard daily-agent foundation. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('web collaboration expert foundation', () => {
  it('keeps every expert on the standard preset without narrowing its daily tool catalog', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(parsed)) throw new TypeError('web patch must parse to a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] => (
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : []
    ))
    const catalog = rows.find(row => row['id'] === 'expert-catalog')
    const blueprints = (catalog?.['config'] as { blueprints?: Array<{
      ref?: { id?: string }
      preset?: string
      plugins?: string[]
      tools?: { allow?: string[]; deny?: string[] }
    }> } | undefined)?.blueprints ?? []

    expect(blueprints).toHaveLength(24)
    for (const blueprint of blueprints) {
      expect(blueprint.preset).toBe('standard')
      expect(blueprint.tools).toEqual({ deny: [] })
    }
    const research = blueprints.filter(blueprint => blueprint.ref?.id?.startsWith('research-'))
    expect(research).toHaveLength(8)
    for (const blueprint of research) {
      expect(blueprint.plugins).toContain('@deepseek-ai/dsh-tool-web')
    }
  })
})
