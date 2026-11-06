import type { Tool } from '@xsai/shared-chat'

import type { MemorySearchHit } from '../stores/memory'

import { rawTool } from '@xsai/tool'
import { description, maxLength, maxValue, minLength, minValue, number, pipe, safeParse, strictObject, string } from 'valibot'
import { toJsonSchema } from 'xsschema'

export const CASTALIA_RECORD_EMOTION_TOOL_NAME = 'builtIn_castaliaRecordEmotion'
export const CASTALIA_SET_DESIRE_TOOL_NAME = 'builtIn_castaliaSetDesire'
export const CASTALIA_SEARCH_DIARY_TOOL_NAME = 'builtIn_castaliaSearchDiary'

const emotionParameters = strictObject({
  valence: pipe(number(), minValue(-1), maxValue(1), description('Your own emotional valence, from -1 to 1.')),
  arousal: pipe(number(), minValue(-1), maxValue(1), description('Your own emotional arousal, from -1 to 1.')),
  dominance: pipe(number(), minValue(-1), maxValue(1), description('Your own sense of agency, from -1 to 1.')),
  reason: pipe(string(), minLength(1), maxLength(300), description('A brief first-person reason for this emotional state.')),
})
const desireParameters = strictObject({
  desire: pipe(string(), maxLength(300), description('A current desire or an empty string to clear it.')),
})
const diaryParameters = strictObject({
  query: pipe(string(), minLength(1), maxLength(200), description('One short phrase from the day you are looking for, in the words that day would use.')),
})

/** One hit stays readable: the day, her line, then what she kept. */
const DIARY_DAY_CHARS = 400
const DIARY_DAY_LIMIT = 5

/**
 * One remembered day as the tool shows it.
 *
 * A day is stored as `# diary-YYYY-MM-DD`, the one line she would say, then the kept thoughts.
 * The date matters more than the rank: the owner asks about a day, not about a score.
 */
function formatDiaryDay(hit: MemorySearchHit) {
  const raw = hit.text.trim()
  const [head = '', ...rest] = raw.split('\n')
  const dated = /^#\s*diary-(\d{4}-\d{2}-\d{2})\s*$/.exec(head)
  if (!dated) {
    const flat = raw.replace(/\s+/g, ' ')
    return `- ${flat.length > DIARY_DAY_CHARS ? `${flat.slice(0, DIARY_DAY_CHARS)}…` : flat}`
  }
  // The stored shape is `<her line>\n\n<kept thoughts>`. Split on the first blank line, so a
  // line inside the thoughts stays part of them.
  const body = rest.join('\n').trim()
  const blank = body.indexOf('\n\n')
  const description = (blank === -1 ? body : body.slice(0, blank)).trim()
  const kept = (blank === -1 ? '' : body.slice(blank + 2)).trim().replace(/\n+/g, ' / ')
  const line = `${dated[1]} · ${description}`
  if (!kept)
    return line
  return `${line}\n  ${kept.length > DIARY_DAY_CHARS ? `${kept.slice(0, DIARY_DAY_CHARS)}…` : kept}`
}

/** Creates tools that update the current character's transient self-state. */
export async function createCastaliaStateTools(options: {
  /** Resolves true only when the engine accepted the write. The tool reports the refusal. */
  recordEmotion: (vad: { valence: number, arousal: number, dominance: number }, reason: string) => Promise<boolean>
  setDesire: (desire: string) => void
}): Promise<Tool[]> {
  return [
    rawTool({
      name: CASTALIA_RECORD_EMOTION_TOOL_NAME,
      description: 'Record your own VAD emotion after a meaningful interaction. Use sparingly and never label the user with this tool.',
      parameters: await toJsonSchema(emotionParameters),
      execute: async (rawInput) => {
        const parsed = safeParse(emotionParameters, rawInput)
        if (!parsed.success)
          return 'Emotion not recorded. Keep VAD values between -1 and 1.'
        const { valence, arousal, dominance, reason } = parsed.output
        const recorded = await options.recordEmotion({ valence, arousal, dominance }, reason)
        return recorded
          ? 'Your VAD emotion was recorded for the next turn.'
          : 'Emotion not recorded. The engine refused the write.'
      },
    }),
    rawTool({
      name: CASTALIA_SET_DESIRE_TOOL_NAME,
      description: 'Set or clear your own current desire. Keep it specific to what you want, not what the user wants.',
      parameters: await toJsonSchema(desireParameters),
      execute: async (rawInput) => {
        const parsed = safeParse(desireParameters, rawInput)
        if (!parsed.success)
          return 'Desire not changed. Use a short statement or an empty string to clear it.'
        options.setDesire(parsed.output.desire)
        return parsed.output.desire.trim() ? 'Your desire was updated for the next turn.' : 'Your desire was cleared.'
      },
    }),
  ]
}

/**
 * The diary tool: reads the diary partition, and nothing else.
 *
 * Why a tool and not the index: her diary is the private side of what she remembers. MemGPT keeps
 * archival memory behind an explicit call for the same reason, so an ordinary turn never reads it
 * and a lookup by the owner stays a deliberate act, like opening the page in Settings.
 */
export async function createCastaliaDiaryTools(options: {
  /** Ranked read over this card's diary. `[]` means the diary holds no such day. */
  searchDiary: (query: string) => Promise<MemorySearchHit[]>
}): Promise<Tool[]> {
  return [
    rawTool({
      name: CASTALIA_SEARCH_DIARY_TOOL_NAME,
      description: 'Read the diary she wrote for herself. Call it only when she brings up her own diary, or the owner asks what she wrote or remembers about a day. Never call it in an ordinary conversation, and never quote the diary otherwise.',
      parameters: await toJsonSchema(diaryParameters),
      execute: async (rawInput) => {
        const parsed = safeParse(diaryParameters, rawInput)
        if (!parsed.success)
          return 'Give one short phrase from the day you are looking for.'
        const query = parsed.output.query.trim()
        let hits: MemorySearchHit[]
        try {
          hits = await options.searchDiary(query)
        }
        catch {
          // 打不开 ≠ 没写过。把失败说成「日记里没有」，她会对着主人否认自己写过的一天。
          return 'The diary could not be opened just now. Say that it failed to open, and do not say the day is missing.'
        }
        if (!hits.length)
          return `Her diary holds nothing about "${query}". Say so plainly, and do not invent a day.`
        return hits.slice(0, DIARY_DAY_LIMIT).map(formatDiaryDay).join('\n')
      },
    }),
  ]
}
