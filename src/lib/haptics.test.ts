import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { trigger, WebHaptics } = vi.hoisted(() => {
  const trigger = vi.fn().mockResolvedValue(undefined)
  const WebHaptics = vi.fn(function MockWebHaptics() {
    return { trigger }
  })
  return { trigger, WebHaptics }
})

vi.mock('web-haptics', () => ({ WebHaptics }))

import { bootHaptics, hapticLight, hapticSubtle, hapticTap, setHapticsEnabled } from './haptics'

describe('vault haptics', () => {
  beforeEach(() => {
    trigger.mockReset().mockResolvedValue(undefined)
    WebHaptics.mockClear()
    setHapticsEnabled(true)
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the same selection and light presets as Arkade Wallet', () => {
    bootHaptics()
    hapticSubtle()
    hapticTap()
    hapticLight()

    expect(trigger).toHaveBeenNthCalledWith(1, 'selection')
    expect(trigger).toHaveBeenNthCalledWith(2, 'selection')
    expect(trigger).toHaveBeenNthCalledWith(3, 'light')
  })

  it('stays quiet when haptics are off', () => {
    setHapticsEnabled(false)
    hapticLight()

    expect(trigger).not.toHaveBeenCalled()
  })

  it('keeps explicitly enabled haptics available with reduced motion', () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList)
    hapticLight()

    expect(trigger).toHaveBeenCalledWith('light')
  })
})
