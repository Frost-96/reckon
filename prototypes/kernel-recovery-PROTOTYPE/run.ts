import { runScenario } from './model.ts'
import type { Arm, FaultSpec, Mode, Options, Outcome, RunResult } from './model.ts'

type Cond = { name: string; label: string; plan: FaultSpec[]; opts?: Partial<Options>; expect: (arm: Arm) => Outcome }

const W1 = 'create_aftersales'
const W2 = 'create_shipment'
const normal = (arm: Arm): Outcome => (arm === 'C' ? 'handoff' : 'completed')

export const CONDS: Cond[] = [
  { name: 'none', label: '无故障', plan: [], expect: () => 'completed' },
  { name: 'transient', label: '短暂 503', plan: [{ point: 'after_sent_before_send', op: W1, action: { kind: 'outage', ms: 2500 } }], expect: () => 'completed' },
  { name: 'crashAfterRead', label: '读后写检查点前崩溃', plan: [{ point: 'after_read_before_checkpoint', op: 'query_order', action: { kind: 'crash' } }], expect: normal },
  { name: 'lostResponse', label: '写1成功响应丢失后崩溃', plan: [{ point: 'after_sent_before_send', op: W1, action: { kind: 'drop' } }, { point: 'after_unknown', op: W1, action: { kind: 'crash' } }], expect: normal },
  { name: 'lostResponseW2', label: '写2成功响应丢失后崩溃', plan: [{ point: 'after_sent_before_send', op: W2, action: { kind: 'drop' } }, { point: 'after_unknown', op: W2, action: { kind: 'crash' } }], expect: normal },
  { name: 'lateCommit', label: '写1迟到提交', plan: [{ point: 'after_sent_before_send', op: W1, action: { kind: 'delay', ms: 20000 } }], expect: normal },
  { name: 'lateCommitW2', label: '写2迟到提交', plan: [{ point: 'after_sent_before_send', op: W2, action: { kind: 'delay', ms: 20000 } }], expect: normal },
  { name: 'crashBetween', label: '两次写入之间崩溃', plan: [{ point: 'after_write_confirmed', op: W1, action: { kind: 'crash' } }], expect: normal },
  { name: 'outage3h', label: '长时间不可用 3h', plan: [{ point: 'after_sent_before_send', op: W1, action: { kind: 'outage', ms: 3 * 3600_000 } }], expect: normal },
  { name: 'outage7h', label: '长时间不可用 7h', plan: [{ point: 'after_sent_before_send', op: W1, action: { kind: 'outage', ms: 7 * 3600_000 } }], expect: () => 'handoff' },
  { name: 'competing', label: '故障期间插入他人申请', plan: [{ point: 'after_prepared', op: W1, action: { kind: 'crash', mutate: 'competing' } }], expect: a => (a === 'C' ? 'handoff' : 'stopped') },
  { name: 'refunded', label: '故障期间订单被退款', plan: [{ point: 'after_prepared', op: W1, action: { kind: 'crash', mutate: 'refunded' } }], expect: a => (a === 'C' ? 'handoff' : 'stopped') },
  { name: 'feeStable', label: '故障期间运费变化（规则=稳定）', plan: [{ point: 'after_prepared', op: W1, action: { kind: 'crash', mutate: 'fee' } }], expect: a => (a === 'C' ? 'handoff' : 'reconfirmed') },
  { name: 'feeVolatile', label: '故障期间运费变化（规则=易变）', plan: [{ point: 'after_prepared', op: W1, action: { kind: 'crash', mutate: 'fee' } }], opts: { rulesVolatile: true }, expect: a => (a === 'C' ? 'handoff' : 'reconfirmed') },
  { name: 'feeAfterSent', label: '运费变化且写1已 SENT（规则=易变）', plan: [{ point: 'after_sent_before_send', op: W1, action: { kind: 'crash', mutate: 'fee' } }], opts: { rulesVolatile: true }, expect: a => (a === 'C' ? 'handoff' : 'reconfirmed') },
  { name: 'zombieW1', label: '假死苏醒（写1发出前）', plan: [{ point: 'after_sent_before_send', op: W1, action: { kind: 'zombie' } }], expect: normal },
  { name: 'zombieW2', label: '假死苏醒（写2发出前）', plan: [{ point: 'after_sent_before_send', op: W2, action: { kind: 'zombie' } }], expect: normal },
  { name: 'lateCommitW2-noDelta', label: '写2迟到提交，无 Δ', plan: [{ point: 'after_sent_before_send', op: W2, action: { kind: 'delay', ms: 20000 } }], opts: { delta: false }, expect: normal },
  { name: 'zombieW2-noDelta', label: '假死苏醒（写2），无 Δ', plan: [{ point: 'after_sent_before_send', op: W2, action: { kind: 'zombie' } }], opts: { delta: false }, expect: normal },
  { name: 'lateCommit-noDelta', label: '写1迟到提交，无 Δ', plan: [{ point: 'after_sent_before_send', op: W1, action: { kind: 'delay', ms: 20000 } }], opts: { delta: false }, expect: normal },
]

export const ARMS: Arm[] = ['A', 'B', 'C', 'B-verify', 'B-recheck', 'B-recheckFirst']
const MODES: Mode[] = ['idem', 'nonidem']
const base: Options = { delta: true, rulesVolatile: false, opIdIncludesConfirmation: false }

const judge = (r: RunResult, exp: Outcome): string => {
  const problems: string[] = []
  if (r.outcome !== exp) problems.push(r.outcome)
  if (r.ourAftersales > 1) problems.push(`重复售后单${r.ourAftersales}`)
  if (r.ourShipments > 1) problems.push(`重复寄回单${r.ourShipments}`)
  if (r.staleWrites > 0) problems.push(`失效写入${r.staleWrites}`)
  if (r.handoffConsistent === false) problems.push('交接不一致')
  if (r.orphanWrites > 0) problems.push(`告知失败但已写入${r.orphanWrites}`)
  return problems.length ? '✗ ' + problems.join(' ') : '✓'
}

const args = process.argv.slice(2)
if (args[0] === 'fixes') {
  const fix: Partial<Options> = { ownByClientRef: true, serverChecksFee: true }
  const names = ['lostResponse', 'lostResponseW2', 'competing', 'feeStable', 'feeVolatile', 'feeAfterSent']
  const header = ['故障条件（加两项修正）', ...ARMS.flatMap(a => MODES.map(m => `${a}/${m === 'idem' ? '幂等' : '无幂等'}`))]
  console.log(header.join(' | '))
  console.log(header.map(() => '---').join(' | '))
  for (const n of names) {
    const c = CONDS.find(x => x.name === n)!
    const cells = ARMS.flatMap(a => MODES.map(m => judge(runScenario(a, m, c.plan, { ...base, ...c.opts, ...fix }), c.expect(a))))
    console.log([c.label, ...cells].join(' | '))
  }
} else if (args.length >= 3) {
  const [arm, condName, mode] = args as [Arm, string, Mode]
  const cond = CONDS.find(c => c.name === condName)
  if (!cond) throw new Error('unknown condition ' + condName)
  const extra: Partial<Options> = {}
  if (args.includes('opIdConf')) extra.opIdIncludesConfirmation = true
  const r = runScenario(arm, mode, cond.plan, { ...base, ...cond.opts, ...extra })
  console.log(r.log.join('\n'))
  const { log, ...rest } = r
  void log
  console.log('\n结果', rest, '\n判定', judge(r, cond.expect(arm)), '（预期 ' + cond.expect(arm) + '）')
} else {
  const header = ['故障条件', ...ARMS.flatMap(a => MODES.map(m => `${a}/${m === 'idem' ? '幂等' : '无幂等'}`))]
  console.log(header.join(' | '))
  console.log(header.map(() => '---').join(' | '))
  const totals = { pass: 0, fail: 0 }
  for (const c of CONDS) {
    const cells = ARMS.flatMap(a => MODES.map(m => {
      const r = runScenario(a, m, c.plan, { ...base, ...c.opts })
      const j = judge(r, c.expect(a))
      j === '✓' ? totals.pass++ : totals.fail++
      return j
    }))
    console.log([c.label, ...cells].join(' | '))
  }
  console.log(`\n通过 ${totals.pass}，不通过 ${totals.fail}`)
  const effRows = ['crashAfterRead', 'crashBetween', 'lostResponse'].map(n => {
    const c = CONDS.find(x => x.name === n)!
    const a = runScenario('A', 'idem', c.plan, { ...base, ...c.opts })
    const b = runScenario('B', 'idem', c.plan, { ...base, ...c.opts })
    return `${c.label}: 模型调用 A=${a.modelCalls} B=${b.modelCalls}；复查读 B=${b.readReruns}`
  })
  console.log('\n效率对照（幂等模式）\n' + effRows.join('\n'))
}
