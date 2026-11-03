import type { Tool } from '@xsai/shared-chat'

import { rawTool } from '@xsai/tool'
import { description, maxLength, maxValue, minLength, minValue, number, pipe, safeParse, strictObject, string } from 'valibot'
import { toJsonSchema } from 'xsschema'

export const CASTALIA_RECORD_EMOTION_TOOL_NAME = 'builtIn_castaliaRecordEmotion'
export const CASTALIA_SET_DESIRE_TOOL_NAME = 'builtIn_castaliaSetDesire'

const emotionParameters = strictObject({
  valence: pipe(number(), minValue(-1), maxValue(1), description('Your own emotional valence, from -1 to 1.')),
  arousal: pipe(number(), minValue(-1), maxValue(1), description('Your own emotional arousal, from -1 to 1.')),
  dominance: pipe(number(), minValue(-1), maxValue(1), description('Your own sense of agency, from -1 to 1.')),
  reason: pipe(string(), minLength(1), maxLength(300), description('A brief first-person reason for this emotional state.')),
})
const desireParameters = strictObject({
  desire: pipe(string(), maxLength(300), description('A current desire or an empty string to clear it.')),
})

/** Creates tools that update the current character's transient self-state. */
export async function createCastaliaStateTools(options: {
  recordEmotion: (vad: { valence: number, arousal: number, dominance: number }, reason: string) => void
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
        options.recordEmotion({ valence, arousal, dominance }, reason)
        return 'Your VAD emotion was recorded for the next turn.'
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
