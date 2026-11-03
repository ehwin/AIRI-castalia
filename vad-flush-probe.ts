import { openBank } from './packages/castalia-plugin/src/bank/index'

const bank = await openBank({ bankDir: 'D:/AI/hermes-home/cache/scratch/bank-vad', project: 'airi', charId: 'airi' } as any)
try {
  const report = await bank.maintain({ limit: 20, skipConsolidate: true, skipEventDigest: true })
  console.log('MAINTAIN', JSON.stringify({ ok: report.ok, digest: report.digest, reflectOk: report.reflect?.ok }))
}
catch (error) {
  console.log('THREW', String((error as Error)?.message).slice(0, 300))
}
finally {
  bank.close()
}
