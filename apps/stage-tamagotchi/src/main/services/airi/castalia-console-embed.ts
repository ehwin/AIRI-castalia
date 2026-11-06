/**
 * 记忆体控制台（星图 / 总成 / 库管理）在 app 里跑起来。
 *
 * 原来是「装个 Node、`node viz/server.mjs`、再开浏览器看 127.0.0.1:3348」。推广版不能这样：
 * 用户机器上没有 Node，也不该为了看自己的记忆去开浏览器。
 *
 * 做法是把它当子进程拉起——Electron 自己就带 Node（`ELECTRON_RUN_AS_NODE=1`），
 * 控制台的代码一行不用改，主进程只负责：挑一个空闲端口、喂库目录和 vec0.dll 路径、
 * 等它答得上 `/api/status`，然后把这个 URL 交给设置页的 iframe。
 *
 * 不内联进主进程 bundle 的原因：控制台里用 `worker_threads` 跑 UMAP 几何重排
 * （`routes/layout-worker.mjs` 是独立文件），打包进 bundle 反而要多做一层搬运。
 */
import type { ChildProcess } from 'node:child_process'

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

export interface ConsoleServerState {
  running: boolean
  url?: string
  error?: string
}

let child: ChildProcess | undefined
let state: ConsoleServerState = { running: false }
let starting: Promise<ConsoleServerState> | undefined
let stderrTail: string[] = []

/** 打包后是 `resources/castalia-console`；开发时是仓库根的 `viz/`。 */
function consoleDir(): string | undefined {
  const candidates: string[] = []
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resources)
    candidates.push(join(resources, 'castalia-console'))
  // `.app` 在 `<app>/out/main/*.js`，仓库根 `viz/` 往上三层。
  candidates.push(join(process.cwd(), '..', '..', 'viz'))
  candidates.push(join(process.cwd(), 'viz'))
  for (const dir of candidates) {
    if (existsSync(join(dir, 'server.mjs')))
      return dir
  }
  return undefined
}

/**
 * 向量扩展。控制台的搜索靠它；找不到就退化成 FTS，星图照样画。
 * 顺序和 `sqlite-shim.ts` 一致：随包的资源目录 → 开发时的 node_modules。
 */
function vecDll(dir: string): string | undefined {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    resources && join(resources, 'castalia', 'vec0.dll'),
    join(dir, 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll'),
    join(process.cwd(), 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll'),
  ].filter((item): item is string => Boolean(item))
  return candidates.find(item => existsSync(item))
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

async function waitForReady(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!child || child.exitCode !== null)
      return false
    try {
      const response = await fetch(`${url}/api/status`)
      if (response.ok)
        return true
    }
    catch { /* 还没 listen 上 */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

/**
 * 拉起来，或者返回已经在跑的那份。
 *
 * `bankDir` 是 `<banks>/<bank>`：控制台按 `<bankDir>/<project>/<memType>/memory.sqlite`
 * 找分区，和引擎自己的布局一致。
 */
export function ensureConsoleServer(bankDir: string): Promise<ConsoleServerState> {
  if (state.running && state.url)
    return Promise.resolve(state)
  if (starting)
    return starting

  starting = (async (): Promise<ConsoleServerState> => {
    const dir = consoleDir()
    if (!dir) {
      state = { running: false, error: 'console files are missing from this build' }
      return state
    }
    const port = await freePort()
    const url = `http://127.0.0.1:${port}`
    stderrTail = []
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WEB_PORT: String(port),
      MEMORY_DB_DIR: bankDir,
    }
    const dll = vecDll(dir)
    if (dll)
      env.CASTALIA_VEC_DLL = dll

    try {
      child = spawn(process.execPath, [join(dir, 'server.mjs')], {
        cwd: dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    }
    catch (error) {
      state = { running: false, error: (error as Error).message }
      return state
    }

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderrTail.push(chunk)
      if (stderrTail.length > 40)
        stderrTail.shift()
    })
    child.stdout?.resume()
    child.once('exit', (code) => {
      child = undefined
      if (state.running)
        state = { running: false, error: `console exited with code ${code}` }
    })

    const ready = await waitForReady(url, 20_000)
    if (!ready) {
      const detail = stderrTail.join('').trim().split('\n').slice(-3).join(' | ')
      state = { running: false, error: detail || 'console did not answer /api/status' }
      stopConsoleServer()
      return state
    }
    state = { running: true, url }
    return state
  })()

  starting.finally(() => {
    starting = undefined
  })
  return starting
}

export function stopConsoleServer(): void {
  if (child && child.exitCode === null)
    child.kill()
  child = undefined
  state = { running: false }
}

export function consoleServerState(): ConsoleServerState {
  return state
}
