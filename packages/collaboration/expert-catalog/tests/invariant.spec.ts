import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as ExpertCatalogInvariant from '../src/invariant.ts'

describe('ExpertCatalog invariant companion', () => {
  it('registers and disposes its package reservation', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService)
    const fiber = ctx.plugin(ExpertCatalogInvariant)
    await expect(fiber).resolves.toBeDefined()
    await expect(fiber.dispose()).resolves.toBeUndefined()
  })
})
