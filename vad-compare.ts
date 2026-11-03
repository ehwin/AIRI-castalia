import { summarizeLocalAffect } from './packages/castalia-plugin/src/vendor/engine/emotion'

const SAMPLES = [
  '用户: 今天累死了，什么都不想干。\n助手: 辛苦啦……今天是不是做了好多好多事呀？那现在什么都不用干哦，就躺着吧。',
  '用户: 那个是你啊，你真傻\n助手: 诶……是我吗？那个像素小人，原来是我呀。',
  '用户: 你先把看屏幕的这个问题解决了，似乎路线没通\n助手: 收到，我先抓一张屏幕看看链路断在哪一段。',
]

const PROMPT = `You are Anima's interaction-appraisal sensor. Output ONLY valid JSON, no commentary.
Analyze the affective impact of the labelled interaction on Anima's current state, goals, and relationship using the VAD model.
Do not claim to know the user's private inner emotion.
- valence: [-1,1], positive=pleasant, negative=unpleasant, neutral=0
- arousal: [-1,1], high=excited/angry, low=calm/bored, neutral=0
- dominance: [-1,1], high=in_control/confident, low=helpless/overwhelmed, neutral=0
Output JSON: {"vad":{"valence":0,"arousal":0,"dominance":0},"confidence":0.9,"tags":[]}`

for (const text of SAMPLES) {
  const local = summarizeLocalAffect([{ text }])
  let llm: any = null
  const started = Date.now()
  try {
    const res = await fetch('http://127.0.0.1:13305/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.5-2b-FLM',
        temperature: 0.1,
        max_tokens: 200,
        messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: text }],
      }),
    })
    const body = await res.json()
    const raw = body.choices?.[0]?.message?.content ?? ''
    const json = raw.match(/\{[\s\S]*\}/)?.[0]
    llm = json ? JSON.parse(json) : { raw: raw.slice(0, 80) }
  }
  catch (error) {
    llm = { error: String(error) }
  }
  const ms = Date.now() - started
  console.log('---', text.split('\n')[0].slice(0, 40))
  console.log('  lexicon:', JSON.stringify(local))
  console.log(`  llm(${ms}ms):`, JSON.stringify(llm))
}
