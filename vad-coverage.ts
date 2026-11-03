import { DatabaseSync } from 'node:sqlite'
import { summarizeLocalAffect } from './packages/castalia-plugin/src/vendor/engine/emotion'

const PROMPT = `You are Anima's interaction-appraisal sensor. Output ONLY valid JSON, no commentary.
Analyze the affective impact of the labelled interaction on Anima using the VAD model.
- valence/arousal/dominance: numbers in [-1,1], 0 = neutral.
Output JSON: {"vad":{"valence":0,"arousal":0,"dominance":0},"confidence":0.9,"tags":[]}`

const db = new DatabaseSync('D:/castalia/memory-banks/airi/airi/general/memory.sqlite', { readOnly: true })
const rows = db.prepare(`
  SELECT text FROM memory WHERE source='conversation_log' AND is_active=1
  ORDER BY created_at DESC LIMIT 20
`).all() as Array<{ text: string }>
db.close()

let lexiconScored = 0
let llmScored = 0
let llmNeutral = 0
const started = Date.now()

for (const row of rows) {
  const text = String(row.text || '').slice(0, 800)
  if (summarizeLocalAffect([{ text }]))
    lexiconScored++

  try {
    const res = await fetch('http://127.0.0.1:13305/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.5-2b-FLM',
        temperature: 0.1,
        max_tokens: 160,
        messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: text }],
      }),
    })
    const body = await res.json()
    const raw = body.choices?.[0]?.message?.content ?? ''
    const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}')
    const v = json?.vad
    if (v && Number.isFinite(v.valence)) {
      llmScored++
      if (Math.abs(v.valence) < 0.05 && Math.abs(v.arousal ?? 0) < 0.05)
        llmNeutral++
    }
  }
  catch { /* an unparsable answer counts as unscored */ }
}

console.log(JSON.stringify({
  samples: rows.length,
  lexiconScored,
  llmScored,
  llmNeutral,
  ms: Date.now() - started,
}, null, 2))
