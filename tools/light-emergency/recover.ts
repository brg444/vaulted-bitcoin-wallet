import { serializeExitPackage } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { openLocalLightBackup, parseLightEncryptedBackup } from '../../src/lib/vault/light/backupCodec'
import { unwrapLightRecoveryPackage } from '../../src/lib/vault/light/portable'
import { unlockLightWithPasskey } from '../../src/lib/vault/light/passkey'
import { unlockLightOwnerKey } from '../../src/lib/vault/light/keyBackup'
import {
  executeLightRecoveryWithOwner,
  prepareLightRecoveryWithOwner,
  validateLightRecoveryFile,
  type LightRecoveryFile,
} from '../../src/lib/vault/light/recovery'
import { validateLightRecoveryArchive } from '../../src/lib/vault/light/recoveryArchive'
import { lightExitDelayLabel, lightRecoveryProgress } from '../../src/lib/vault/light/recoveryProgress'
import { requireReleaseNetwork } from '../../src/lib/vault/releaseNetwork'

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
let raw: unknown
let file: LightRecoveryFile | undefined
let legacy = false
let controller: AbortController | undefined
let busy = false
async function run(action: () => Promise<void>) {
  if (busy) return
  busy = true
  el('error').textContent = ''
  el('status').textContent = ''
  document.querySelectorAll<HTMLButtonElement>('button:not(#stop)').forEach((button) => {
    button.disabled = true
  })
  try {
    await action()
  } catch (error) {
    el('error').textContent = error instanceof Error ? error.message : 'Recovery failed'
  } finally {
    busy = false
    document.querySelectorAll<HTMLButtonElement>('button:not(#stop)').forEach((button) => {
      button.disabled = false
    })
  }
}
async function owner() {
  if (!file) throw new Error('Open your backup first')
  if (!legacy) return unlockLightWithPasskey(file)
  const secret = el<HTMLTextAreaElement>('secret').value.trim()
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error('Enter the complete recovery code')
  const material = hex.decode(secret)
  try {
    return await unlockLightOwnerKey(file.recoveryBackup, material, 'recovery-secret', file.descriptor)
  } finally {
    material.fill(0)
  }
}
function review() {
  if (!file) return
  requireReleaseNetwork(file.descriptor.network)
  const snapshot = file.archive ? validateLightRecoveryArchive(file.archive, file.descriptor) : undefined
  if (!snapshot && !file.exitPackage)
    throw new Error('This older file has no Bitcoin exit paths. Import a newer recovery file.')
  el('review').hidden = Boolean(file.exitPackage)
  el('snapshot').textContent = snapshot
    ? `${snapshot.coins.length} outputs, ${snapshot.coins.reduce((n, coin) => n + coin.value, 0)} sats. Saved ${new Date(snapshot.archive.capturedAt).toLocaleString()}.`
    : ''
  el('exit').hidden = !file.exitPackage
  if (file.exitPackage) {
    const pkg = file.exitPackage
    el('details').textContent =
      `${pkg.totals.recoveredSats} sats to recover. Estimated fees: ${pkg.totals.totalFeeSats} sats. Fee funding needed: ${pkg.totals.fundingRequiredSats} sats. Exit delay: ${lightExitDelayLabel(file.descriptor.exitDelaySeconds)}, plus Bitcoin confirmations.`
    el('funding').textContent = file.feeFundingAddress!
    el('target').textContent = pkg.sweepAddress
  }
}
el<HTMLInputElement>('file').onchange = () =>
  void run(async () => {
    file = undefined
    raw = undefined
    legacy = false
    el('review').hidden = true
    el('exit').hidden = true
    const selected = el<HTMLInputElement>('file').files?.[0]
    if (!selected || selected.size > 32_000_000) throw new Error('Choose a Light recovery file smaller than 32 MB')
    raw = unwrapLightRecoveryPackage(JSON.parse(await selected.text()))
    if ((raw as { name?: string }).name === 'vaulted-light-backup') {
      const encrypted = parseLightEncryptedBackup(raw)
      requireReleaseNetwork(encrypted.header.descriptor.network)
      el('origin').textContent =
        `The passkey for this backup belongs to ${encrypted.header.origin}. Open this recovery page at that origin.`
      el('legacy').hidden = true
    } else {
      file = validateLightRecoveryFile(raw)
      el('legacy').hidden = !file.recoveryBackup
      el('origin').textContent =
        'Use the original wallet website address for passkey recovery, or the saved code for an older file.'
    }
  })
el('unlock').onclick = () =>
  void run(async () => {
    if ((raw as { name?: string })?.name === 'vaulted-light-backup') file = (await openLocalLightBackup(raw)).file
    else {
      if (!file) throw new Error('Choose a backup first')
      const key = await unlockLightWithPasskey(file)
      key.fill(0)
    }
    legacy = false
    review()
  })
el('legacy-open').onclick = () =>
  void run(async () => {
    legacy = true
    const key = await owner()
    key.fill(0)
    review()
  })
el('prepare').onclick = () =>
  void run(async () => {
    if (!file?.archive) throw new Error('Saved transaction paths are required')
    const key = await owner()
    try {
      file = await prepareLightRecoveryWithOwner(
        file,
        key,
        el<HTMLInputElement>('destination').value.trim(),
        file.archive,
        true,
      )
    } finally {
      key.fill(0)
    }
    if (!file.exitPackage) throw new Error('This backup has no unspent outputs')
    review()
  })
function saveExit(standard = false) {
  if (!file?.exitPackage) return
  const url = URL.createObjectURL(
    new Blob([standard ? serializeExitPackage(file.exitPackage) : JSON.stringify(file)], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `vaulted-light-exit-${file.descriptor.vaultId.slice(0, 8)}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
el('save').onclick = () => saveExit()
el('export-sdk').onclick = () => saveExit(true)
el('execute').onclick = () =>
  void run(async () => {
    if (!file?.exitPackage) throw new Error('Prepare an exit first')
    const key = await owner()
    controller = new AbortController()
    el('stop').hidden = false
    try {
      await executeLightRecoveryWithOwner(file, key, controller.signal, (event) => {
        el('events').textContent += `${lightRecoveryProgress(event)}${event.txid ? ` ${event.txid}` : ''}\n`
      })
      el('status').textContent = 'Bitcoin recovery completed'
    } finally {
      key.fill(0)
      controller = undefined
      el('stop').hidden = true
      el<HTMLTextAreaElement>('secret').value = ''
    }
  })
el('stop').onclick = () => controller?.abort()
