export async function setupLedgerUi(width) {
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { VaultContext } = await import('/src/vault/context.ts')
  const { ledgerPaymentFixture } = await import('/src/test/ledgerSavingsFixture.ts')
  const { LedgerHardware } = await import('/src/screens/Vault/onboard/Ledger.tsx')
  const { default: Approval } = await import('/src/screens/Vault/LedgerSavingsApproval.tsx')
  const { default: Receive } = await import('/src/screens/Vault/Receive.tsx')
  const { default: Recovery } = await import('/src/screens/Vault/LedgerRecovery.tsx')
  const { ledgerRecoveryFixture } = await import('/src/lib/vault/recovery/testdata/ledger.ts')
  const recovery = await ledgerRecoveryFixture(false, 'mainnet')
  const { default: Plan } = await import('/src/screens/Vault/onboard/Plan.tsx')
  await import('/src/screens/Vault/vault.css')
  await import('/src/screens/Vault/vault-system.css')
  await import('/src/screens/Vault/quiet-guardian-flows.css')
  await import('/src/screens/Vault/qg/layout.css')
  await import('/src/screens/Vault/quiet-guardian-screens.css')
  const { default: vectors } = await import('/src/lib/vault/program/ledger-key-vectors.json')
  const { payment, family } = ledgerPaymentFixture(
    vectors.find((vector) => vector.input.network === 'mainnet' && !vector.input.recovery),
  )
  await import('/src/tokens.css')
  await import('/src/app.css')
  await import('/src/index.css')
  document.body.innerHTML = '<main id="root" class="page" data-testid="vault-app"></main>'
  const app = createRoot(document.querySelector('#root'))
  if (width < 600) {
    Reflect.deleteProperty(navigator, 'hid')
    Reflect.deleteProperty(Object.getPrototypeOf(navigator), 'hid')
  }
  const state = {
    account: 'savings',
    networkLabel: 'Bitcoin',
    savingsAddress: family.receive.address,
    status: { templateVersion: payment.contract.context.templateVersion, network: 'mainnet' },
    setup: {
      protectionTier: 'standard',
      hardwarePub: '02' + '11'.repeat(32),
      txCapSats: 50000,
      dailyLimitSats: 100000,
      ledger: { hardware: payment.contract.context.hardware },
    },
  }
  const screens = {
    recovery: () => React.createElement(Recovery, { kit: recovery.kit, status: recovery.status, back: () => {} }),
    receive: () => React.createElement(Receive),
    setup: () => React.createElement(LedgerHardware),
    plan: () => React.createElement(Plan),
    payment: () =>
      React.createElement(Approval, {
        mode: 'sign',
        payment,
        phonePsbt: 'fixture-only',
        registration: {},
        onSigned: async () => {},
        onBack: () => {},
      }),
  }
  window.showLedgerFixture = (name) =>
    app.render(
      React.createElement(VaultContext.Consumer, null, (defaults) =>
        React.createElement(VaultContext.Provider, { value: { ...defaults, ...state } }, screens[name]()),
      ),
    )
}
