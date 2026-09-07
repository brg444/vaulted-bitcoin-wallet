# Vaulted documentation

These documents describe the implementation in this checkout. Deployed
capabilities also depend on the connected Guardian and wallet build settings.

| Guide                                              | Contents                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| [Architecture](architecture.md)                    | Wallet, worker, Guardian, Operator, and storage responsibilities      |
| [Programs](program.md)                             | Light, Standard, Advanced, connector versions, and recovery authority |
| [Security](security.md)                            | Enforced checks and remaining trust assumptions                       |
| [Recovery with saved files](emergency-recovery.md) | Backups, required keys, delays, and the recovery companion            |
| [Light](light.md)                                  | Passkey setup, Spending, watch-only Savings, and owner recovery       |
| [Automatic backup](light-automatic-backup.md)      | Encryption, synchronization, freshness, and passkey access            |
| [Delegated renewal](light-delegated-renewal.md)    | Bounded renewal authority and recovery-data reconciliation            |
| [Boarding](boarding.md)                            | Confirmed onchain deposits entering Spending                          |
| [Savings signers](connector-signers.md)            | Descriptor import and external transaction approval                   |
| [Lightning send](lightning.md)                     | Funding, payment state, and refunds                                   |
| [Interface components](interface-system.md)        | Shared components, layout tokens, and browser checks                  |
| [Testing](testing.md)                              | Reproducible checks and their coverage limits                         |
| [Dependencies](upstream-alignment.md)              | SDK provenance and compatibility requirements                         |
| [Dependency checks](advisories.md)                 | Production dependency audit commands                                  |

Network-specific program parameters are in the [Mutinynet Contract Pack](../src/lib/vault/contract-pack.json)
and [mainnet Contract Pack](../src/lib/vault/contract-pack.mainnet.json).
Service contracts are documented in [Arkade Runtime](https://github.com/brg444/arkade-runtime/tree/main/docs).
