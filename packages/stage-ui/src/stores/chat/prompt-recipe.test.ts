import { describe, expect, it } from 'vitest'

import { composeRecipeSpacePrompt, composeSystemPrompt, localZoneLabel } from './prompt-recipe'

describe('chat prompt recipe', () => {
  // https://github.com/moeru-ai/airi/discussions/2239
  it('adds the AIRI chat math syntax before the identity', () => {
    const content = composeSystemPrompt('You are AIRI.')

    expect(content).toContain('Use $$...$$ for inline math.')
    expect(content).toContain('Use a separate multiline $$ block for each display equation.')
    expect(content).toContain('Use a latex fence for a list of independent one-line equations.')
    expect(content).toContain('Use a math fence for one multiline equation or LaTeX environment.')
    expect(content).toContain('Do not use single dollar signs as math delimiters.')
    expect(content).not.toContain('eg: $ x^3 $')
    expect(content.endsWith('You are AIRI.')).toBe(true)
  })
  // The model only knows the time from the per-message prefix, so the prompt has to say what that prefix is.
  // A fixed zone keeps it byte-stable: the clock itself never enters the cacheable prefix.
  it('teaches the per-message time prefix before the identity', () => {
    const content = composeSystemPrompt('You are AIRI.', 'Asia/Shanghai (UTC+08:00)')

    expect(content).toContain('[YYYY-MM-DD HH:MM]')
    expect(content).toContain('Asia/Shanghai (UTC+08:00)')
    expect(content).toContain('The newest prefix is the current time')
    expect(content.indexOf('[YYYY-MM-DD HH:MM]')).toBeLessThan(content.indexOf('You are AIRI.'))
    // Nothing in the rule may be a live clock value, or the prompt cache breaks every minute.
    expect(composeSystemPrompt('You are AIRI.', 'Asia/Shanghai (UTC+08:00)'))
      .toBe(composeSystemPrompt('You are AIRI.', 'Asia/Shanghai (UTC+08:00)'))
    expect(content).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })
  it('names the machine zone and renders an offset for it', () => {
    expect(localZoneLabel(new Date(2026, 3, 25, 18, 47))).toMatch(/UTC[+-]\d{2}:\d{2}\)?$/)
    expect(localZoneLabel(new Date(2026, 3, 25, 18, 47))).toBe(localZoneLabel(new Date(2026, 7, 25, 18, 47)))
  })
  // A recipe runs in its own session, so its steps join that session's prefix and never the conversation's.
  it('describes a task recipe space', () => {
    const recipe = { id: 'user:look', name: 'Look', description: '', instructions: 'Read the screen slot.', keywords: [], source: 'user' as const, enabled: true, approved: true }

    expect(composeRecipeSpacePrompt(recipe)).toContain('Your reply is the recipe\'s result')
    expect(composeRecipeSpacePrompt(recipe)).toContain('Recipe steps:\nRead the screen slot.')
    // The steps can leave each run to the model, so they come after the recipe's purpose.
    expect(composeRecipeSpacePrompt({ ...recipe, description: 'Checks on the owner late at night.' }))
      .toContain('Purpose: Checks on the owner late at night.\nRecipe steps:\nRead the screen slot.')
  })
})
