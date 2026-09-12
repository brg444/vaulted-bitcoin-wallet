// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const root = process.cwd()
const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile)
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options

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

it.each(['src/lib/vault/networkPins.ts', 'src/lib/vault/recovery/finalization.ts'])(
  '%s has no transitive dependency on payment coordination or screens',
  (entry) => {
    const seen = new Set<string>()
    const visit = (path: string) => {
      if (seen.has(path)) return
      seen.add(path)
      for (const target of imports(path)) {
        expect(target, `${path} imports ${target}`).not.toMatch(
          /\/screens\/|\/vtxo\/spend\.ts$|\/spendingBitcoinFunding\.ts$/,
        )
        visit(target)
      }
    }
    visit(entry)
  },
)

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
