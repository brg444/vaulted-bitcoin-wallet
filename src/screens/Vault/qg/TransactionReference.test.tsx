import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TransactionReference from './TransactionReference'

afterEach(() => vi.unstubAllGlobals())

describe('Transaction reference', () => {
  it('copies the full transaction ID', async () => {
    const txid = 'ab'.repeat(32)
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<TransactionReference txid={txid} explorer={null} />)
    expect(screen.getByText('ab'.repeat(32))).not.toBeVisible()
    fireEvent.click(screen.getByText('View transaction'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy transaction ID' }))
    await waitFor(() => expect(screen.getByText('Copied')).toBeVisible())
    expect(writeText).toHaveBeenCalledExactlyOnceWith(txid)
  })

  it('keeps the full ID selectable when clipboard access is unavailable', async () => {
    vi.stubGlobal('navigator', {})
    render(<TransactionReference txid={'ab'.repeat(32)} explorer={null} />)
    expect(screen.getByText('ab'.repeat(32))).not.toBeVisible()
    fireEvent.click(screen.getByText('View transaction'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy transaction ID' }))
    await screen.findByRole('status')
    expect(screen.queryByText('Copied')).toBeNull()
    expect(screen.getByText('ab'.repeat(32))).toBeVisible()
  })

  it('omits an unavailable transaction ID', () => {
    render(<TransactionReference txid='' explorer={null} />)
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
