import { useContext, type ReactNode } from 'react'
import { VaultContext, type VaultScreen } from '../../vault/context'
import Home from './Home'
import Receive from './Receive'
import Send from './Send'
import Review from './Review'
import Success from './Success'
import Tx from './Tx'
import Navigation from './Navigation'

export const spendingScreens = {
  home: <Home />,
  receive: <Receive />,
  send: <Send />,
  review: <Review />,
  success: <Success />,
  tx: <Tx />,
} satisfies Partial<Record<VaultScreen, JSX.Element>>

export default function SpendingScreens({ homeNotice }: { homeNotice?: ReactNode }) {
  const { screen } = useContext(VaultContext)
  const content =
    screen === 'home' ? <Home>{homeNotice}</Home> : spendingScreens[screen as keyof typeof spendingScreens]
  return (
    <>
      {content}
      {screen === 'home' ? <Navigation /> : null}
    </>
  )
}
