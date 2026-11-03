import { formatAgentStatePrompt, useCastaliaPluginStore } from '@proj-airi/castalia-plugin'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { CASTALIA_SET_DESIRE_TOOL_NAME, createCastaliaStateTools } from '../tools/castalia'

describe('castalia prompt and reply paths', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('carries the stored self-state into the next system prompt', () => {
    const castalia = useCastaliaPluginStore()
    castalia.setCharacter('alice')
    castalia.recordEmotion({ valence: 0.6, arousal: 0.2, dominance: 0.4 }, 'Solving it felt satisfying.')
    castalia.setDesire('Learn how the song was made.')

    const prompt = formatAgentStatePrompt(castalia.snapshotFor('alice'))

    expect(prompt).toContain('Castalia self-state')
    expect(prompt).toContain('What you want right now: Learn how the song was made.')
    expect(prompt).toContain('warmer than usual, in control')
    expect(castalia.moodHistory).toHaveLength(1)
  })

  it('applies the reply tool call to the state that the next prompt reads', async () => {
    const castalia = useCastaliaPluginStore()
    castalia.setCharacter('alice')
    const persona = castalia.activeCharacterId
    const tools = await createCastaliaStateTools({
      recordEmotion: (vad, reason) => castalia.recordEmotion(vad, reason, persona),
      setDesire: desire => castalia.setDesire(desire, persona),
    })

    const setDesire = tools.find(tool => tool.function.name === CASTALIA_SET_DESIRE_TOOL_NAME)
    await setDesire!.execute({ desire: 'Hear the rest of the song.' }, { messages: [], toolCallId: 'reply' })

    expect(castalia.snapshotFor('alice').currentDesire).toBe('Hear the rest of the song.')
    expect(formatAgentStatePrompt(castalia.snapshotFor('alice'))).toContain('What you want right now: Hear the rest of the song.')
    expect(castalia.activeCharacterId).toBe('alice')
  })
})
