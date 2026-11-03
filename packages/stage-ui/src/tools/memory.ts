import type { Tool } from '@xsai/shared-chat'

import type { MemoryEntry, MemoryFact, MemorySearchHit } from '../stores/memory'

import { rawTool } from '@xsai/tool'
import { array, description, maxLength, minLength, pipe, safeParse, strictObject, string } from 'valibot'
import { toJsonSchema } from 'xsschema'

export const READ_MEMORY_TOOL_NAME = 'builtIn_readMemory'
export const SEARCH_MEMORY_TOOL_NAME = 'builtIn_searchMemory'
export const WRITE_MEMORY_TOOL_NAME = 'builtIn_writeMemory'
export const FORGET_MEMORY_TOOL_NAME = 'builtIn_forgetMemory'

const nameSchema = pipe(string(), minLength(1), maxLength(64), description('The entry name, as the memory index shows it, in kebab case.'))
const readParameters = strictObject({
  names: pipe(array(nameSchema), minLength(1), description('Every entry that the reply needs, so one call reads them all.')),
})
/**
 * A search carries only the query: the backend decides how many rows a lookup needs.
 *
 * Why one phrase and not a keyword list: measured on the live bank (2026-11-03), the query
 * "拔牙" ranked the dentist fact first, while the list "拔牙 牙齿 牙医 看牙" did not return it
 * in the top five at all. Extra terms dilute the vector match faster than they add recall.
 */
const searchParameters = strictObject({
  query: pipe(string(), minLength(1), maxLength(200), description('One short phrase, in the words the remembered fact would use. A single phrase ranks better than a keyword list: extra terms dilute the match.')),
})
/** Forgetting an entry takes only its name. */
const forgetParameters = strictObject({ name: nameSchema })
// Strict function calling needs every property in `required`, in nested objects too.
const entrySchema = strictObject({
  name: nameSchema,
  description: pipe(string(), maxLength(150), description('One line for the index. When the fact fits in one line, write the fact itself. Otherwise write when the fact matters.')),
  body: pipe(string(), minLength(1), maxLength(2000), description('The fact itself, with what makes it true or when it was said.')),
})
const writeParameters = strictObject({
  entries: pipe(array(entrySchema), minLength(1), description('Every fact to save in this turn, one entry per fact.')),
})

/**
 * The memory part of a run's prompt: how to use memory, and the index of the run's persona.
 * The index changes only when an entry changes, so it stays in the cacheable prefix.
 */
export function composeMemoryPrompt(index: string) {
  return [
    '',
    '',
    'Long-term memory. You keep it yourself. The index is a map, not a dump: facts about you, facts about the owner, then the last few moments.',
    `Read one entry with ${READ_MEMORY_TOOL_NAME} when its line is too short to act on. A line that already states the fact needs no read.`,
    `Search with ${SEARCH_MEMORY_TOOL_NAME} whenever the reply depends on something the index does not state, and whenever someone asks you to look something up. The index is a short list, not the whole memory.`,
    'Search with one short phrase, the words the fact itself would use. A keyword list dilutes the match; one phrase ranks the fact higher.',
    'An empty search means that fact is not in memory: say so plainly, never fill the gap with a guess.',
    'The recalled block attached to a turn is fetched from the owner\'s message text alone, so an instruction like "去搜搜" carries no topic and brings back the wrong memories: search with the words you mean instead of trusting that block.',
    'Memory is reference, not a script. Use it to stay consistent; do not re-enact old lines, and never narrate the lookup.',
    'A remembered line carries the feeling of that moment, not of now. This turn\'s mood comes from this conversation.',
    `Save with ${WRITE_MEMORY_TOOL_NAME} only when someone asks you to remember something, or states a lasting fact. Most turns save nothing.`,
    'One fact per entry. Update an existing entry instead of adding a near copy. Never save what a recipe already holds, your own rules, codes, passwords, or secrets.',
    `Forget an entry with ${FORGET_MEMORY_TOOL_NAME} when it turns out wrong or someone asks. General entries belong to the owner, so you cannot change or forget them.`,
    index ? `Memory index:\n${index}` : 'The memory index is empty.',
  ].join('\n')
}

/** What the memory tools change. The caller binds them to the run's character card. */
interface CreateMemoryToolsOptions {
  read: (name: string) => MemoryEntry | undefined
  /** Ranked lookup over the whole bank; empty when the backend has no search or nothing matched. */
  search: (query: string) => Promise<MemorySearchHit[]>
  /** Structured facts near the same query; printed beside the hits, never as their own tool. */
  searchFacts: (query: string) => Promise<MemoryFact[]>
  write: (entry: { name: string, description: string, body: string }) => MemoryEntry | undefined
  forget: (name: string) => boolean
}

/** One hit stays readable in a 400-character window; the whole answer stays under 1.4k. */
const HIT_CHARS = 400
const SEARCH_RESULT_CHARS = 1400

/** One ranked hit, as the tool shows it: the fact first, then how sure the backend was. */
function formatHit(hit: MemorySearchHit) {
  const raw = hit.text.trim()
  // Ingested rows keep their store header (`# name\ndescription\n\nbody`). The name is the
  // index address, so the tool shows it as one: a hit the model can `read` beats a blob.
  const header = /^#\s+([^\n]+)\n?/.exec(raw)
  const name = header?.[1]?.trim()
  const body = (header ? raw.slice(header[0].length) : raw).replace(/\s+/g, ' ').trim()
  const text = body.length > HIT_CHARS ? `${body.slice(0, HIT_CHARS)}…` : body
  const meta = [
    typeof hit.score === 'number' && hit.score > 0 ? `sim ${hit.score.toFixed(2)}` : '',
    hit.createdAt ? hit.createdAt.slice(0, 10) : '',
    hit.memType ?? '',
  ].filter(Boolean).join(' · ')
  const line = `${name ? `${name}: ` : ''}${text}`
  return meta ? `- ${line} (${meta})` : `- ${line}`
}

/** A structured fact reads as one line: who · what · value. */
function formatFact(fact: MemoryFact) {
  const value = String(fact.object ?? '')
  return `- ${fact.subject} · ${fact.predicate} · ${value.length > 160 ? `${value.slice(0, 160)}…` : value}`
}

/** Creates the memory tools for one run. The run reads its card's memories and the general ones, and changes only its card's. */
export async function createMemoryTools(options: CreateMemoryToolsOptions): Promise<Tool[]> {
  return [
    rawTool({
      name: READ_MEMORY_TOOL_NAME,
      description: 'Read long-term memory entries by their index names.',
      parameters: await toJsonSchema(readParameters),
      execute: async (rawInput) => {
        const parsed = safeParse(readParameters, rawInput)
        if (!parsed.success)
          return 'Give at least one entry name from the memory index.'
        return parsed.output.names.map((name) => {
          const entry = options.read(name)
          return entry ? `${entry.name} (${entry.persona ? 'yours' : 'general'}): ${entry.body}` : `No memory entry named "${name}".`
        }).join('\n')
      },
    }),
    rawTool({
      name: SEARCH_MEMORY_TOOL_NAME,
      description: 'Search long-term memory by meaning and return the closest facts. Use it when the reply depends on something the index does not state, including when someone asks you to look something up.',
      parameters: await toJsonSchema(searchParameters),
      execute: async (rawInput) => {
        const parsed = safeParse(searchParameters, rawInput)
        if (!parsed.success)
          return 'Give a search query.'
        const query = parsed.output.query.trim()
        if (!query)
          return 'Give a search query.'
        const [hits, facts] = await Promise.all([options.search(query), options.searchFacts(query)])
        if (!hits.length && !facts.length)
          return `No memory matched "${query}".`
        const lines: string[] = []
        let used = 0
        for (const hit of hits) {
          const line = formatHit(hit)
          if (lines.length && used + line.length > SEARCH_RESULT_CHARS)
            break
          lines.push(line)
          used += line.length + 1
        }
        const hitLines = lines.length
        // Facts ride along in their own lines: three short rows cost less than a second call,
        // and they answer what the rows only imply (who someone is, what her own name is).
        if (facts.length)
          lines.push('known facts:', ...facts.slice(0, 3).map(formatFact))
        const left = hits.length - hitLines
        return left > 0
          ? `${lines.join('\n')}\n(+${left} more hits; narrow the query to see them)`
          : lines.join('\n')
      },
    }),
    rawTool({
      name: WRITE_MEMORY_TOOL_NAME,
      description: 'Save or update lasting facts in long-term memory, one entry per fact.',
      parameters: await toJsonSchema(writeParameters),
      execute: async (rawInput) => {
        const parsed = safeParse(writeParameters, rawInput)
        if (!parsed.success)
          return 'Memory not saved: each entry needs a name and a body.'
        return parsed.output.entries.map((input) => {
          const entry = options.write(input)
          return entry ? `Saved memory "${entry.name}".` : `Memory "${input.name}" not saved: it needs a name and a body.`
        }).join('\n')
      },
    }),
    rawTool({
      name: FORGET_MEMORY_TOOL_NAME,
      description: 'Forget one long-term memory entry.',
      parameters: await toJsonSchema(forgetParameters),
      execute: async (rawInput) => {
        const parsed = safeParse(forgetParameters, rawInput)
        return parsed.success && options.forget(parsed.output.name) ? `Forgot memory "${parsed.output.name}".` : 'No memory entry with that name.'
      },
    }),
  ]
}
