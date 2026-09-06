import { useContext, useState } from 'react'
import { prettyNumber } from '../../../lib/format'
import { fingerprint } from '../../../lib/vault/hex'
import { VaultContext } from '../../../vault/context'
import RecoveryExplanation from '../qg/RecoveryExplanation'
import QgScreen, { QgPrimary } from '../qg/QgScreen'

function shortPub(pub: string) {
  return pub ? fingerprint(pub, 2) : 'Not enrolled'
}

export default function VaultPlan() {
  const { finishPlan, navigate, networkLabel, setup } = useContext(VaultContext)
  const [consented, setConsented] = useState(false)
  const advanced = setup.protectionTier === 'advanced'

  return (
    <QgScreen
      title='Review'
      stepLabel='5 of 6'
      back={() => navigate('conditions')}
      footer={<QgPrimary onClick={finishPlan} disabled={!consented} label='Continue' />}
    >
      <p className='qg-eyebrow'>Your setup</p>
      <h1>Review your Vault</h1>
      {setup.connector ? (
        <section className='qg-note'>
          <div>
            <strong>Signer reserve · 1,000 sats</strong>
            <p style={{ overflowWrap: 'anywhere' }} data-testid='plan-connector-address'>
              {setup.connector.address}
            </p>
            <p>Compare this address with your signing wallet. Savings deposits use a separate address after setup.</p>
          </div>
        </section>
      ) : null}
      <section className='qg-summary'>
        <div>
          <span>Network</span>
          <strong>{networkLabel}</strong>
        </div>
        <div>
          <span>Protection</span>
          <strong>{advanced ? 'Advanced' : 'Standard'}</strong>
        </div>
        <div>
          <span>Hardware key</span>
          <strong>{shortPub(setup.hardwarePub)}</strong>
        </div>
        <div>
          <span>Recovery key</span>
          <strong>{advanced ? shortPub(setup.recoveryPub) : 'Not enrolled'}</strong>
        </div>
        <div>
          <span>Per payment</span>
          <strong>{prettyNumber(setup.txCapSats, 0)} sats</strong>
        </div>
        <div>
          <span>Rolling 24 hours</span>
          <strong>{prettyNumber(setup.dailyLimitSats, 0)} sats</strong>
        </div>
        <div>
          <span>Savings</span>
          <strong>Passkey and hardware wallet</strong>
        </div>
        <div>
          <span>Recovery</span>
          <strong>{advanced ? 'Separate recovery key' : 'One remaining normal key'}</strong>
        </div>
        <div>
          <span>Spending</span>
          <strong>Limits enforced</strong>
        </div>
      </section>
      <p className='qg-copy'>
        The short hardware and recovery codes identify the keys you chose. Check them against your saved public keys.
      </p>
      <RecoveryExplanation advanced={advanced} mainnet={networkLabel === 'Bitcoin'} />
      <label className='qg-consent'>
        <input type='checkbox' checked={consented} onChange={(event) => setConsented(event.target.checked)} />
        <span>I understand that this protection choice and these Spending limits cannot be changed after setup.</span>
      </label>
    </QgScreen>
  )
}
