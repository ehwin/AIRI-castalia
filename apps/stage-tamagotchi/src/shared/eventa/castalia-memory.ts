import type { CastaliaMemoryEntry } from '@proj-airi/castalia-plugin/memory'

import { defineInvokeEventa } from '@moeru/eventa'

/**
 * One recall for the injection block.
 *
 * Empty `text` means the backend found nothing that passed its similarity gate,
 * so the caller appends the block without a relevance check of its own.
 */
export interface CastaliaRecalledMemory {
  text: string
  /** Items inside the block. */
  count: number
  /** Highest cosine similarity of the recall. */
  topSim: number
  /** Length of the block, in characters. */
  chars: number
}

export const castaliaMemoryList = defineInvokeEventa<CastaliaMemoryEntry[]>('eventa:invoke:castalia:memory:list')
export const castaliaMemorySave = defineInvokeEventa<void, CastaliaMemoryEntry>('eventa:invoke:castalia:memory:save')
export const castaliaMemoryForget = defineInvokeEventa<boolean, Pick<CastaliaMemoryEntry, 'name' | 'persona'>>('eventa:invoke:castalia:memory:forget')
export const castaliaMemoryRecall = defineInvokeEventa<CastaliaRecalledMemory, string>('eventa:invoke:castalia:memory:recall')
