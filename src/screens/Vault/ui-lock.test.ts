import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')

function read(rel: string) {
  return readFileSync(resolve(root, rel), 'utf8')
}

describe('vault UI lock', () => {
  it('keeps the restyle screens that Vercel deploys from git', () => {
    expect(existsSync(resolve(root, 'src/screens/Vault/History.tsx'))).toBe(true)
    expect(existsSync(resolve(root, 'src/screens/Vault/Tx.tsx'))).toBe(true)
    expect(existsSync(resolve(root, 'src/screens/Vault/Navigation.tsx'))).toBe(true)
    expect(existsSync(resolve(root, 'src/screens/Vault/Settings.tsx'))).toBe(true)
    expect(existsSync(resolve(root, 'src/screens/Vault/Refresher.tsx'))).toBe(true)
    expect(existsSync(resolve(root, 'src/lib/vault/prefs.ts'))).toBe(true)
  })

  it('mounts the Vault navigation and settings from VaultApp', () => {
    const app = read('src/VaultApp.tsx')
    expect(app).toContain('VaultNavigation')
    expect(app).toContain('VaultSettings')
    expect(app).toContain('has-vault-navigation')
    const content = read('src/screens/Vault/Content.tsx')
    expect(content).toContain('VaultRefresher')
    const nav = read('src/screens/Vault/Navigation.tsx')
    expect(nav).not.toMatch(/hwsign/)
  })

  it('keeps Standard and Advanced protection chrome and the kit path', () => {
    expect(existsSync(resolve(root, 'src/screens/Vault/onboard/Recovery.tsx'))).toBe(true)
    expect(existsSync(resolve(root, 'src/screens/Vault/Recover.tsx'))).toBe(true)
    const recovery = read('src/screens/Vault/onboard/Recovery.tsx')
    expect(recovery).toMatch(/Recovery public key/)
    expect(recovery).not.toMatch(/Prove you hold/)
    expect(recovery).not.toMatch(/recovery-secret/)
    expect(recovery).toMatch(/stored separately/)
    const design = read('src/screens/Vault/onboard/Design.tsx')
    expect(design).toMatch(/acceptDesign\('standard'\)/)
    expect(design).toMatch(/acceptDesign\('advanced'\)/)
    expect(design).not.toMatch(/Recovery is required/)
    const recover = read('src/screens/Vault/Recover.tsx')
    expect(recover).toMatch(/public map/)
    expect(recover).toMatch(/contains no private keys/)
    expect(recover).toMatch(/Save copy with Vault service/)
    expect(recover).toMatch(/Retrieve Recovery Kit/)
    expect(recover).not.toMatch(/Unlock map with hardware/)
    expect(recover).toMatch(/cannot move/)
    const app = read('src/VaultApp.tsx')
    expect(app).toContain('VaultRecovery')
    expect(app).toContain('VaultRecover')
    expect(app).toContain('VaultUnlock')
    const enroll = read('src/lib/vault/tenantEnrollment.ts')
    expect(enroll).toMatch(/recoveryXOnly/)
    expect(enroll).toMatch(/wantRecovery/)
    const descriptorCheck = read('src/lib/vault/program/enroll.ts')
    expect(descriptorCheck).toMatch(/enroll needs the current Vault Program descriptor/)
    expect(descriptorCheck).not.toMatch(/requireV4ProposedDescriptor/)
    expect(enroll).toMatch(/this setup skipped recovery/)
    const constants = read('src/lib/vault/program/constants.ts')
    expect(constants).toContain('arkade-vault/savings-v1')
    expect(constants).toContain('phone-hww-recovery-savings-v1')
    const settings = read('src/screens/Vault/Settings.tsx')
    expect(settings).not.toMatch(/settings-recover/)
    expect(settings).not.toMatch(/settings-kit/)
    expect(settings).not.toMatch(/settings-hwsign/)
    expect(settings).toMatch(/Sign out/)
    const keys = [read('src/screens/Vault/Keys.tsx'), read('src/screens/Vault/SecurityOverview.tsx')].join('\n')
    expect(keys).toMatch(/title='Recovery key'/)
    expect(keys).toMatch(/Your passkey/)
    expect(keys).toMatch(/Backups/)
    expect(keys).toMatch(/hasRecovery/)
    expect(keys).not.toMatch(/Not on this vault/)
    expect(keys).toMatch(/useVaultReadiness/)
    expect(keys).not.toMatch(/Daily only/)
    expect(keys).not.toMatch(/PolicyTimeline/)
    expect(keys).not.toMatch(/If you lose one/)
    expect(keys).toMatch(/I lost a key/)
  })

  it('keeps raw private keys out of production routes', () => {
    expect(existsSync(resolve(root, 'src/screens/Vault/HwSign.tsx'))).toBe(false)
    const app = read('src/VaultApp.tsx')
    const recover = read('src/screens/Vault/Recover.tsx')
    const savings = read('src/lib/vault/savingsSpend.ts')
    for (const productionSource of [app, recover, savings]) {
      expect(productionSource).not.toMatch(/parseHardwareSecret|WIF or 64-char|hardware-map-secret/)
    }
    expect(recover).toMatch(/recover-guardian-signed-file/)
    expect(recover).toMatch(/acceptGuardianExitSignature/)
    expect(app).not.toMatch(/offline-recovery/)
    expect(existsSync(resolve(root, 'tools/offline-recovery/index.html'))).toBe(true)
    expect(existsSync(resolve(root, 'tools/offline-recovery/Recover.command'))).toBe(true)
    expect(read('.gitmodules')).toMatch(/vaulted-emergency-recovery/)
  })

  it('keeps emergency recovery copy free of protocol jargon', () => {
    const userCopy = [
      read('tools/offline-recovery/index.html'),
      read('src/screens/Vault/onboard/Kit.tsx'),
      read('src/screens/Vault/Recover.tsx'),
      read('docs/emergency-recovery.md'),
    ].join('\n')
    expect(userCopy).not.toMatch(/version 4/i)
    expect(userCopy).not.toMatch(/\bRP ID\b/)
    expect(userCopy).not.toMatch(/envelope/i)
    expect(read('tools/offline-recovery/index.html')).toMatch(/Open recovery/)
    for (const network of ['mainnet', 'mutinynet']) {
      const page = read(`tools/offline-recovery/programs/${network}/index.html`)
      expect(page).toMatch(/Recovery file/)
      expect(page).toMatch(/Save recovery plan/)
      expect(page).toMatch(/Start or resume Bitcoin recovery/)
      expect(page).not.toMatch(/\bRP ID\b|private key input|WIF or 64-char/)
    }
    expect(read('src/screens/Vault/onboard/Kit.tsx')).toMatch(/Recovery Kit/)
  })

  it('collapses the obsolete Savings page and keeps the live spend path', () => {
    expect(existsSync(resolve(root, 'src/screens/Vault/Savings.tsx'))).toBe(false)
    const app = read('src/VaultApp.tsx')
    expect(app).not.toMatch(/VaultSavings/)
    expect(app).not.toMatch(/navigate\('savings'\)/)
    expect(existsSync(resolve(root, 'src/lib/vault/savingsSpend.ts'))).toBe(true)
    expect(existsSync(resolve(root, 'src/lib/vault/savingsQr.ts'))).toBe(true)
    const home = read('src/screens/Vault/Home.tsx')
    const navigation = read('src/screens/Vault/Navigation.tsx')
    expect(navigation).toContain('account-savings')
    expect(home).not.toMatch(/Phone can spend/)
    expect(home).not.toMatch(/Hardware only/)
  })

  it('rejects the retired singleton home chrome', () => {
    const home = [read('src/screens/Vault/Home.tsx'), read('src/screens/Vault/AccountHome.tsx')].join('\n')
    expect(home).toContain('account-switcher')
    expect(home).not.toContain('in your rolling 24-hour')
    expect(read('src/screens/Vault/Send.tsx')).toMatch(/rolling limit/)
    expect(home).not.toMatch(/Phone may spend/)
    expect(home).not.toMatch(/Mutinynet · live coins/)
    expect(home).not.toMatch(/Daily path ready/)
    expect(home).not.toMatch(/Open Mutinynet faucet/)
    expect(home).not.toMatch(/Move onchain funds to VTXOs/)
    expect(home).not.toMatch(/Finish boarding/)
    expect(home).not.toMatch(/in VTXOs/)
    expect(home).not.toMatch(/Converting confirmed Bitcoin to VTXOs automatically/)
    expect(home).not.toMatch(/Waiting for confirmation\. Boarding will resume automatically/)
    const receive = read('src/screens/Vault/Receive.tsx')
    expect(receive).toMatch(/encodeVaultBip21/)
    expect(receive).not.toMatch(/operationalAddress/)
  })

  it('rejects obsolete balance, biometric, success, and recovery copy', () => {
    const productCopy = [
      read('src/screens/Vault/Home.tsx'),
      read('src/screens/Vault/AccountHome.tsx'),
      read('src/screens/Vault/Review.tsx'),
      read('src/screens/Vault/Success.tsx'),
      read('src/screens/Vault/Recover.tsx'),
      read('src/lib/vault/humanize.ts'),
    ].join('\n')
    expect(productCopy).not.toMatch(/available today/i)
    expect(productCopy).not.toMatch(/Face ID is required/i)
    expect(productCopy).not.toMatch(/Sent as a VTXO/i)
    expect(productCopy).not.toMatch(/cancellation requires the vault services/i)
  })
})
