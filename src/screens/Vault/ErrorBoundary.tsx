import { Component, type ReactNode } from 'react'
import { createIncidentReference, recordVaultIncident } from '../../lib/logs'
import WalletScreen from './qg/WalletScreen'
import { QgPrimary, QgSecondary } from './qg/QgScreen'

interface Props {
  children: ReactNode
  reload?: () => void
}

interface State {
  crashed: boolean
  incidentReference: string
}

/** Vault-owned crash boundary with no dependency on the general wallet shell. */
export default class VaultErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false, incidentReference: '' }

  static getDerivedStateFromError(): State {
    return { crashed: true, incidentReference: createIncidentReference() }
  }

  componentDidCatch(error: Error) {
    recordVaultIncident(this.state.incidentReference, error)
  }

  render() {
    if (!this.state.crashed) return this.props.children
    return (
      <div className='page vault-error-page' data-testid='vault-app'>
        <WalletScreen
          title='Can’t continue'
          footer={
            <>
              <QgPrimary label='Reload' onClick={this.props.reload || (() => window.location.reload())} />
              <QgSecondary label='Try again' onClick={() => this.setState({ crashed: false, incidentReference: '' })} />
            </>
          }
        >
          <p className='qg-eyebrow'>Something went wrong</p>
          <h1>Vaulted could not display this screen.</h1>
          <p className='qg-copy'>
            If you were sending a payment, check its status after reopening the wallet before trying again.
          </p>
          <section className='qg-alert'>
            <div>
              <strong>Incident reference</strong>
              <p>{this.state.incidentReference}</p>
            </div>
          </section>
        </WalletScreen>
      </div>
    )
  }
}
