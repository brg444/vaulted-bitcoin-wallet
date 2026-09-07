import { HDKey } from '@scure/bip32'
import { hex } from '@scure/base'
// Disposable deterministic test identity, never used outside browser fixtures.
const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(73), { public: 0x043587cf, private: 0x04358394 })
const account = root.derive("m/84'/1'/0'")
export const CONNECTOR_TEST_DESCRIPTOR = `wpkh([${root.fingerprint.toString(16).padStart(8, '0')}/84'/1'/0']${account.publicExtendedKey}/0/*)`
export const CONNECTOR_TEST_PUB = hex.encode(account.derive('m/0/0').publicKey!)
export function connectorTestSecret() {
  return account.derive('m/0/0').privateKey!
}
