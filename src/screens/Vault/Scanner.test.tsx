import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import Scanner from './Scanner'

const camera = vi.hoisted(() => ({
  receive: null as null | ((result: { data: string }) => void),
  destroy: vi.fn(),
  start: vi.fn(async () => {}),
}))
vi.mock('qr-scanner', () => ({
  default: class {
    static hasCamera = async () => true
    constructor(_video: HTMLVideoElement, receive: typeof camera.receive) {
      camera.receive = receive
    }
    start = camera.start
    destroy = camera.destroy
  },
}))
beforeEach(() => vi.clearAllMocks())
it('keeps the camera running for incomplete QR frames and closes after completion', async () => {
  const close = vi.fn()
  const onData = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(undefined)
  render(<Scanner label='Scan descriptor' close={close} onData={onData} onError={vi.fn()} />)
  await waitFor(() => expect(camera.start).toHaveBeenCalledOnce())
  act(() => camera.receive!({ data: 'first frame' }))
  expect(close).not.toHaveBeenCalled()
  expect(camera.destroy).not.toHaveBeenCalled()
  act(() => camera.receive!({ data: 'last frame' }))
  expect(onData).toHaveBeenNthCalledWith(2, 'last frame')
  expect(close).toHaveBeenCalledOnce()
  expect(camera.destroy).toHaveBeenCalledOnce()
})
