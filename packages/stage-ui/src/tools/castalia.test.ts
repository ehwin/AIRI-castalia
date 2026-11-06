import { describe, expect, it, vi } from 'vitest'

import { CASTALIA_RECORD_EMOTION_TOOL_NAME, CASTALIA_SEARCH_DIARY_TOOL_NAME, CASTALIA_SET_DESIRE_TOOL_NAME, createCastaliaDiaryTools, createCastaliaStateTools } from './castalia'

describe('castalia state tools', () => {
  it('binds state changes to the character\'s plugin state', async () => {
    const state = {
      recordEmotion: vi.fn(async () => true),
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

  it('says so when the engine refuses the emotion', async () => {
    const state = {
      recordEmotion: vi.fn(async () => false),
      setDesire: vi.fn(),
    }
    const tools = await createCastaliaStateTools(state)
    const call = { messages: [], toolCallId: 'castalia-state' }

    const reply = await tools[0]!.execute({ valence: 0.2, arousal: 0.1, dominance: 0, reason: 'quiet' }, call)
    expect(reply).toBe('Emotion not recorded. The engine refused the write.')
  })

  it('rejects values outside the documented state ranges', async () => {
    const state = {
      recordEmotion: vi.fn(async () => true),
      setDesire: vi.fn(),
    }
    const tools = await createCastaliaStateTools(state)
    const call = { messages: [], toolCallId: 'castalia-state' }

    expect(await tools[0]!.execute({ valence: 2, arousal: 0, dominance: 0, reason: 'outside scale' }, call)).toContain('Emotion not recorded')
    expect(state.recordEmotion).not.toHaveBeenCalled()
  })
})

describe('castalia diary tool', () => {
  it('shows the day, her line and the thoughts she kept', async () => {
    const searchDiary = vi.fn(async () => ([{
      text: '# diary-2026-11-01\n\n他说今天累死了，我记着了\n\n- 09:12 阅读Gemini学习建议\n- 19:30 他说今天累死了，我记着了',
      score: 0.8,
    }]))
    const tools = await createCastaliaDiaryTools({ searchDiary })
    const call = { messages: [], toolCallId: 'castalia-diary' }

    expect(tools.map(tool => tool.function.name)).toEqual([CASTALIA_SEARCH_DIARY_TOOL_NAME])
    const reply = await tools[0]!.execute({ query: '累' }, call)

    expect(searchDiary).toHaveBeenCalledWith('累')
    expect(reply).toContain('2026-11-01 · 他说今天累死了，我记着了')
    expect(reply).toContain('09:12 阅读Gemini学习建议')
    // 存的是 store 文本，给模型的是那一天本身，不把 markdown 头交出去
    expect(reply).not.toContain('# diary-')
  })

  it('says the diary holds nothing instead of inventing a day', async () => {
    const tools = await createCastaliaDiaryTools({ searchDiary: async () => [] })
    const reply = await tools[0]!.execute({ query: '前天' }, { messages: [], toolCallId: 'castalia-diary' })

    expect(reply).toContain('holds nothing')
  })

  it('says the diary could not be read instead of saying the day is missing', async () => {
    // 打不开时返回空列表，模型会把失败当「她没写过」，然后对主人否认那一天。
    const bankDown = async (): Promise<never> => {
      throw new Error('bank down')
    }
    const tools = await createCastaliaDiaryTools({ searchDiary: bankDown })
    const reply = await tools[0]!.execute({ query: '昨天' }, { messages: [], toolCallId: 'castalia-diary' })

    expect(reply).toContain('could not be opened')
    expect(reply).not.toContain('holds nothing')
  })

  it('rejects an empty query before it calls the bank', async () => {
    const searchDiary = vi.fn(async () => [])
    const tools = await createCastaliaDiaryTools({ searchDiary })
    const reply = await tools[0]!.execute({ query: '' }, { messages: [], toolCallId: 'castalia-diary' })

    expect(reply).toContain('Give one short phrase')
    expect(searchDiary).not.toHaveBeenCalled()
  })
})
