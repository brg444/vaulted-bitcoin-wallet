import {
  ArkAddress,
  DefaultVtxo,
  SingleKey,
  VHTLC,
  VHTLCV2ContractHandler,
  getNetwork,
  provisionRefundKey,
  resolveEmulatorPubkey,
  toXOnly,
} from '@arkade-os/sdk'
import {
  AddressMismatch,
  InMemoryAssetSwapRepository,
  lightningSendVtxoScript,
  lockupContractParams,
  rebuildRfqSwap,
  unilateralClaimDelay,
  type InvoiceFacts,
  type LightningSendTreeParams,
  type RfqQuote,
  type RfqTransport,
  type SwapContractRegistry,
} from '@arkade-os/swap'
import { hex } from '@scure/base'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestVaultLightningQuote, vaultLightningRequestWallet } from './lightning'
import {
  buildLightningSendCandidates,
  matchLightningSendCandidate,
  requestVaultLightningSend,
} from './lightningCovenant'
import {
  INVOICE_EXPIRES,
  INVOICE_TIMESTAMP,
  MAINNET_INVOICE,
  MAINNET_TEST_PROFILE,
  memoryContracts,
  quoteManager,
  refundAddress,
} from './lightningTestUtils'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const NOW = 1_800_000_000
const PAYMENT_HASH = 'da9fa986cf48f56ad387495f8e840ea9ed10889bf82f67c8a7b10d5d8a27886c'
const AMOUNT_SATS = 2100
const FUND_AMOUNT = 2125
const ARK_SERVER = 'https://arkade.computer'

function facts(overrides: Partial<InvoiceFacts> = {}): InvoiceFacts {
  return {
    raw: MAINNET_INVOICE,
    paymentHash: PAYMENT_HASH,
    amountSats: AMOUNT_SATS,
    expiresAt: NOW + 86_400,
    ...overrides,
  }
}

async function xOnly(key: SingleKey): Promise<Uint8Array> {
  return (await key.compressedPublicKey()).slice(1)
}

function serverInfo(operatorCompressedHex: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 'v0.9.16-rc.11',
    signerPubkey: operatorCompressedHex,
    forfeitPubkey: operatorCompressedHex,
    forfeitAddress: 'bc1qexample',
    checkpointTapscript: '20' + '00'.repeat(32) + 'ac',
    network: 'bitcoin',
    sessionDuration: '60',
    unilateralExitDelay: '605184',
    boardingExitDelay: '7776256',
    utxoMinAmount: '330',
    utxoMaxAmount: '50000000',
    vtxoMinAmount: '330',
    vtxoMaxAmount: '50000000',
    dust: '330',
    fees: {
      intentFee: { offchainInput: '', offchainOutput: '', onchainInput: '', onchainOutput: '200.0' },
      txFeeRate: '0',
    },
    ...overrides,
  }
}

function stubServerInfo(info: Record<string, unknown>) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(info), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function receiverScriptFor(operatorXOnly: Uint8Array): Promise<Uint8Array> {
  const receiver = SingleKey.fromPrivateKey(hex.decode('06'.padStart(64, '0')))
  const receiverPub = (await receiver.compressedPublicKey()).slice(1)
  return new DefaultVtxo.Script({
    pubKey: receiverPub,
    serverPubKey: operatorXOnly,
    csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
  }).pkScript
}

interface CovenantFixture {
  wallet: import('@arkade-os/sdk').IWallet
  contracts: SwapContractRegistry
  createContract: ReturnType<typeof vi.fn>
  phone: SingleKey
  phoneXOnly: Uint8Array
  operator: SingleKey
  operatorXOnly: Uint8Array
  operatorCompressedHex: string
  solverXOnly: Uint8Array
  receiverPkScript: Uint8Array
  vaultAddress: string
  emulatorXOnly: Uint8Array
  claimDelay: number
}

async function covenantFixture(): Promise<CovenantFixture> {
  const phone = SingleKey.fromPrivateKey(hex.decode('02'.padStart(64, '0')))
  const operator = SingleKey.fromPrivateKey(hex.decode('04'.padStart(64, '0')))
  const solver = SingleKey.fromPrivateKey(hex.decode('05'.padStart(64, '0')))
  const phoneXOnly = await xOnly(phone)
  const operatorXOnly = await xOnly(operator)
  const solverXOnly = await xOnly(solver)
  const operatorCompressedHex = hex.encode(await operator.compressedPublicKey())
  const vaultAddress = await refundAddress()
  const { contracts, createContract } = memoryContracts()
  const wallet = vaultLightningRequestWallet(phone, vaultAddress, contracts as never)
  const receiverPkScript = await receiverScriptFor(operatorXOnly)
  const network = getNetwork('bitcoin')
  const emulatorXOnly = toXOnly(hex.decode(resolveEmulatorPubkey(network)), 'emulator signer key')
  const claimDelay = unilateralClaimDelay(605_184)
  return {
    wallet,
    contracts,
    createContract,
    phone,
    phoneXOnly,
    operator,
    operatorXOnly,
    operatorCompressedHex,
    solverXOnly,
    receiverPkScript,
    vaultAddress,
    emulatorXOnly,
    claimDelay,
  }
}

async function treeParamsFor(
  fx: CovenantFixture,
  overrides: Partial<LightningSendTreeParams> = {},
): Promise<LightningSendTreeParams> {
  const secrets = await provisionRefundKey(fx.wallet)
  return {
    solverPubkey: fx.solverXOnly,
    refundLocktime: NOW + 10_000,
    serverPubkey: fx.operatorXOnly,
    paymentHash: PAYMENT_HASH,
    claimDelay: fx.claimDelay,
    emulatorPubkey: fx.emulatorXOnly,
    refundPkScript: secrets.pkScript,
    senderPubkey: secrets.pubkey,
    receiverPkScript: fx.receiverPkScript,
    ...overrides,
  }
}

function nineLeafOf(eight: InstanceType<typeof VHTLC.ScriptV2>): InstanceType<typeof VHTLC.ScriptV2> {
  return new VHTLC.ScriptV2({
    ...eight.options,
    nonInteractiveRefund: { ...eight.options.nonInteractiveRefund!, withoutReceiver: true },
  })
}

function quoteFor(params: {
  rfqId: string
  solverPubkeyHex: string
  refundLocktime: number
  validUntil: number
  fromAmount: number
  toAmount: number
  receiverPkScript: Uint8Array
  lockupAddress: string
  refundWithoutReceiverDelay?: number
}): RfqQuote {
  return {
    v: 1,
    type: 'rfq_quote',
    rfq_id: params.rfqId,
    pair: 'arkade:BTC->lightning:BTC',
    amount_side: 'to',
    from_amount: params.fromAmount,
    to_amount: params.toAmount,
    solver_pubkey: params.solverPubkeyHex,
    valid_until: params.validUntil,
    refund_locktime: params.refundLocktime,
    profile: {
      receiver_pk_script: hex.encode(params.receiverPkScript),
      lockup_address: params.lockupAddress,
      ...(params.refundWithoutReceiverDelay !== undefined
        ? { refund_without_receiver_delay: params.refundWithoutReceiverDelay }
        : {}),
    },
  }
}

function transportFor(quote: RfqQuote, onPayload?: (payload: Record<string, unknown>) => void): RfqTransport {
  return {
    requestQuote: vi.fn(async (payload: Record<string, unknown>) => {
      onPayload?.(payload)
      return quote
    }),
    status: vi.fn(async () => null),
    close: vi.fn(async () => {}),
  } as unknown as RfqTransport
}

describe('Lightning dual-candidate covenant matching', () => {
  it('selects a valid eight-leaf quote and leaves it fundable', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fx = await covenantFixture()
    stubServerInfo(serverInfo(fx.operatorCompressedHex))
    const treeParams = await treeParamsFor(fx)
    const eight = lightningSendVtxoScript(treeParams)
    const address = eight.address('ark', fx.operatorXOnly).encode()
    const rfqId = 'ab'.repeat(32)
    const quote = quoteFor({
      rfqId,
      solverPubkeyHex: hex.encode(fx.solverXOnly),
      refundLocktime: treeParams.refundLocktime,
      validUntil: NOW + 100,
      fromAmount: FUND_AMOUNT,
      toAmount: AMOUNT_SATS,
      receiverPkScript: fx.receiverPkScript,
      lockupAddress: address,
    })
    const result = await requestVaultLightningSend(fx.wallet, ARK_SERVER, transportFor(quote), {
      invoice: facts(),
      rfqId,
    })
    expect(result.address).toBe(address)
    expect(hex.encode(result.swapPkScript)).toBe(hex.encode(eight.pkScript))
    expect(result.fundAmount).toBe(FUND_AMOUNT)
    expect(fx.createContract).toHaveBeenCalledOnce()
    const registered = fx.createContract.mock.calls[0][0]
    expect(registered.address).toBe(address)
    expect(registered.params.nonInteractiveRefundWithoutReceiver).toBeUndefined()
  })

  it('selects a valid nine-leaf quote and leaves it fundable', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fx = await covenantFixture()
    stubServerInfo(serverInfo(fx.operatorCompressedHex))
    const treeParams = await treeParamsFor(fx)
    const eight = lightningSendVtxoScript(treeParams)
    const nine = nineLeafOf(eight)
    const address = nine.address('ark', fx.operatorXOnly).encode()
    expect(address).not.toBe(eight.address('ark', fx.operatorXOnly).encode())
    const rfqId = 'bc'.repeat(32)
    const quote = quoteFor({
      rfqId,
      solverPubkeyHex: hex.encode(fx.solverXOnly),
      refundLocktime: treeParams.refundLocktime,
      validUntil: NOW + 100,
      fromAmount: FUND_AMOUNT,
      toAmount: AMOUNT_SATS,
      receiverPkScript: fx.receiverPkScript,
      lockupAddress: address,
    })
    const result = await requestVaultLightningSend(fx.wallet, ARK_SERVER, transportFor(quote), {
      invoice: facts(),
      rfqId,
    })
    expect(result.address).toBe(address)
    expect(hex.encode(result.swapPkScript)).toBe(hex.encode(nine.pkScript))
    expect(fx.createContract).toHaveBeenCalledOnce()
    const registered = fx.createContract.mock.calls[0][0]
    expect(registered.address).toBe(address)
    expect(registered.params.nonInteractiveRefundWithoutReceiver).toBe('1')
  })

  it('refuses when neither candidate matches and exposes no funding address', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fx = await covenantFixture()
    stubServerInfo(serverInfo(fx.operatorCompressedHex))
    const treeParams = await treeParamsFor(fx)
    const eight = lightningSendVtxoScript(treeParams)
    const nine = nineLeafOf(eight)
    const stranger = SingleKey.fromPrivateKey(hex.decode('09'.padStart(64, '0')))
    const strangerPub = (await stranger.compressedPublicKey()).slice(1)
    const foreign = new DefaultVtxo.Script({
      pubKey: strangerPub,
      serverPubKey: fx.operatorXOnly,
      csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
    })
    const foreignAddress = foreign.address('ark', fx.operatorXOnly).encode()
    expect([
      eight.address('ark', fx.operatorXOnly).encode(),
      nine.address('ark', fx.operatorXOnly).encode(),
    ]).not.toContain(foreignAddress)
    const rfqId = 'cd'.repeat(32)
    const quote = quoteFor({
      rfqId,
      solverPubkeyHex: hex.encode(fx.solverXOnly),
      refundLocktime: treeParams.refundLocktime,
      validUntil: NOW + 100,
      fromAmount: FUND_AMOUNT,
      toAmount: AMOUNT_SATS,
      receiverPkScript: fx.receiverPkScript,
      lockupAddress: foreignAddress,
    })
    await expect(
      requestVaultLightningSend(fx.wallet, ARK_SERVER, transportFor(quote), { invoice: facts(), rfqId }),
    ).rejects.toBeInstanceOf(AddressMismatch)
    expect(fx.createContract).not.toHaveBeenCalled()
  })

  it('does not register a contract when the solver is unavailable before funding', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fx = await covenantFixture()
    stubServerInfo(serverInfo(fx.operatorCompressedHex))
    const transport = {
      requestQuote: vi.fn(async () => {
        throw new Error('solver unavailable')
      }),
      status: vi.fn(),
      close: vi.fn(),
    }
    await expect(
      requestVaultLightningSend(fx.wallet, ARK_SERVER, transport as never, {
        invoice: facts(),
        rfqId: '11'.repeat(32),
      }),
    ).rejects.toThrow(/solver unavailable/)
    expect(fx.createContract).not.toHaveBeenCalled()
  })

  it('refuses a quote built for a different Arkade operator', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fx = await covenantFixture()
    // Quote is derived for operator 04, but the wallet's own server reports 07.
    const otherOperator = SingleKey.fromPrivateKey(hex.decode('07'.padStart(64, '0')))
    stubServerInfo(serverInfo(hex.encode(await otherOperator.compressedPublicKey())))
    const treeParams = await treeParamsFor(fx)
    const eight = lightningSendVtxoScript(treeParams)
    const rfqId = 'de'.repeat(32)
    const quote = quoteFor({
      rfqId,
      solverPubkeyHex: hex.encode(fx.solverXOnly),
      refundLocktime: treeParams.refundLocktime,
      validUntil: NOW + 100,
      fromAmount: FUND_AMOUNT,
      toAmount: AMOUNT_SATS,
      receiverPkScript: fx.receiverPkScript,
      lockupAddress: eight.address('ark', fx.operatorXOnly).encode(),
    })
    await expect(
      requestVaultLightningSend(fx.wallet, ARK_SERVER, transportFor(quote), { invoice: facts(), rfqId }),
    ).rejects.toBeInstanceOf(AddressMismatch)
    expect(fx.createContract).not.toHaveBeenCalled()
  })

  it('refuses when the refund destination differs from the pinned Spending script', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fx = await covenantFixture()
    stubServerInfo(serverInfo(fx.operatorCompressedHex))
    // A genuinely different refund script: another phone key under the same
    // operator, so the pkScript bytes (not just the hrp) differ.
    const otherPhone = SingleKey.fromPrivateKey(hex.decode('09'.padStart(64, '0')))
    const otherPhonePub = (await otherPhone.compressedPublicKey()).slice(1)
    const otherPkScript = new DefaultVtxo.Script({
      pubKey: otherPhonePub,
      serverPubKey: fx.operatorXOnly,
      csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
    }).pkScript
    expect(hex.encode(otherPkScript)).not.toBe(hex.encode(ArkAddress.decode(fx.vaultAddress).pkScript))
    const treeParams = await treeParamsFor(fx, { refundPkScript: otherPkScript })
    const eight = lightningSendVtxoScript(treeParams)
    const rfqId = 'ef'.repeat(32)
    const quote = quoteFor({
      rfqId,
      solverPubkeyHex: hex.encode(fx.solverXOnly),
      refundLocktime: treeParams.refundLocktime,
      validUntil: NOW + 100,
      fromAmount: FUND_AMOUNT,
      toAmount: AMOUNT_SATS,
      receiverPkScript: fx.receiverPkScript,
      lockupAddress: eight.address('ark', fx.operatorXOnly).encode(),
    })
    await expect(
      requestVaultLightningSend(fx.wallet, ARK_SERVER, transportFor(quote), { invoice: facts(), rfqId }),
    ).rejects.toBeInstanceOf(AddressMismatch)
    expect(fx.createContract).not.toHaveBeenCalled()
  })

  it('refuses altered amounts before any contract is registered', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fx = await covenantFixture()
    stubServerInfo(serverInfo(fx.operatorCompressedHex))
    const treeParams = await treeParamsFor(fx)
    const eight = lightningSendVtxoScript(treeParams)
    const address = eight.address('ark', fx.operatorXOnly).encode()
    const base = {
      solverPubkeyHex: hex.encode(fx.solverXOnly),
      refundLocktime: treeParams.refundLocktime,
      validUntil: NOW + 100,
      receiverPkScript: fx.receiverPkScript,
      lockupAddress: address,
    }
    const toMismatch = quoteFor({ ...base, rfqId: 'aa'.repeat(32), fromAmount: FUND_AMOUNT, toAmount: AMOUNT_SATS + 1 })
    await expect(
      requestVaultLightningSend(fx.wallet, ARK_SERVER, transportFor(toMismatch), {
        invoice: facts(),
        rfqId: toMismatch.rfq_id,
      }),
    ).rejects.toThrow(/does not match the invoice/)
    const negativeSpread = quoteFor({
      ...base,
      rfqId: 'bb'.repeat(32),
      fromAmount: AMOUNT_SATS - 1,
      toAmount: AMOUNT_SATS,
    })
    await expect(
      requestVaultLightningSend(fx.wallet, ARK_SERVER, transportFor(negativeSpread), {
        invoice: facts(),
        rfqId: negativeSpread.rfq_id,
      }),
    ).rejects.toThrow(/negative spread/)
    expect(fx.createContract).not.toHaveBeenCalled()
  })

  it('refuses when the solver key changes after the lockup was derived', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fx = await covenantFixture()
    stubServerInfo(serverInfo(fx.operatorCompressedHex))
    const treeParams = await treeParamsFor(fx)
    const eight = lightningSendVtxoScript(treeParams)
    const address = eight.address('ark', fx.operatorXOnly).encode()
    const otherSolver = SingleKey.fromPrivateKey(hex.decode('0a'.padStart(64, '0')))
    const otherSolverXOnly = (await otherSolver.compressedPublicKey()).slice(1)
    const rfqId = 'cc'.repeat(32)
    const quote = quoteFor({
      rfqId,
      solverPubkeyHex: hex.encode(otherSolverXOnly),
      refundLocktime: treeParams.refundLocktime,
      validUntil: NOW + 100,
      fromAmount: FUND_AMOUNT,
      toAmount: AMOUNT_SATS,
      receiverPkScript: fx.receiverPkScript,
      lockupAddress: address,
    })
    await expect(
      requestVaultLightningSend(fx.wallet, ARK_SERVER, transportFor(quote), { invoice: facts(), rfqId }),
    ).rejects.toBeInstanceOf(AddressMismatch)
    expect(fx.createContract).not.toHaveBeenCalled()
  })

  it('refuses malformed or missing unilateral delay data', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fx = await covenantFixture()
    const treeParams = await treeParamsFor(fx)
    const eight = lightningSendVtxoScript(treeParams)
    const address = eight.address('ark', fx.operatorXOnly).encode()
    const makeQuote = (rfqId: string) =>
      quoteFor({
        rfqId,
        solverPubkeyHex: hex.encode(fx.solverXOnly),
        refundLocktime: treeParams.refundLocktime,
        validUntil: NOW + 100,
        fromAmount: FUND_AMOUNT,
        toAmount: AMOUNT_SATS,
        receiverPkScript: fx.receiverPkScript,
        lockupAddress: address,
      })
    stubServerInfo(serverInfo(fx.operatorCompressedHex, { unilateralExitDelay: undefined }))
    await expect(
      requestVaultLightningSend(fx.wallet, ARK_SERVER, transportFor(makeQuote('dd'.repeat(32))), {
        invoice: facts(),
        rfqId: 'dd'.repeat(32),
      }),
    ).rejects.toThrow()
    stubServerInfo(serverInfo(fx.operatorCompressedHex, { unilateralExitDelay: 'not-a-number' }))
    await expect(
      requestVaultLightningSend(fx.wallet, ARK_SERVER, transportFor(makeQuote('ee'.repeat(32))), {
        invoice: facts(),
        rfqId: 'ee'.repeat(32),
      }),
    ).rejects.toThrow()
    expect(fx.createContract).not.toHaveBeenCalled()
  })

  it('round-trips persisted nine-leaf params to the same address', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fx = await covenantFixture()
    stubServerInfo(serverInfo(fx.operatorCompressedHex))
    const treeParams = await treeParamsFor(fx)
    const nine = nineLeafOf(lightningSendVtxoScript(treeParams))
    const address = nine.address('ark', fx.operatorXOnly).encode()
    const rfqId = 'ab'.repeat(32)
    const quote = quoteFor({
      rfqId,
      solverPubkeyHex: hex.encode(fx.solverXOnly),
      refundLocktime: treeParams.refundLocktime,
      validUntil: NOW + 100,
      fromAmount: FUND_AMOUNT,
      toAmount: AMOUNT_SATS,
      receiverPkScript: fx.receiverPkScript,
      lockupAddress: address,
    })
    const result = await requestVaultLightningSend(fx.wallet, ARK_SERVER, transportFor(quote), {
      invoice: facts(),
      rfqId,
    })
    const persisted = VHTLCV2ContractHandler.serializeParams(result.script.options)
    expect(persisted.nonInteractiveRefundWithoutReceiver).toBe('1')
    const rebuilt = VHTLCV2ContractHandler.createScript(persisted)
    expect(rebuilt.address('ark', fx.operatorXOnly).encode()).toBe(address)
    const stored = await lockupContractParams(fx.contracts, address)
    expect(stored).toEqual(persisted)
    const rebuiltFromStore = VHTLCV2ContractHandler.createScript(stored)
    expect(rebuiltFromStore.address('ark', fx.operatorXOnly).encode()).toBe(address)
  })

  it('round-trips persisted eight-leaf params without growing a ninth leaf', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fx = await covenantFixture()
    stubServerInfo(serverInfo(fx.operatorCompressedHex))
    const treeParams = await treeParamsFor(fx)
    const eight = lightningSendVtxoScript(treeParams)
    const address = eight.address('ark', fx.operatorXOnly).encode()
    const rfqId = 'bc'.repeat(32)
    const quote = quoteFor({
      rfqId,
      solverPubkeyHex: hex.encode(fx.solverXOnly),
      refundLocktime: treeParams.refundLocktime,
      validUntil: NOW + 100,
      fromAmount: FUND_AMOUNT,
      toAmount: AMOUNT_SATS,
      receiverPkScript: fx.receiverPkScript,
      lockupAddress: address,
    })
    const result = await requestVaultLightningSend(fx.wallet, ARK_SERVER, transportFor(quote), {
      invoice: facts(),
      rfqId,
    })
    const persisted = VHTLCV2ContractHandler.serializeParams(result.script.options)
    expect('nonInteractiveRefundWithoutReceiver' in persisted).toBe(false)
    const rebuilt = VHTLCV2ContractHandler.createScript(persisted)
    expect(rebuilt.address('ark', fx.operatorXOnly).encode()).toBe(address)
    expect(rebuilt.nonInteractiveRefundWithoutReceiverScript).toBeUndefined()
  })

  it('sends the persistent phone identity as client_refund_pubkey', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fx = await covenantFixture()
    stubServerInfo(serverInfo(fx.operatorCompressedHex))
    const treeParams = await treeParamsFor(fx)
    const eight = lightningSendVtxoScript(treeParams)
    const address = eight.address('ark', fx.operatorXOnly).encode()
    const rfqId = 'cd'.repeat(32)
    const quote = quoteFor({
      rfqId,
      solverPubkeyHex: hex.encode(fx.solverXOnly),
      refundLocktime: treeParams.refundLocktime,
      validUntil: NOW + 100,
      fromAmount: FUND_AMOUNT,
      toAmount: AMOUNT_SATS,
      receiverPkScript: fx.receiverPkScript,
      lockupAddress: address,
    })
    let seen: Record<string, unknown> | undefined
    const transport = transportFor(quote, (payload) => {
      seen = payload
    })
    const result = await requestVaultLightningSend(fx.wallet, ARK_SERVER, transport, {
      invoice: facts(),
      rfqId,
    })
    const profile = (seen as unknown as { profile: Record<string, string> }).profile
    expect(profile.client_refund_pubkey).toBe(hex.encode(fx.phoneXOnly))
    expect(hex.encode(result.senderPubkey)).toBe(hex.encode(fx.phoneXOnly))
    expect(hex.encode(result.secrets.pubkey)).toBe(hex.encode(fx.phoneXOnly))
    const identityPubkey = await fx.phone.xOnlyPublicKey()
    expect(hex.encode(result.secrets.pubkey)).toBe(hex.encode(identityPubkey))
    expect(result.refundAddress).toBe(fx.vaultAddress)
    expect(hex.encode(result.secrets.pkScript)).toBe(hex.encode(ArkAddress.decode(fx.vaultAddress).pkScript))
    expect((fx.wallet as unknown as { getNextSigningDescriptor?: unknown }).getNextSigningDescriptor).toBeUndefined()
  })

  it('matches both candidates purely and persists the nine-leaf flag through the quote flow', async () => {
    vi.useFakeTimers()
    vi.setSystemTime((INVOICE_TIMESTAMP + 1) * 1000)
    const fx = await covenantFixture()
    stubServerInfo(serverInfo(fx.operatorCompressedHex))
    const secrets = await provisionRefundKey(fx.wallet)
    const treeParams: LightningSendTreeParams = {
      solverPubkey: fx.solverXOnly,
      refundLocktime: INVOICE_TIMESTAMP + 10_000,
      serverPubkey: fx.operatorXOnly,
      paymentHash: PAYMENT_HASH,
      claimDelay: fx.claimDelay,
      emulatorPubkey: fx.emulatorXOnly,
      refundPkScript: secrets.pkScript,
      senderPubkey: secrets.pubkey,
      receiverPkScript: fx.receiverPkScript,
    }
    const candidates = buildLightningSendCandidates(treeParams, 'ark', fx.operatorXOnly)
    expect(candidates.eightAddress).not.toBe(candidates.nineAddress)
    expect(matchLightningSendCandidate(candidates, candidates.eightAddress).variant).toBe('eight-leaf')
    expect(matchLightningSendCandidate(candidates, candidates.nineAddress).variant).toBe('nine-leaf')
    expect(() => matchLightningSendCandidate(candidates, 'tark1qqmismatch')).toThrow(AddressMismatch)

    const rfqId = 'ab'.repeat(32)
    const quote = quoteFor({
      rfqId,
      solverPubkeyHex: hex.encode(fx.solverXOnly),
      refundLocktime: treeParams.refundLocktime,
      validUntil: INVOICE_TIMESTAMP + 100,
      fromAmount: FUND_AMOUNT,
      toAmount: AMOUNT_SATS,
      receiverPkScript: fx.receiverPkScript,
      lockupAddress: candidates.nineAddress,
    })
    const repository = new InMemoryAssetSwapRepository()
    const { manager } = quoteManager(repository, fx.contracts)
    try {
      const stored = await requestVaultLightningQuote({
        wallet: fx.wallet,
        arkServerUrl: ARK_SERVER,
        invoice: MAINNET_INVOICE,
        network: 'bitcoin',
        transport: transportFor(quote),
        repository,
        contracts: fx.contracts,
        manager,
        profile: MAINNET_TEST_PROFILE,
        rfqId,
        nowSeconds: INVOICE_TIMESTAMP + 1,
        enabled: true,
      })
      expect(stored.fundAddress).toBe(candidates.nineAddress)
      const record = await repository.getRfqSwap(rfqId)
      expect(record?.lockupAddress).toBe(candidates.nineAddress)
      const params = await lockupContractParams(fx.contracts, candidates.nineAddress)
      expect(params.nonInteractiveRefundWithoutReceiver).toBe('1')
      const swap = rebuildRfqSwap(record!, params)
      expect(swap.lockup?.address).toBe(candidates.nineAddress)
      expect(manager.hasSwap(rfqId)).toBeTruthy()
    } finally {
      await manager.stop()
      await repository[Symbol.asyncDispose]()
    }
    expect(INVOICE_EXPIRES).toBeGreaterThan(INVOICE_TIMESTAMP)
  })

  it('restores a funded nine-leaf swap from persisted params after restart', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fx = await covenantFixture()
    stubServerInfo(serverInfo(fx.operatorCompressedHex))
    const treeParams = await treeParamsFor(fx)
    const nine = nineLeafOf(lightningSendVtxoScript(treeParams))
    const address = nine.address('ark', fx.operatorXOnly).encode()
    const persisted = VHTLCV2ContractHandler.serializeParams(nine.options)
    expect(persisted.nonInteractiveRefundWithoutReceiver).toBe('1')
    // Simulate restart: only the persisted params survive; rebuild the same tree.
    const rebuilt = VHTLCV2ContractHandler.createScript(persisted)
    expect(rebuilt.address('ark', fx.operatorXOnly).encode()).toBe(address)
    expect(hex.encode(rebuilt.pkScript)).toBe(hex.encode(nine.pkScript))
    expect(rebuilt.nonInteractiveRefundWithoutReceiverScript).toBeDefined()
    // And the eight-leaf rebuild must not gain the ninth leaf.
    const eightPersisted = VHTLCV2ContractHandler.serializeParams(lightningSendVtxoScript(treeParams).options)
    const eightRebuilt = VHTLCV2ContractHandler.createScript(eightPersisted)
    expect(eightRebuilt.nonInteractiveRefundWithoutReceiverScript).toBeUndefined()
  })

  it('binds the advertised refund delay to both shapes and persists it exactly', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fx = await covenantFixture()
    stubServerInfo(serverInfo(fx.operatorCompressedHex))
    const QUOTED = 612_864
    const treeParams = await treeParamsFor(fx, { refundLocktime: NOW + 612_384 })
    const expected = buildLightningSendCandidates(treeParams, 'ark', fx.operatorXOnly, {
      refundWithoutReceiverDelay: QUOTED,
    })
    const fixed = buildLightningSendCandidates(treeParams, 'ark', fx.operatorXOnly)
    expect(expected.eightAddress).not.toBe(expected.nineAddress)
    expect(expected.eightAddress).not.toBe(fixed.eightAddress)
    expect(expected.nineAddress).not.toBe(fixed.nineAddress)
    const rfqId = 'a1'.repeat(32)
    const quote = quoteFor({
      rfqId,
      solverPubkeyHex: hex.encode(fx.solverXOnly),
      refundLocktime: treeParams.refundLocktime,
      validUntil: NOW + 100,
      fromAmount: FUND_AMOUNT,
      toAmount: AMOUNT_SATS,
      receiverPkScript: fx.receiverPkScript,
      lockupAddress: expected.nineAddress,
      refundWithoutReceiverDelay: QUOTED,
    })
    const result = await requestVaultLightningSend(fx.wallet, ARK_SERVER, transportFor(quote), {
      invoice: facts(),
      rfqId,
    })
    expect(result.address).toBe(expected.nineAddress)
    expect(hex.encode(result.swapPkScript)).toBe(hex.encode(expected.nine.pkScript))
    expect(fx.createContract).toHaveBeenCalledOnce()
    expect(fx.createContract.mock.calls[0][0].address).toBe(expected.nineAddress)
    const stored = await lockupContractParams(fx.contracts, expected.nineAddress)
    const rebuilt = VHTLCV2ContractHandler.createScript(stored)
    expect(rebuilt.options.unilateralRefundWithoutReceiverDelay).toEqual({ type: 'seconds', value: BigInt(QUOTED) })
    expect(rebuilt.address('ark', fx.operatorXOnly).encode()).toBe(expected.nineAddress)
    expect(hex.encode(rebuilt.pkScript)).toBe(hex.encode(expected.nine.pkScript))
  })

  it('refuses a fixed-delay eight-leaf address when the quote advertises a larger delay', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fx = await covenantFixture()
    stubServerInfo(serverInfo(fx.operatorCompressedHex))
    const treeParams = await treeParamsFor(fx, { refundLocktime: NOW + 612_384 })
    const fixed = buildLightningSendCandidates(treeParams, 'ark', fx.operatorXOnly)
    const rfqId = 'a2'.repeat(32)
    const quote = quoteFor({
      rfqId,
      solverPubkeyHex: hex.encode(fx.solverXOnly),
      refundLocktime: treeParams.refundLocktime,
      validUntil: NOW + 100,
      fromAmount: FUND_AMOUNT,
      toAmount: AMOUNT_SATS,
      receiverPkScript: fx.receiverPkScript,
      lockupAddress: fixed.eightAddress,
      refundWithoutReceiverDelay: 612_864,
    })
    await expect(
      requestVaultLightningSend(fx.wallet, ARK_SERVER, transportFor(quote), { invoice: facts(), rfqId }),
    ).rejects.toBeInstanceOf(AddressMismatch)
    expect(fx.createContract).not.toHaveBeenCalled()
  })

  it('refuses malformed, too-short or excessive advertised delays before registration', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fx = await covenantFixture()
    stubServerInfo(serverInfo(fx.operatorCompressedHex))
    const treeParams = await treeParamsFor(fx, { refundLocktime: NOW + 612_384 })
    const expected = buildLightningSendCandidates(treeParams, 'ark', fx.operatorXOnly, {
      refundWithoutReceiverDelay: 612_864,
    })
    const base = {
      solverPubkeyHex: hex.encode(fx.solverXOnly),
      refundLocktime: treeParams.refundLocktime,
      validUntil: NOW + 100,
      fromAmount: FUND_AMOUNT,
      toAmount: AMOUNT_SATS,
      receiverPkScript: fx.receiverPkScript,
      lockupAddress: expected.nineAddress,
    }
    const tooShort = quoteFor({
      ...base,
      rfqId: 'b1'.repeat(32),
      refundWithoutReceiverDelay: fx.claimDelay, // 605_184, below the 609_280 floor
    })
    await expect(
      requestVaultLightningSend(fx.wallet, ARK_SERVER, transportFor(tooShort), {
        invoice: facts(),
        rfqId: tooShort.rfq_id,
      }),
    ).rejects.toThrow(/below the independently derived solo-refund floor/)
    const nonGranular = quoteFor({ ...base, rfqId: 'b2'.repeat(32), refundWithoutReceiverDelay: 612_000 })
    await expect(
      requestVaultLightningSend(fx.wallet, ARK_SERVER, transportFor(nonGranular), {
        invoice: facts(),
        rfqId: nonGranular.rfq_id,
      }),
    ).rejects.toThrow(/whole multiple/)
    const farFuture = quoteFor({
      ...base,
      rfqId: 'b3'.repeat(32),
      refundLocktime: NOW + 400 * 24 * 3600,
      refundWithoutReceiverDelay: fx.claimDelay + 4096,
    })
    await expect(
      requestVaultLightningSend(fx.wallet, ARK_SERVER, transportFor(farFuture), {
        invoice: facts(),
        rfqId: farFuture.rfq_id,
      }),
    ).rejects.toThrow(/sender recovery ceiling/)
    expect(fx.createContract).not.toHaveBeenCalled()
  })

  it('persists and restores the exact advertised delay through the quote flow', async () => {
    vi.useFakeTimers()
    vi.setSystemTime((INVOICE_TIMESTAMP + 1) * 1000)
    const fx = await covenantFixture()
    stubServerInfo(serverInfo(fx.operatorCompressedHex))
    const QUOTED = 612_864
    const secrets = await provisionRefundKey(fx.wallet)
    const treeParams: LightningSendTreeParams = {
      solverPubkey: fx.solverXOnly,
      refundLocktime: INVOICE_TIMESTAMP + 612_384,
      serverPubkey: fx.operatorXOnly,
      paymentHash: PAYMENT_HASH,
      claimDelay: fx.claimDelay,
      emulatorPubkey: fx.emulatorXOnly,
      refundPkScript: secrets.pkScript,
      senderPubkey: secrets.pubkey,
      receiverPkScript: fx.receiverPkScript,
    }
    const expected = buildLightningSendCandidates(treeParams, 'ark', fx.operatorXOnly, {
      refundWithoutReceiverDelay: QUOTED,
    })
    const rfqId = 'a3'.repeat(32)
    const quote = quoteFor({
      rfqId,
      solverPubkeyHex: hex.encode(fx.solverXOnly),
      refundLocktime: treeParams.refundLocktime,
      validUntil: INVOICE_TIMESTAMP + 100,
      fromAmount: FUND_AMOUNT,
      toAmount: AMOUNT_SATS,
      receiverPkScript: fx.receiverPkScript,
      lockupAddress: expected.nineAddress,
      refundWithoutReceiverDelay: QUOTED,
    })
    const repository = new InMemoryAssetSwapRepository()
    const { manager } = quoteManager(repository, fx.contracts)
    try {
      const stored = await requestVaultLightningQuote({
        wallet: fx.wallet,
        arkServerUrl: ARK_SERVER,
        invoice: MAINNET_INVOICE,
        network: 'bitcoin',
        transport: transportFor(quote),
        repository,
        contracts: fx.contracts,
        manager,
        profile: MAINNET_TEST_PROFILE,
        rfqId,
        nowSeconds: INVOICE_TIMESTAMP + 1,
        enabled: true,
      })
      expect(stored.fundAddress).toBe(expected.nineAddress)
      const record = await repository.getRfqSwap(rfqId)
      expect(record?.lockupAddress).toBe(expected.nineAddress)
      const params = await lockupContractParams(fx.contracts, expected.nineAddress)
      const rebuilt = VHTLCV2ContractHandler.createScript(params)
      expect(rebuilt.options.unilateralRefundWithoutReceiverDelay).toEqual({ type: 'seconds', value: BigInt(QUOTED) })
      const swap = rebuildRfqSwap(record!, params)
      expect(swap.lockup?.address).toBe(expected.nineAddress)
      expect(swap.lockup?.script.options.unilateralRefundWithoutReceiverDelay.value).toBe(BigInt(QUOTED))
    } finally {
      await manager.stop()
      await repository[Symbol.asyncDispose]()
    }
  })
})
