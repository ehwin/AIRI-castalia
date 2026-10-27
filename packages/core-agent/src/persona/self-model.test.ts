import { describe, expect, it } from 'vitest'

import {
  affectFromCastalia,
  createSelfModel,
  renderSelfModelContext,
  restoreSelfModel,
  reviewSelfPrediction,
  toCastaliaSelfMemory,
} from './self-model'

const prediction = {
  id: 'prediction-1',
  assessmentKey: 'long-session-energy',
  claim: 'Long work sessions leave me tired.',
  expectedOutcome: 'I will feel tired after the session.',
  createdAt: 1_000,
}

describe('self model', () => {
  it('uses Castalia mood, energy, desire, and VAD as transient evidence context', () => {
    expect(affectFromCastalia({
      currentMood: -4,
      energy: 35,
      currentDesire: 'finish the story',
    }, { valence: -0.3, arousal: 0.1, dominance: 0.2 })).toEqual({
      mood: -4,
      energy: 35,
      desire: 'finish the story',
      vad: { valence: -0.3, arousal: 0.1, dominance: 0.2 },
    })
  })

  it('learns from an observed outcome and lowers confidence after contradiction', () => {
    const first = reviewSelfPrediction(createSelfModel(), prediction, {
      predictionId: prediction.id,
      observedOutcome: 'I felt tired after the session.',
      supportsClaim: true,
      observedAt: 2_000,
      affect: {
        mood: -6,
        energy: 24,
        vad: { valence: -0.4, arousal: 0.2, dominance: -0.1 },
      },
    })
    const second = reviewSelfPrediction(first.model, {
      ...prediction,
      id: 'prediction-2',
      createdAt: 3_000,
    }, {
      predictionId: 'prediction-2',
      observedOutcome: 'I felt alert after a similar session.',
      supportsClaim: false,
      observedAt: 4_000,
    })

    expect(first.assessment.evidenceBalance).toBeCloseTo(2 / 3)
    expect(second.assessment.evidenceBalance).toBe(0.5)
    expect(second.assessment.supportCount).toBe(1)
    expect(second.assessment.contradictionCount).toBe(1)
  })

  it('does not create self knowledge without an observed outcome', () => {
    expect(renderSelfModelContext(createSelfModel().assessments)).toBe('')
  })

  it('labels a single outcome as evidence balance, not probability', () => {
    const review = reviewSelfPrediction(createSelfModel(), prediction, {
      predictionId: prediction.id,
      observedOutcome: 'The outcome partly matched.',
      supportsClaim: true,
      observedAt: 2_000,
    })

    expect(renderSelfModelContext([review.assessment])).toContain('Evidence balance: 67%')
    expect(renderSelfModelContext([review.assessment])).toContain('not a calibrated probability')
    expect(renderSelfModelContext([review.assessment])).toContain('Contradicting outcomes: 0')
  })

  it('maps evidence to Castalia memory fields with self ownership', () => {
    const review = reviewSelfPrediction(createSelfModel(), prediction, {
      predictionId: prediction.id,
      observedOutcome: 'I felt tired after the session.',
      supportsClaim: true,
      observedAt: 2_000,
      affect: {
        mood: -6,
        energy: 24,
        vad: { valence: -0.4, arousal: 0.2, dominance: -0.1 },
      },
    })
    const memory = toCastaliaSelfMemory(review)

    expect(memory.subject).toBe('self')
    expect(memory.memType).toBe('project')
    expect(memory.category).toBe('self_model_evidence')
    expect(memory.emotionalImpact).toBe(6)
    expect(memory.tags).toContain('self-model')
    expect(JSON.parse(memory.text)).toMatchObject({
      kind: 'self-model-evidence',
      supportCount: 1,
      latestEvidence: { summary: expect.stringContaining('Affective context: mood -6, energy 24, VAD -0.4/0.2/-0.1.') },
    })
  })

  it('restores the newest assessment per claim from Castalia records', () => {
    const first = reviewSelfPrediction(createSelfModel(), prediction, {
      predictionId: prediction.id,
      observedOutcome: 'I felt tired after the session.',
      supportsClaim: true,
      observedAt: 2_000,
    })
    const second = reviewSelfPrediction(first.model, {
      ...prediction,
      id: 'prediction-2',
      createdAt: 3_000,
    }, {
      predictionId: 'prediction-2',
      observedOutcome: 'I felt alert after a similar session.',
      supportsClaim: false,
      observedAt: 4_000,
    })
    const restored = restoreSelfModel([
      { id: 'memory-2', text: toCastaliaSelfMemory(second).text, createdAt: '2026-10-26T00:00:04.000Z' },
      { id: 'memory-1', text: toCastaliaSelfMemory(first).text, createdAt: '2026-10-26T00:00:02.000Z' },
    ])

    expect(restored.assessments).toHaveLength(1)
    expect(restored.assessments[0].evidenceBalance).toBe(0.5)
    expect(restored.assessments[0].supportCount).toBe(1)
    expect(restored.assessments[0].contradictionCount).toBe(1)
  })

  it('ignores invalid Castalia records during restore', () => {
    expect(restoreSelfModel([
      { id: 'bad', text: '{not json}', createdAt: '2026-10-26T00:00:00.000Z' },
    ]).assessments).toEqual([])
  })

  it('rejects affect values outside Castalia ranges', () => {
    expect(() => reviewSelfPrediction(createSelfModel(), prediction, {
      predictionId: prediction.id,
      observedOutcome: 'I felt tired after the session.',
      supportsClaim: true,
      observedAt: 2_000,
      affect: { mood: -11 },
    })).toThrow('Castalia mood must be between -10 and 10.')
  })

  it('rejects an outcome that belongs to another prediction', () => {
    expect(() => reviewSelfPrediction(createSelfModel(), prediction, {
      predictionId: 'another-prediction',
      observedOutcome: 'The outcome was observed.',
      supportsClaim: true,
      observedAt: 2_000,
    })).toThrow('The outcome must refer to its prediction.')
  })
})
