import { ipcMain, net } from 'electron'

/** Renderer-initiated cancellations, keyed by the id the preload passes with each request. */
const inflight = new Map<string, AbortController>()

/**
 * Bailian answers a burst over the account's rate quota with `429 Throttling.RateQuota` and no `Retry-After`.
 * A rejected segment is not billed, so waiting and asking again is the cheap half of the fix: the other half is the
 * provider's in-flight cap, because one rejection voids every later segment of the same reply.
 */
const QUOTA_RETRY_DELAYS_MS = [800, 1600]
const RETRYABLE_STATUS = new Set([429, 503])

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'))
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (timer)
        clearTimeout(timer)
      reject(signal?.reason ?? new Error('Aborted'))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Sends the synthesis request, waiting out a rate-quota rejection before the segment is given up on. */
async function postWithQuotaRetry(
  request: typeof fetch,
  target: URL,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  let rejected: Error | undefined
  for (let attempt = 0; attempt <= QUOTA_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0)
      await sleep(QUOTA_RETRY_DELAYS_MS[attempt - 1]!, signal)
    const response = await request(target, { ...init, signal })
    if (response.ok)
      return response

    rejected = new Error(`Bailian synthesis ${response.status}: ${await response.text()}`)
    if (!RETRYABLE_STATUS.has(response.status))
      throw rejected
  }
  throw rejected ?? new Error('Bailian synthesis failed')
}

/** Native desktop synthesis; the renderer cannot call Bailian's non-CORS API. */
export async function synthesizeBailian(endpoint: string, apiKey: string, body: string, request: typeof fetch = (input, init) => net.fetch(input instanceof URL ? input.href : input as string | Request, init) as Promise<Response>, cancelled?: AbortSignal) {
  const target = new URL(endpoint)
  if (target.protocol !== 'https:' || !target.hostname.endsWith('.maas.aliyuncs.com') || target.pathname !== '/api/v1/services/audio/tts/SpeechSynthesizer')
    throw new Error('Unsupported Bailian speech endpoint')
  // One abort for "the renderer lost interest" and "the endpoint is slow"; the renderer's interrupt
  // must not keep a spoken segment alive after the user stopped listening.
  const timeout = AbortSignal.timeout(20000)
  const signal = cancelled ? AbortSignal.any([timeout, cancelled]) : timeout
  const response = await postWithQuotaRetry(request, target, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body,
    redirect: 'error',
  }, signal)
  const result = await response.json() as { output?: { audio?: { url?: string } | string }, message?: string }
  const audio = result.output?.audio
  const audioUrl = typeof audio === 'string' ? audio : audio?.url
  if (!audioUrl)
    throw new Error(result.message || 'Bailian returned no audio URL')
  const url = new URL(audioUrl)
  if (url.protocol === 'http:' && url.hostname.endsWith('.aliyuncs.com'))
    url.protocol = 'https:'
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.aliyuncs.com'))
    throw new Error(`Unsupported Bailian audio URL host: ${url.hostname}`)
  const downloadTimeout = AbortSignal.timeout(10000)
  const downloadSignal = cancelled ? AbortSignal.any([downloadTimeout, cancelled]) : downloadTimeout
  const download = await request(url, { signal: downloadSignal, redirect: 'error' })
  if (!download.ok)
    throw new Error(`Bailian audio download ${download.status}`)
  return new Uint8Array(await download.arrayBuffer())
}

export function setupBailianSpeech() {
  ipcMain.handle('airi:bailian:synthesize', async (_event, endpoint: string, apiKey: string, body: string, requestId?: string) => {
    const controller = new AbortController()
    if (requestId)
      inflight.set(requestId, controller)
    try {
      return await synthesizeBailian(endpoint, apiKey, body, undefined, controller.signal)
    }
    finally {
      if (requestId && inflight.get(requestId) === controller)
        inflight.delete(requestId)
    }
  })

  // The renderer aborts a spoken segment the user stopped listening to; without this the request
  // keeps running in main until its own timeout and still bills a synthesis.
  ipcMain.on('airi:bailian:cancel', (_event, requestId: string) => {
    const controller = inflight.get(requestId)
    if (!controller)
      return
    inflight.delete(requestId)
    controller.abort(new Error('Cancelled by the renderer'))
  })
}
