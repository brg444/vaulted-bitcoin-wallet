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

  it('partitions the migrated activity fixture and rejects the legacy balance keys', () => {
    const accountReads = {
      spend: { loaded: true, refreshing: false, fresh: true, error: '' },
      savings: { loaded: true, refreshing: false, fresh: true, error: '' },
    }
    const slices = partitionVaultTestOverrides({
      allHistory: [],
      accountReads,
      openTx: () => {},
      navigate: () => {},
      loadOlderActivity: async () => ({ added: 0, exhausted: true }),
      olderActivity: { status: 'idle', error: '' },
    })
    expect(slices.activity).toMatchObject({ allHistory: [], openTx: expect.any(Function) })
    expect(slices.account).toEqual({ accountReads })
    expect(slices.navigation).toMatchObject({ navigate: expect.any(Function) })
    expect(() => partitionVaultTestOverrides({ balancesLoaded: true } as never)).toThrow(
      /belongs to no narrow application context/,
    )
    expect(() => partitionVaultTestOverrides({ refreshingBalance: false } as never)).toThrow(
      /belongs to no narrow application context/,
    )
  })
})
