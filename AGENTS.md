# Vaulted wallet development and releases

The canonical repositories are `brg444/vaulted-bitcoin-wallet`,
`brg444/arkade-runtime`, and `brg444/vaulted-emergency-recovery`. Their `main`
branches contain the integrated release source; older session checkouts can
contain superseded implementations or unfinished experiments.

Before editing, fetch the relevant repository and compare the checkout with
`origin/main`. Preserve unrelated working changes, and reconcile completed
work before preparing a release. The recovery companion is pinned through
`tools/offline-recovery`; changes to its generated bundles must identify the
wallet source and retain both network variants.

Fresh Light uses the same Spending enrollment, boarding, worker, payment,
receive, and recovery paths as protected Spending. It has device recovery and
watch-only Savings navigation. Keep the shared implementation when resolving
conflicts with older branches that contain a separate Light screen or worker.

Build RC from a clean, integrated `main` checkout with `pnpm build:mainnet`.
`vercel.mainnet.json` supplies the mainnet feature flags through the release
plugin. Run a complete Vercel build for the same source revision; copying new
static assets over another revision's server output produces an unverified
release. Coordinate one RC deployment at a time across active sessions.

Verify the source revision, UI feature flags, static assets, worker hash, and
Guardian readiness before assigning `rc.getvaulted.xyz`. The public
`app.getvaulted.xyz` alias has a separate release scope. Guardian stays running
during repository merges and frontend releases; a runtime restart uses its
configured interactive unlock procedure.
