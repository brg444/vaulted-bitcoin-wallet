import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { VaultTestProvider } from './VaultTestProvider'
export function renderVault(element: ReactElement) {
  return render(element, { wrapper: VaultTestProvider })
}
