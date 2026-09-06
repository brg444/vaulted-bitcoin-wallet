// Messages authored for the payment/setup UI, distinct from parser or remote
// errors whose technical details should not become generic user guidance.
export class ConnectorUserError extends Error {}
