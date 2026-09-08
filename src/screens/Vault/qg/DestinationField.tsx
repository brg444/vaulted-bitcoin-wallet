import { useId, type InputHTMLAttributes, type ReactNode } from 'react'
import { ScanLine } from 'lucide-react'

type Props = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  onScan: () => void
  scanLabel?: string
  hint?: ReactNode
}

export default function DestinationField({ label, onScan, scanLabel = 'Scan destination', hint, ...input }: Props) {
  const hintId = useId()
  const description = [input['aria-describedby'], hint ? hintId : null].filter(Boolean).join(' ') || undefined
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
          aria-describedby={description}
        />
        <button type='button' aria-label={scanLabel} disabled={input.disabled} onClick={onScan}>
          <ScanLine aria-hidden='true' />
        </button>
      </div>
      {hint ? <small id={hintId}>{hint}</small> : null}
    </label>
  )
}
