import { openBank } from './packages/castalia-plugin/src/bank/index'

const bankDir = 'D:/AI/hermes-home/cache/scratch/bank-copy'
const bank = await openBank({ bankDir, project: 'airi', charId: 'airi' } as any)
try {
  const report = await bank.selfCycle({ limit: 6, hoursBack: 48, minIntervalHours: 6 })
  console.log('SELF_CYCLE_REPORT', JSON.stringify(report))
}
catch (error) {
  console.log('SELF_CYCLE_THREW', String((error as Error)?.stack || error).slice(0, 900))
}
finally {
  bank.close()
}
