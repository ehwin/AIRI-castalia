/**
 * Reading the screen as an activity, not as a picture.
 *
 * `screen:interpret` answers "what is on screen", which is a description. What the
 * companion needs before it opens its mouth is a judgement: what is this person
 * doing, and would a word from me land or interrupt. That is one small JSON object
 * from the vision model, parsed here so the rule stays testable without a model.
 */

export interface ActivityAssessment {
  /** What the person is doing, in their language, one short phrase. */
  activity: string
  /** True when a word from the companion would not break anything. */
  interruptible: boolean
  /** Why, in a few characters. Shown to nobody; kept for diagnosis. */
  reason?: string
  /** How sure the model is, 0 to 1. Absent when the model omitted it. */
  confidence?: number
}

/** Strip the fences and chatter a model wraps JSON in, then find the object. */
function extractJsonObject(raw: string): string | undefined {
  const text = String(raw ?? '').trim()
  if (!text)
    return undefined
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start)
    return undefined
  return body.slice(start, end + 1)
}

/**
 * Parse an activity assessment.
 *
 * Returns undefined when the model did not answer in the expected shape — a
 * caller must then fall back to its keyword read rather than assume "idle",
 * because an unparsed answer is not evidence that the person is free.
 */
export function parseActivityAssessment(raw: string): ActivityAssessment | undefined {
  const json = extractJsonObject(raw)
  if (!json)
    return undefined
  let parsed: any
  try {
    parsed = JSON.parse(json)
  }
  catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object')
    return undefined

  const activity = String(parsed.activity ?? parsed.what ?? '').replace(/\s+/g, ' ').trim()
  if (!activity)
    return undefined

  const rawFlag = parsed.interruptible ?? parsed.canInterrupt ?? parsed.ok
  let interruptible: boolean
  if (typeof rawFlag === 'boolean')
    interruptible = rawFlag
  else if (typeof rawFlag === 'string')
    interruptible = /^(true|yes|[y1能是]|可以)$/iu.test(rawFlag.trim())
  else
    return undefined

  const reason = String(parsed.reason ?? parsed.why ?? '').replace(/\s+/g, ' ').trim()
  const confidenceRaw = Number(parsed.confidence)
  return {
    activity: activity.slice(0, 40),
    interruptible,
    ...(reason ? { reason: reason.slice(0, 30) } : {}),
    ...(Number.isFinite(confidenceRaw) ? { confidence: Math.min(1, Math.max(0, confidenceRaw)) } : {}),
  }
}

/** The prompt the vision workload sends. Output must be JSON and nothing else. */
export const ACTIVITY_ASSESS_PROMPT = [
  'You look at a screenshot and answer one question: what is this person doing right now, and would a short line from a companion interrupt them?',
  'Answer with ONLY a JSON object, no prose, no code fence:',
  '{"activity":"<what they are doing, in Chinese, <=18 characters>","interruptible":<true|false>,"reason":"<why, in Chinese, <=12 characters>","confidence":<0-1>}',
  'Rules:',
  '- interruptible=false when they are in a call, meeting, presentation, game, recording, fullscreen video, or clearly mid-task in an editor or terminal.',
  '- interruptible=true when they are browsing, reading casually, idle on a desktop, or waiting for something to finish.',
  '- Judge the whole picture, not the window title alone. If unsure, use false.',
].join('\n')
