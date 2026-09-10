import {
  ArkAddress,
  BITCOIN_EMULATOR_PUBKEY,
  DefaultVtxo,
  SingleKey,
  VHTLCV2ContractHandler,
  type IWallet,
} from '@arkade-os/sdk'
import {
  InMemoryAssetSwapRepository,
  RfqSwapManager,
  lightningSendVtxoScript,
  unilateralClaimDelay,
  type RfqQuote,
  type SwapContractRegistry,
} from '@arkade-os/swap'
import { hex } from '@scure/base'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeVaultLightningInvoice,
  discoverVaultLightningSolver,
  getVaultLightningStatus,
  isVaultLightningInput,
  BITCOIN_LIGHTNING_SOLVER,
  MUTINYNET_LIGHTNING_SOLVER,
  requestVaultLightningQuote,
  requireMatchingLightningOperatorNetwork,
  validateVaultLightningRefund,
  vaultLightningRequestWallet,
  vaultLightningSendEnabled,
  vaultLightningSolverProfile,
  wholeSatsFromMillisats,
  withVaultLightningTransport,
  withVaultLightningLifecycleLock,
} from './lightning'
import { tryVaultLightningLifecycleLock } from './lightningLock'
import {
  INVOICE_EXPIRES,
  INVOICE_TIMESTAMP,
  MAINNET_INVOICE,
  MAINNET_TEST_PROFILE,
  MUTINYNET_INVOICE,
  MUTINYNET_INVOICE_TIMESTAMP,
  completeRequestResult,
  memoryContracts,
  lightningQuoteHarness,
  quoteManager,
  refundAddress,
} from './lightningTestUtils'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Lightning SEND release boundary', () => {
  it('exposes only the SDK capabilities required to request a Lightning quote', async () => {
    const identity = SingleKey.fromPrivateKey(hex.decode('03'.padStart(64, '0')))
    const contracts = {} as never
    const address = await refundAddress()
    const wallet = vaultLightningRequestWallet(identity, address, contracts)

    await expect(wallet.getAddress()).resolves.toBe(address)
    await expect(wallet.getContractManager()).resolves.toBe(contracts)
    expect(wallet.identity).toBe(identity)
    expect((wallet as unknown as { getNextSigningDescriptor?: unknown }).getNextSigningDescriptor).toBeUndefined()
    expect(() => (wallet as unknown as { send: unknown }).send).toThrow(/unsupported wallet capability: send/)
  })

  it('is disabled unless the release flag is exactly true', () => {
    expect(vaultLightningSendEnabled(undefined, 'true')).toBe(false)
    expect(vaultLightningSendEnabled('mutinynet', undefined)).toBe(false)
    expect(vaultLightningSendEnabled('mutinynet', 'TRUE')).toBe(false)
    expect(vaultLightningSendEnabled('mutinynet', '1')).toBe(false)
    expect(vaultLightningSendEnabled('mutinynet', 'true')).toBe(true)
    expect(vaultLightningSendEnabled('bitcoin', 'true')).toBe(true)
    expect(vaultLightningSendEnabled('mainnet', 'true')).toBe(true)
  })

  it('pins a dedicated solver per product network and never cross-wires them', () => {
    expect(vaultLightningSolverProfile('mutinynet')).toEqual(MUTINYNET_LIGHTNING_SOLVER)
    expect(vaultLightningSolverProfile('bitcoin')).toEqual(BITCOIN_LIGHTNING_SOLVER)
    expect(vaultLightningSolverProfile('mainnet')).toEqual(BITCOIN_LIGHTNING_SOLVER)
    expect(MUTINYNET_LIGHTNING_SOLVER).toMatchObject({
      network: 'mutinynet',
      minSats: 1_000,
      maxSats: 25_000,
      maxFundingSats: 25_076,
    })
    expect(BITCOIN_LIGHTNING_SOLVER).toMatchObject({
      network: 'bitcoin',
      pubkey: '66422c952f8dcb96e4d0c3f049cd1e265b8461b916d9913c65c2494b64b4e3ce',
      minSats: 500,
      maxSats: 50_000,
    })
    expect(BITCOIN_LIGHTNING_SOLVER.maxFundingSats).toBeGreaterThanOrEqual(50_000)
    expect(BITCOIN_LIGHTNING_SOLVER.pubkey).not.toBe(MUTINYNET_LIGHTNING_SOLVER.pubkey)
  })

  it('loads the bundled solver card through official discovery without following a registry', async () => {
    await expect(discoverVaultLightningSolver('mutinynet')).resolves.toMatchObject({
      pubkey: MUTINYNET_LIGHTNING_SOLVER.pubkey,
      relays: ['wss://nostr.arkade.sh'],
      minSats: 1_000,
      maxSats: 25_000,
      maxFundingSats: 25_076,
      market: { pair: 'BTC/lightning:BTC', fee_bps: 30 },
    })
    const bitcoin = await discoverVaultLightningSolver('bitcoin')
    const mainnetAlias = await discoverVaultLightningSolver('mainnet')
    expect(bitcoin).toMatchObject({
      pubkey: BITCOIN_LIGHTNING_SOLVER.pubkey,
      relays: ['wss://nostr.arkade.sh'],
      minSats: 500,
      maxSats: 50_000,
      market: { pair: 'BTC/lightning:BTC', fee_bps: 30 },
    })
    expect(mainnetAlias?.pubkey).toBe(bitcoin?.pubkey)
    expect(bitcoin?.pubkey).not.toBe(MUTINYNET_LIGHTNING_SOLVER.pubkey)
  })

  it('uses one required per-vault Web Lock for Lightning lifecycle work', async () => {
    const run = vi.fn(async () => 'done')
    const request = vi.fn(async (_name, _options, callback) => callback({ held: true }))
    await expect(withVaultLightningLifecycleLock('vault-a', run, { request } as never)).resolves.toBe('done')
    expect(request).toHaveBeenCalledWith('arkade-vault-lightning:vault-a', { mode: 'exclusive' }, expect.any(Function))
    expect(run).toHaveBeenCalledOnce()
    await expect(withVaultLightningLifecycleLock('vault-a', run, null)).rejects.toThrow(/Web Locks API/)
  })

  it('skips a background observer pass instead of waiting behind the foreground lock', async () => {
    const run = vi.fn(async () => 'done')
    const request = vi.fn(async (_name, options, callback) => {
      expect(options).toEqual({ mode: 'exclusive', ifAvailable: true })
      return callback(null)
    })

    await expect(tryVaultLightningLifecycleLock('vault-a', run, { request } as never)).resolves.toEqual({
      held: false,
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('recognizes direct and URI-wrapped BOLT11 inputs without accepting ordinary addresses', () => {
    expect(isVaultLightningInput(MUTINYNET_INVOICE)).toBe(true)
    expect(isVaultLightningInput(`lightning:${MUTINYNET_INVOICE}`)).toBe(true)
    expect(isVaultLightningInput('tark1qqexample')).toBe(false)
  })

  it('decodes the invoice locally and rejects wrong-network and expired invoices', () => {
    const facts = decodeVaultLightningInvoice(MAINNET_INVOICE, 'bitcoin', INVOICE_TIMESTAMP + 1)
    expect(facts).toEqual({
      raw: MAINNET_INVOICE,
      paymentHash: 'da9fa986cf48f56ad387495f8e840ea9ed10889bf82f67c8a7b10d5d8a27886c',
      amountSats: 2100,
      expiresAt: INVOICE_EXPIRES,
    })
    expect(() => decodeVaultLightningInvoice(MAINNET_INVOICE, 'mutinynet', INVOICE_TIMESTAMP + 1)).toThrow(
      /not for mutinynet/,
    )
    expect(() => decodeVaultLightningInvoice(MAINNET_INVOICE, 'bitcoin', INVOICE_EXPIRES)).toThrow(/expired/)
  })

  it('decodes a Mutinynet invoice without treating testnet HRP as mainnet', () => {
    expect(decodeVaultLightningInvoice(MUTINYNET_INVOICE, 'mutinynet', MUTINYNET_INVOICE_TIMESTAMP + 1)).toEqual({
      raw: MUTINYNET_INVOICE,
      paymentHash: '7bf084f590eb0ca08d0e8b37586b161c98828892346c7f432872aafb8d5f523e',
      amountSats: 2100,
      expiresAt: MUTINYNET_INVOICE_TIMESTAMP + 86_400,
    })
    expect(() => decodeVaultLightningInvoice(MUTINYNET_INVOICE, 'bitcoin', MUTINYNET_INVOICE_TIMESTAMP + 1)).toThrow(
      /not for bitcoin/,
    )
  })

  it('rejects fractional millisatoshi amounts instead of rounding them down', () => {
    expect(wholeSatsFromMillisats(2_100_000)).toBe(2100)
    try {
      wholeSatsFromMillisats(2_100_001)
      throw new Error('expected fractional invoice rejection')
    } catch (error) {
      expect(error).toMatchObject({ reason: 'fractional_amount' })
    }
  })

  it('binds the refund address to the advertised Spending script and Operator', async () => {
    const operator = SingleKey.fromPrivateKey(hex.decode('04'.padStart(64, '0')))
    const operatorPubkey = hex.encode(await operator.compressedPublicKey())
    const address = await refundAddress()
    const script = hex.encode(ArkAddress.decode(address).pkScript)
    const status = {
      enrolled: true,
      vaultId: 'vault-lightning',
      network: 'bitcoin',
      spendingArkAddress: address,
      spendingArkScript: script,
    } as import('./types').VaultStatus

    expect(validateVaultLightningRefund(status, 'bitcoin', operatorPubkey).encode()).toBe(address)
    expect(() =>
      validateVaultLightningRefund({ ...status, spendingArkScript: '51'.repeat(34) }, 'bitcoin', operatorPubkey),
    ).toThrow(/pinned script/)
    const otherOperator = SingleKey.fromPrivateKey(hex.decode('07'.padStart(64, '0')))
    const otherOperatorPubkey = hex.encode(await otherOperator.compressedPublicKey())
    expect(() => validateVaultLightningRefund(status, 'bitcoin', otherOperatorPubkey)).toThrow(
      /another Arkade Operator/,
    )
  })

  it('binds a Mutinynet refund to the current Operator without a mainnet-only gate', async () => {
    const operator = SingleKey.fromPrivateKey(hex.decode('04'.padStart(64, '0')))
    const operatorPubkey = hex.encode(await operator.compressedPublicKey())
    const address = await refundAddress('mutinynet')
    const status = {
      enrolled: true,
      vaultId: 'vault-lightning-mutinynet',
      network: 'mutinynet',
      spendingArkAddress: address,
      spendingArkScript: hex.encode(ArkAddress.decode(address).pkScript),
    } as import('./types').VaultStatus

    expect(validateVaultLightningRefund(status, 'mutinynet', operatorPubkey).encode()).toBe(address)
    expect(() => validateVaultLightningRefund(status, 'bitcoin', operatorPubkey)).toThrow(/networks do not match/)
  })

  it('treats Guardian mainnet status as the bitcoin Operator network and ark HRP', async () => {
    const operator = SingleKey.fromPrivateKey(hex.decode('04'.padStart(64, '0')))
    const operatorPubkey = hex.encode(await operator.compressedPublicKey())
    const address = await refundAddress('bitcoin')
    const status = {
      enrolled: true,
      vaultId: 'vault-lightning-mainnet',
      network: 'mainnet',
      spendingArkAddress: address,
      spendingArkScript: hex.encode(ArkAddress.decode(address).pkScript),
    } as import('./types').VaultStatus

    expect(requireMatchingLightningOperatorNetwork('mainnet', 'bitcoin')).toBe('bitcoin')
    expect(requireMatchingLightningOperatorNetwork('bitcoin', 'bitcoin')).toBe('bitcoin')
    expect(() => requireMatchingLightningOperatorNetwork('mainnet', 'mutinynet')).toThrow(/networks do not match/)
    expect(() => requireMatchingLightningOperatorNetwork('mainnet', 'mainnet')).toThrow(/networks do not match/)
    expect(validateVaultLightningRefund(status, 'bitcoin', operatorPubkey).encode()).toBe(address)
    expect(ArkAddress.decode(address).hrp).toBe('ark')
    expect(() => validateVaultLightningRefund(status, 'mutinynet', operatorPubkey)).toThrow(/networks do not match/)
    const mutinynetAddress = await refundAddress('mutinynet')
    expect(() =>
      validateVaultLightningRefund(
        {
          ...status,
          spendingArkAddress: mutinynetAddress,
          spendingArkScript: hex.encode(ArkAddress.decode(mutinynetAddress).pkScript),
        },
        'bitcoin',
        operatorPubkey,
      ),
    ).toThrow(/encoded for another network/)
  })

  it('passes the adapted wallet to the package client and retains its authoritative fee and refund facts', async () => {
    const vaultAddress = await refundAddress()
    const identity = SingleKey.fromPrivateKey(hex.decode('02'.padStart(64, '0')))
    const { contracts } = memoryContracts()
    const repository = new InMemoryAssetSwapRepository()
    const { manager } = quoteManager(repository, contracts)
    const wallet = vaultLightningRequestWallet(identity, vaultAddress, contracts as never)
    const result = await completeRequestResult(wallet, contracts)
    const requester = vi.fn(async (receivedWallet: IWallet, origin: string, _transport: unknown, params: any) => {
      expect(receivedWallet).toBe(wallet)
      expect(await receivedWallet.getAddress()).toBe(vaultAddress)
      expect(await receivedWallet.getContractManager()).toBe(contracts)
      expect(origin).toBe('https://arkade.computer')
      expect(params.invoice.amountSats).toBe(2100)
      expect(params.rfqId).toBe(result.rfqId)
      return result
    })

    const quote = await requestVaultLightningQuote({
      wallet,
      arkServerUrl: 'https://arkade.computer',
      invoice: MAINNET_INVOICE,
      network: 'bitcoin',
      transport: {} as never,
      repository,
      contracts,
      manager,
      profile: MAINNET_TEST_PROFILE,
      rfqId: result.rfqId,
      requester: requester as never,
      nowSeconds: INVOICE_TIMESTAMP + 1,
      enabled: true,
    })
    expect(quote).toMatchObject({
      invoiceAmountSats: 2100,
      fundAddress: result.address,
      fundAmountSats: 2125,
      corridorFeeSats: 25,
    })
    const record = await getVaultLightningStatus(repository, result.rfqId)
    expect(record).toMatchObject({
      rfqId: result.rfqId,
      kind: 'lightning_send',
      lockupAddress: result.address,
      amount: 2125,
      profile: {
        signer: { signingDescriptor: result.secrets.descriptor },
        hashlock: { paymentHash: result.treeParams.paymentHash },
      },
    })
    expect(record?.profile.vaultLightning).toEqual({
      version: 2,
      network: 'bitcoin',
      invoice: MAINNET_INVOICE,
      quote: result.quote,
      fundingState: 'quoted',
    })
    expect(await manager.hasSwap(result.rfqId)).toBe(true)
    await manager.stop()
    await repository[Symbol.asyncDispose]()
  })

  it('uses the published package to derive, verify, and register the VHTLC before returning it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime((INVOICE_TIMESTAMP + 1) * 1000)
    const phone = SingleKey.fromPrivateKey(hex.decode('02'.padStart(64, '0')))
    const operator = SingleKey.fromPrivateKey(hex.decode('04'.padStart(64, '0')))
    const solver = SingleKey.fromPrivateKey(hex.decode('05'.padStart(64, '0')))
    const receiver = SingleKey.fromPrivateKey(hex.decode('06'.padStart(64, '0')))
    const operatorPub = (await operator.compressedPublicKey()).slice(1)
    const solverPub = (await solver.compressedPublicKey()).slice(1)
    const receiverPub = (await receiver.compressedPublicKey()).slice(1)
    const receiverScript = new DefaultVtxo.Script({
      pubKey: receiverPub,
      serverPubKey: operatorPub,
      csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
    }).pkScript
    const vaultAddress = await refundAddress()
    const { contracts, createContract } = memoryContracts()
    const repository = new InMemoryAssetSwapRepository()
    const { manager } = quoteManager(repository, contracts)
    const wallet = vaultLightningRequestWallet(phone, vaultAddress, contracts as never)
    const info = {
      version: 'v0.9.16-rc.11',
      signerPubkey: hex.encode(await operator.compressedPublicKey()),
      forfeitPubkey: hex.encode(await operator.compressedPublicKey()),
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
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://arkade.computer/v1/info')
      return new Response(JSON.stringify(info), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const transport = {
      requestQuote: vi.fn(async (request: any): Promise<RfqQuote> => {
        const refundLocktime = INVOICE_TIMESTAMP + 10_000
        const script = lightningSendVtxoScript({
          solverPubkey: solverPub,
          refundLocktime,
          serverPubkey: operatorPub,
          paymentHash: 'da9fa986cf48f56ad387495f8e840ea9ed10889bf82f67c8a7b10d5d8a27886c',
          claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
          emulatorPubkey: hex.decode(BITCOIN_EMULATOR_PUBKEY).slice(1),
          refundPkScript: ArkAddress.decode(vaultAddress).pkScript,
          senderPubkey: hex.decode(request.profile.client_refund_pubkey),
          receiverPkScript: receiverScript,
        })
        return {
          v: 1,
          type: 'rfq_quote',
          rfq_id: request.rfq_id,
          pair: 'arkade:BTC->lightning:BTC',
          amount_side: 'to',
          from_amount: 2125,
          to_amount: 2100,
          solver_pubkey: hex.encode(solverPub),
          valid_until: INVOICE_TIMESTAMP + 100,
          refund_locktime: refundLocktime,
          profile: {
            receiver_pk_script: hex.encode(receiverScript),
            lockup_address: script.address('ark', operatorPub).encode(),
          },
        }
      }),
      status: vi.fn(),
      close: vi.fn(),
    }

    const quote = await requestVaultLightningQuote({
      wallet,
      arkServerUrl: 'https://arkade.computer',
      invoice: MAINNET_INVOICE,
      network: 'bitcoin',
      transport,
      repository,
      contracts,
      manager,
      profile: MAINNET_TEST_PROFILE,
      rfqId: 'ab'.repeat(32),
      nowSeconds: INVOICE_TIMESTAMP + 1,
      enabled: true,
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(createContract).toHaveBeenCalledOnce()
    expect(createContract).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'vhtlc-v2',
        metadata: { genericallySpendable: false, kind: 'rfq-swap-lockup' },
      }),
    )
    const registered = createContract.mock.calls[0][0]
    const rebuilt = VHTLCV2ContractHandler.createScript(registered.params)
    expect(hex.encode(rebuilt.options.nonInteractiveRefund!.senderPkScript)).toBe(
      hex.encode(ArkAddress.decode(vaultAddress).pkScript),
    )
    const record = await repository.getRfqSwap(quote.rfqId)
    expect(registered.address).toBe(record?.lockupAddress)
    expect(registered.script).toBe(hex.encode(ArkAddress.decode(record!.lockupAddress).pkScript))
    await manager.stop()
    await repository[Symbol.asyncDispose]()
  })

  it('always closes the package Nostr transport', async () => {
    const transport = { close: vi.fn(async () => {}) } as unknown as import('@arkade-os/swap').RfqTransport
    await expect(
      withVaultLightningTransport(
        MAINNET_TEST_PROFILE,
        async () => 'quoted',
        () => transport,
      ),
    ).resolves.toBe('quoted')
    expect(transport.close).toHaveBeenCalledOnce()

    const rejected = { close: vi.fn(async () => {}) } as unknown as import('@arkade-os/swap').RfqTransport
    await expect(
      withVaultLightningTransport(
        MAINNET_TEST_PROFILE,
        async () => {
          throw new Error('solver unavailable')
        },
        () => rejected,
      ),
    ).rejects.toThrow(/solver unavailable/)
    expect(rejected.close).toHaveBeenCalledOnce()
  })

  it('withholds a quote when the registered contract row does not contain the package-derived recovery tree', async () => {
    const vaultAddress = await refundAddress()
    const { contracts, rows } = memoryContracts()
    const repository = new InMemoryAssetSwapRepository()
    const { manager } = quoteManager(repository, contracts)
    const wallet = vaultLightningRequestWallet(
      SingleKey.fromPrivateKey(hex.decode('02'.padStart(64, '0'))),
      vaultAddress,
      contracts as never,
    )
    const result = await completeRequestResult(wallet, contracts)
    const script = hex.encode(result.script.pkScript)
    const contract = rows.get(script)!
    rows.set(script, { ...contract, params: { ...contract.params, refundLocktime: '1' } })

    await expect(
      requestVaultLightningQuote({
        wallet,
        arkServerUrl: 'https://arkade.computer',
        invoice: MAINNET_INVOICE,
        network: 'bitcoin',
        transport: {} as never,
        repository,
        contracts,
        manager,
        profile: MAINNET_TEST_PROFILE,
        rfqId: result.rfqId,
        requester: vi.fn(async () => result) as never,
        nowSeconds: INVOICE_TIMESTAMP + 1,
        enabled: true,
      }),
    ).rejects.toThrow(/does not contain the quoted recovery tree/)

    expect(await repository.getRfqSwap(result.rfqId)).toBeUndefined()
    expect(rows.get(script)?.watch).toBe('retained')
    await manager.stop()
    await repository[Symbol.asyncDispose]()
  })

  it('does not contact a solver while the release gate is off', async () => {
    const requester = vi.fn()
    await expect(
      requestVaultLightningQuote({
        wallet: {} as IWallet,
        arkServerUrl: 'https://arkade.computer',
        invoice: MAINNET_INVOICE,
        network: 'bitcoin',
        transport: {} as never,
        repository: {} as InMemoryAssetSwapRepository,
        contracts: {} as SwapContractRegistry,
        manager: {} as RfqSwapManager,
        profile: MAINNET_TEST_PROFILE,
        requester: requester as never,
        nowSeconds: INVOICE_TIMESTAMP + 1,
        enabled: false,
      }),
    ).rejects.toThrow(/not enabled/)
    expect(requester).not.toHaveBeenCalled()
  })

  it('rejects a quote above the pinned Arkade funding corridor before Review', async () => {
    const harness = await lightningQuoteHarness()
    const result = await completeRequestResult(harness.wallet, harness.contracts, { fundAmount: 50_001 })

    await expect(
      requestVaultLightningQuote({
        wallet: harness.wallet,
        arkServerUrl: 'https://arkade.computer',
        invoice: MAINNET_INVOICE,
        network: 'bitcoin',
        transport: {} as never,
        repository: harness.repository,
        contracts: harness.contracts,
        manager: harness.manager,
        profile: { ...MAINNET_TEST_PROFILE, maxFundingSats: 50_000 },
        rfqId: result.rfqId,
        requester: vi.fn(async () => result) as never,
        nowSeconds: INVOICE_TIMESTAMP + 1,
        enabled: true,
      }),
    ).rejects.toThrow(/funding amount exceeds.*50,000 sat limit/)

    expect(await harness.repository.getRfqSwap(result.rfqId)).toBeUndefined()
    await harness.manager.stop()
    await harness.repository[Symbol.asyncDispose]()
  })

  it('rejects a quote above the published solver fee ceiling before Review', async () => {
    const harness = await lightningQuoteHarness()
    const result = await completeRequestResult(harness.wallet, harness.contracts, { fundAmount: 2_126 })

    await expect(
      requestVaultLightningQuote({
        wallet: harness.wallet,
        arkServerUrl: 'https://arkade.computer',
        invoice: MAINNET_INVOICE,
        network: 'bitcoin',
        transport: {} as never,
        repository: harness.repository,
        contracts: harness.contracts,
        manager: harness.manager,
        profile: MAINNET_TEST_PROFILE,
        rfqId: result.rfqId,
        requester: vi.fn(async () => result) as never,
        nowSeconds: INVOICE_TIMESTAMP + 1,
        enabled: true,
      }),
    ).rejects.toThrow(/pinned solver fee allows at most 2,125 sats/)

    expect(await harness.repository.getRfqSwap(result.rfqId)).toBeUndefined()
    await harness.manager.stop()
    await harness.repository[Symbol.asyncDispose]()
  })
})
