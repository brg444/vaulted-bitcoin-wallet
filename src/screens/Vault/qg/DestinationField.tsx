import type { InputHTMLAttributes, ReactNode } from 'react'
import { ScanLine } from 'lucide-react'

type Props = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  onScan: () => void
  scanLabel?: string
  hint?: ReactNode
}

export default function DestinationField({ label, onScan, scanLabel = 'Scan destination', hint, ...input }: Props) {
  return (
    <label className='qg-dest-field'>
      <span>{label}</span>
      <div>
        <input
          aria-label={label}
          autoComplete='off'
          autoCapitalize='none'
          autoCorrect='off'
          spellCheck={false}
          enterKeyHint='done'
          {...input}
        />
        <button type='button' aria-label={scanLabel} onClick={onScan}>
          <ScanLine />
        </button>
      </div>
      {hint ? <small>{hint}</small> : null}
    </label>
  )
}
