import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import DestinationField from './DestinationField'

it('associates its hint and caller description with the input', () => {
  render(
    <>
      <p id='network'>Mutinynet only.</p>
      <DestinationField label='Address' hint='Paste a payment address.' aria-describedby='network' onScan={vi.fn()} />
    </>,
  )
  expect(screen.getByRole('textbox')).toHaveAccessibleDescription('Mutinynet only. Paste a payment address.')
})

it('keeps the scanner disabled with the destination and restores it when editing resumes', () => {
  const scan = vi.fn()
  const { rerender } = render(<DestinationField label='Address' onScan={scan} disabled />)
  fireEvent.click(screen.getByRole('button', { name: 'Scan destination' }))
  expect(scan).not.toHaveBeenCalled()
  rerender(<DestinationField label='Address' onScan={scan} />)
  fireEvent.click(screen.getByRole('button', { name: 'Scan destination' }))
  expect(scan).toHaveBeenCalledOnce()
})
