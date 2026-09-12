// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const root = process.cwd()
const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile)
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options

const files = (directory: string): string[] =>
  readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    return entry.isDirectory() ? files(path) : [path]
  })

function imports(path: string) {
  const filename = resolve(root, path)
  const ast = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
  const paths: string[] = []
  const add = (specifier: string) => {
    const found = ts.resolveModuleName(specifier, filename, options, ts.sys).resolvedModule
    if (found && !found.isExternalLibraryImport) paths.push(relative(root, found.resolvedFileName))
  }
  const walk = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const onlyTypes =
        clause?.isTypeOnly ||
        (clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly))
      if (!onlyTypes && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      const onlyTypes =
        node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((element) => element.isTypeOnly)
      if (!onlyTypes && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      add(node.arguments[0].text)
    }
    ts.forEachChild(node, walk)
  }
  walk(ast)
  return paths
}

it.each([
  'src/lib/vault/networkPins.ts',
  'src/lib/vault/recovery/finalization.ts',
  'src/lib/vault/accountRuntime.ts',
  'src/lib/vault/accountMaintenance.ts',
])('%s has no transitive dependency on payment coordination or screens', (entry) => {
  const seen = new Set<string>()
  const visit = (path: string) => {
    if (seen.has(path)) return
    seen.add(path)
    for (const target of imports(path)) {
      expect(target, `${path} imports ${target}`).not.toMatch(
        /\/screens\/|\/vtxo\/spend\.ts$|\/vtxo\/walletWorker\.ts$|\/spendingBitcoinFunding\.ts$/,
      )
      visit(target)
    }
  }
  visit(entry)
})

it.each([
  'useSpendingRenewals',
  'useSpendingBitcoin',
  'useLedgerSavings',
  'useRecoveryArchive',
  'useRecoveryKit',
  'useRecoveryAlerts',
])('%s uses the account maintenance clock', (name) => {
  const source = readFileSync(resolve(root, `src/vault/${name}.ts`), 'utf8')
  const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true)
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const call = node.expression
      const identifier = ts.isPropertyAccessExpression(call) ? call.name.text : ts.isIdentifier(call) ? call.text : ''
      expect(identifier).not.toMatch(/^set(Interval|Timeout)$/)
    }
    ts.forEachChild(node, walk)
  }
  walk(ast)
})

it('recovery alert presentation consumes account-owned observation without a separate poll', () => {
  const owner = readFileSync(resolve(root, 'src/lib/vault/accountRecoveryWatch.ts'), 'utf8')
  const binding = readFileSync(resolve(root, 'src/vault/useRecoveryAlerts.ts'), 'utf8')
  const kit = readFileSync(resolve(root, 'src/vault/useRecoveryKit.ts'), 'utf8')
  expect(owner).toContain("'recovery-watch'")
  expect(owner).not.toMatch(/setInterval|setTimeout|addEventListener/)
  expect(binding).toContain('useSyncExternalStore')
  expect(binding).not.toMatch(/fetchAddressUtxos|pollPendingInitiates/)
  expect(kit).not.toMatch(/initiateAlert|pollPendingInitiates|fetchAddressUtxos/)
})

it('Lightning invoice observation delegates reconciliation and cadence to the account owner', () => {
  const screen = readFileSync(resolve(root, 'src/screens/Vault/LightningReceive.tsx'), 'utf8')
  const observation = readFileSync(resolve(root, 'src/lib/vault/lightningReceiveObservation.ts'), 'utf8')
  expect(screen).not.toMatch(/reconcileVaultLightningReceives|refreshBalance/)
  expect(observation).not.toMatch(/reconcileVaultLightningReceives|setInterval|setTimeout/)
})

it('capture has no payment mutation or SDK history dependency', () => {
  const file = 'src/lib/vault/recovery/capture.ts'
  expect(imports(file)).not.toContain('src/lib/vault/vtxo/walletWorker.ts')
  expect(imports(file)).not.toContain('src/lib/vault/spendingBitcoinFunding.ts')
  const ast = ts.createSourceFile(file, readFileSync(resolve(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
  const paymentImports = ast.statements.filter(
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '../spendingBitcoinStore',
  )
  expect(paymentImports).toHaveLength(1)
  const bindings = paymentImports[0].importClause?.namedBindings
  expect(
    bindings && ts.isNamedImports(bindings)
      ? bindings.elements.map((item) => item.propertyName?.text ?? item.name.text)
      : [],
  ).toEqual(['readSpendingBitcoin'])
})

it('Qg presentation primitives have no transitive wallet state or Help-flow dependency', () => {
  const seen = new Set<string>()
  const visit = (path: string) => {
    if (seen.has(path)) return
    seen.add(path)
    for (const target of imports(path)) {
      expect(target, `${path} imports ${target}`).not.toMatch(
        /src\/(vault|providers|lib\/vault)\/|\/(Help|RecoveryHelp|WalletScreen)\.tsx$/,
      )
      visit(target)
    }
  }
  visit('src/screens/Vault/qg/QgScreen.tsx')
})

it('wallet implementation modules have no runtime import cycle', () => {
  const paths = new Set(
    [...files('src'), ...files('api')].filter(
      (path) =>
        /\.tsx?$/.test(path) &&
        !path.endsWith('.d.ts') &&
        !/(^|\/)(test|testdata|fixtures)(\/|\.|$)|\.(test|fixture)\./.test(path),
    ),
  )
  const active = new Set<string>(),
    done = new Set<string>()
  const visit = (path: string, chain: string[]) => {
    if (done.has(path)) return
    if (active.has(path)) throw new Error(`Runtime import cycle: ${[...chain, path].join(' -> ')}`)
    active.add(path)
    for (const next of imports(path)) if (paths.has(next)) visit(next, [...chain, path])
    active.delete(path)
    done.add(path)
  }
  for (const path of paths) visit(path, [])
})

it('session activation and mutation stay outside React consumers', () => {
  for (const path of [...files('src/screens'), ...files('src/providers'), ...files('src/vault')]) {
    if (!/\.tsx?$/.test(path) || /\.(test|fixture)\./.test(path)) continue
    for (const target of imports(path)) {
      expect(target, `${path} imports ${target}`).not.toMatch(
        /src\/lib\/vault\/(signIn|tenantEnrollment|recovery\/restore|vtxo\/board)\.ts$/,
      )
    }
    const source = readFileSync(resolve(root, path), 'utf8')
    expect(source, path).not.toMatch(
      /\b(setSessionLocked|saveSelectedVaultId|saveEnrollment|saveStagedEnrollment|loadStagedEnrollment|saveVaultPrivacyLock)\b/,
    )
  }
  const controller = readFileSync(resolve(root, 'src/lib/vault/session.ts'), 'utf8')
  expect(controller).not.toMatch(/from ['"]react['"]|from ['"].*\/(screens|providers|vault)\//)
  const binding = readFileSync(resolve(root, 'src/vault/useVaultSession.ts'), 'utf8')
  expect(binding).toContain('useSyncExternalStore')
  expect(binding).not.toMatch(/useState|loadEnrollment|fetchVaultStatus|setInterval|addEventListener/)
})

it('balance state belongs to the controller and React only binds its external store', () => {
  const controller = readFileSync(resolve(root, 'src/lib/vault/accountBalances.ts'), 'utf8')
  const hook = readFileSync(resolve(root, 'src/vault/useVaultBalances.ts'), 'utf8')
  expect(controller).not.toMatch(/from ['"]react['"]|from ['"].*\/screens\//)
  expect(hook).toContain('useSyncExternalStore')
  expect(hook).not.toMatch(/fetchVault|saveBalanceSnapshot|setTimeout|setInterval|reconcilePersisted/)
})

it('balance observations and primary Receive use account maintenance without local timers', () => {
  for (const path of ['src/lib/vault/accountBalances.ts', 'src/screens/Vault/Receive.tsx']) {
    const source = readFileSync(resolve(root, path), 'utf8')
    expect(source).not.toMatch(/setTimeout|setInterval|window\.addEventListener/)
  }
  const controller = readFileSync(resolve(root, 'src/lib/vault/accountBalances.ts'), 'utf8')
  expect(controller).toContain("observe('spending-balance'")
  expect(controller).toContain("observe('savings-balance'")
  const receive = readFileSync(resolve(root, 'src/screens/Vault/Receive.tsx'), 'utf8')
  expect(receive).toContain('requestCadence')
  expect(receive).not.toContain('refreshBalance')
})
