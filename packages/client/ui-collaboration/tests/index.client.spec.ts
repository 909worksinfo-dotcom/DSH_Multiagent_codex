import { describe, expect, it } from 'vitest'
import { inject } from '../src/client/index.ts'

describe('collaboration client composition', () => {
  it('declares every service read by the collaboration dock injection', () => {
    expect(inject).toEqual(expect.arrayContaining([
      'collaboration', 'layout', 'slots', 'locale', 'sessions',
    ]))
  })
})
