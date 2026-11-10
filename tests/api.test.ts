import { describe, expect, it } from 'vitest'
import { emptyBodyParser } from '../server/api.js'

function parse(contentType: string, body: string) {
  let error: (Error & { statusCode?: number }) | null = null
  let value: unknown = 'unset'
  emptyBodyParser(contentType, body, (cause, result) => {
    error = cause
    value = result
  })
  return { error, value }
}

describe('emptyBodyParser', () => {
  it('accepts an empty body whatever content type the request claims', () => {
    for (const contentType of [
      'no content type',
      'application/x-www-form-urlencoded',
      'text/plain',
    ]) {
      const { error, value } = parse(contentType, '')
      expect(error).toBeNull()
      expect(value).toBeUndefined()
    }
  })

  it('treats whitespace as an empty body', () => {
    expect(parse('text/plain', '  \n ').error).toBeNull()
  })

  it('rejects a body the daemon cannot read with 415', () => {
    const { error } = parse('application/x-www-form-urlencoded', 'answer=yes')
    expect(error?.statusCode).toBe(415)
  })
})
