import { consoleError } from './logs'

export const copyToClipboard = async (text: string): Promise<void> => {
  if (navigator.clipboard) {
    try {
      return await navigator.clipboard.writeText(text)
    } catch (err) {
      consoleError(err, 'error writing to clipboard')
    }
  }
}

export const pasteFromClipboard = async (): Promise<string> => {
  if (navigator.clipboard) {
    try {
      return await navigator.clipboard.readText()
    } catch (err) {
      consoleError(err, 'error pasting from clipboard')
    }
  }
  return ''
}
