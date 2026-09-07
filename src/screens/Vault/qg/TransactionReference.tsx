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
  const [copied, setCopied] = useState('')
  const [copyFailed, setCopyFailed] = useState(false)
  const id = txid.trim()
  if (!id) return null
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(id)
      setCopyFailed(false)
    } catch {
      setCopyFailed(true)
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
          {copied === id ? <Check aria-hidden='true' /> : <Copy aria-hidden='true' />}
          {copied === id ? 'Copied' : 'Copy ID'}
        </button>
        {explorer ? (
          <a href={explorer.url} target='_blank' rel='noopener noreferrer'>
            {explorer.label}
            <ExternalLink aria-hidden='true' />
          </a>
        ) : null}
      </div>
      {copyFailed ? <p role='status'>Select the transaction ID above to copy it.</p> : null}
    </details>
  )
}
