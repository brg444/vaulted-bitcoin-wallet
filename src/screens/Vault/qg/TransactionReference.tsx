import { useState } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import type { VaultTransactionExplorer } from '../../../lib/vault/explorer'
import './transaction-reference.css'

export default function TransactionReference({
  txid,
  explorer,
  funding = false,
}: {
  txid: string
  explorer: VaultTransactionExplorer | null
  funding?: boolean
}) {
  const [copyResult, setCopyResult] = useState<{ id: string; success: boolean } | null>(null)
  const id = txid.trim()
  const copied = copyResult?.id === id && copyResult.success
  const copyFailed = copyResult?.id === id && !copyResult.success
  if (!id) return null
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id)
      setCopyResult({ id, success: true })
    } catch {
      setCopyResult({ id, success: false })
    }
  }
  return (
    <details
      className='qg-transaction-reference qg-guidance'
      aria-label={funding ? 'Funding transaction' : 'Transaction reference'}
    >
      <summary>{funding ? 'View funding transaction' : 'View transaction'}</summary>
      <span>{funding ? 'Funding transaction ID' : 'Transaction ID'}</span>
      <code>{id}</code>
      <div className='qg-transaction-reference-actions'>
        <button type='button' onClick={() => void copy()} aria-label='Copy transaction ID'>
          {copied ? <Check aria-hidden='true' /> : <Copy aria-hidden='true' />}
          {copied ? 'Copied' : 'Copy ID'}
        </button>
        {explorer ? (
          <a href={explorer.url} target='_blank' rel='noopener noreferrer'>
            {explorer.label}
            <ExternalLink aria-hidden='true' />
          </a>
        ) : null}
      </div>
      <p role='status' className={copyFailed ? undefined : 'qg-visually-hidden'}>
        {copyFailed ? 'Select the transaction ID above to copy it.' : copied ? 'Transaction ID copied.' : ''}
      </p>
    </details>
  )
}
