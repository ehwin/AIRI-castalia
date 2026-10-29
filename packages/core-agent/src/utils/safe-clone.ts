/**
 * A clone that never takes the whole turn down.
 *
 * The orchestrator clones context envelopes, session messages, and generated
 * turns so later mutations cannot reach stored state. `structuredClone` is the
 * right tool until one field is not cloneable — a DOM node, an AbortSignal, a
 * function, a Proxy-wrapped host object — and then it throws a DataCloneError
 * that aborted the entire send. Every failed send surfaced as a "核心系统" error
 * bubble reading `Failed to execute 'structuredClone' on 'Window': # could not be
 * cloned.`, so chat could not proceed at all.
 *
 * Root cause of the unclonable field is still being hunted; this keeps a bad
 * field from blocking the turn while naming it in one warning so the producer
 * can be found from the log.
 *
 * 移除条件: 一旦定位并修掉那个产出不可克隆字段的地方, 这里可以退回直接 structuredClone ——
 * 但保留它作为兜底更稳: 上下文信封来自插件与各 provider, 任何一家都可能塞进宿主对象。
 */
type ClonePath = string

const UNCLONABLE = Symbol('unclonable')

function tryClone(value: unknown): unknown {
  try {
    return structuredClone(value)
  }
  catch {
    return UNCLONABLE
  }
}

function isPlainContainer(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object')
    return false
  const proto = Object.getPrototypeOf(value)
  // 数组与纯对象才值得往下拆; Date/Map/Blob/DOM 等交给 tryClone 自己判断。
  return Array.isArray(value) || proto === Object.prototype || proto === null
}

function cloneLoose(value: unknown, path: ClonePath, dropped: ClonePath[], seen: WeakSet<object>): unknown {
  const straight = tryClone(value)
  if (straight !== UNCLONABLE)
    return straight
  if (!isPlainContainer(value)) {
    if (value !== undefined && value !== null)
      dropped.push(path || 'value')
    return undefined
  }
  if (seen.has(value as object)) {
    // 循环引用: structuredClone 能处理, 拆解不能, 直接放弃这一支而不是死循环。
    dropped.push(`${path}(circular)`)
    return undefined
  }
  seen.add(value as object)

  if (Array.isArray(value)) {
    const out = value.map((item, index) => cloneLoose(item, `${path}[${index}]`, dropped, seen))
    return out
  }

  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const cloned = cloneLoose((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key, dropped, seen)
    if (cloned !== undefined || (value as Record<string, unknown>)[key] === undefined)
      out[key] = cloned
  }
  return out
}

/**
 * Clones `value`, dropping (and reporting) only the fields the structured clone
 * algorithm rejects. Falls back to the original value only when nothing at all
 * could be salvaged, so a caller never receives `undefined` in place of data.
 */
export function safeClone<T>(value: T, label = 'value'): T {
  const straight = tryClone(value)
  if (straight !== UNCLONABLE)
    return straight as T

  const dropped: ClonePath[] = []
  const cloned = cloneLoose(value, '', dropped, new WeakSet())
  if (dropped.length > 0) {
    const shown = dropped.slice(0, 6).join(', ')
    const more = dropped.length > 6 ? ` (+${dropped.length - 6} more)` : ''
    console.warn(`[core-agent] safeClone(${label}) dropped ${dropped.length} unclonable field(s): ${shown}${more}`)
  }
  return (cloned ?? value) as T
}
