import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useRecipesStore } from './recipes'

describe('recipes store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // A model proposal waits for the owner. After one approval it runs without asking again.
  it('keeps a model proposal unusable until the owner approves and enables it', () => {
    const recipes = useRecipesStore()
    const proposal = recipes.propose({ name: 'Game night', description: 'Starts a game.', instructions: 'Open the game.', keywords: ['想玩粥了'] })
    expect(recipes.usable.some(recipe => recipe.id === proposal.id)).toBe(false)

    recipes.approve(proposal.id)
    recipes.setEnabled(proposal.id, true)

    expect(recipes.usable.some(recipe => recipe.id === proposal.id)).toBe(true)
  })

  it('approves the owner own recipes as they are added', () => {
    const recipes = useRecipesStore()
    recipes.add({ name: 'Music', description: 'Plays music.', instructions: 'Play music.', keywords: [], enabled: true })

    expect(recipes.usable.map(recipe => recipe.name)).toEqual(['Music'])
  })

  // Editing changes what a recipe does, never who wrote it or whether the owner approved it.
  it('edits a recipe and keeps its source, switch, and approval', () => {
    const recipes = useRecipesStore()
    const proposal = recipes.propose({ name: 'Summaries', description: 'Recaps.', instructions: 'List goals.', keywords: [] })

    recipes.update(proposal.id, { name: 'Recap', description: 'When the owner asks.', instructions: 'List goals and decisions.', keywords: ['总结'] })

    expect(recipes.recipes.find(recipe => recipe.id === proposal.id)).toEqual({
      id: proposal.id,
      name: 'Recap',
      description: 'When the owner asks.',
      instructions: 'List goals and decisions.',
      keywords: ['总结'],
      source: 'model',
      enabled: false,
      approved: false,
    })
  })

  // A scheduled run has no owner message behind it, so it must own a task session: the schedule turns the
  // background flag on by itself, and saving waits a full interval before the first call.
  it('schedules a recipe, marks a run, and takes it off the schedule', () => {
    const recipes = useRecipesStore()
    recipes.add({ name: 'Morning brief', description: 'Summarize the overnight news.', instructions: 'List the headlines.', keywords: [], enabled: true })
    const id = recipes.recipes[0].id
    const now = 1_800_000_000_000

    recipes.setSchedule(id, 30, now)

    expect(recipes.recipes[0]).toMatchObject({ background: true, schedule: { everyMinutes: 30 }, lastRunAt: now })

    recipes.markRun(id, now + 60_000)

    expect(recipes.recipes[0].lastRunAt).toBe(now + 60_000)

    recipes.setSchedule(id, undefined)

    expect(recipes.recipes[0].schedule).toBeUndefined()
  })
})
