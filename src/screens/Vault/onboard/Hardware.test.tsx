import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultContext, type VaultContextProps } from '../../../vault/context'
import { emptySetupPlan } from '../../../lib/vault/setupPlan'
import { CONNECTOR_TEST_DESCRIPTOR } from '../../../test/e2e-vault/fixtures/connector'
import Hardware from './Hardware'

const scanner = vi.hoisted(() => ({
  current: null as null | {
    onData: (data: string) => void | boolean
    close: () => void
    onError: (error: string) => void
  },
}))
vi.mock('../Scanner', () => ({
  default: (props: NonNullable<typeof scanner.current>) => {
    scanner.current = props
    return <h1>Descriptor camera</h1>
  },
}))
function mount() {
  const applyConnectorDescriptor = vi.fn()
  render(
    <VaultContext.Provider
      value={{ setup: emptySetupPlan(), liveNetwork: true, applyConnectorDescriptor } as unknown as VaultContextProps}
    >
      <Hardware />
    </VaultContext.Provider>,
  )
  return applyConnectorDescriptor
}
beforeEach(() => {
  vi.clearAllMocks()
  scanner.current = null
})
describe('hardware descriptor entry', () => {
  it('shows the field only after Paste is selected', () => {
    mount()
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('imports a QR for review and preserves the draft when camera entry is cancelled', async () => {
    const apply = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Scan descriptor QR code' }))
    await screen.findByText('Descriptor camera')
    act(() => {
      scanner.current!.onData(CONNECTOR_TEST_DESCRIPTOR)
    })
    expect(screen.getByText(CONNECTOR_TEST_DESCRIPTOR)).toBeInTheDocument()
    expect(apply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Scan descriptor QR code' }))
    await screen.findByText('Descriptor camera')
    act(() => scanner.current!.close())
    expect(screen.getByText(CONNECTOR_TEST_DESCRIPTOR)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use this hardware key' }))
    expect(apply).toHaveBeenCalledExactlyOnceWith(CONNECTOR_TEST_DESCRIPTOR)
  })
  it('uploads a descriptor without submitting it and retains the draft on invalid imports', async () => {
    const apply = mount()
    const file = new File([], 'descriptor.txt')
    Object.defineProperty(file, 'text', { value: async () => CONNECTOR_TEST_DESCRIPTOR })
    fireEvent.change(screen.getByLabelText('Descriptor file'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByText(CONNECTOR_TEST_DESCRIPTOR)).toBeInTheDocument())
    expect(apply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Scan descriptor QR code' }))
    await screen.findByText('Descriptor camera')
    act(() => {
      scanner.current!.onData('not a descriptor')
    })
    expect(screen.getByText(CONNECTOR_TEST_DESCRIPTOR)).toBeInTheDocument()
    expect(screen.getByText(/This QR code could not be imported/)).toBeVisible()
  })
})
