/**
 * 记忆库的配置读写（`<bankDir>/config.json` + `<bankDir>/keys.enc`）。
 *
 * 为什么长在 app 里：这份配置原来只能手改 JSON，或者去 3348 那个控制台改。换台机器、
 * 第一次接嵌入模型时，手写 `config.json` 是唯一的路 —— 字段名（`api_model` vs `model`）
 * 还分两种模式，写错不会报错，只会静默退回默认模型，然后把库里别人的向量判成「换了模型」。
 *
 * 密钥不落 `config.json`：写进 `keys.enc`（AES-256-GCM，key 在 `keys.key`），和引擎的
 * `configLoader` 读的是同一份；引擎先读 keys.enc 再读 config.json，所以 keys.enc 里的值优先。
 * 页面只回 `hasApiKey`，永远不回明文。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { join } from 'node:path'

/** 一次配置读取的结果。密钥只有「有没有」，没有明文。 */
export interface CastaliaSettingsSnapshot {
  bankDir: string
  configPath: string
  configExists: boolean
  keysFile: string
  keysExists: boolean
  project: string
  character: string
  embedding: {
    mode: 'api' | 'ollama' | 'none'
    apiUrl: string
    apiModel: string
    ollamaUrl: string
    model: string
    dim?: number
    hasApiKey: boolean
  }
  reflect: {
    llmUrl: string
    model: string
    maxTokens?: number
    factExtraction: string
    maxFacts?: number
    hasApiKey: boolean
  }
  triage: {
    llmUrl: string
    model: string
    hasApiKey: boolean
  }
}

/** 保存时只接受这些字段；`apiKey` 是写进 keys.enc 的，不会出现在 config.json 里。 */
export interface CastaliaSettingsPatch {
  embedding?: Partial<{
    mode: 'api' | 'ollama' | 'none'
    apiUrl: string
    apiModel: string
    ollamaUrl: string
    model: string
    dim: number | null
    apiKey: string
    clearApiKey: boolean
  }>
  reflect?: Partial<{
    llmUrl: string
    model: string
    maxTokens: number | null
    factExtraction: string
    maxFacts: number | null
    apiKey: string
    clearApiKey: boolean
  }>
  triage?: Partial<{
    llmUrl: string
    model: string
    apiKey: string
    clearApiKey: boolean
  }>
}

export interface CastaliaSettingsSaveResult {
  ok: boolean
  changed: string[]
  keysUpdated: boolean
  /** 改了嵌入模型/维度这类只在开库时读一次的东西，要重启才生效。 */
  restartRequired: boolean
  error?: string
}

type ConfigFile = Record<string, any>
type Secrets = Record<string, { api_key?: string }>

const CONFIG_NAME = 'config.json'
const KEYS_NAME = 'keys.enc'
const KEY_NAME = 'keys.key'

function readJson(file: string): ConfigFile {
  try {
    return JSON.parse(readFileSync(file, 'utf-8').replace(/^\uFEFF+/, '')) as ConfigFile
  }
  catch {
    return {}
  }
}

function readSecrets(bankDir: string): Secrets {
  const keysFile = join(bankDir, KEYS_NAME)
  const keyFile = join(bankDir, KEY_NAME)
  if (!existsSync(keysFile) || !existsSync(keyFile))
    return {}
  try {
    const key = Buffer.from(readFileSync(keyFile, 'utf-8').trim(), 'hex')
    if (key.length !== 32)
      return {}
    const enc = JSON.parse(readFileSync(keysFile, 'utf-8')) as { iv: string, tag: string, data: string }
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'hex'))
    decipher.setAuthTag(Buffer.from(enc.tag, 'hex'))
    const plain = Buffer.concat([decipher.update(Buffer.from(enc.data, 'hex')), decipher.final()]).toString('utf-8')
    const parsed = JSON.parse(plain) as Secrets
    return parsed && typeof parsed === 'object' ? parsed : {}
  }
  catch {
    // 解不开时当作没有：页面显示「未设置」，不让一次坏文件挡住整个设置页。
    return {}
  }
}

function writeSecrets(bankDir: string, secrets: Secrets) {
  mkdirSync(bankDir, { recursive: true })
  const keyFile = join(bankDir, KEY_NAME)
  let key: Buffer
  if (existsSync(keyFile)) {
    key = Buffer.from(readFileSync(keyFile, 'utf-8').trim(), 'hex')
    if (key.length !== 32)
      throw new Error(`${KEY_NAME} 不是 32 字节 hex，拒绝用它加密密钥`)
  }
  else {
    key = randomBytes(32)
    writeFileSync(keyFile, key.toString('hex'), { encoding: 'utf-8', mode: 0o600 })
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf-8'), cipher.final()])
  writeFileSync(join(bankDir, KEYS_NAME), JSON.stringify({
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('hex'),
  }), 'utf-8')
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 读一份快照。`project` / `character` 只是给人看的标签，落库位置由 bankDir 决定。 */
export function readCastaliaSettings(options: { bankDir: string, project: string, character: string }): CastaliaSettingsSnapshot {
  const configPath = join(options.bankDir, CONFIG_NAME)
  const config = readJson(configPath)
  const secrets = readSecrets(options.bankDir)
  const emb = (config.embedding ?? {}) as Record<string, any>
  const ref = (config.reflect ?? {}) as Record<string, any>
  const tri = (config.triage ?? {}) as Record<string, any>
  const mode = emb.mode === 'api' ? 'api' : emb.mode === 'none' ? 'none' : 'ollama'
  return {
    bankDir: options.bankDir,
    configPath,
    configExists: existsSync(configPath),
    keysFile: join(options.bankDir, KEYS_NAME),
    keysExists: existsSync(join(options.bankDir, KEYS_NAME)),
    project: options.project,
    character: options.character,
    embedding: {
      mode,
      apiUrl: str(emb.api_url),
      apiModel: str(emb.api_model),
      ollamaUrl: str(emb.ollama_url),
      model: str(emb.model),
      dim: num(emb.dim),
      hasApiKey: Boolean(str(emb.api_key).trim() || (secrets.embedding?.api_key ?? '').trim()),
    },
    reflect: {
      llmUrl: str(ref.llm_url),
      model: str(ref.model),
      maxTokens: num(ref.maxTokens),
      factExtraction: str(ref.factExtraction),
      maxFacts: num(ref.maxFacts),
      hasApiKey: Boolean(str(ref.api_key).trim() || (secrets.reflect?.api_key ?? '').trim()),
    },
    triage: {
      llmUrl: str(tri.llm_url),
      model: str(tri.model),
      hasApiKey: Boolean(str(tri.api_key).trim() || (secrets.triage?.api_key ?? '').trim()),
    },
  }
}

function backup(file: string) {
  if (!existsSync(file))
    return
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
  copyFileSync(file, `${file}.bak-${stamp}`)
}

/**
 * 合并写回：只动 patch 里给的字段，其它键原样保留（`db_dir`、`personas`、提示词路径都在里面）。
 * 返回哪些字段真的变了 —— 页面用它决定要不要提示「重启后生效」。
 */
export function writeCastaliaSettings(
  options: { bankDir: string, project: string, character: string },
  patch: CastaliaSettingsPatch,
): CastaliaSettingsSaveResult {
  const configPath = join(options.bankDir, CONFIG_NAME)
  const config = readJson(configPath)
  const changed: string[] = []
  const secrets = readSecrets(options.bankDir)
  let keysUpdated = false

  mkdirSync(options.bankDir, { recursive: true })

  const assign = (target: Record<string, any>, key: string, value: unknown, label: string) => {
    if (value === undefined)
      return
    if (target[key] !== value) {
      target[key] = value
      changed.push(label)
    }
  }
  const drop = (target: Record<string, any>, key: string, label: string) => {
    if (key in target) {
      delete target[key]
      changed.push(label)
    }
  }
  /** 密钥：写 keys.enc，并把 config.json 里的明文删掉（引擎先读 keys.enc，留着只会误导）。 */
  const applyKey = (section: Record<string, any>, name: 'embedding' | 'reflect' | 'triage', label: string) => {
    const next = patch[name]
    if (!next)
      return
    if (next.apiKey && next.apiKey.trim()) {
      secrets[name] = { ...(secrets[name] ?? {}), api_key: next.apiKey.trim() }
      keysUpdated = true
      drop(section, 'api_key', label)
    }
    if (next.clearApiKey) {
      if (secrets[name]) {
        delete secrets[name].api_key
        keysUpdated = true
      }
      drop(section, 'api_key', label)
    }
  }

  // 三个 section 都先拷贝再写：patch 只填了一个通道时，另外两个不该在 config.json 里
  // 冒出空对象（`"triage": {}`）—— 那是「这份文件被人写过」的痕迹，不是配置。
  const emb = { ...(config.embedding ?? {}) } as Record<string, any>
  if (patch.embedding) {
    const p = patch.embedding
    if (p.mode)
      assign(emb, 'mode', p.mode, 'embedding.mode')
    assign(emb, 'api_url', p.apiUrl, 'embedding.apiUrl')
    assign(emb, 'api_model', p.apiModel, 'embedding.apiModel')
    assign(emb, 'ollama_url', p.ollamaUrl, 'embedding.ollamaUrl')
    assign(emb, 'model', p.model, 'embedding.model')
    if (p.dim === null)
      drop(emb, 'dim', 'embedding.dim')
    else if (p.dim !== undefined)
      assign(emb, 'dim', Number(p.dim), 'embedding.dim')
    applyKey(emb, 'embedding', 'embedding.apiKey')
  }

  const ref = { ...(config.reflect ?? {}) } as Record<string, any>
  if (patch.reflect) {
    const p = patch.reflect
    assign(ref, 'llm_url', p.llmUrl, 'reflect.llmUrl')
    assign(ref, 'model', p.model, 'reflect.model')
    assign(ref, 'factExtraction', p.factExtraction, 'reflect.factExtraction')
    if (p.maxTokens === null)
      drop(ref, 'maxTokens', 'reflect.maxTokens')
    else if (p.maxTokens !== undefined)
      assign(ref, 'maxTokens', Number(p.maxTokens), 'reflect.maxTokens')
    if (p.maxFacts === null)
      drop(ref, 'maxFacts', 'reflect.maxFacts')
    else if (p.maxFacts !== undefined)
      assign(ref, 'maxFacts', Number(p.maxFacts), 'reflect.maxFacts')
    applyKey(ref, 'reflect', 'reflect.apiKey')
  }

  const tri = { ...(config.triage ?? {}) } as Record<string, any>
  if (patch.triage) {
    const p = patch.triage
    assign(tri, 'llm_url', p.llmUrl, 'triage.llmUrl')
    assign(tri, 'model', p.model, 'triage.model')
    applyKey(tri, 'triage', 'triage.apiKey')
  }

  // 原来就有这个 section，或者这次真的写进了东西，才落盘；否则留空对象在文件里。
  if (config.embedding || Object.keys(emb).length > 0)
    config.embedding = emb
  if (config.reflect || Object.keys(ref).length > 0)
    config.reflect = ref
  if (config.triage || Object.keys(tri).length > 0)
    config.triage = tri

  try {
    if (keysUpdated)
      writeSecrets(options.bankDir, secrets)
    if (changed.length > 0) {
      backup(configPath)
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
    }
  }
  catch (error) {
    return { ok: false, changed, keysUpdated, restartRequired: false, error: (error as Error).message }
  }

  // 嵌入后端/维度只在开库时读一次；反思模型是每次调用现读 env，但 env 也是启动时注入的。
  // 两种情况都只有重启后才确定生效，页面按这个提示。
  const restartRequired = changed.some(field => field.startsWith('embedding.') || field.startsWith('reflect.') || field.startsWith('triage.') || keysUpdated)
  return { ok: true, changed, keysUpdated, restartRequired }
}

