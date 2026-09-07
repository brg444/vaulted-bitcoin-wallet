import { Buffer } from 'buffer'
import process from 'process/browser.js'

// Initialize before the UR codec loads its Node-compatible CBOR and assertion helpers.
globalThis.Buffer ??= Buffer as unknown as typeof globalThis.Buffer
globalThis.process ??= process
