// NOTICE: Full 总线客户端（MCP over HTTP，默认 127.0.0.1:3314）。
// why: 记忆体本体已进程内化，但"跨库总览/跨库检索"仍然只在 Full 的总线接口里
//      （memory_search_all / federation_members），面板「记忆体」页要它。
// 边界: 只读。写入一律走本库的进程内插件（castalia-inprocess.ts），不从这里写。
// 移除条件: 总线提供进程内实现（目前它是独立进程 mcp-proxy + fedServer）。
import type { CastaliaFullMembersResult, CastaliaFullSearchResult } from '../../../shared/eventa/castalia-memory'

import process from 'node:process'

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_URL = 'http://127.0.0.1:3314/mcp'

/** 读 `<userData>/castalia-engine.json` 的 `fullUrl`；没有就退回环境变量/默认端口。 */
export function resolveCastaliaFullUrl(userDataDir?: string): string {
  if (process.env.CASTALIA_FULL_URL)
    return process.env.CASTALIA_FULL_URL
  if (userDataDir) {
    const file = join(userDataDir, 'castalia-engine.json')
    if (existsSync(file)) {
      try {
        const cfg = JSON.parse(readFileSync(file, 'utf-8').replace(/^\uFEFF+/, ''))
        if (typeof cfg?.fullUrl === 'string' && cfg.fullUrl.length > 0)
          return cfg.fullUrl
      }
      catch {}
    }
  }
  return DEFAULT_URL
}

interface RpcBody {
  jsonrpc: '2.0'
  id?: number
  method: string
  params?: Record<string, unknown>
}

/** 从可能被 SSE 包裹的响应体里取出最后一个带 id 的 JSON-RPC 结果。 */
function parseBody(text: string, contentType: string): any {
  const trimmed = text.trim()
  if (!trimmed)
    return undefined
  if (!contentType.includes('text/event-stream'))
    return JSON.parse(trimmed)
  let last: any
  for (const line of trimmed.split('\n')) {
    const payload = line.startsWith('data:') ? line.slice(5).trim() : ''
    if (!payload || payload === '[DONE]')
      continue
    try {
      const parsed = JSON.parse(payload)
      if (parsed && (parsed.result !== undefined || parsed.error !== undefined))
        last = parsed
    }
    catch {}
  }
  return last
}

export interface CastaliaFullClient {
  members: () => Promise<CastaliaFullMembersResult>
  search: (params: { query: string, topK?: number, members?: string[] }) => Promise<CastaliaFullSearchResult>
}

export function createCastaliaFullClient(options: { url: string, timeoutMs?: number }): CastaliaFullClient {
  const timeoutMs = options.timeoutMs ?? 8000
  let sessionId: string | undefined
  let seq = 0

  async function post(body: RpcBody): Promise<any> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
    }
    if (sessionId)
      headers['mcp-session-id'] = sessionId
    const response = await fetch(options.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const nextSession = response.headers.get('mcp-session-id')
    if (nextSession)
      sessionId = nextSession
    const text = await response.text()
    if (!response.ok)
      throw new Error(`bus ${response.status}: ${text.slice(0, 120)}`)
    return parseBody(text, response.headers.get('content-type') ?? '')
  }

  /** 总线要求先 initialize，再用同一个 session id 发 notifications/initialized。 */
  async function ensureSession() {
    if (sessionId)
      return
    const init = await post({
      jsonrpc: '2.0',
      id: ++seq,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'airi-memory-panel', version: '1.0.0' },
      },
    })
    if (!init || init.error)
      throw new Error(`initialize failed: ${JSON.stringify(init?.error ?? init ?? null).slice(0, 120)}`)
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
    await ensureSession()
    const result = await post({
      jsonrpc: '2.0',
      id: ++seq,
      method: 'tools/call',
      params: { name, arguments: args },
    })
    if (!result || result.error)
      throw new Error(`${name} failed: ${JSON.stringify(result?.error ?? result ?? null).slice(0, 120)}`)
    // MCP reports a tool failure inside a successful JSON-RPC result (`isError: true`). Reading its
    // text as data turned "member unavailable" into an empty member list (audit A10).
    if (result.result?.isError) {
      const reason = (result.result?.content ?? [])
        .filter((item: any) => item?.type === 'text')
        .map((item: any) => item.text)
        .join('')
        .slice(0, 200)
      throw new Error(`${name} reported an error: ${reason || 'no reason given'}`)
    }
    const text = (result.result?.content ?? [])
      .filter((item: any) => item?.type === 'text')
      .map((item: any) => item.text)
      .join('')
    return text ? JSON.parse(text) : {}
  }

  return {
    async members() {
      try {
        const data = await callTool('federation_members', {})
        return {
          ok: true,
          totalMemories: Number(data.totalMemories ?? 0),
          members: (data.members ?? []).map((member: any) => ({
            id: String(member.id),
            label: member.label,
            variant: member.variant,
            transport: member.transport,
            target: member.target,
            ok: member.ok !== false,
            memories: Number(member.counts?.memories ?? 0),
            libraries: Number(member.counts?.libraries ?? 0),
          })),
        }
      }
      catch (error) {
        // 总线没起不该让面板崩：把错误当成"总线离线"展示
        return { ok: false, totalMemories: 0, members: [], error: (error as Error).message }
      }
    },

    async search(params) {
      try {
        const data = await callTool('memory_search_all', {
          query: params.query,
          topK: params.topK ?? 8,
          ...(params.members?.length ? { members: params.members } : {}),
        })
        return {
          ok: true,
          count: Number(data.count ?? 0),
          results: (data.results ?? []).map((row: any) => ({
            instance: String(row.instance ?? ''),
            project: row.project,
            score: Number(row.score ?? 0),
            text: String(row.text ?? ''),
            memType: row.memType,
          })),
        }
      }
      catch (error) {
        return { ok: false, count: 0, results: [], error: (error as Error).message }
      }
    },
  }
}
