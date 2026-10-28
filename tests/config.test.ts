import { describe, expect, it } from 'vitest'
import { clientUrl } from '../server/api.js'
import { ConfigError, parseConfig } from '../server/config.js'

function configFor(host: string, port = 4747) {
  return { host, port } as Parameters<typeof clientUrl>[0]
}

describe('parseConfig', () => {
  it('starts on loopback with the default port', () => {
    const config = parseConfig([], {})
    expect(config).toMatchObject({
      mode: 'serve',
      host: '127.0.0.1',
      port: 4747,
      token: null,
      readOnly: false,
      allowInsecure: false,
    })
    expect(config.dataDir.endsWith('.claude-session-manager')).toBe(true)
  })

  it('refuses a non-loopback bind without a token', () => {
    expect(() => parseConfig(['--host', '0.0.0.0'], {})).toThrow(ConfigError)
    expect(parseConfig(['--host', '0.0.0.0', '--token', 'secret'], {}).token).toBe('secret')
    expect(parseConfig(['--host', '0.0.0.0', '--allow-insecure'], {}).allowInsecure).toBe(true)
  })

  it('parses flags, modes and rejects bad input', () => {
    const config = parseConfig(
      ['--port', '5000', '--read-only', '--data-dir', '/tmp/csm-state', 'doctor'],
      {},
    )
    expect(config).toMatchObject({ mode: 'doctor', port: 5000, readOnly: true })
    expect(config.dataDir).toBe('/tmp/csm-state')
    expect(() => parseConfig(['--port', '0'], {})).toThrow(ConfigError)
    expect(() => parseConfig(['--nope'], {})).toThrow(ConfigError)
  })
})

describe('clientUrl', () => {
  it('uses loopback for loopback and wildcard binds', () => {
    expect(clientUrl(configFor('127.0.0.1'))).toBe('http://127.0.0.1:4747')
    expect(clientUrl(configFor('0.0.0.0', 5000))).toBe('http://127.0.0.1:5000')
    expect(clientUrl(configFor('::'))).toBe('http://127.0.0.1:4747')
  })

  it('keeps an explicit address and brackets IPv6', () => {
    expect(clientUrl(configFor('10.8.0.5'))).toBe('http://10.8.0.5:4747')
    expect(clientUrl(configFor('fd00::1'))).toBe('http://[fd00::1]:4747')
    expect(clientUrl(configFor('[fd00::1]'))).toBe('http://[fd00::1]:4747')
  })
})
