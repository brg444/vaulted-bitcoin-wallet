const expectedOperator = {
  network: 'bitcoin',
  signerPubkey: '038202bebddeb1f7442803897a85eaf3ce9254d07df0172fc3725ab5f0d097779c',
  forfeitPubkey: '03b43a8363118c084a04d4f6a50ebfa58e81957f8cceceb2aee0ab64c9fd2d9977',
  checkpointTapscript: '039e0440b27520b43a8363118c084a04d4f6a50ebfa58e81957f8cceceb2aee0ab64c9fd2d9977ac',
  unilateralExitDelay: '605184',
  boardingExitDelay: '7776256',
}
async function requireJson(url) {
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new Error('Release dependency transport unavailable')
  }
  if (!response.ok) throw new Error(`Release dependency returned HTTP ${response.status}`)
  try {
    return await response.json()
  } catch {
    throw new Error('Release dependency returned invalid JSON')
  }
}

function verify(label, actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (String(actual[key] ?? '') !== value) throw new Error(`${label} ${key} no longer matches the release pin`)
  }
}

const operator = await requireJson('https://arkade.computer/v1/info')
verify('Operator', operator, expectedOperator)
console.log(`mainnet pins verified against Operator ${operator.version}`)
