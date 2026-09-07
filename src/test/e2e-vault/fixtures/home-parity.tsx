import { lazy, Suspense, useContext } from 'react'
import { VaultContext } from '../../../vault/context'

const originalPath = '/src/screens/Vault/Home.tsx?parity-original'
const Home = lazy(() => import(/* @vite-ignore */ originalPath))

// Test-only data seam; both real screen trees retain their production styling.
export default function HomeParityFixture() {
  const original = useContext(VaultContext)
  const { balance, pendingBalance, history } = Reflect.get(window, '__vaultHomeParity')
  return (
    <VaultContext.Provider
      value={{
        ...original,
        balancesLoaded: true,
        canSend: balance > 0,
        history,
        positions: {
          ...original.positions,
          spending: { availableSats: balance, pendingSats: pendingBalance, totalSats: balance + pendingBalance },
        },
      }}
    >
      <Suspense>
        <Home />
      </Suspense>
    </VaultContext.Provider>
  )
}
