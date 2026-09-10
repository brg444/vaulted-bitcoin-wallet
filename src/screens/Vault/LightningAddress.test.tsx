import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultStatus } from '../../lib/vault/types'
import { Fiats } from '../../lib/types'
import { configureLightningAddress, loadLightningAddress } from '../../lib/vault/lnurl'
import { copyToClipboard } from '../../lib/clipboard'
import LightningAddress from './LightningAddress'

const fixture = vi.hoisted(() => ({ unit: 'sats' as 'sats' | 'usd' }))
vi.mock('../../lib/vault/useDisplayUnit', () => ({
  useDisplayUnit: () => ({ unit: fixture.unit, rate: { currency: Fiats.USD, pricePerBtc: 100_000 } }),
}))
vi.mock('../../lib/vault/lnurl', () => ({
  loadLightningAddress: vi.fn(),
  configureLightningAddress: vi.fn(),
  lightningNameAvailable: vi.fn(async () => true),
  validLightningName: (name: string) => /^[a-z][a-z0-9_-]{2,31}$/.test(name),
}))
vi.mock('../../lib/clipboard', () => ({ copyToClipboard: vi.fn(async () => {}) }))
vi.mock('../../components/QrCode', () => ({ default: ({ value }: { value: string }) => <output>{value}</output> }))

const status = { vaultId: 'one', network: 'mainnet' } as VaultStatus
const address = {
  name: 'alex',
  id: 'v1212121212121212',
  address: 'alex@ln.getvaulted.xyz',
  lnurl: 'LNURL-FIXTURE',
  active: true,
  maxFeeSats: 25,
} as ReturnType<typeof loadLightningAddress>

beforeEach(() => {
  vi.mocked(loadLightningAddress).mockReturnValue(address)
  vi.mocked(configureLightningAddress).mockResolvedValue(address!)
  fixture.unit = 'sats'
})
afterEach(() => {
  vi.clearAllMocks()
  Reflect.deleteProperty(navigator, 'share')
  Reflect.deleteProperty(navigator, 'canShare')
})

describe('primary Lightning address', () => {
  it('shows the active address immediately and copies the exact address', async () => {
    const user = userEvent.setup()
    render(<LightningAddress status={status} primary />)
    expect(screen.getByText('alex@ln.getvaulted.xyz')).toBeVisible()
    expect(screen.queryByText(/Receive while Vaulted is closed/)).toBeNull()
    expect(screen.queryByText(/per payment/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Copy address' }))
    expect(copyToClipboard).toHaveBeenCalledWith('alex@ln.getvaulted.xyz')
    await user.click(screen.getByText('Address options'))
    expect(screen.getByText('LNURL-FIXTURE')).toBeVisible()
  })

  it('shares the Lightning address and ignores a cancelled share', async () => {
    const user = userEvent.setup()
    const share = vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError'))
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    render(<LightningAddress status={status} primary />)
    await user.click(screen.getByText('Address options'))
    await user.click(screen.getByRole('button', { name: 'Share Lightning address' }))
    expect(share).toHaveBeenCalledWith({ title: 'Vaulted Lightning address', text: 'alex@ln.getvaulted.xyz' })
    expect(copyToClipboard).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('copies the address when native sharing is unavailable', async () => {
    const user = userEvent.setup()
    render(<LightningAddress status={status} primary />)
    await user.click(screen.getByText('Address options'))
    await user.click(screen.getByRole('button', { name: 'Share Lightning address' }))
    expect(copyToClipboard).toHaveBeenCalledWith('alex@ln.getvaulted.xyz')
  })

  it('shows setup for an unconfigured address and updates primary Receive after registration', async () => {
    vi.mocked(loadLightningAddress).mockReturnValue(undefined)
    const user = userEvent.setup()
    render(<LightningAddress status={status} primary />)
    await user.click(screen.getByText('Set up Lightning address', { selector: 'summary' }))
    await user.type(screen.getByLabelText('Address name'), 'alex')
    await user.click(screen.getByRole('button', { name: 'Set up Lightning address' }))
    expect(configureLightningAddress).toHaveBeenCalledWith(status, 'register', 'alex')
    expect(screen.getByText('alex@ln.getvaulted.xyz')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Copy address' })).toBeVisible()
  })

  it('retains an existing address when editing fails and returns to setup after revocation', async () => {
    const user = userEvent.setup()
    render(<LightningAddress status={status} primary />)
    await user.click(screen.getByText('Address options'))
    await user.click(screen.getByRole('button', { name: 'Edit address' }))
    await user.clear(screen.getByLabelText('Address name'))
    await user.type(screen.getByLabelText('Address name'), 'newname')
    vi.mocked(configureLightningAddress).mockRejectedValueOnce(new Error('Service unavailable'))
    await user.click(screen.getByRole('button', { name: 'Save address' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Service unavailable')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('alex@ln.getvaulted.xyz')).toBeVisible()
    vi.mocked(configureLightningAddress).mockResolvedValueOnce({ ...address!, active: false })
    await user.click(screen.getByText('Address options'))
    await user.click(screen.getByRole('button', { name: 'Disable address' }))
    expect(screen.queryByRole('button', { name: 'Copy address' })).toBeNull()
    expect(screen.getByText('Set up Lightning address', { selector: 'summary' })).toBeVisible()
  })

  it('reloads the address for a different wallet instead of showing the previous address', () => {
    const { rerender } = render(<LightningAddress status={status} primary />)
    vi.mocked(loadLightningAddress).mockReturnValue(undefined)
    rerender(<LightningAddress status={{ ...status, vaultId: 'two' }} primary />)
    expect(screen.queryByText('alex@ln.getvaulted.xyz')).toBeNull()
    expect(screen.getByText('Set up Lightning address', { selector: 'summary' })).toBeVisible()
  })

  it('denominates the receive fee in address settings using the selected wallet unit', async () => {
    fixture.unit = 'usd'
    vi.mocked(loadLightningAddress).mockReturnValue({ ...address!, maxFeeSats: 1_000 })
    render(<LightningAddress status={status} />)
    await userEvent.click(screen.getByText('Lightning address', { selector: 'summary' }))
    expect(screen.getByText(/up to \$1.00 per payment/)).toBeVisible()
  })
})
