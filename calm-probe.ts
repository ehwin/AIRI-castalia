import { openBank } from './packages/castalia-plugin/src/bank/index'

const bank = await openBank({ bankDir: 'D:/AI/hermes-home/cache/scratch/bank-calm', project: 'airi', charId: 'airi' } as any)
try {
  const report = await bank.maintain({ limit: 20, skipConsolidate: true, skipEventDigest: true })
  console.log('DIGEST', JSON.stringify(report.digest))
}
catch (error) {
  console.log('THREW', String((error as Error)?.message).slice(0, 200))
}
finally { bank.close() }
