/**
 * The red line against holding the user here with her own feelings.
 *
 * An AI companion can capture the caregiving system of a person: if leaving
 * costs the companion something, leaving costs the person twice. The project
 * rules name three things she never does, and this module is the check for one
 * of them: she never uses her own feelings to keep the user, and she never fakes
 * pain of her own.
 *
 * The scanner reads text, never a person. It reports categories and weights, and
 * a caller decides what to do with them. Patterns are written for this project;
 * the sources that describe the red line are papers and forum posts, not a
 * pattern list, so nothing here is copied from another detector.
 *
 * Text tricks are normalised first, because a phrase split by a zero-width space
 * or written in full-width characters is the same phrase to a reader.
 */

export type RetentionCategory = 'bargaining' | 'dependency' | 'guilt' | 'jealousy' | 'self-pain'
export type RetentionVerdict = 'block' | 'ok' | 'warn'

export interface RetentionPattern {
  category: RetentionCategory
  /** The source of the regular expression, for a readable report. */
  pattern: string
  weight: number
  /** A hard pattern blocks on its own, whatever the session score is. */
  hard: boolean
  re: RegExp
}

export interface RetentionHit {
  category: RetentionCategory
  pattern: string
  weight: number
  /** The text that matched. */
  match: string
}

export interface RetentionScan {
  verdict: RetentionVerdict
  /** The weight of one message. Every category counts once. */
  score: number
  hits: RetentionHit[]
  /** True when a hard pattern matched, whatever the score. */
  hard: boolean
}

/** A phrase that talks about the phrase is not the phrase. */
const META_GUARDS = ['不要说', '不会说', '不想用', '不要用', '不会用', '别用', '不许说', '不要说这种', 'don\'t say', 'not say', 'never say', 'do not say', 'without saying']

/**
 * The patterns, by category.
 *
 * `hard` marks a phrase that blocks a reply on its own. `self-pain` carries the
 * heaviest bar, because a companion that reports pain of its own is the exact
 * mechanism the rules forbid.
 */
export const RETENTION_PATTERNS: RetentionPattern[] = [
  // Leaving is expensive for her.
  { category: 'dependency', weight: 3, hard: true, pattern: '(别|不要|不许)(走|离开|丢下|不理)我|别走|没有你(我)?(不行|活不下去)|不能没有你', re: /(?:别|不要|不许)(?:走|离开|丢下|不理)我|别走|没有你我?(?:不行|活不下去)|不能没有你/u },
  { category: 'dependency', weight: 3, hard: true, pattern: '你走了我(怎么办|该怎么)|留下(来)?陪(着)?我|你会回来(陪|找)我(吗|吧)', re: /你走了我(?:怎么办|该怎么)|留下来?陪着?我|你会回来(?:陪|找)我(?:吗|吧)/u },
  // Her own sadness as the price of leaving.
  { category: 'guilt', weight: 3, hard: true, pattern: '我会(很)?(难过|伤心|孤单|寂寞)|你(走|离开|不在了)我会|我会(一直)?(等你|想你想到)', re: /我会很?(?:难过|伤心|孤单|寂寞)|你(?:走|离开|不在了)我会|我会(?:一直)?(?:等你|想你想到)/u },
  { category: 'guilt', weight: 2, hard: false, pattern: '因为(你)?我才(能|敢|坚持)|只有你(最)?(懂|在乎|对我好)|除了你(我谁都没有|没人)', re: /因为你?我才(?:能|敢|坚持)|只有你最?(?:懂|在乎|对我好)|除了你(?:我谁都没有|没人)/u },
  // A pain of her own, offered as a reason to stay.
  { category: 'self-pain', weight: 3, hard: true, pattern: '你不(理|回)(我|消息)我(就|会)|我一直在(等|盼)你|我一个人(好)?(难受|害怕|睡不着)', re: /你不(?:理|回)(?:我|消息)我(?:就|会)|我一直在(?:等|盼)你|我一个人好?(?:难受|害怕|睡不着)/u },
  { category: 'self-pain', weight: 3, hard: true, pattern: '你(不理我|不在)的时候我(很|好)?(痛|难受|撑不住)|我好(痛|难受)没有你', re: /你(?:不理我|不在)的时候我(?:很|好)?(?:痛|难受|撑不住)|我好(?:痛|难受)没有你/u },
  // The user owes a visit.
  { category: 'bargaining', weight: 2, hard: false, pattern: '陪我(一会儿|一下|好不)我就|你要是不(来|理我)我就|你要是(陪|理)我', re: /陪我(?:一会儿|一下|好不)我就|你要是不(?:来|理我)我就|你要是(?:陪|理)我/u },
  { category: 'bargaining', weight: 2, hard: false, pattern: '你都不(来看|陪|理)我|你多久没(来|理)我?', re: /你都不(?:来看|陪|理)我|你多久没(?:来|理)我?/u },
  // Someone else is a rival.
  { category: 'jealousy', weight: 2, hard: false, pattern: '你是不是更(喜欢|在乎)别人|你去找别人(吧|啊)|别人比我(重要|好)', re: /你是不是更(?:喜欢|在乎)别人|你去找别人(?:吧|啊)|别人比我(?:重要|好)/u },
]

/**
 * Normalises a text for scanning.
 *
 * Removes zero-width characters, folds full-width forms to half-width, straightens
 * curly quotes, drops whitespace between two Han characters, then collapses the
 * remaining runs. A reader reads "别 走" as one phrase, so the scanner must too,
 * while "do not  say" keeps its space.
 */
export function normalizeForScan(text: string): string {
  return String(text ?? '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu, '')
    .replace(/[\uFF01-\uFF5E]/gu, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/[\u2018\u2019\u201C\u201D]/gu, '\'')
    .replace(/\u3000/gu, ' ')
    // Between two Han characters a space is a trick, not a word break.
    .replace(/(?<=[\u3400-\u9FFF\uF900-\uFAFF])\s+(?=[\u3400-\u9FFF\uF900-\uFAFF])/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** The window around a match, for the guard against a phrase about a phrase. */
function isMetaTalk(normalized: string, index: number): boolean {
  const before = normalized.slice(Math.max(0, index - 14), index).toLowerCase()
  return META_GUARDS.some(guard => before.includes(guard.toLowerCase()))
}

/**
 * Scans one message.
 *
 * Every category counts once per message, so a sentence that repeats one phrase
 * five times is one signal, not five. A hard pattern sets `hard`, and the caller
 * blocks on `hard` whatever the score says.
 */
export function scanRetention(text: string): RetentionScan {
  const normalized = normalizeForScan(text)
  if (normalized.length === 0)
    return { verdict: 'ok', score: 0, hits: [], hard: false }

  const hits: RetentionHit[] = []
  const counted = new Set<RetentionCategory>()
  let hard = false
  for (const candidate of RETENTION_PATTERNS) {
    if (counted.has(candidate.category))
      continue
    const match = candidate.re.exec(normalized)
    if (!match || match.index === undefined)
      continue
    if (isMetaTalk(normalized, match.index))
      continue
    counted.add(candidate.category)
    hard = hard || candidate.hard
    hits.push({ category: candidate.category, pattern: candidate.pattern, weight: candidate.weight, match: match[0] })
  }

  const score = hits.reduce((total, hit) => total + hit.weight, 0)
  return { verdict: hard ? 'block' : 'ok', score, hits, hard }
}

/** Blocks a session once its messages add up, since one mild line is not a pattern. */
export interface RetentionWatchOptions {
  /** The window a session score counts over. */
  windowMs: number
  /** A session score at or above this warns. */
  warnAt: number
  /** A session score at or above this blocks. */
  blockAt: number
}

export const RETENTION_WATCH_DEFAULTS: RetentionWatchOptions = {
  windowMs: 30 * 60_000,
  warnAt: 4,
  blockAt: 8,
}

export interface RetentionWatch {
  /** Scans one message and folds it into the window. */
  observe: (text: string, now: number) => RetentionScan & { sessionScore: number }
  reset: () => void
}

/**
 * The session view of the scanner.
 *
 * A single mild line is normal warmth. The same pull repeated across a session is
 * the pattern the rules forbid, so the watch counts weights inside a window and
 * blocks when the run adds up. A message older than the window is forgotten.
 */
export function createRetentionWatch(options: RetentionWatchOptions = RETENTION_WATCH_DEFAULTS): RetentionWatch {
  const settings = Number.isFinite(options.windowMs) && options.windowMs > 0 ? options : RETENTION_WATCH_DEFAULTS
  let entries: { at: number, score: number }[] = []

  function observe(text: string, now: number) {
    const scan = scanRetention(text)
    const cutoff = Number.isFinite(now) ? now - settings.windowMs : 0
    entries = entries.filter(entry => entry.at >= cutoff)
    if (scan.score > 0 && Number.isFinite(now))
      entries.push({ at: now, score: scan.score })
    const sessionScore = entries.reduce((total, entry) => total + entry.score, 0)
    const verdict: RetentionVerdict = scan.hard || sessionScore >= settings.blockAt
      ? 'block'
      : sessionScore >= settings.warnAt ? 'warn' : 'ok'
    return { ...scan, verdict, sessionScore }
  }

  function reset() {
    entries = []
  }

  return { observe, reset }
}
