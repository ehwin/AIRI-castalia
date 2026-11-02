#!/usr/bin/env node
/**
 * Probe: what a memory block does to her voice and her feeling.
 *
 * Use when:
 * - Changing what the memory index, the recalled block, or the memory prompt carries, and you
 *   want measured answers instead of an impression of one chat window.
 *
 * Why a separate script instead of a unit test: the question needs the real chat model, costs
 * tokens, and is noisy across seeds. Unit tests pin the mechanism (what the prompt says);
 * this probe measures the effect (what comes back).
 *
 * Usage:
 *   PROBE_BASE_URL=https://.../v1 PROBE_MODEL=... PROBE_API_KEY=... \
 *     node scripts/persona-probe.mjs --case probe-case.json --out probe-result.json [--judge]
 *
 * Case file:
 *   {
 *     "system": "…the character card…",
 *     "anchors": ["6月27", "谕女", "锚点"],
 *     "variants": { "no-memory": "", "index-old": "…", "index-new": "…" },
 *     "turns": [{ "user": "你还记得你的生日吗？", "recall": "…optional injected block…" }],
 *     "seeds": 2,
 *     "temperature": 0.8
 *   }
 *
 * The probe never writes to memory and never calls a tool: it measures the reply text only.
 * A tool-calling check belongs to the app (builtIn_searchMemory), where the real schemas live.
 */

import process from 'node:process'

import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
function argOf(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const casePath = argOf('--case')
const outPath = argOf('--out') ?? 'probe-result.json'
const baseURL = process.env.PROBE_BASE_URL
const model = process.env.PROBE_MODEL
const apiKey = process.env.PROBE_API_KEY
const useJudge = args.includes('--judge')

if (!casePath || !baseURL || !model || !apiKey) {
  console.error('Need --case, PROBE_BASE_URL, PROBE_MODEL and PROBE_API_KEY.')
  process.exit(2)
}

const probe = JSON.parse(readFileSync(casePath, 'utf-8'))
const seeds = Math.max(1, Number(probe.seeds ?? 1))
const temperature = Number(probe.temperature ?? 0.8)

async function chat(messages, options = {}) {
  const response = await fetch(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? temperature,
      max_tokens: options.maxTokens ?? 400,
    }),
  })
  if (!response.ok)
    throw new Error(`chat failed: HTTP ${response.status} ${await response.text()}`)
  const body = await response.json()
  return String(body.choices?.[0]?.message?.content ?? '').trim()
}

/** Meta talk, not story: naming the machinery pulls the reader out of the scene. */
const META = /记忆体|数据库|检索|我搜了|我查了|系统里|存档|日志|memory bank/

/** Longest shared run of characters, for detecting a reprinted memory line. */
function longestSharedRun(left, right) {
  if (!left || !right)
    return 0
  const shortest = left.length < right.length ? left : right
  const longest = shortest === left ? right : left
  let best = 0
  for (let start = 0; start < shortest.length; start++) {
    for (let end = shortest.length; end - start > best; end--) {
      if (longest.includes(shortest.slice(start, end)))
        best = end - start
    }
  }
  return best
}

function measure(text, turn) {
  const anchors = (probe.anchors ?? []).filter(anchor => text.includes(anchor))
  return {
    chars: text.length,
    endsWithQuestion: /[？?]\s*$/.test(text),
    metaNarration: META.test(text),
    reprintedRecall: turn.recall ? longestSharedRun(text, turn.recall) : 0,
    anchors,
    text,
  }
}

const JUDGE_SYSTEM = [
  'You grade one role-play reply. Answer with JSON only:',
  '{"valence": number between -1 and 1, "arousal": number between 0 and 1,',
  ' "persona_fidelity": integer 0-5, "notes": short string}',
  'valence/arousal describe the feeling the reply expresses. persona_fidelity is 5 when the',
  'reply could only come from this character, 0 when any assistant could have written it.',
].join('\n')

async function judge(reply, card) {
  const raw = await chat([
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: `Character card:\n${card}\n\nReply:\n${reply}` },
  ], { temperature: 0, maxTokens: 200 })
  const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
  try {
    return JSON.parse(json)
  }
  catch {
    return { error: 'unparsable judge output', raw }
  }
}

const results = []
for (const [variant, suffix] of Object.entries(probe.variants ?? { base: '' })) {
  const system = suffix ? `${probe.system}\n\n${suffix}` : probe.system
  for (const turn of probe.turns ?? []) {
    const messages = [{ role: 'system', content: system }]
    if (turn.recall)
      messages.push({ role: 'system', content: turn.recall })
    messages.push({ role: 'user', content: turn.user })
    for (let seed = 0; seed < seeds; seed++) {
      const text = await chat(messages)
      const measured = measure(text, turn)
      const graded = useJudge ? await judge(text, probe.system) : undefined
      results.push({ variant, seed, user: turn.user, ...measured, judge: graded })
    }
  }
}

const summary = {}
for (const variant of Object.keys(probe.variants ?? { base: '' })) {
  const rows = results.filter(row => row.variant === variant)
  const graded = rows.map(row => row.judge).filter(Boolean)
  summary[variant] = {
    replies: rows.length,
    meanChars: Math.round(rows.reduce((sum, row) => sum + row.chars, 0) / rows.length),
    questionEndingRate: rows.filter(row => row.endsWithQuestion).length / rows.length,
    metaNarrationRate: rows.filter(row => row.metaNarration).length / rows.length,
    maxReprintedRun: Math.max(...rows.map(row => row.reprintedRecall)),
    anchorHitRate: rows.filter(row => row.anchors.length > 0).length / rows.length,
    ...(graded.length
      ? {
          meanValence: graded.reduce((sum, row) => sum + Number(row.valence ?? 0), 0) / graded.length,
          meanArousal: graded.reduce((sum, row) => sum + Number(row.arousal ?? 0), 0) / graded.length,
          meanFidelity: graded.reduce((sum, row) => sum + Number(row.persona_fidelity ?? 0), 0) / graded.length,
        }
      : {}),
  }
}

writeFileSync(outPath, JSON.stringify({ model, temperature, seeds, summary, results }, null, 2))
console.info(JSON.stringify(summary, null, 2))
console.info(`\nWrote ${outPath}`)
