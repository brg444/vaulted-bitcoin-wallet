import { useSession } from '../../../vault/sessionContext'
import { type ComponentProps } from 'react'
import WalletHelp from './Help'
import QgScreen from './QgScreen'

/** Compose wallet Help and onboarding progress above the presentation primitives. */
export default function WalletScreen({
  help = true,
  stepLabel,
  ...props
}: Omit<ComponentProps<typeof QgScreen>, 'help'> & { help?: boolean }) {
  const { setup } = useSession()
  const advanced = setup?.protectionTier === 'advanced'
  const numberedStep = stepLabel?.match(/^(\d) of 6$/)
  const displayedStep = numberedStep
    ? `${Number(numberedStep[1]) - (!advanced && Number(numberedStep[1]) > 3 ? 1 : 0)} of ${advanced ? 7 : 6}`
    : stepLabel === 'Backup'
      ? `${advanced ? 7 : 6} of ${advanced ? 7 : 6}`
      : stepLabel
  return <QgScreen {...props} stepLabel={displayedStep} help={help ? <WalletHelp /> : undefined} />
}
