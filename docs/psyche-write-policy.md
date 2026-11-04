# Who owns psyche: one appraisal per turn

Three open points came out of the audit round on the emotion write path. This file records how
other projects and papers handle each one, what I measured, and what this repository does now.

## 1. A write needs a stable id, not a timestamp

The engine already accepts an idempotency key (`eventId`). The gap was the caller: `recordEmotion`
defaulted the key to `emotion:llm:<project>:<character>:<at>`, so a retried turn produced a new id
and moved the state twice.

What other projects do:

- Zep treats every ingest unit as an episode, and reconciliation is explicit: "duplicates merge, and
  contradictions invalidate older facts rather than leaving conflicting truths side by side"
  ([How Graph Creation Works](https://help.getzep.com/how-graph-creation-works)).
- Both MemGPT/Letta and Zep address a write by a message or episode id that the caller owns. The
  store does not invent one.

This repository now passes `emotion:turn:<conversationId>:<turnId>`. The runtime already uses the
persisted user-message id as its round key (`ChatRoundCorrelation.roundId`), so a retry of one turn
lands on one event and the engine drops the repeat.

## 2. Two appraisals of one turn are not two pieces of evidence

With `PSYCHE_FROM_VAD=on`, the automatic chain judges every ingested turn. An explicit
`recordEmotion` about the same turn used to land on top of it. That is not corroboration: the two
readings describe one moment, and the engine adds them as if they were two.

What the literature says:

- ACII 2019, *Annotation Matters* (Yang and Lee) shows intended, self-reported, and observed labels
  are three different things. Self-reported labels recognize about 3-10% worse than the others
  against the same physiology. A second labelling scheme is not confirmation of the first.
- Zep's ingestion policy resolves conflicting statements instead of keeping both.

Measured here (temp bank, one turn, baseline VAD 0.4/0.3/0.6, `speech`-free path):

| writes on one turn | valence | arousal | dominance |
| --- | --- | --- | --- |
| explicit only (0.70/0.50/0.60) | 0.532 | 0.394 | 0.600 |
| explicit + inferred (0.55/0.45/0.50) | 0.539 | 0.418 | 0.548 |

The second appraisal adds about +5% valence and +6% arousal on top of the first, and the drift
compounds over a conversation. The rule now is **one writer per state**: under `PSYCHE_FROM_VAD=on`
the explicit write answers `estimator_active` and does not move psyche. The panel still records the
emotion for the prompt.

Left open: the reverse priority. If the model's judgement must win over the estimator, the engine
needs a turn-to-memory link so the estimator can skip rows that already have an explicit appraisal.
That is a schema change and is not done here.

## 3. A background repair must not fail silently

The VAD sweep ran every two minutes with `.catch(() => {})`. A queue that fails on every tick left
no trace. The sweep now warns at most once per ten minutes. A console flood would hide the rest of
the log, and the sweep is a repair path, not the main write path.
