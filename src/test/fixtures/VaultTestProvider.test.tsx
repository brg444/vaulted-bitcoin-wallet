import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useBitcoinPayment } from '../../vault/bitcoinPaymentContext'
import { useLedgerPayment } from '../../vault/ledgerPaymentContext'
import { useSpendingPayment } from '../../vault/spendingPaymentContext'
import { useSession } from '../../vault/sessionContext'
import {
  useVaultAccount,
  useVaultActivity,
  useVaultDisplay,
  useVaultInteraction,
  useVaultNavigation,
  useVaultRecovery,
  useVaultRenewals,
  useVaultSend,
} from '../../vault/appContexts'
import { VaultTestProvider, partitionVaultTestOverrides } from './VaultTestProvider'

type Snapshot = {
  session: ReturnType<typeof useSession>
  navigation: ReturnType<typeof useVaultNavigation>
  account: ReturnType<typeof useVaultAccount>
  send: ReturnType<typeof useVaultSend>
  activity: ReturnType<typeof useVaultActivity>
  recovery: ReturnType<typeof useVaultRecovery>
  interaction: ReturnType<typeof useVaultInteraction>
  display: ReturnType<typeof useVaultDisplay>
  renewal: ReturnType<typeof useVaultRenewals>
  ledger: ReturnType<typeof useLedgerPayment>
  bitcoin: ReturnType<typeof useBitcoinPayment>
  spending: ReturnType<typeof useSpendingPayment>
}

function Probe({ capture }: { capture: (snapshot: Snapshot) => void }) {
  capture({
    session: useSession(),
    navigation: useVaultNavigation(),
    account: useVaultAccount(),
    send: useVaultSend(),
    activity: useVaultActivity(),
    recovery: useVaultRecovery(),
    interaction: useVaultInteraction(),
    display: useVaultDisplay(),
    renewal: useVaultRenewals(),
    ledger: useLedgerPayment(),
    bitcoin: useBitcoinPayment(),
    spending: useSpendingPayment(),
  })
  return null
}

describe('VaultTestProvider override ownership', () => {
  it('places every override in its owning narrow context and never in another', () => {
    const slices = partitionVaultTestOverrides({
      balanceUnit: 'usd',
      account: 'savings',
      screen: 'home',
      error: 'boom',
    })
    expect(slices.display).toEqual({ balanceUnit: 'usd' })
    expect(slices.account).toEqual({ account: 'savings' })
    expect(slices.navigation).toEqual({ screen: 'home' })
    expect(slices.interaction).toEqual({ error: 'boom' })
    for (const name of ['session', 'send', 'activity', 'recovery', 'renewal']) expect(slices[name]).toEqual({})
  })

  it('rejects an override that belongs to no narrow application context', () => {
    expect(() => partitionVaultTestOverrides({ notAField: 1 } as never)).toThrow(
      /belongs to no narrow application context/,
    )
  })

  it('wires only the owning slice and keeps a shared error out of the payment contexts', () => {
    let snapshot: Snapshot | undefined
    render(
      <VaultTestProvider value={{ error: 'boom', balanceUnit: 'usd' }} ledgerPayment={{ error: 'ledger-error' }}>
        <Probe capture={(next) => (snapshot = next)} />
      </VaultTestProvider>,
    )
    const live = snapshot!
    expect(live.interaction.error).toBe('boom')
    expect(live.display.balanceUnit).toBe('usd')
    expect(live.ledger.error).toBe('ledger-error')
    expect(live.bitcoin.error).toBe('')
    expect(live.spending).not.toHaveProperty('error')
    expect('balanceUnit' in live.account).toBe(false)
    expect('error' in live.session).toBe(false)
  })
})
