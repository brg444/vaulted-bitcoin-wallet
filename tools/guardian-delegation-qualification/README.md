# Guardian delegation SDK fixtures

`fixture.ts` creates owner-signed requests through the vendored SDK's
`DelegateManagerImpl`, then bounds the registration lifetime with the public
`Intent.create` primitive and a fresh owner signature. The original partial
forfeit is preserved. A separate input-scoped SDK delete proof authorizes queue
cleanup without spending funds. It uses public test keys and synthetic VTXOs; network
access is disabled. Guardian consumes the JSON in
`internal/application/testdata/light-delegation-sdk.json` through
`TestLightDelegationActualSDKRequests`.

From the wallet repository, generate a candidate fixture:

```sh
node --input-type=module <<'JS'
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
await build({
  entryPoints: ['tools/guardian-delegation-qualification/fixture.ts'],
  outfile: '.vault-browser-tests/guardian-delegation-fixture.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  define: { 'import.meta.env': '{}', '__VAULT_E2E_OPERATOR_ORIGIN__': '""' },
});
JS
node .vault-browser-tests/guardian-delegation-fixture.mjs /tmp/light-delegation-sdk.json
```

The four vectors cover both release networks, zero fees, and a 150-sat quote
whose signed transaction pays 100 sats. The pinned SDK calculates the output
fee before adding its receiver; this mismatch must be rejected before native
execution. The nonzero-fee vectors also exercise committed preconfirmed VTXOs.
`operatorFee` records the signed amount and `quotedOperatorFee` records the
input-plus-output fee quote.

The fixture clock is fixed. A future SDK input expiry keeps generation stable;
`coinExpiresAt` supplies the separate test-clock indexer metadata. These cases
verify request compatibility and signature validation, without qualifying live
renewal, restart recovery, or a funded exit.
