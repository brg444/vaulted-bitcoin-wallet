# Vaulted Light implementation

Status: lifecycle qualification complete, September 5, 2026. **Ready for the RC mainnet rollout once the release commit has green CI.** Deployment has not been performed.

The `vaulted-light-v1` profile uses `vault-light-policy-v1` Spending with immutable per-payment and rolling 24-hour limits. Standard and Advanced keep their existing keys, descriptors, recovery paths, and authenticated ledger records.

## Implemented behavior

The wallet and Go runtime independently reconstruct the same two-leaf contract. Cooperative payments require the owner, Vault policy cosigner, and stock Arkade Operator. The owner can use the separate Bitcoin exit after the release-pinned delay; this emergency path does not enforce ordinary payment limits.

Light enrollment creates a resident PRF-capable passkey and an independent owner key. The runtime validates the WebAuthn ceremony, derives a Light-scoped cosigner, binds the exact policy and descriptor, and atomically consumes the admission token. The shared invitation setting applies: `VAULT_INVITE_ONLY=false` issues a short-lived admission session without a manual invitation.

Owner-key backups use separate AES-GCM envelopes for the passkey PRF and a random 32-byte recovery secret. Enrollment requires reopening the saved file and decrypting its owner key with the saved secret before completion. An unfinished setup survives reload with encrypted material only; the recovery secret must already have been saved separately. Confirmed expiry offers an explicit restart, while a completed ceremony still replays its original wallet after a lost response. Ordinary restoration requires the original passkey and matching saved descriptor.

The Spending screen uses the existing reservation, authorization, checkpoint, reconciliation, and activity machinery. Light's service worker receives only its public descriptor and rejects signing requests. The UI exposes direct Arkade receipt and payments, plus a separate watch-only Bitcoin address for Savings. An unavailable Savings update clears the previous balance.

The wallet captures current output metadata and complete transaction paths into an atomic local archive. Incomplete captures retain the previous archive. Recovery can use that archive or an imported archive with no Operator requests; the Bitcoin explorer remains required. The screen shows the archive date, and files must be updated after receiving, paying, or renewing.

Emergency recovery can prepare an owner-signed SDK graph package for the current outputs and execute a previously prepared package through Bitcoin explorer requests. The package signature binds its complete contents, descriptor, destination, and fee address. Completion requires confirmation of every prepared sweep; an exhausted SDK iterator with failed branches cannot produce a success notice. The funded contract exit has confirmed; the enrolled-wallet exit is described below.

## Rollout and binaries

The new runtime binary defaults `VAULT_LIGHT_ENABLED` to `false`. Setting it to `true` advertises Light in `supportedSetups` and allows new Light enrollment starts. Disabling it later preserves already-started ceremonies and existing Light wallets. This switch is independent of `VAULT_INVITE_ONLY`.

The wallet displays the three setup choices only when the runtime advertises Light. Mainnet and Mutinynet Vercel configurations route Light enrollment through the existing flat gateway function. A wallet build and updated runtime binary are required; this candidate makes no hardware firmware change and requests no stock Operator binary change. Schema version 2 requires a compatible runtime during rollback; preserve the current database, key material, and independent policy sequence.

The vendored SDK remains at the reviewed Vaulted lineage documented in `node_modules/@arkade-os/sdk/ORIGIN.md`. Replacing it with a published package would discard required boarding changes. Any SDK extension must retain the selective Lightning patches as well.

## Verification

- Shared wallet/Go vectors cover both release networks, scripts, control blocks, policy digests, and descriptor hashes.
- Runtime tests cover open and invite-only enrollment, frozen identities, restart, lost responses, protected change, per-payment limits, authenticated payment signing, and Light-specific key derivation.
- Wallet tests reject cross-profile substitutions, corrupted backups, wrong secrets, invalid imported keys, altered exit packages, and incomplete recovery execution.
- The HTTPS browser test uses a real Chromium virtual PRF passkey against the Go application, with an isolated Operator fixture. It covers file verification, reload during setup, enrollment, worker balance loading, Receive, reload/unlock, Security, and narrow-screen dark mode. It does not fund a live test-network wallet.
- The wallet passed 929 unit tests, including the expiry-reminder checks. Type checking, wallet lint, the mainnet build, and 69 regression browser checks passed. The opt-in Light browser checks additionally cover restoration with the original PRF passkey and recovery without it.
- Runtime full tests, race checks, lint, vulnerability analysis, and all three image builds passed. The vulnerability scan found no affected call paths. Live mainnet dependency pins were verified separately.

The HTTP compatibility golden adds Light enrollment and renewal shapes, eight routes, optional Light status fields, and the public setup list. Existing Contract Pack and cryptographic vectors remain byte-identical. Runtime schema version 2 adds authenticated renewal operations and events; existing records retain their original MAC encodings.

## Funded contract drill

A fresh Mutinynet Light script received 50,000 test sats. The application prepared a complete owner-signed graph package for that output. A separate disposable SDK wallet supplied confirmed Bitcoin fee funds after the faucet's onchain route failed. The saved-package executor confirmed all three prerequisite transactions and reached the owner-only timelock, while its network boundary rejected non-Bitcoin provider requests. The final owner-only sweep `3dac10a244fad7a0eae62a5575b4fc44d72a225708cbd650b4488e0f24bb48e6` confirmed at Mutinynet block 3402166, recovering 49,702 sats. The executor contacted neither Vault nor the Operator. This qualifies the contract exit; it does not replace renewal and enrolled-wallet lifecycle checks.

A separate mobile Chromium drill then enrolled through the Go application with a real virtual PRF passkey, received 50,000 Mutinynet sats, and paid 10,000 sats through the real reservation, authorization, checkpoint, and finalization endpoints. The payment transaction is `ff9da7c269c6dd119e325e9f7be1b9cb3376670b929c3cc63f222a9c3d6bb55d`. Its initial test assertion matched two success headings and failed after the payment completed; the assertion now selects the main heading. A subsequent passing browser test prepared recovery of all 40,000 sats of protected change from the saved file and secret, without a passkey, and verified the runtime's 10,000-sat usage and 40,000-sat remaining allowance.

## Funded renewal and recovery qualification

The real mobile browser flow now passes enrollment, 50,000-sat receipt, 10,000-sat payment, renewal of the protected 40,000-sat change, reload/unlock, and recovery preparation without a passkey. Both current-data and saved-data recovery pass. The saved-data check reloads the app, blocks Operator requests, and requires the same output set. The wallet also accepts a validated imported archive when local browser storage is unavailable.

One confirmed renewal commitment is `3976d350f7026b89f908b142b2d636f8f39234818b02222977b6fb4c76c88ac0`, with replacement output `28c5de13b7841c29cff756f928b2c2021bab1a1114e30bb67baa6e03f85a173e:0`. Repeating its status, registration, and final requests before and after a full runtime process restart returns the same confirmed result without changing durable renewal events. An interrupted registration releases after expiry, with repeated release returning the same terminal result. Two simultaneous live renewal preparations produce exactly one reservation; cancellation closes that reservation before dispatch.

The renewed output's saved emergency package has three transactions, requires 556 sats of external Bitcoin fee funding, and recovers 39,702 sats after a 298-sat sweep fee. Its owner-only sweep `6d81bce760c9be5d6ededa382fc1ccedb000b0eecd3e5adadfd386d5063796df` confirmed at Mutinynet block 3402489, recovering the full quoted 39,702 sats after the 4,608-second delay. The executor completed with every request restricted to the Mutinynet Bitcoin explorer, while the local Vault service was stopped and no passkey was available.

The renewal flow quotes its fee before confirmation, retains the same Light script and limits, and charges only the fee against the shared allowance. The runtime verifies the complete signed replacement tree and exact forfeit before cosigning. Durable dispatch records prevent automatic resubmission after an unknown outcome. The wallet shows the next expiry and reminds the user within three days; expired balances direct the user to recovery options. Setup and recovery display the configured owner-only delay. Recovery progress distinguishes confirmed steps, waiting deadlines, and failures, with Bitcoin explorer links and a tested pause/resume action.

The pinned SDK remains unchanged. Wallet adapters preserve public MuSig metadata when serializing the signed tree and omit an explicit default-sighash PSBT field that the Go serializer canonically omits. The runtime continues to require canonical proofs and independently valid signatures. Tests cover both serialization cases with the pinned SDK.

The repeatable tools and private-state requirements are documented in `tools/light-qualification/README.md`. Merge and enable Light on RC after the final commit checks pass. The intended release target is `rc.getvaulted.xyz`; `app.getvaulted.xyz` is outside this rollout.

## Local browser check

From the runtime checkout, start the opt-in harness with Go 1.26.6:

```bash
VAULT_LIGHT_BROWSER_ADDR=127.0.0.1:18898 VAULT_LIGHT_BROWSER_ORIGIN=https://localhost:3119 go test ./internal/application -run '^TestLightBrowserHarness$' -v -count=1 -timeout=25m
```

From the wallet checkout:

```bash
node scripts/prepare-browser-tests.mjs
HTTPS=true VAULT_E2E_PORT=3119 VAULT_E2E_OPERATOR_PORT=18897 VAULT_LIGHT_BROWSER_API=http://127.0.0.1:18898 pnpm exec playwright test -c playwright.vault.config.ts light.test.ts --project='Mobile Chrome'
```

The harness binds loopback, uses ephemeral test keys and a temporary ledger, and stops after 45 minutes. HTTPS certificate relaxation belongs only to the local Playwright process; production origin validation remains intact.
