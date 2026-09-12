import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Run the same retained-product gate locally and in CI, for both release networks.
for (const name of ['contract-pack.json', 'contract-pack.mainnet.json']) {
  const pack = JSON.parse(await readFile(new URL(`../src/lib/vault/${name}`, import.meta.url), 'utf8'))
  assert.equal(pack.version, 3, `${name}: retained contract baseline required`)
  assert.equal(pack.databaseSchemaVersion, 12, `${name}: current database schema required`)
  assert.deepEqual(
    Object.keys(pack.programs).sort(),
    ['phone-ledger-guardian-savings-v1', 'vault-board-v1', 'vault-policy-v1'],
    `${name}: exactly the retained programs must be published`,
  )
  const savings = pack.programs['phone-ledger-guardian-savings-v1']
  assert.equal(savings.template, 'phone-ledger-guardian-savings-v1')
  assert.equal(savings.enrollable, true)
  assert.equal(savings.admissionCapability, 'ledgerSavingsCapability/v1')
  assert.equal(savings.admissionDefault, false)
  assert.equal(savings.formats.runtimeSchema, 12)
  assert.equal(pack.programs['vault-board-v1'].destination, 'vault-policy-v1')
  assert.deepEqual(Object.keys(pack.enrollmentProfiles), ['vaulted-spending-v1'])
  assert.deepEqual(pack.enrollmentProfiles['vaulted-spending-v1'], {
    schema: 'arkade-vault/spending-enrollment-v1',
    protectionTier: 'light',
    spending: 'vault-policy-v1',
    boarding: 'vault-board-v1',
    exitMode: 'device',
    hardwareKey: 'forbidden',
    recoveryKey: 'forbidden',
    savings: 'watch-only',
  })
  assert.deepEqual(pack.formats.recoveryKit, {
    'vaulted-spending-v1': 5,
    'phone-ledger-guardian-savings-v1': 4,
  })
  console.log(`${name}: retained programs, enrollment, schema and Recovery Kit formats verified`)
}
