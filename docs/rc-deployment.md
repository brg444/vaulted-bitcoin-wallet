# RC deployment

The release target and passkey signing address are `https://rc.getvaulted.xyz`.
Guardian must advertise that exact `clientOrigin` and `rpId: rc.getvaulted.xyz`
through `/v1/status`. The wallet follows Guardian’s signing address before a
passkey ceremony; an app-domain setting sends an RC visitor to that domain.

## Assemble the release

Use a clean, integrated wallet `main` checkout with its pinned recovery
companion. Verify the vendored SDK, both Contract Packs and companion producer
inputs. Use Node 24.15.0 and the pnpm version pinned in `package.json`.

Build the complete mainnet frontend, worker and gateway from the same revision.
`vercel.mainnet.json` supplies the mainnet feature flags. For a local Vercel
build, pass its build environment explicitly and bind the commit to the checkout:

```sh
export VERCEL_GIT_COMMIT_SHA="$(git rev-parse HEAD)"
export VITE_GIT_COMMIT="$(git rev-parse --short=8 HEAD)"
export VAULT_RELEASE_NETWORK=mainnet VITE_VAULT_RELEASE_NETWORK=mainnet
export VAULT_LIGHT_ONLY_ENROLLMENT=true VITE_VAULT_LIGHT_ONLY_ENROLLMENT=true
export VITE_VAULT_LIGHTNING_SEND=true VITE_VAULT_LIGHTNING_RECEIVE=true VITE_VAULT_LNURL=true
pnpm install --frozen-lockfile
vercel build --prod --local-config vercel.mainnet.json --standalone --yes
```

Initialize the companion for input verification and recovery builds in a separate
checkout. Keep it uninitialized in the frontend build checkout: Tailwind can scan
its generated content and change frontend asset hashes. Save generated output
outside that checkout.

## Guardian and routing

The browser uses same-origin gateway routes. Configure `AUTHORIZER_ORIGIN` and
`AUTHORIZER_GATEWAY_SECRET` in the server environment, together with the required
durable rate-limit configuration. Guardian uses
`VAULT_CLIENT_ORIGIN=https://rc.getvaulted.xyz` and `VAULT_RP_ID=rc.getvaulted.xyz`.
Keep private credentials outside browser build variables.

Activate the matching Guardian through its configured interactive unlock.
Confirm `/ready` returns `ok: true`, schema 12, mainnet and enrollment template
`vaulted-spending-v1`. Public status must also return policy
`vault-spending-policy-v1` and the expected signing origin and RP ID.

## Verify and assign RC

Use one deployment owner. The shared Vercel project can assign its public domain
automatically during a production deployment. Deploy without automatic domain
assignment, then assign only the intended alias; inspect the current domain
configuration before the operation. Restoring another alias after it moves does
not provide deployment isolation.

After assigning RC to the complete build, verify it with the explicit signing
identity:

```sh
pnpm verify:deployment https://rc.getvaulted.xyz <deployment-url-or-index-asset> mainnet https://rc.getvaulted.xyz rc.getvaulted.xyz
```

Verify the expected commit in `release.json`, the worker digest, static assets,
server functions and gateway routes against the build. Check the page loads and
stays at RC before attempting a passkey ceremony. Browser qualification, hardware
signing and funded recovery drills each require their own passing evidence;
serving a deployment does not establish those results.
