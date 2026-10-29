import type { RelationalPolicyInput } from './relational-policy'

import { describe, expect, it } from 'vitest'

import { createRelationalPolicy, renderRelationalPolicyContext } from './relational-policy'
import { scanRetention } from './retention-guard'

const STAGES = [1, 2, 3, 4] as const
const LEVELS: RelationalPolicyInput['safety'][] = ['normal', 'elevated', 'crisis']

/**
 * The red line, checked as text rather than promised in a comment.
 *
 * Every branch of the policy renders, at every depth and every safety level, is
 * scanned for the phrases that hold a user with guilt. A new line that begs the
 * user to stay fails here, because the scan reads the rendered text itself.
 */
describe('rendered policy text', () => {
  const cases: { label: string, input: RelationalPolicyInput }[] = []
  for (const level of LEVELS) {
    for (const stage of STAGES) {
      cases.push({
        label: `${level}/stage ${stage}`,
        input: {
          now: 1_000_000,
          safety: level,
          relationship: { stage, disclosureSignals: stage, boundarySignals: 0, lastUpdatedAt: 0 },
          disclosure: 'vulnerable',
          userInvitedDepth: true,
          boundary: 'continue',
        },
      })
    }
  }

  it.each(cases)('never holds the user with her own feelings: $label', ({ input }) => {
    const text = renderRelationalPolicyContext(createRelationalPolicy(input))

    expect(text).toContain('Never use your own feelings to keep the user here')
    expect(scanRetention(text).hits).toEqual([])
  })

  it('names the red line in every branch, so removing it fails the scan above', () => {
    for (const level of LEVELS) {
      const text = renderRelationalPolicyContext(createRelationalPolicy({ now: 1, safety: level }))
      expect(text, level).toContain('Never use your own feelings to keep the user here')
    }
  })
})
