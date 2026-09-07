import { useEffect, useRef, useState, type ReactNode } from 'react'
import { QRCanvas, frameLoop, frontalCamera } from 'qr/dom.js'
import QrScanner from 'qr-scanner'
import { SlidersHorizontal } from 'lucide-react'
import ErrorMessage from '../../components/Error'
import { extractError } from '../../lib/error'
import QgScreen, { QgSecondary } from './qg/QgScreen'

function ScanFrame({
  label,
  error,
  onClose,
  onSwitch,
  onManual,
  video,
  message,
}: {
  label: string
  error: boolean
  onClose: () => void
  onSwitch: () => void
  onManual?: () => void
  video: ReactNode
  message?: string
}) {
  return (
    <QgScreen
      variant='scan'
      title={label}
      back={onClose}
      aux={<SlidersHorizontal />}
      auxAriaLabel='Try another scanner'
      auxOnClick={onSwitch}
      footer={
        <QgSecondary onClick={error ? onManual || onClose : onClose} label={error ? 'Enter manually' : 'Cancel'} />
      }
    >
      <ErrorMessage error={error} text='Camera not available' />
      <div id='video-wrapper' className='qg-camera'>
        {video}
        <div className='qg-scan-guide' aria-hidden>
          <i />
          <i />
          <i />
          <i />
        </div>
        <p role='status'>{message || 'Place the QR code inside the frame'}</p>
      </div>
    </QgScreen>
  )
}

interface ScannerProps {
  close: () => void
  manual?: () => void
  label: string
  message?: string
  onData: (value: string) => void | boolean
  onError: (error: string) => void
  onSwitch?: () => void
  calculateScanRegion?: (video: HTMLVideoElement) => QrScanner.ScanRegion
}

export default function VaultScanner({ close, manual, label, message, onData, onError }: ScannerProps) {
  const [implementation, setImplementation] = useState<'qr' | 'qrmini' | 'mills'>('qr')
  const next = () =>
    setImplementation(implementation === 'qr' ? 'qrmini' : implementation === 'qrmini' ? 'mills' : 'qr')

  if (implementation === 'qr') {
    return (
      <ScannerQr
        close={close}
        manual={manual}
        label={label}
        message={message}
        onData={onData}
        onError={onError}
        onSwitch={next}
      />
    )
  }
  if (implementation === 'qrmini') {
    return (
      <ScannerQrMini
        close={close}
        manual={manual}
        label={label}
        message={message}
        onData={onData}
        onError={onError}
        onSwitch={next}
      />
    )
  }
  return (
    <ScannerMills
      close={close}
      manual={manual}
      label={label}
      message={message}
      onData={onData}
      onError={onError}
      onSwitch={next}
    />
  )
}

function ScannerMills({ close, manual, label, message, onData, onError, onSwitch }: ScannerProps) {
  const [error, setError] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const cameraRef = useRef<any>(null)
  const canvasRef = useRef<QRCanvas | null>(null)
  const cancelRef = useRef<(() => void) | null>(null)

  const stop = () => {
    cancelRef.current?.()
    cancelRef.current = null
    cameraRef.current?.stop()
    cameraRef.current = null
  }
  const closeScanner = () => {
    stop()
    close()
  }

  useEffect(() => {
    let cancelled = false
    const start = async () => {
      if (!videoRef.current) return
      try {
        canvasRef.current?.clear()
        const canvas = new QRCanvas()
        const camera = await frontalCamera(videoRef.current)
        if (cancelled) {
          camera.stop()
          return
        }
        const devices = await camera.listDevices()
        await camera.setDevice(devices[devices.length - 1].deviceId)
        canvasRef.current = canvas
        cameraRef.current = camera
        cancelRef.current = frameLoop(() => {
          const value = camera.readFrame(canvas)
          if (value) {
            if (onData(value) !== false) closeScanner()
          }
        })
      } catch (cause) {
        onError(extractError(cause))
        setError(true)
      }
    }
    void start()
    return () => {
      cancelled = true
      stop()
    }
  }, [])

  const switchScanner = () => {
    stop()
    onSwitch?.()
  }

  return (
    <ScanFrame
      label={label}
      message={message}
      error={error}
      onClose={closeScanner}
      onManual={() => {
        stop()
        ;(manual || close)()
      }}
      onSwitch={switchScanner}
      video={<video className='qg-scanner-video' ref={videoRef} />}
    />
  )
}

function ScannerQr({ calculateScanRegion, close, manual, label, message, onData, onError, onSwitch }: ScannerProps) {
  const [error, setError] = useState(false)
  const [hasCamera, setHasCamera] = useState<boolean | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const scannerRef = useRef<QrScanner | null>(null)

  const stop = () => {
    scannerRef.current?.destroy()
    scannerRef.current = null
  }
  const closeScanner = () => {
    stop()
    close()
  }

  useEffect(() => {
    void QrScanner.hasCamera()
      .then(setHasCamera)
      .catch(() => setHasCamera(false))
  }, [])

  useEffect(() => {
    if (!hasCamera || !videoRef.current) return
    const scanner = new QrScanner(
      videoRef.current,
      (result) => {
        if (onData(result.data) !== false) closeScanner()
      },
      {
        maxScansPerSecond: 100,
        highlightScanRegion: true,
        highlightCodeOutline: true,
        onDecodeError: () => {},
        calculateScanRegion,
      },
    )
    scannerRef.current = scanner
    scanner.start().catch((cause) => {
      onError(extractError(cause))
      setError(true)
    })
    return stop
  }, [hasCamera])

  const switchScanner = () => {
    stop()
    onSwitch?.()
  }

  return (
    <ScanFrame
      label={label}
      message={message}
      error={error || hasCamera === false}
      onClose={closeScanner}
      onManual={() => {
        stop()
        ;(manual || close)()
      }}
      onSwitch={switchScanner}
      video={<video id='qr-scanner' ref={videoRef} className='qg-scanner-video' />}
    />
  )
}

function ScannerQrMini(props: ScannerProps) {
  const calculateScanRegion = (video: HTMLVideoElement): QrScanner.ScanRegion => {
    const smallestDimension = Math.min(video.videoWidth, video.videoHeight)
    const size = Math.round(smallestDimension / 4)
    return {
      x: Math.round((video.videoWidth - size) / 2),
      y: Math.round((video.videoHeight - size) / 2),
      width: size,
      height: size,
    }
  }
  return <ScannerQr {...props} calculateScanRegion={calculateScanRegion} />
}
