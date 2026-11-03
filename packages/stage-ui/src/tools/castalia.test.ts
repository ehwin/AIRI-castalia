import { describe, expect, it, vi } from 'vitest'

import { CASTALIA_RECORD_EMOTION_TOOL_NAME, CASTALIA_SET_DESIRE_TOOL_NAME, createCastaliaStateTools } from './castalia'

describe('castalia state tools', () => {
  it('binds state changes to the character\'s plugin state', async () => {
    const state = {
      recordEmotion: vi.fn(),
      setDesire: vi.fn(),
    }
    const tools = await createCastaliaStateTools(state)
    const call = { messages: [], toolCallId: 'castalia-state' }

    expect(tools.map(tool => tool.function.name)).toEqual([
      CASTALIA_RECORD_EMOTION_TOOL_NAME,
      CASTALIA_SET_DESIRE_TOOL_NAME,
    ])
    await tools[0]!.execute({ valence: 0.7, arousal: 0.2, dominance: 0.4, reason: 'I felt satisfied.' }, call)
    await tools[1]!.execute({ desire: 'Learn more about the music.' }, call)

    expect(state.recordEmotion).toHaveBeenCalledWith({ valence: 0.7, arousal: 0.2, dominance: 0.4 }, 'I felt satisfied.')
    expect(state.setDesire).toHaveBeenCalledWith('Learn more about the music.')
  })

  it('rejects values outside the documented state ranges', async () => {
    const state = {
      recordEmotion: vi.fn(),
      setDesire: vi.fn(),
    }
    const tools = await createCastaliaStateTools(state)
    const call = { messages: [], toolCallId: 'castalia-state' }

    expect(await tools[0]!.execute({ valence: 2, arousal: 0, dominance: 0, reason: 'outside scale' }, call)).toContain('Emotion not recorded')
    expect(state.recordEmotion).not.toHaveBeenCalled()
  })
})
