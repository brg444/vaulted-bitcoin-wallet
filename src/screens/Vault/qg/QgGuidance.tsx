import type { ReactNode } from 'react'
import './guidance.css'

export default function QgGuidance({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className='qg-guidance'>
      <summary>{title}</summary>
      <div className='qg-guidance-body qg-prose'>{children}</div>
    </details>
  )
}
