// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { Buffer } from 'buffer'
import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import { AppClient, WalletPolicy } from '@ledgerhq/ledger-bitcoin'
import vectors from './program/ledger-key-vectors.json'
import { ledgerPaymentFixture } from '../../test/ledgerSavingsFixture'
import { signLedgerSavingsWithPhone } from './ledgerSavings'
import {
  registerLedgerSavings,
  signLedgerSavings,
  validateLedgerSavingsRegistration,
  connectLedgerSavings,
} from './ledgerClient'

function setup() {
  const fixture = ledgerPaymentFixture()
  const { payment, family, signHardware } = fixture
  const app = {
    getMasterFingerprint: vi.fn(async () => payment.contract.context.hardware.fingerprint),
    getExtendedPubkey: vi.fn(async () => payment.contract.context.hardware.xpub),
    registerWallet: vi.fn(async (policy: WalletPolicy) => [policy.getId(), Buffer.alloc(32, 1)] as const),
    getWalletAddress: vi.fn(async (_policy, _hmac, branch) =>
      branch ? family.change.address : family.receive.address,
    ),
    signPsbt: vi.fn(async (psbt: Buffer) => {
      const signed = Transaction.fromPSBT(hex.decode(signHardware(psbt.toString('hex'))), {
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      })
      const h = signed
        .getInput(0)
        .tapScriptSig!.find(
          ([key]) =>
            hex.encode(key.pubKey) === hex.encode(fixture.hardware.deriveChild(0).deriveChild(0).publicKey!.slice(1)),
        )!
      return [
        [
          0,
          { pubkey: Buffer.from(h[0].pubKey), tapleafHash: Buffer.from(h[0].leafHash), signature: Buffer.from(h[1]) },
        ],
      ] as Awaited<ReturnType<AppClient['signPsbt']>>
    }),
  }
  return { ...fixture, app }
}

describe('Ledger native account and signing integration', () => {
  it('registers one complete policy and verifies receive on-device, then signs without registering again', async () => {
    const { app, payment, phone } = setup()
    const record = await registerLedgerSavings(app, payment.contract)
    expect(record.walletPolicy.keysInfo).toHaveLength(4)
    expect(app.getWalletAddress.mock.calls.map((call) => call.slice(2))).toEqual([
      [0, 0, true],
      [1, 0, false],
    ])
    const approved = signLedgerSavingsWithPhone(payment, phone)
    const signed = await signLedgerSavings(app, payment, approved, record)
    expect(app.registerWallet).toHaveBeenCalledTimes(1)
    expect(app.signPsbt).toHaveBeenCalledTimes(1)
    expect(Transaction.fromPSBT(hex.decode(signed)).getInput(0).tapScriptSig).toHaveLength(2)
    expect(await validateLedgerSavingsRegistration(payment.contract, JSON.parse(JSON.stringify(record)))).toEqual(
      record,
    )
  })

  it('rejects another device before registration or signing', async () => {
    const { app, payment, phone } = setup()
    const record = await registerLedgerSavings(app, payment.contract)
    app.getExtendedPubkey.mockResolvedValueOnce(payment.contract.context.phone.xpub)
    await expect(signLedgerSavings(app, payment, signLedgerSavingsWithPhone(payment, phone), record)).rejects.toThrow(
      'Connect the Ledger',
    )
    expect(app.signPsbt).not.toHaveBeenCalled()
    app.getMasterFingerprint.mockResolvedValue('00000000')
    await expect(registerLedgerSavings(app, payment.contract)).rejects.toThrow('Connect the Ledger')
    expect(app.registerWallet).toHaveBeenCalledTimes(1)
  })

  it('rejects policy, origin, address and key-order substitutions in recovery metadata', async () => {
    const { app, payment } = setup()
    const original = await registerLedgerSavings(app, payment.contract)
    for (const patch of [
      { walletId: '00'.repeat(32) },
      { contextDigest: '11'.repeat(32) },
      { walletHmac: 'aa' },
      { receiveAddress: original.changeAddress },
      { changeAddress: original.receiveAddress },
      { walletPolicy: { ...original.walletPolicy, keysInfo: [...original.walletPolicy.keysInfo].reverse() } },
      { walletPolicy: { ...original.walletPolicy, name: 'Other wallet' } },
    ])
      await expect(validateLedgerSavingsRegistration(payment.contract, { ...original, ...patch })).rejects.toThrow(
        'registration does not match',
      )
    await expect(
      validateLedgerSavingsRegistration(
        { ...payment.contract, context: { ...payment.contract.context, vaultId: 'aa'.repeat(16) } },
        original,
      ),
    ).rejects.toThrow()
  })

  it('does not complete enrollment when address confirmation is cancelled or differs', async () => {
    const { app, payment } = setup()
    app.getWalletAddress.mockRejectedValueOnce(new Error('denied'))
    await expect(registerLedgerSavings(app, payment.contract)).rejects.toThrow('denied')
    app.getWalletAddress.mockResolvedValueOnce('bc1qwrong')
    await expect(registerLedgerSavings(app, payment.contract)).rejects.toThrow('registration does not match')
  })

  it('rejects wrong policy ID, empty or non-default signatures and never retries a device rejection', async () => {
    const { app, payment, phone } = setup()
    const record = await registerLedgerSavings(app, payment.contract)
    const approved = signLedgerSavingsWithPhone(payment, phone)
    app.signPsbt.mockResolvedValueOnce([])
    await expect(signLedgerSavings(app, payment, approved, record)).rejects.toThrow('every Savings input')
    app.signPsbt.mockResolvedValueOnce([
      [0, { pubkey: Buffer.alloc(32), tapleafHash: Buffer.alloc(32), signature: Buffer.alloc(65) }],
    ])
    await expect(signLedgerSavings(app, payment, approved, record)).rejects.toThrow('unexpected Savings signature')
    app.signPsbt.mockRejectedValueOnce(new Error('denied'))
    await expect(signLedgerSavings(app, payment, approved, record)).rejects.toThrow('denied')
    expect(app.signPsbt).toHaveBeenCalledTimes(3)
    app.registerWallet.mockImplementationOnce(async () => [Buffer.alloc(32), Buffer.alloc(32)] as const)
    await expect(registerLedgerSavings(app, payment.contract)).rejects.toThrow('different Savings policy')
  })

  it('does not offer a connector fallback in an unsupported browser', async () => {
    await expect(connectLedgerSavings()).rejects.toThrow('desktop browser')
  })
})

it('runs the official client registration and independent address validation on both networks and tiers', async () => {
  for (const vector of vectors) {
    const { payment, family } = ledgerPaymentFixture(vector)
    const p = family.walletPolicy
    const policy = new WalletPolicy(p.name, p.descriptorTemplate, p.keysInfo)
    const appName = payment.contract.context.network === 'mainnet' ? 'Bitcoin' : 'Bitcoin Test'
    const transport = {
      send: async (cla: number, ins: number, _p1: number, _p2: number, data?: Buffer) => {
        let body: Buffer
        if (cla === 0xb0 && ins === 1)
          body = Buffer.concat([
            Buffer.from([1, appName.length]),
            Buffer.from(appName),
            Buffer.from([5]),
            Buffer.from('2.4.2'),
            Buffer.from([1, 0]),
          ])
        else if (ins === 5) body = Buffer.from(payment.contract.context.hardware.fingerprint, 'hex')
        else if (ins === 0) body = Buffer.from(payment.contract.context.hardware.xpub)
        else if (ins === 2) body = Buffer.concat([policy.getId(), Buffer.alloc(32, 1)])
        else if (ins === 3) body = Buffer.from(data![65] ? family.change.address : family.receive.address)
        else throw new Error('Unexpected APDU in public fixture')
        return Buffer.concat([body, Buffer.from('9000', 'hex')])
      },
    }
    const warning = vi.spyOn(console, 'warn')
    const record = await registerLedgerSavings(
      new AppClient(transport as unknown as ConstructorParameters<typeof AppClient>[0]),
      payment.contract,
    )
    expect(record.receiveAddress).toBe(family.receive.address)
    expect(record.changeAddress).toBe(family.change.address)
    expect(warning).not.toHaveBeenCalled()
    warning.mockRestore()
  }
})
