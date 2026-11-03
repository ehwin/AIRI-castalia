import { createServer } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { createCastaliaFullClient } from '../src/main/services/airi/castalia-full'

let server: ReturnType<typeof createServer> | undefined

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
  server = undefined
})

describe('castalia link review: local Full protocol stub', () => {
  // A10 (fixed): an MCP tool error carrying valid JSON now fails with its reason instead of
  // reporting an empty but healthy bus.
  it('reports the MCP tool error instead of an empty success', async () => {
    server = createServer((request, response) => {
      request.setEncoding('utf8')
      let body = ''
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        const rpc = JSON.parse(body) as { id?: number, method: string }
        if (rpc.method === 'notifications/initialized') {
          response.writeHead(202).end()
          return
        }
        response.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'audit-session' })
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: rpc.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'audit', version: '1' } }
            : { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'audit: member unavailable' }) }] },
        }))
      })
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('The local protocol stub did not start')
    const client = createCastaliaFullClient({ url: `http://127.0.0.1:${address.port}/mcp` })

    const members = await client.members()
    expect(members.ok).toBe(false)
    expect(String((members as { error?: string }).error ?? '')).toContain('member unavailable')

    const search = await client.search({ query: 'audit marker' })
    expect(search.ok).toBe(false)
    expect(String((search as { error?: string }).error ?? '')).toContain('member unavailable')
  })
})
