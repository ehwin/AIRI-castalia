import type { CastaliaMemoryEntry } from '@proj-airi/castalia-plugin/memory'

import { defineInvokeEventa } from '@moeru/eventa'

export const castaliaMemoryList = defineInvokeEventa<CastaliaMemoryEntry[]>('eventa:invoke:castalia:memory:list')
export const castaliaMemorySave = defineInvokeEventa<void, CastaliaMemoryEntry>('eventa:invoke:castalia:memory:save')
export const castaliaMemoryForget = defineInvokeEventa<boolean, Pick<CastaliaMemoryEntry, 'name' | 'persona'>>('eventa:invoke:castalia:memory:forget')
