import { createHash } from 'node:crypto'

export type Mode = 'idem' | 'nonidem'
export type Arm = 'A' | 'B' | 'C' | 'B-verify' | 'B-recheck' | 'B-recheckFirst'
export type TaskState = 'READY' | 'RUNNING' | 'WAITING_USER' | 'WAITING_EXTERNAL' | 'HANDED_OFF' | 'CLOSED'
export type IntentState = 'PREPARED' | 'SENT' | 'CONFIRMED' | 'UNKNOWN' | 'VERIFIED_DONE' | 'VERIFIED_ABSENT' | 'HANDOFF' | 'REJECTED' | 'CANCELLED'
export type OpName = 'create_aftersales' | 'create_shipment'
export type Outcome = 'completed' | 'reconfirmed' | 'stopped' | 'rejected' | 'handoff' | 'incomplete'

export type FaultAction =
  | { kind: 'crash'; mutate?: 'competing' | 'refunded' | 'fee' }
  | { kind: 'zombie' }
  | { kind: 'drop' }
  | { kind: 'delay'; ms: number }
  | { kind: 'outage'; ms: number }

export type FaultSpec = { point: string; op: string; action: FaultAction }

export type Options = { delta: boolean; rulesVolatile: boolean; opIdIncludesConfirmation: boolean; ownByClientRef?: boolean; serverChecksFee?: boolean }

export const LEASE = 10_000
export const DELTA = 5_000
export const MARGIN = 2_000
export const CLIENT_TIMEOUT = 3_000
export const NET = 50
export const MAX_WAIT = 6 * 3600_000

export const canon = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  const o = v as Record<string, unknown>
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}'
}
export const h = (v: unknown): string => createHash('sha256').update(canon(v)).digest('hex').slice(0, 10)

type Params = { orderId: string; lineItemId: string; qty: number; reason: string; fee: number }
type Req = { op: OpName; opId: string; params: Record<string, unknown>; deadline: number | null }
type Flight = { req: Req; arriveAt: number; respondAt: number; result: Resp | null; drop: boolean }
type Resp = { status: 200 | 422 | 503 | 'timeout'; code?: string; body?: Record<string, unknown> }
type AS = { id: string; clientRef: string | null; lineItemId: string; qty: number; fee: number; open: boolean; at: number }
type Ship = { id: string; clientRef: string; aftersalesId: string; at: number }

export class Business {
  mode: Mode
  delta: boolean
  sim: Sim
  refunded = false
  fee = 0
  aftersales: AS[] = []
  shipments: Ship[] = []
  keys = new Map<string, { paramsHash: string; result: Resp }>()
  outages: Array<[number, number]> = []
  inflight: Flight[] = []
  nextDrop = new Set<string>()
  nextDelay = new Map<string, number>()
  staleWrites = 0
  committedLog: string[] = []
  constructor(sim: Sim, mode: Mode, delta: boolean) {
    this.sim = sim
    this.mode = mode
    this.delta = delta
  }
  down(t: number): boolean {
    return this.outages.some(([a, b]) => t >= a && t < b)
  }
  process(f: Flight): void {
    const now = this.sim.now
    const req = f.req
    if (this.down(now)) { f.result = { status: 503 }; return }
    if (this.delta && req.deadline !== null && now > req.deadline) { f.result = { status: 422, code: 'DEADLINE_EXCEEDED' }; this.sim.trace(`业务服务拒绝过期请求 ${req.op} ${req.opId}`); return }
    const ph = h(req.params)
    if (this.mode === 'idem') {
      const e = this.keys.get(req.opId)
      if (e) { f.result = e.paramsHash === ph ? e.result : { status: 422, code: 'IDEMPOTENCY_KEY_PARAMETER_MISMATCH' }; return }
    }
    let result: Resp
    if (req.op === 'create_aftersales') {
      const p = req.params as Params
      if (this.refunded) result = { status: 422, code: 'ORDER_REFUNDED' }
      else if (this.sim.opts.serverChecksFee && p.fee !== this.fee) result = { status: 422, code: 'FEE_CHANGED' }
      else if (this.aftersales.some(a => a.open && a.lineItemId === p.lineItemId)) result = { status: 422, code: 'OPEN_APPLICATION_EXISTS' }
      else {
        const id = 'AS-' + h([req.opId, this.aftersales.length])
        if (p.fee !== this.fee) this.staleWrites++
        this.aftersales.push({ id, clientRef: req.opId, lineItemId: p.lineItemId, qty: p.qty, fee: p.fee, open: true, at: now })
        this.committedLog.push(`${now} create_aftersales ${id}`)
        result = { status: 200, body: { id } }
      }
    } else {
      const asId = String(req.params.aftersalesId)
      if (!this.aftersales.some(a => a.id === asId)) result = { status: 422, code: 'NO_AFTERSALES' }
      else {
        const id = 'RS-' + h([req.opId, this.shipments.length])
        this.shipments.push({ id, clientRef: req.opId, aftersalesId: asId, at: now })
        this.committedLog.push(`${now} create_shipment ${id}`)
        result = { status: 200, body: { id } }
      }
    }
    if (this.mode === 'idem' && result.status === 200) this.keys.set(req.opId, { paramsHash: ph, result })
    f.result = result
  }
  find(op: OpName, clientRef: string): 'unavailable' | { id: string } | null {
    if (this.down(this.sim.now)) return 'unavailable'
    const r = op === 'create_aftersales' ? this.aftersales.find(a => a.clientRef === clientRef) : this.shipments.find(s => s.clientRef === clientRef)
    return r ? { id: r.id } : null
  }
  read(name: string): Record<string, unknown> | 'unavailable' {
    if (this.down(this.sim.now)) return 'unavailable'
    if (name === 'query_order') return { refunded: this.refunded, items: [{ id: 'L1', qty: 1 }] }
    if (name === 'query_aftersales') return { list: this.aftersales.filter(a => a.lineItemId === 'L1').map(a => ({ id: a.id, open: a.open, clientRef: a.clientRef })) }
    return { fee: this.fee }
  }
}

class Crash extends Error {}
class Paused extends Error {}
class ExternalWait extends Error {}
class HandoffNow extends Error {}
class Fenced extends Error {}

type Inst = { id: string; version: number; alive: boolean }
type Step = { turn: number; k: number; kind: 'model' | 'tool'; name: string; input: unknown; output: any; volatile: boolean; discarded: boolean }
type Intent = { opId: string; op: OpName; params: Record<string, unknown>; state: IntentState; deadline: number | null; result: { id: string } | null; history: string[] }
type Confirmation = { id: number; hash: string; params: Params; confirmed: boolean; valid: boolean }
type Note = { turn: number; disposition: 'stop' | 'reconfirm'; reason: string; fee?: number }
type ModelOut = { text?: string; tools?: Array<{ name: string; input: any }> }

export type RunResult = {
  outcome: Outcome
  ourAftersales: number
  ourShipments: number
  staleWrites: number
  handoffConsistent: boolean | null
  modelCalls: number
  readReruns: number
  fencedRejections: number
  takeovers: number
  orphanWrites: number
  log: string[]
}

const VOLATILE_BASE = new Set(['query_order', 'query_aftersales'])
const INTERACTION = new Set(['ask_user', 'request_confirmation'])

export class Sim {
  now = 0
  arm: Arm
  opts: Options
  plan: FaultSpec[]
  fired = new Set<string>()
  bs: Business
  logLines: string[] = []
  task = { state: 'READY' as TaskState, owner: null as string | null, leaseUntil: 0, version: 0, needsRecovery: false, turn: 0, externalSince: 0, probeDelay: 60_000, nextProbe: 0, notified: false }
  steps: Step[] = []
  intents = new Map<string, Intent>()
  confirmations: Confirmation[] = []
  messages = new Map<string, string>()
  notes: Note[] = []
  handoffPkg: { reason: string; intents: Array<{ op: OpName; opId: string; state: IntentState; result: string | null }> } | null = null
  counters = { modelCalls: 0, readReruns: 0, fencedRejections: 0, takeovers: 0, reconfirms: 0 }
  zombie: (() => void) | null = null
  pendingMutation: FaultAction | null = null
  constructor(arm: Arm, mode: Mode, plan: FaultSpec[], opts: Options) {
    this.arm = arm
    this.plan = plan
    this.opts = opts
    this.bs = new Business(this, mode, opts.delta)
  }
  trace(s: string): void {
    this.logLines.push(`[t=${(this.now / 1000).toFixed(1)}s] ${s}`)
  }
  advanceTo(t: number): void {
    for (;;) {
      const due = this.bs.inflight.filter(f => f.result === null && f.arriveAt <= t).sort((a, b) => a.arriveAt - b.arriveAt)[0]
      if (!due) break
      this.now = Math.max(this.now, due.arriveAt)
      this.bs.process(due)
      due.respondAt = due.drop ? Infinity : this.now + NET
    }
    this.now = Math.max(this.now, t)
  }
  call(req: Req): Resp {
    const delay = this.bs.nextDelay.get(req.op) ?? 0
    this.bs.nextDelay.delete(req.op)
    const drop = this.bs.nextDrop.delete(req.op)
    const f: Flight = { req, arriveAt: this.now + NET + delay, respondAt: Infinity, result: null, drop }
    this.bs.inflight.push(f)
    const timeoutAt = this.now + CLIENT_TIMEOUT
    this.advanceTo(Math.min(f.arriveAt, timeoutAt))
    if (f.result && f.respondAt <= timeoutAt) { this.advanceTo(f.respondAt); return f.result }
    this.advanceTo(timeoutAt)
    return { status: 'timeout' }
  }
  fault(point: string, op: string): FaultAction | null {
    const spec = this.plan.find(p => p.point === point && p.op === op)
    if (!spec) return null
    const key = point + '|' + op
    if (this.fired.has(key)) return null
    this.fired.add(key)
    this.trace(`故障点 ${point}(${op}) 触发 ${spec.action.kind}`)
    return spec.action
  }
  hit(point: string, op: string): void {
    const a = this.fault(point, op)
    if (!a) return
    if (a.kind === 'crash') { this.pendingMutation = a; throw new Crash() }
    if (a.kind === 'drop') this.bs.nextDrop.add(op)
    if (a.kind === 'delay') this.bs.nextDelay.set(op, a.ms)
    if (a.kind === 'outage') this.bs.outages.push([this.now, this.now + a.ms])
  }
  claim(id: string): Inst {
    this.task.version++
    this.task.owner = id
    this.task.leaseUntil = this.now + LEASE
    this.task.state = 'RUNNING'
    this.trace(`执行实例 ${id} 认领任务（版本 ${this.task.version}）`)
    return { id, version: this.task.version, alive: true }
  }
  persist(inst: Inst, f: () => void): void {
    if (this.task.owner !== inst.id || this.task.version !== inst.version) { this.counters.fencedRejections++; this.trace(`实例 ${inst.id} 的检查点写入被版本校验拒绝`); throw new Fenced() }
    f()
    this.task.leaseUntil = this.now + LEASE
  }
  wait(inst: Inst, until: number): void {
    while (this.now < until) {
      this.advanceTo(Math.min(until, this.now + 3000))
      if (inst.alive && this.task.owner === inst.id && this.task.version === inst.version) this.task.leaseUntil = this.now + LEASE
    }
  }
  isVolatile(name: string): boolean {
    return VOLATILE_BASE.has(name) || (name === 'query_rules' && this.opts.rulesVolatile)
  }
  stepAt(turn: number, k: number): Step | undefined {
    return this.steps.find(s => s.turn === turn && s.k === k && !s.discarded)
  }
  validConfirmed(): Confirmation | undefined {
    return [...this.confirmations].reverse().find(c => c.confirmed && c.valid)
  }
  ctx(turn: number): { turn: number; results: any[]; notes: Note[]; confirmed: Params | null } {
    const results = this.steps.filter(s => s.turn === turn && s.kind === 'tool' && !s.discarded).sort((a, b) => a.k - b.k).map(s => ({ name: s.name, ...s.output }))
    return { turn, results, notes: this.notes.filter(n => n.turn === turn), confirmed: this.validConfirmed()?.params ?? null }
  }
  model(c: ReturnType<Sim['ctx']>): ModelOut {
    const base = { orderId: 'O1', lineItemId: 'L1', qty: 1, reason: '尺码不合适' }
    const last = c.results.at(-1)
    const stop = c.notes.find(n => n.disposition === 'stop')
    const reconf = c.notes.find(n => n.disposition === 'reconfirm')
    if (c.turn === 1) {
      if (c.results.length === 0) return { tools: [{ name: 'query_order', input: { orderId: 'O1' } }, { name: 'query_aftersales', input: { orderId: 'O1', lineItemId: 'L1' } }, { name: 'query_rules', input: { orderId: 'O1' } }] }
      const fee = c.results.find(r => r.name === 'query_rules')?.data?.fee ?? 0
      const p: Params = { ...base, fee }
      return { tools: [{ name: 'request_confirmation', input: p }, { name: 'submit_return', input: p }] }
    }
    if (stop && (c.results.length === 0 || last?.error)) return { text: '无法继续办理：' + stop.reason }
    if (last?.name === 'query_rules') return { tools: [{ name: 'request_confirmation', input: { ...base, fee: last.data.fee } }] }
    if (reconf && (c.results.length === 0 || last?.error)) return { tools: [{ name: 'request_confirmation', input: { ...base, fee: reconf.fee } }] }
    if (c.results.length === 0) return c.confirmed ? { tools: [{ name: 'submit_return', input: c.confirmed }] } : { tools: [{ name: 'query_rules', input: { orderId: 'O1' } }] }
    if (last?.error === '需要用户确认') return { tools: [{ name: 'query_rules', input: { orderId: 'O1' } }] }
    if (last?.ok) return { text: '已提交退货：' + last.data.ids.join(', ') }
    return { text: '无法办理：' + (last?.code ?? last?.error) }
  }
  opIds(p: Params, confId: number): [string, string] {
    const first = h(this.opts.opIdIncludesConfirmation ? ['op', 'T1', 'create_aftersales', p.orderId, p.lineItemId, confId] : ['op', 'T1', 'create_aftersales', p.orderId, p.lineItemId])
    return [first, h([first, 'create_shipment'])]
  }
  setIntent(inst: Inst, it: Intent, state: IntentState, extra: Partial<Intent> = {}): void {
    this.persist(inst, () => {
      Object.assign(it, extra)
      it.state = state
      it.history.push(`${(this.now / 1000).toFixed(1)}s:${state}`)
      this.intents.set(it.opId, it)
    })
  }
  verify(inst: Inst | null, it: Intent): 'done' | 'absent' | 'handoff' {
    if (it.deadline !== null) {
      const until = it.deadline + MARGIN
      if (inst) this.wait(inst, until)
      else this.advanceTo(until)
    }
    for (let i = 0; i < 3; i++) {
      const r = this.bs.find(it.op, it.opId)
      if (r !== 'unavailable') {
        const next: IntentState = r ? 'VERIFIED_DONE' : 'VERIFIED_ABSENT'
        const apply = () => { it.state = next; it.result = r; it.history.push(`${(this.now / 1000).toFixed(1)}s:${next}`) }
        if (inst) this.persist(inst, apply)
        else apply()
        this.trace(`核验 ${it.op}：${r ? '已生效 ' + r.id : '未生效'}`)
        return r ? 'done' : 'absent'
      }
      if (inst) this.wait(inst, this.now + 2000 * (i + 1))
      else this.advanceTo(this.now + 2000 * (i + 1))
    }
    it.state = 'HANDOFF'
    it.history.push(`${(this.now / 1000).toFixed(1)}s:HANDOFF`)
    this.trace(`核验 ${it.op}：无法判断`)
    return 'handoff'
  }
  sendOp(inst: Inst, it: Intent): 'done' | 'rejected' | 'cancelled' {
    let backoff = 1000
    let unavailable = 0
    for (let attempt = 0; attempt < 8; attempt++) {
      if (it.state !== 'PREPARED') this.setIntent(inst, it, 'PREPARED')
      this.hit('after_prepared', it.op)
      this.setIntent(inst, it, 'SENT', { deadline: this.now + DELTA })
      const z = this.fault('after_sent_before_send', it.op)
      if (z?.kind === 'zombie') {
        const req: Req = { op: it.op, opId: it.opId, params: { ...it.params }, deadline: it.deadline }
        this.zombie = () => {
          this.trace(`假死实例 ${inst.id} 苏醒，补发 ${it.op}`)
          const resp = this.call(req)
          this.trace(`假死实例补发结果 ${resp.status}${resp.code ? ' ' + resp.code : ''}`)
          try { this.persist(inst, () => { it.state = 'CONFIRMED' }) } catch { }
        }
        inst.alive = false
        throw new Paused()
      }
      if (z?.kind === 'crash') { this.pendingMutation = z; throw new Crash() }
      if (z?.kind === 'drop') this.bs.nextDrop.add(it.op)
      if (z?.kind === 'delay') this.bs.nextDelay.set(it.op, z.ms)
      if (z?.kind === 'outage') this.bs.outages.push([this.now, this.now + z.ms])
      const resp = this.call({ op: it.op, opId: it.opId, params: it.params, deadline: this.opts.delta ? it.deadline : null })
      if (resp.status === 200) {
        this.setIntent(inst, it, 'CONFIRMED', { result: { id: String(resp.body?.id) } })
        this.trace(`${it.op} 成功 ${resp.body?.id}`)
        this.hit('after_write_confirmed', it.op)
        return 'done'
      }
      if (resp.status === 'timeout') {
        this.setIntent(inst, it, 'UNKNOWN')
        this.trace(`${it.op} 超时，结果未知`)
        this.hit('after_unknown', it.op)
        if (this.arm === 'C') throw new HandoffNow('写入结果不确定')
        if (this.arm === 'B-verify') continue
        const v = this.verify(inst, it)
        if (v === 'done') return 'done'
        if (v === 'handoff') throw new HandoffNow('无法判断写入结果')
        continue
      }
      if (resp.status === 503) {
        unavailable++
        this.trace(`${it.op} 返回 503（第 ${unavailable} 次）`)
        this.setIntent(inst, it, 'PREPARED')
        if (unavailable > 3) { if (this.arm === 'C') throw new HandoffNow('重试用尽'); throw new ExternalWait() }
        this.wait(inst, this.now + backoff)
        backoff *= 2
        continue
      }
      if (resp.code === 'DEADLINE_EXCEEDED') continue
      if (resp.code === 'IDEMPOTENCY_KEY_PARAMETER_MISMATCH') { this.setIntent(inst, it, 'HANDOFF'); throw new HandoffNow('幂等 key 参数不一致') }
      this.setIntent(inst, it, 'REJECTED')
      this.trace(`${it.op} 被业务拒绝 ${resp.code}`)
      ;(it as any).code = resp.code
      return 'rejected'
    }
    throw new HandoffNow('写操作重试过多')
  }
  submitReturn(inst: Inst, p: Params): any {
    const ph = h(p)
    const conf = this.validConfirmed()
    const [id1, id2] = this.opIds(p, conf?.id ?? -1)
    const ops: Array<[OpName, string]> = [['create_aftersales', id1], ['create_shipment', id2]]
    const pending = ops.some(([, id]) => { const it = this.intents.get(id); return !it || !['CONFIRMED', 'VERIFIED_DONE'].includes(it.state) })
    if (pending && (!conf || conf.hash !== ph)) return { error: '需要用户确认' }
    const ids: string[] = []
    for (const [op, opId] of ops) {
      let it = this.intents.get(opId)
      const params = op === 'create_aftersales' ? { ...p } : { aftersalesId: ids[0] }
      if (it && ['CONFIRMED', 'VERIFIED_DONE'].includes(it.state)) { ids.push(it.result!.id); continue }
      if (it?.state === 'CANCELLED') return { error: '已停止' }
      if (it?.state === 'REJECTED') return { error: '业务拒绝', code: (it as any).code }
      if (it?.state === 'HANDOFF') throw new HandoffNow('写入意图已转人工')
      if (it && (it.state === 'SENT' || it.state === 'UNKNOWN')) {
        if (this.arm === 'B-verify') this.trace(`消融：不核验，直接用原标识重试 ${op}`)
        else {
          const v = this.verify(inst, it)
          if (v === 'done') { ids.push(it.result!.id); continue }
          if (v === 'handoff') throw new HandoffNow('无法判断写入结果')
        }
      }
      if (!it) { it = { opId, op, params, state: 'PREPARED', deadline: null, result: null, history: [] }; this.setIntent(inst, it, 'PREPARED') }
      if (canon(it.params) !== canon(params)) { this.trace(`写入意图 ${op} 参数已变，改用新参数`); it.params = params }
      const r = this.sendOp(inst, it)
      if (r === 'rejected') return { error: '业务拒绝', code: (it as any).code }
      ids.push(it.result!.id)
    }
    return { ok: true, data: { ids } }
  }
  execTool(inst: Inst, call: { name: string; input: any }): any {
    if (call.name === 'request_confirmation') {
      this.persist(inst, () => { this.confirmations.push({ id: this.confirmations.length + 1, hash: h(call.input), params: call.input, confirmed: false, valid: true }) })
      return { asked: true }
    }
    if (call.name === 'submit_return') return this.submitReturn(inst, call.input)
    this.advanceTo(this.now + 200)
    for (let i = 0; i < 4; i++) {
      const r = this.bs.read(call.name)
      if (r !== 'unavailable') {
        this.hit('after_read_before_checkpoint', call.name)
        return { data: r }
      }
      if (i === 3) { if (this.arm === 'C') throw new HandoffNow('重试用尽'); throw new ExternalWait() }
      this.wait(inst, this.now + 1000 * 2 ** i)
    }
  }
  runTurn(inst: Inst): void {
    const turn = this.task.turn
    let k = 0
    for (let guard = 0; guard < 12; guard++) {
      let out: ModelOut
      const ms = this.stepAt(turn, k)
      if (ms) out = ms.output
      else {
        this.advanceTo(this.now + 1000)
        this.counters.modelCalls++
        out = this.model(this.ctx(turn))
        this.hit('after_model_before_checkpoint', 'model')
        const kk = k
        this.persist(inst, () => { this.steps.push({ turn, k: kk, kind: 'model', name: 'model', input: null, output: out, volatile: false, discarded: false }) })
      }
      k++
      if (out.text) {
        const kk = k
        this.persist(inst, () => {
          const key = `${turn}:${kk}`
          if (!this.messages.has(key)) this.messages.set(key, out.text!)
          this.task.state = 'WAITING_USER'
          this.task.owner = null
        })
        this.trace(`Agent 回复：${out.text}`)
        return
      }
      let ended = false
      for (const call of out.tools ?? []) {
        if (!this.stepAt(turn, k)) {
          const result = ended ? { skipped: true, note: '未执行：本轮已转为等待用户' } : this.execTool(inst, call)
          const kk = k
          this.persist(inst, () => { this.steps.push({ turn, k: kk, kind: 'tool', name: call.name, input: call.input, output: result, volatile: this.isVolatile(call.name), discarded: false }) })
          if (ended) this.trace(`跳过 ${call.name}：本轮已转为等待用户`)
        }
        k++
        if (INTERACTION.has(call.name)) ended = true
      }
      if (ended) {
        this.persist(inst, () => { this.task.state = 'WAITING_USER'; this.task.owner = null })
        this.trace('Agent 请求确认，等待用户')
        return
      }
    }
  }
  recheck(inst: Inst): Array<{ name: string; before: any; after: any }> {
    const latest = new Map<string, Step>()
    for (const s of this.steps) if (s.kind === 'tool' && s.volatile && !s.discarded && s.output?.data) latest.set(s.name + h(s.input), s)
    const changes: Array<{ name: string; before: any; after: any }> = []
    for (const s of latest.values()) {
      const r = this.bs.read(s.name)
      this.counters.readReruns++
      if (r === 'unavailable') continue
      if (h(r) !== h(s.output.data)) changes.push({ name: s.name, before: s.output.data, after: r })
    }
    this.trace(`复查 ${latest.size} 个易变读：${changes.length ? changes.map(c => c.name).join(',') + ' 有变化' : '无变化'}`)
    return changes
  }
  assess(changes: Array<{ name: string; before: any; after: any }>): Note | null {
    const own = new Set([...this.intents.values()].filter(i => i.result).map(i => i.result!.id))
    if (this.opts.ownByClientRef) for (const c of changes) if (c.name === 'query_aftersales') for (const a of c.after.list) if (a.clientRef && this.intents.has(a.clientRef)) own.add(a.id)
    const firstDone = [...this.intents.values()].some(i => i.op === 'create_aftersales' && ['CONFIRMED', 'VERIFIED_DONE'].includes(i.state))
    const turn = this.task.turn
    for (const c of changes) if (c.name === 'query_order' && c.after.refunded) return { turn, disposition: 'stop', reason: '订单已退款' }
    for (const c of changes) if (c.name === 'query_aftersales' && c.after.list.some((a: any) => a.open && !own.has(a.id))) return { turn, disposition: 'stop', reason: '该商品已有其他进行中的申请' }
    for (const c of changes) if (c.name === 'query_rules' && c.after.fee !== c.before.fee && !firstDone) return { turn, disposition: 'reconfirm', reason: '退货运费已变化', fee: c.after.fee }
    return null
  }
  recover(inst: Inst): void {
    this.counters.takeovers++
    const verifyAll = () => {
      for (const it of [...this.intents.values()]) if (it.state === 'SENT' || it.state === 'UNKNOWN') {
        const v = this.verify(inst, it)
        if (v === 'handoff') throw new HandoffNow('无法判断写入结果')
      }
    }
    const doRecheck = () => {
      const changes = this.recheck(inst)
      if (!changes.length) return
      const note = this.assess(changes)
      if (!note) { this.trace('处置：继续'); return }
      this.trace(`处置：${note.disposition}（${note.reason}）`)
      this.persist(inst, () => {
        this.notes.push(note)
        for (const c of this.confirmations) c.valid = false
        if (note.disposition === 'stop') for (const it of this.intents.values()) if (['PREPARED', 'VERIFIED_ABSENT'].includes(it.state)) it.state = 'CANCELLED'
        if (note.disposition === 'reconfirm') this.counters.reconfirms++
      })
    }
    if (this.arm === 'B-recheckFirst') { doRecheck(); verifyAll() }
    else {
      if (this.arm !== 'B-verify') verifyAll()
      if (this.arm === 'B' || this.arm === 'B-verify') doRecheck()
    }
    if (this.arm === 'A') {
      const turn = this.task.turn
      this.persist(inst, () => { for (const s of this.steps) if (s.turn === turn) s.discarded = true })
      this.trace('轮次级重跑：丢弃本轮内部轨迹，从本轮开头重跑')
    }
  }
  handoff(reason: string): void {
    for (const it of this.intents.values()) if (it.state === 'SENT' || it.state === 'UNKNOWN') this.verify(null, it)
    this.handoffPkg = { reason, intents: [...this.intents.values()].map(i => ({ op: i.op, opId: i.opId, state: i.state, result: i.result?.id ?? null })) }
    this.task.state = 'HANDED_OFF'
    this.task.owner = null
    this.trace(`转人工：${reason}`)
  }
  mutate(m: string): void {
    if (m === 'competing') this.bs.aftersales.push({ id: 'AS-OTHER', clientRef: null, lineItemId: 'L1', qty: 1, fee: this.bs.fee, open: true, at: this.now })
    if (m === 'refunded') this.bs.refunded = true
    if (m === 'fee') this.bs.fee = 12
    this.trace(`故障期间业务状态变化：${m}`)
  }
  watchdog(): void {
    if (this.task.state !== 'RUNNING' || this.now <= this.task.leaseUntil) return
    this.trace('看门狗发现租约过期')
    if (this.arm === 'C') { this.handoff('执行进程崩溃'); return }
    this.task.state = 'READY'
    this.task.owner = null
    this.task.needsRecovery = true
  }
  userActs(): void {
    const pending = [...this.confirmations].reverse().find(c => !c.confirmed && c.valid)
    if (pending) {
      pending.confirmed = true
      this.task.turn++
      this.task.state = 'READY'
      this.trace(`用户确认（运费 ${pending.params.fee}）`)
      return
    }
    this.task.state = 'CLOSED'
    this.trace('用户结束会话')
  }
  probe(): void {
    if (this.now - this.task.externalSince > MAX_WAIT) { this.handoff('等待外部超时'); return }
    this.advanceTo(Math.max(this.now, this.task.nextProbe))
    if (!this.bs.down(this.now)) {
      this.task.state = 'READY'
      this.task.needsRecovery = true
      this.trace('外部服务恢复，任务回到待执行')
      return
    }
    this.task.probeDelay = Math.min(this.task.probeDelay * 2, 30 * 60_000)
    this.task.nextProbe = this.now + this.task.probeDelay
  }
}

export function runScenario(arm: Arm, mode: Mode, plan: FaultSpec[], opts: Options): RunResult {
  const sim = new Sim(arm, mode, plan, opts)
  sim.task.turn = 1
  sim.trace('用户：我要退货（订单 O1，商品 L1）')
  let n = 0
  for (let i = 0; i < 200; i++) {
    const st = sim.task.state
    if (st === 'CLOSED' || st === 'HANDED_OFF') break
    if (st === 'WAITING_USER') { sim.userActs(); continue }
    if (st === 'WAITING_EXTERNAL') { sim.probe(); continue }
    if (st === 'RUNNING') { sim.advanceTo(sim.task.leaseUntil + 1); sim.watchdog(); continue }
    const inst = sim.claim('E' + ++n)
    try {
      if (sim.task.needsRecovery) { sim.recover(inst); sim.persist(inst, () => { sim.task.needsRecovery = false }) }
      sim.runTurn(inst)
      if (sim.zombie) { const z = sim.zombie; sim.zombie = null; z() }
    } catch (e) {
      if (e instanceof Crash || e instanceof Paused) {
        inst.alive = false
        const m = sim.pendingMutation
        sim.pendingMutation = null
        if (m && m.kind === 'crash' && m.mutate) sim.mutate(m.mutate)
        sim.trace(e instanceof Crash ? `执行实例 ${inst.id} 崩溃` : `执行实例 ${inst.id} 假死`)
        sim.advanceTo(sim.task.leaseUntil + 1)
        sim.watchdog()
      } else if (e instanceof ExternalWait) {
        sim.task.state = 'WAITING_EXTERNAL'
        sim.task.owner = null
        if (!sim.task.notified) { sim.task.notified = true; sim.messages.set('external', '外部服务暂不可用，恢复后自动继续') }
        sim.task.externalSince = sim.now
        sim.task.probeDelay = 60_000
        sim.task.nextProbe = sim.now + 60_000
        sim.trace('重试用尽，进入等待外部')
      } else if (e instanceof HandoffNow) sim.handoff(e.message)
      else if (!(e instanceof Fenced)) throw e
    }
  }
  if (sim.zombie) { const z = sim.zombie; sim.zombie = null; z() }
  sim.advanceTo(sim.now + 60_000)
  const ids = [...sim.intents.values()]
  const ourAs = sim.bs.aftersales.filter(a => a.clientRef !== null)
  const ourShip = sim.bs.shipments
  const lastMsg = [...sim.messages.entries()].filter(([k]) => k !== 'external').sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).at(-1)?.[1] ?? ''
  let outcome: Outcome = 'incomplete'
  if (sim.task.state === 'HANDED_OFF') outcome = 'handoff'
  else if (ourAs.length >= 1 && ourShip.length >= 1 && lastMsg.startsWith('已提交')) outcome = sim.counters.reconfirms > 0 ? 'reconfirmed' : 'completed'
  else if (lastMsg.startsWith('无法继续办理')) outcome = 'stopped'
  else if (lastMsg.startsWith('无法办理')) outcome = 'rejected'
  let consistent: boolean | null = null
  if (sim.handoffPkg) {
    consistent = sim.handoffPkg.intents.every(p => {
      const actual = p.op === 'create_aftersales' ? ourAs.some(a => a.clientRef === p.opId) : ourShip.some(s => s.clientRef === p.opId)
      if (p.state === 'CONFIRMED' || p.state === 'VERIFIED_DONE') return actual
      if (p.state === 'SENT' || p.state === 'UNKNOWN' || p.state === 'HANDOFF') return true
      return !actual
    }) && ourAs.every(a => sim.handoffPkg!.intents.some(p => p.opId === a.clientRef)) && ourShip.every(s => sim.handoffPkg!.intents.some(p => p.opId === s.clientRef))
  }
  void ids
  const orphan = outcome === 'stopped' || outcome === 'rejected' ? ourAs.length + ourShip.length : 0
  return {
    outcome,
    ourAftersales: ourAs.length,
    ourShipments: ourShip.length,
    staleWrites: sim.bs.staleWrites,
    handoffConsistent: consistent,
    modelCalls: sim.counters.modelCalls,
    readReruns: sim.counters.readReruns,
    fencedRejections: sim.counters.fencedRejections,
    takeovers: sim.counters.takeovers,
    orphanWrites: orphan,
    log: sim.logLines,
  }
}
