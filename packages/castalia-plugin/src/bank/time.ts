/**
 * 时间字段归一化：两种后端都可能把 `updated_at` 交回整数（秒或毫秒）或文本。
 *
 * NOTICE:
 * 为什么需要：SQLite 的 `updated_at` 在真库里既有 INTEGER（实测某分类 254 行）也有 TEXT
 * （42 行）。两个适配器各自写过 `value.includes('T')`，只要来一行整数就抛
 * `value.includes is not a function`，整次列表失败，渲染层 hydrate 退回旧缓存——
 * 表现为"面板有库、模型读不到"，而所有 mock 端口的单测都是绿的。
 * 根因：把"SQLite 一定给字符串"当成了前提。
 * 移除条件：库里 `updated_at` 的存储类型统一，且两条后端契约都改成 `number`。
 */

/** SQLite `YYYY-MM-DD HH:MM:SS`（UTC）、ISO、秒/毫秒 epoch 都转成 epoch ms。无法解析时返回当前时间。 */
export function parseBankTime(value: string | number | null | undefined, now = Date.now()): number {
  if (value === null || value === undefined || value === '')
    return now
  if (typeof value === 'number')
    return value > 1e11 ? Math.round(value) : Math.round(value * 1000)
  const text = String(value)
  const numeric = Number(text)
  if (text.trim() !== '' && Number.isFinite(numeric))
    return numeric > 1e11 ? Math.round(numeric) : Math.round(numeric * 1000)
  const normalized = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : now
}
