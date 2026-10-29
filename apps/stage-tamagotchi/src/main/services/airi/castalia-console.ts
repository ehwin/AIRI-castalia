// NOTICE: 从 AIRI 打开 Castalia 控制台的“记忆体”栏。
// why: 控制台（3348 记忆总成）已经是跨库浏览的完整 UI（统一 FTS+向量索引、改删、管库），
//      app 里再养一份同样的检索页只会两边漂移。这里只负责“把它切到记忆体并置前”。
// 机制: 外壳 castalia_shell.py 的控制面 GET /open?view=agg|mng|viz 会切换并 PostMessage 置前；
//      外壳没开时退回默认浏览器打开同一页。
// 移除条件: 控制台提供更正式的 deep-link（目前 view 只有 agg/mng/viz 三档）。
import process from 'node:process'

import { shell } from 'electron'

export type CastaliaConsoleView = 'agg' | 'mng' | 'viz'

export interface OpenConsoleResult {
  ok: boolean
  /** shell = 已切到运行中的控制台窗口；browser = 外壳没开，改用默认浏览器 */
  via: 'shell' | 'browser'
  error?: string
}

const PAGES: Record<string, string> = {
  agg: 'http://127.0.0.1:3348/aggregate.html',
  mng: 'http://127.0.0.1:3348/manage.html',
  viz: 'http://127.0.0.1:3348/?scope=federation',
}

export async function openCastaliaConsole(options: { view?: CastaliaConsoleView, url?: string } = {}): Promise<OpenConsoleResult> {
  const view = options.view ?? 'agg'
  const port = Number(process.env.CASTALIA_SHELL_PORT || 3397)
  const query = new URLSearchParams({ view })
  if (options.url)
    query.set('url', options.url)

  try {
    const response = await fetch(`http://127.0.0.1:${port}/open?${query.toString()}`, {
      signal: AbortSignal.timeout(2500),
    })
    const body = await response.json() as { ok?: boolean, error?: string }
    if (body?.ok)
      return { ok: true, via: 'shell' }
  }
  catch {
    // 控制台窗口没开（或控制面未就绪）→ 下面用浏览器兜底
  }

  try {
    await shell.openExternal(options.url ?? PAGES[view] ?? PAGES.agg)
    return { ok: true, via: 'browser' }
  }
  catch (error) {
    return { ok: false, via: 'browser', error: (error as Error).message }
  }
}
