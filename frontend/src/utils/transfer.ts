/**
 * 倒罐容量与工单流转：
 * - 可转罐要求源罐液量不超过目标罐剩余容量（容量 − 在罐批次占用）
 * - 完成倒罐即把批次改绑到目标罐，占住的容量随批次出罐才释放
 * - 容量不足的安排进入「排队中」并给出短差升数，容量释放后自动恢复「计划」
 * 版本原语（批次版本 / 审计日志 / 冲突检测）统一走 utils/versioning.ts。
 */
import { db, ROW_REVISION, nextOperationSeq, type OperationRow } from './db'
import { analyzeReadings } from './trend'
import {
  appendChangeLog,
  assertLatestVersion,
  bumpBatchVersion,
  operationLabel
} from './versioning'
import { createId, nowIso } from './uuid'
import type { OperationState, OperationType } from '../types/operation'
import type { TankCapacity, TransferVerdict } from '../types/transfer'

/* ------------------------------ 容量计算 ------------------------------ */

/** 目标罐容量状况：在罐批次（含已完成倒罐改绑进来的）占用之和 */
export async function tankCapacityInfo(tankId: string): Promise<TankCapacity> {
  const tank = await db.tanks.get(tankId)
  if (!tank) throw new Error('发酵罐不存在')
  const occupants = await db.batches
    .where('tankId')
    .equals(tankId)
    .filter((batch) => batch.state !== '已出罐')
    .toArray()
  const usedL = occupants.reduce((sum, batch) => sum + batch.volumeL, 0)
  return { tankId, capacityL: tank.capacityL, usedL, remainingL: tank.capacityL - usedL }
}

/** 可转罐结论：趋势维度（后发酵起且未停滞）+ 容量维度（剩余容量装得下源罐液量） */
export async function evaluateTransfer(batchId: string, targetTankId: string): Promise<TransferVerdict> {
  const batch = await db.batches.get(batchId)
  if (!batch) throw new Error('批次不存在')
  const reasons: string[] = []
  const readings = await db.readings.where('batchId').equals(batchId).sortBy('date')
  const trendOk = analyzeReadings(readings).transferable
  if (!trendOk) reasons.push('趋势未到位：需进入后发酵且未停滞')
  if (!targetTankId) {
    reasons.push('未选择目标罐')
    return { trendOk, capacityOk: false, shortfallL: 0, ok: false, reasons }
  }
  if (targetTankId === batch.tankId) {
    reasons.push('目标罐不能与源罐相同')
    return { trendOk, capacityOk: false, shortfallL: 0, ok: false, reasons }
  }
  const targetTank = await db.tanks.get(targetTankId)
  if (!targetTank) throw new Error('目标罐不存在')
  if (targetTank.state === '清洗中') {
    reasons.push(`罐 ${targetTank.code} 正在清洗中，暂不可转入`)
    return { trendOk, capacityOk: false, shortfallL: 0, ok: false, reasons }
  }
  const capacity = await tankCapacityInfo(targetTankId)
  const shortfallL = Math.max(0, batch.volumeL - capacity.remainingL)
  const capacityOk = shortfallL === 0
  if (!capacityOk) reasons.push(`目标罐剩余容量不足，还差 ${shortfallL} L`)
  return { trendOk, capacityOk, shortfallL, ok: trendOk && capacityOk, reasons }
}

/* ------------------------------ 工单保存 ------------------------------ */

export interface SaveOperationInput {
  /** 编辑已有工单时传 id，新增为空 */
  id?: string | null
  batchId: string
  type: OperationType
  date: string
  durationMin: number
  operator: string
  targetTankId: string
  /** 本窗口的批次基准版本 */
  baseVersion: number
}

export interface SaveOperationResult {
  id: string
  /** 变更后的批次数据版本 */
  version: number
  state: OperationState
  /** 容量短差（排队中时 > 0） */
  shortfallL: number
}

const OPERATION_TABLES = [db.operations, db.batches, db.readings, db.tanks, db.changeLogs, db.batchVersions]

/**
 * 保存工单（新增 / 编辑）：版本校验 → 倒罐容量评估（不足转排队）→ 写日志。
 * 编辑「待复核」工单保存即视为复核（按最新趋势与容量重新定状态）。
 */
export async function saveOperationVersioned(input: SaveOperationInput): Promise<SaveOperationResult> {
  return db.transaction('rw', OPERATION_TABLES, async () => {
    await assertLatestVersion(input.batchId, input.baseVersion)
    const now = Date.now()
    const prev = input.id ? ((await db.operations.get(input.id)) as OperationRow | undefined) : undefined
    if (input.id && !prev) throw new Error('作业不存在或已被删除')

    let state: OperationState = '计划'
    let shortfallL = 0
    let detail = prev ? '更新作业安排' : '排入作业队列'
    if (prev?.state === '已完成') {
      state = '已完成'
    } else if (input.type === '倒罐') {
      if (!input.targetTankId) throw new Error('倒罐作业必须选择目标罐')
      const verdict = await evaluateTransfer(input.batchId, input.targetTankId)
      if (!verdict.capacityOk && verdict.shortfallL === 0) {
        // 目标罐不可用（清洗中 / 与源罐相同），不属于排队场景
        throw new Error(verdict.reasons.join('；') || '目标罐不可用')
      }
      if (verdict.shortfallL > 0) {
        state = '排队中'
        shortfallL = verdict.shortfallL
        detail = `目标罐剩余容量不足，还差 ${shortfallL} L，转入排队等待`
      }
    }

    const id = input.id ?? createId('operation')
    await db.operations.put({
      id,
      batchId: input.batchId,
      type: input.type,
      date: input.date,
      durationMin: input.durationMin,
      operator: input.operator,
      state,
      seq: prev?.seq ?? (await nextOperationSeq(input.batchId)),
      targetTankId: input.type === '倒罐' ? input.targetTankId : '',
      invalidReason: null,
      version: (prev?.version ?? 0) + 1,
      revision: ROW_REVISION,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    })
    const version = await bumpAndLog(input, id, prev ? 'update' : 'create', detail)
    if (state === '排队中') {
      await appendChangeLog({
        batchId: input.batchId,
        entity: 'operation',
        entityId: id,
        action: 'queue',
        date: input.date,
        label: operationLabel(input),
        detail,
        batchVersion: version
      })
    }
    return { id, version, state, shortfallL }
  })
}

/** 事务内：bump 批次版本并写工单日志 */
async function bumpAndLog(
  input: Pick<SaveOperationInput, 'batchId' | 'type' | 'date' | 'operator'>,
  id: string,
  action: 'create' | 'update' | 'review' | 'complete' | 'dequeue',
  detail: string
): Promise<number> {
  const version = await bumpBatchVersion(input.batchId)
  await appendChangeLog({
    batchId: input.batchId,
    entity: 'operation',
    entityId: id,
    action,
    date: input.date,
    label: operationLabel(input),
    detail,
    batchVersion: version
  })
  return version
}

/** 复核：待复核工单按最新趋势与容量重新定状态（计划 / 排队中） */
export async function reviewOperationVersioned(
  id: string,
  baseVersion: number
): Promise<SaveOperationResult> {
  return db.transaction('rw', OPERATION_TABLES, async () => {
    const op = (await db.operations.get(id)) as OperationRow | undefined
    if (!op) throw new Error('作业不存在或已被删除')
    if (op.state !== '待复核') throw new Error('仅「待复核」工单需要复核')
    await assertLatestVersion(op.batchId, baseVersion)

    let state: OperationState = '计划'
    let shortfallL = 0
    let detail = '复核通过，恢复计划'
    if (op.type === '倒罐') {
      const verdict = await evaluateTransfer(op.batchId, op.targetTankId)
      if (!verdict.capacityOk && verdict.shortfallL === 0) {
        throw new Error(verdict.reasons.join('；') || '目标罐不可用，请编辑工单改选目标罐')
      }
      if (verdict.shortfallL > 0) {
        state = '排队中'
        shortfallL = verdict.shortfallL
        detail = `复核后容量仍不足，还差 ${shortfallL} L，继续排队`
      }
    }
    await db.operations.update(id, {
      state,
      invalidReason: null,
      version: op.version + 1,
      updatedAt: Date.now()
    } as never)
    const version = await bumpAndLog(op, id, 'review', detail)
    return { id, version, state, shortfallL }
  })
}

/**
 * 完成作业：回写批次最近作业时间；倒罐完成即把批次改绑目标罐（占住容量），
 * 源罐无其它在罐批次则释放为空闲。
 */
export async function completeOperationVersioned(id: string, baseVersion: number): Promise<number> {
  return db.transaction('rw', OPERATION_TABLES, async () => {
    const op = (await db.operations.get(id)) as OperationRow | undefined
    if (!op) throw new Error('作业不存在或已被删除')
    if (op.state === '已完成') throw new Error('作业已完成，无需重复操作')
    if (op.state === '待复核') throw new Error('工单已退回复核，请先复核再执行')
    await assertLatestVersion(op.batchId, baseVersion)
    const batch = await db.batches.get(op.batchId)
    if (!batch) throw new Error('批次不存在')

    const now = Date.now()
    let detail = '作业完成，回写批次最近作业时间'
    if (op.type === '倒罐') {
      if (!op.targetTankId) throw new Error('倒罐作业缺少目标罐')
      const verdict = await evaluateTransfer(op.batchId, op.targetTankId)
      if (!verdict.capacityOk) throw new Error(verdict.reasons.join('；') || '目标罐不可用')
      if (!verdict.trendOk) throw new Error('当前趋势不满足可转罐条件（需进入后发酵且未停滞）')
      const sourceTankId = batch.tankId
      await db.tanks.update(op.targetTankId, { state: '在用', updatedAt: now } as never)
      if (sourceTankId && sourceTankId !== op.targetTankId) {
        const remaining = await db.batches
          .where('tankId')
          .equals(sourceTankId)
          .filter((item) => item.state !== '已出罐' && item.id !== batch.id)
          .count()
        if (remaining === 0) await db.tanks.update(sourceTankId, { state: '空闲', updatedAt: now } as never)
      }
      await db.batches.update(op.batchId, { tankId: op.targetTankId, updatedAt: now } as never)
      detail = `倒罐完成，批次改绑目标罐并占住 ${batch.volumeL} L 容量`
    }
    await db.operations.update(id, {
      state: '已完成',
      invalidReason: null,
      version: op.version + 1,
      updatedAt: now
    } as never)
    await db.batches.update(op.batchId, { lastOperationAt: nowIso(), updatedAt: now } as never)
    return bumpAndLog(op, id, 'complete', detail)
  })
}

/**
 * 容量释放后（出罐 / 倒罐完成 / 批次删除）重估排队工单：
 * 剩余容量够的恢复「计划」，逐条记日志；返回恢复的工单数。
 */
export async function requeueWaitingOps(): Promise<number> {
  const waiting = (await db.operations.where('state').equals('排队中').toArray()) as OperationRow[]
  if (waiting.length === 0) return 0
  return db.transaction('rw', OPERATION_TABLES, async () => {
    let promoted = 0
    for (const op of waiting.sort((a, b) => a.seq - b.seq)) {
      const verdict = await evaluateTransfer(op.batchId, op.targetTankId)
      if (!verdict.capacityOk) continue
      await db.operations.update(op.id, {
        state: '计划',
        invalidReason: null,
        version: op.version + 1,
        updatedAt: Date.now()
      } as never)
      await bumpAndLog(op, op.id, 'dequeue', '目标罐容量已释放，恢复计划')
      promoted += 1
    }
    return promoted
  })
}
