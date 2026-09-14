// Test-only stand-in for the `vi.fn` factory used by wallet testdata
// builders when they run inside the program-emergency browser fixture
// bundle outside vitest. It implements just enough of the mock API
// (creation, calls, implementation swaps) for fixture construction.
export function fn(implementation) {
  const state = { implementation, calls: [] }
  const mock = (...args) => {
    state.calls.push(args)
    return state.implementation ? state.implementation(...args) : undefined
  }
  mock.mock = { calls: state.calls }
  mock.mockImplementation = (next) => {
    state.implementation = next
    return mock
  }
  mock.mockResolvedValue = (value) => {
    state.implementation = async () => value
    return mock
  }
  mock.mockReturnValue = (value) => {
    state.implementation = () => value
    return mock
  }
  return mock
}
export const vi = { fn }
export default { fn, vi }
