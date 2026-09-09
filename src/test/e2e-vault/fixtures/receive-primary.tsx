import React, { useContext } from 'react'
import { createRoot } from 'react-dom/client'
import { bech32 } from '@scure/base'
import '../../../tokens.css'
import '../../../app.css'
import '../../../index.css'
import '../../../screens/Vault/vault.css'
import '../../../screens/Vault/vault-system.css'
import '../../../screens/Vault/quiet-guardian-flows.css'
import '../../../screens/Vault/qg/layout.css'
import '../../../screens/Vault/quiet-guardian-screens.css'
import VaultReceive from '../../../screens/Vault/Receive'
import { VaultContext } from '../../../vault/context'
import { ToastProvider } from '../../../components/Toast'
import { recoveryFixture } from '../../../lib/vault/recovery/testdata/helpers'

const { status, archive } = recoveryFixture(false, 'mainnet')
const id = 'v' + '12'.repeat(8)
const active = new URLSearchParams(location.search).has('active')
const name = new URLSearchParams(location.search).has('named') ? 'alex' : id
if (active)
  localStorage.setItem(
    `vaulted:lnurl:v1:mainnet:${status.vaultId}`,
    JSON.stringify({
      id,
      name,
      address: `${name}@ln.getvaulted.xyz`,
      active: true,
      readToken: 'ab'.repeat(32),
      maxFeeSats: 25,
      lnurl: bech32
        .encode(
          'lnurl',
          bech32.toWords(new TextEncoder().encode(`https://ln.getvaulted.xyz/.well-known/lnurlp/${name}`)),
          1023,
        )
        .toUpperCase(),
      binding: {
        vaultId: status.vaultId,
        network: status.network,
        templateVersion: status.templateVersion,
        protectionTier: status.protectionTier,
        policyVersion: status.policyVersion,
        descriptorHash: archive.spending.descriptorHash,
        spendingPolicyDigest: status.spendingPolicyDigest,
        spendingAddress: status.spendingArkAddress,
        spendingScript: status.spendingArkScript,
        claimPublicKey: status.phoneBip340Pub,
      },
    }),
  )
else localStorage.removeItem(`vaulted:lnurl:v1:mainnet:${status.vaultId}`)
const params = new URLSearchParams(location.search)
document.documentElement.classList.toggle('palette-dark', params.has('dark'))
function ReceiveFixture() {
  const defaults = useContext(VaultContext)
  return (
    <ToastProvider>
      <VaultContext.Provider
        value={{
          ...defaults,
          status,
          account: 'spend',
          boardingAddress: status.vtxoBoardingAddress || '',
          spendingArkAddress: status.spendingArkAddress || '',
          savingsAddress: status.savingsAddress,
        }}
      >
        <div
          data-testid='vault-app'
          style={{
            height: '100dvh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            maxWidth: 480,
            margin: '0 auto',
            position: 'relative',
          }}
        >
          <VaultReceive />
        </div>
      </VaultContext.Provider>
    </ToastProvider>
  )
}
createRoot(document.getElementById('root')!).render(<ReceiveFixture />)
