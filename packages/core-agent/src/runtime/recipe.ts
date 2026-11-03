/** A yes-or-no question. */
interface NoulQuestion {
  type: 'noul'
  instructions: string
  /** What yes and no mean. */
  criteria: { true: string, false: string }
}

/** Picks one named option. */
interface ChoiceQuestion {
  type: 'choice'
  instructions: string
  /** Option name to its meaning. */
  criteria: Record<string, string>
}

/** The question of a decision: yes or no, or one of some options. */
export type DecisionQuestion = NoulQuestion | ChoiceQuestion

/**
 * What one answer of a decision does. An answer without an action replies as usual.
 * - `stay-quiet`: the character reads the message and does not reply.
 * - `hint`: the character replies and keeps a sentence in mind.
 * - `recipe`: the character uses another recipe.
 */
export type DecisionAction
  = | { kind: 'stay-quiet' }
    | { kind: 'hint', text: string }
    | { kind: 'recipe', recipeId: string }

/**
 * A decision: one question about the owner's message, and the action of each answer.
 * A keyword of its recipe invokes it like any skill. The character picks one answer, and code picks what follows.
 */
export interface RecipeDecision {
  question: DecisionQuestion
  /** Answer key to action. The keys are `true` and `false`, or the option names. An answer without an action replies as usual. */
  actions: Record<string, DecisionAction>
}

/** One recipe. The user or a model proposal supplies it. */
export interface Recipe {
  id: string
  name: string
  /** When the recipe fits. The conversation model reads it to choose. */
  description: string
  /** The steps that the conversation or a background run follows. A decision recipe has none. */
  instructions: string
  /** A decision recipe asks this after its keyword appears in the owner's message, instead of giving steps. */
  decision?: RecipeDecision
  /** Words in the owner's message that invoke the recipe. Without one, only the conversation run chooses it. */
  keywords: string[]
  source: 'user' | 'model'
  enabled: boolean
  /**
   * The user authorized this recipe once. Later uses need no prompt.
   * A model proposal waits unauthorized until the user approves it.
   */
  approved: boolean
  /**
   * The recipe starts itself on this interval, without the owner's message.
   * Only a background recipe can keep it: a run that started by itself has to own a task session.
   */
  schedule?: RecipeSchedule
  /** The last start, by the owner, the model, or the schedule. A schedule never runs twice inside its interval. */
  lastRunAt?: number
  /**
   * The recipe runs as a task in its own session, and its result reaches the conversation later.
   * Without it, using the recipe gives its steps to the conversation, which follows them itself.
   */
  background?: boolean
}

/** How often a recipe starts itself. */
export interface RecipeSchedule {
  /** Minutes between two runs. Below `MIN_AUTO_RUN_MINUTES` is refused, so a typo cannot loop the model. */
  everyMinutes: number
}

/** The shortest auto-run interval. One tick is already a model call, so minutes are the unit that makes sense. */
export const MIN_AUTO_RUN_MINUTES = 15

/** When the schedule next starts the recipe. Undefined when it has none. */
export function nextRunAt(recipe: Recipe, now: number): number | undefined {
  if (!recipe.schedule)
    return undefined
  const everyMinutes = Math.max(MIN_AUTO_RUN_MINUTES, Math.round(recipe.schedule.everyMinutes))
  // A recipe that never ran waits one interval, so saving the schedule does not call the model at once.
  return (recipe.lastRunAt ?? now) + everyMinutes * 60_000
}

/**
 * Instructions that let the model decide what each run does, from the recipe's purpose.
 * A model proposal writes them when the owner wants the model to decide each run, and Settings recognize them to show that choice. The runtime treats them as plain instructions.
 */
export const MODEL_DECIDES_STEPS = 'Decide what this run does from the recipe\'s purpose and what you know now, and use your tools to do it.'

/** Recipes that can run now: enabled and authorized. */
export function usableRecipes(recipes: readonly Recipe[]) {
  return recipes.filter(recipe => recipe.enabled && recipe.approved)
}

/** Recipes a schedule starts now: authorized, switched on, scheduled, and past the interval. */
export function dueRecipes(recipes: readonly Recipe[], now: number) {
  return usableRecipes(recipes).filter((recipe) => {
    const at = nextRunAt(recipe, now)
    return at !== undefined && now >= at
  })
}

/** Whether a recipe runs in its own session. */
export function isBackgroundRecipe(recipe: Recipe) {
  return recipe.background === true
}

/** Usable recipes whose keyword appears in the text. Matching ignores letter case. */
export function matchKeywordRecipes(recipes: readonly Recipe[], text: string) {
  const lower = text.toLowerCase()
  return usableRecipes(recipes).filter(recipe => recipe.keywords.some(keyword => keyword.trim() && lower.includes(keyword.trim().toLowerCase())))
}

/** One answer that the character can give: the id that it answers with, the action key, and what the answer means. */
export interface DecisionOption {
  id: string
  key: string
  meaning: string
}

/**
 * The answers of a decision in order: yes then no, or the options.
 * The character answers with the id: `yes` or `no`, or an option number from 1.
 */
export function decisionOptions(question: DecisionQuestion): DecisionOption[] {
  if (question.type === 'noul')
    return [{ id: 'yes', key: 'true', meaning: question.criteria.true }, { id: 'no', key: 'false', meaning: question.criteria.false }]
  return Object.entries(question.criteria).map(([key, meaning], index) => ({ id: String(index + 1), key, meaning }))
}

/**
 * Picks what follows the character's answer. The character commits to one answer, and code picks its action.
 * A decision has no unsure answer, so every judgment leads to the action of the answer that the character chose.
 *
 * Returns:
 * - The answered option and its action. Without an action, the character replies as usual.
 * - An error text for an answer that the decision does not have, so the character can fix its call.
 */
export function judgeDecision(decision: RecipeDecision, answerId: string): { option: DecisionOption, action?: DecisionAction } | string {
  const options = decisionOptions(decision.question)
  const option = options.find(entry => entry.id === answerId.trim())
  if (!option)
    return `The answer must be one of: ${options.map(entry => entry.id).join(', ')}.`
  const action = decision.actions[option.key]
  return { option, ...(action ? { action } : {}) }
}
