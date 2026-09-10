import React from 'react'
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
import LightningAddress from '../../../screens/Vault/LightningAddress'
import { recoveryFixture } from '../../../lib/vault/recovery/testdata/helpers'

const { status, archive } = recoveryFixture(false, 'mainnet')
const id = 'v' + '12'.repeat(8)
const active = new URLSearchParams(location.search).has('active')
if (active)
  localStorage.setItem(
    `vaulted:lnurl:v1:mainnet:${status.vaultId}`,
    JSON.stringify({
      id,
      address: `${id}@ln.getvaulted.xyz`,
      active: true,
      readToken: 'ab'.repeat(32),
      maxFeeSats: 25,
      lnurl: bech32
        .encode(
          'lnurl',
          bech32.toWords(new TextEncoder().encode(`https://ln.getvaulted.xyz/.well-known/lnurlp/${id}`)),
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
createRoot(document.getElementById('root')!).render(
  <main data-testid='vault-app' className='qg-screen' style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
    <LightningAddress status={status} />
  </main>,
)
