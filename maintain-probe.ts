import { openBank } from './packages/castalia-plugin/src/bank/index'

const bankDir = 'D:/AI/hermes-home/cache/scratch/bank-copy'
const bank = await openBank({ bankDir, project: 'airi', charId: 'airi' } as any)
try {
  const before = (bank as any).listMemories ? undefined : undefined
  const report = await bank.maintain({ limit: 20 })
  console.log('MAINTAIN_REPORT', JSON.stringify(report).slice(0, 1200))
}
catch (error) {
  console.log('MAINTAIN_THREW', String((error as Error)?.stack || error).slice(0, 800))
}
finally {
  bank.close()
}
