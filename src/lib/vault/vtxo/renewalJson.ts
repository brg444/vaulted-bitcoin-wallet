/** Match encoding/json.Marshal for the ordered renewal signing bodies. */
export function renewalSigningJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}
