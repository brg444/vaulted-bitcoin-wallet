import { useContext, useState } from 'react'
import { prettyNumber } from '../../../lib/format'
import { fingerprint } from '../../../lib/vault/hex'
import { VaultContext } from '../../../vault/context'
import QgScreen, { QgPrimary } from '../qg/QgScreen'

function shortPub(pub: string) {
  return pub ? fingerprint(pub, 2) : 'Not enrolled'
}

export default function VaultPlan() {
  const { finishPlan, navigate, networkLabel, setup } = useContext(VaultContext)
  const [consented, setConsented] = useState(false)
  const light = setup.protectionTier === 'light'
  const advanced = setup.protectionTier === 'advanced'

  return (
    <QgScreen
      title='Review'
      stepLabel='5 of 6'
      back={() => navigate('conditions')}
      footer={<QgPrimary onClick={finishPlan} disabled={!consented} label='Continue' />}
    >
      <h1>Review your Vault</h1>
      {setup.connector ? (
        <details className='qg-guidance'>
          <summary>Verify signer reserve address · 1,000 sats</summary>
          <div className='qg-guidance-body'>
            <p style={{ overflowWrap: 'anywhere' }} data-testid='plan-connector-address'>
              {setup.connector.address}
            </p>
            <p>Compare this address with your signing wallet. Savings deposits use a separate address after setup.</p>
          </div>
        </details>
      ) : null}
      <section className='qg-summary'>
        <div>
          <span>Network</span>
          <strong>{networkLabel}</strong>
        </div>
        <div>
          <span>Protection</span>
          <strong>{light ? 'Light' : advanced ? 'Advanced' : 'Standard'}</strong>
        </div>
        {!light ? (
          <div>
            <span>Hardware key</span>
            <strong>{shortPub(setup.hardwarePub)}</strong>
          </div>
        ) : null}
        <div>
          <span>Recovery</span>
          <strong>{light ? 'Saved device key' : advanced ? shortPub(setup.recoveryPub) : 'One remaining key'}</strong>
        </div>
        <div>
          <span>Per payment</span>
          <strong>{prettyNumber(setup.txCapSats, 0)} sats</strong>
        </div>
        <div>
          <span>Rolling 24 hours</span>
          <strong>{prettyNumber(setup.dailyLimitSats, 0)} sats</strong>
        </div>
      </section>
      {!light ? <p className='qg-copy'>Check the key identifiers against your saved public keys.</p> : null}
      {light ? (
        <p className='qg-copy'>
          Your passkey authorizes Spending payments. Keep your recovery backup to recover Spending and pending Bitcoin
          deposits. Savings is available to watch an address held in another wallet.
        </p>
      ) : (
        <p className='qg-copy'>
          {advanced
            ? 'The separate recovery key can recover Savings if both normal keys are lost.'
            : 'If both normal keys are lost, Standard has no separate recovery key.'}{' '}
          {setup.ledger
            ? 'Starting delayed recovery requires the Guardian. A compromised user key together with a compromised Guardian can bypass the recovery delay; the Guardian cannot spend alone.'
            : 'Starting delayed recovery requires the recovery services.'}
        </p>
      )}
      {setup.ledger ? (
        <p className='qg-copy'>
          Emergency Spending exit requires entering your Ledger seed backup into the offline recovery tool.{' '}
          {advanced
            ? 'The separate recovery wallet seed is also required.'
            : 'Your recovered phone key is also required.'}{' '}
          That computer can access every account under the entered seeds.
        </p>
      ) : null}
      <label className='qg-consent'>
        <input type='checkbox' checked={consented} onChange={(event) => setConsented(event.target.checked)} />
        <span>I understand that this protection choice and these Spending limits cannot be changed after setup.</span>
      </label>
    </QgScreen>
  )
}
