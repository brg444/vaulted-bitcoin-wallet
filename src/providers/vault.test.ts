import { describe, expect, it } from 'vitest'
import { vaultDraftFee } from './vault'

describe('vault send draft fees', () => {
  it('keeps the Savings fallback out of an Arkade Spending draft', () => {
    expect(vaultDraftFee('spend', true)).toBe(0)
    expect(vaultDraftFee('savings', true)).toBe(1_500)
  })
})
