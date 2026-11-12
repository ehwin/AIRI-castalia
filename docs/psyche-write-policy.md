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
compounds over a conversation. The rule now is **one writer per turn**: the explicit verdict is
written, and the same verdict is handed back to `ingestTurn`, which stores that row as already
analyzed and keeps it out of the VAD queue
(`apps/stage-tamagotchi/src/main/services/airi/castalia-memory.ts:409`-`:417`,
`packages/castalia-plugin/src/bank/index.ts:841`). One turn moves psyche once, whichever path got
there first.

An earlier revision refused the explicit write while `PSYCHE_FROM_VAD=on`, answering
`estimator_active`. That guard is gone: the lexicon abstains on most turns (8.6% judged), so the
refusal left psyche idle on every turn the estimator skipped. The reason survives only as a value
in the union type (`apps/stage-tamagotchi/src/shared/eventa/castalia-memory.ts:271`) and has no
producer.

Left open: turns with no stable id. A caller that cannot supply a turn id leaves the row `pending`,
so the automatic chain judges it after the explicit verdict already landed
(`packages/castalia-plugin/src/bank/index.ts:589`). The fix is to thread the row id through that
path, not to add another guard.

## 3. A background repair must not fail silently

The VAD sweep ran every two minutes with `.catch(() => {})`. A queue that fails on every tick left
no trace. The sweep now warns at most once per ten minutes. A console flood would hide the rest of
the log, and the sweep is a repair path, not the main write path.
