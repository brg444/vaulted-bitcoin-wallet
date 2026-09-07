import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/Toast'
import { VaultContext, type VaultContextProps } from '../../vault/context'
import VaultHandoff from './Handoff'

const readPsbtFile = vi.hoisted(() => vi.fn())
const copyToClipboard = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../../lib/clipboard', () => ({ copyToClipboard }))

vi.mock('../../lib/vault/savingsSpend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/vault/savingsSpend')>()),
  readPsbtFile,
}))

function renderHandoff(network: 'mutinynet' | 'mainnet' = 'mutinynet') {
  const completeSavingsHandoff = vi.fn(async () => {})
  const cancelSavingsHandoff = vi.fn()
  render(
    <ToastProvider>
      <VaultContext.Provider
        value={
          {
            busy: false,
            cancelSavingsHandoff,
            completeSavingsHandoff,
            error: '',
            handoffPsbt: '00',
            navigate: vi.fn(),
            spend: { address: 'tb1pdestination', amount: 50_000, fee: 1_500 },
            status: { network },
          } as unknown as VaultContextProps
        }
      >
        <VaultHandoff />
      </VaultContext.Provider>
    </ToastProvider>,
  )
  return { cancelSavingsHandoff, completeSavingsHandoff }
}

describe('Savings hardware handoff', () => {
  it('copies the phone-signed PSBT while keeping signed-file upload available', async () => {
    renderHandoff()

    fireEvent.click(screen.getByRole('button', { name: 'Copy PSBT' }))

    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith('AA=='))
    fireEvent.click(screen.getByRole('button', { name: 'I’ve signed it' }))
    expect(screen.getByRole('button', { name: /Upload file/ })).toBeTruthy()
  })

  it('uploads a signed PSBT file and broadcasts that payload', async () => {
    readPsbtFile.mockResolvedValueOnce('hardware-signed-psbt')
    const { completeSavingsHandoff } = renderHandoff()
    const file = new File([new Uint8Array([1, 2, 3])], 'hardware-signed.psbt', {
      type: 'application/octet-stream',
    })

    fireEvent.click(screen.getByRole('button', { name: 'I’ve signed it' }))
    fireEvent.change(screen.getByTestId('savings-signed-psbt-file'), { target: { files: [file] } })
    expect(await screen.findByText('hardware-signed.psbt is ready to check.')).toBeTruthy()
    expect(screen.getByText('Transaction received')).toBeTruthy()
    expect(screen.queryByText('Hardware signature verified')).toBeNull()
    expect(completeSavingsHandoff).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Check and send transaction' }))

    await waitFor(() => expect(completeSavingsHandoff).toHaveBeenCalledExactlyOnceWith('hardware-signed-psbt'))
  })

  it('shares raw PSBT bytes instead of base64 text in the .psbt file', async () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
    renderHandoff()

    fireEvent.click(screen.getByRole('button', { name: 'Share PSBT' }))
    await waitFor(() => expect(share).toHaveBeenCalledOnce())
    const file = share.mock.calls[0]![0].files![0]!
    expect(file.name).toBe('Savings transfer.psbt')
    expect(file.size).toBe(1)
  })

  it('accepts a pasted hardware-signed PSBT alongside file upload', async () => {
    const { completeSavingsHandoff } = renderHandoff()

    fireEvent.click(screen.getByRole('button', { name: 'I’ve signed it' }))
    fireEvent.click(screen.getByRole('button', { name: /Paste/ }))
    fireEvent.change(screen.getByTestId('savings-signed-psbt-paste'), {
      target: { value: 'hardware-signed-psbt-base64' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Use this PSBT' }))
    expect(screen.getByText('Transaction received')).toBeTruthy()
    expect(screen.queryByText('Hardware signature verified')).toBeNull()
    expect(completeSavingsHandoff).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Check and send transaction' }))

    await waitFor(() => expect(completeSavingsHandoff).toHaveBeenCalledExactlyOnceWith('hardware-signed-psbt-base64'))
  })

  it('labels a mainnet handoff as Bitcoin', () => {
    renderHandoff('mainnet')
    fireEvent.click(screen.getByRole('button', { name: 'I’ve signed it' }))
    fireEvent.click(screen.getByRole('button', { name: /Paste/ }))
    fireEvent.change(screen.getByTestId('savings-signed-psbt-paste'), {
      target: { value: 'hardware-signed-psbt-base64' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Use this PSBT' }))
    expect(screen.getByText('Bitcoin')).toBeTruthy()
    expect(screen.queryByText('Mutinynet')).toBeNull()
  })

  it('can delete the locally pending transfer', () => {
    const { cancelSavingsHandoff } = renderHandoff()
    fireEvent.click(screen.getByRole('button', { name: 'Delete pending transfer' }))
    expect(cancelSavingsHandoff).toHaveBeenCalledOnce()
  })
})
