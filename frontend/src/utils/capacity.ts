/**
 * 倒罐容量核算引擎（纯函数）：
 * - 可转罐要求：源罐液量 ≤ 目标罐剩余容量
 * - 已完成倒罐占住的容量持续保留（批次当前位置以最近一次完成的倒罐为准）
 * - 容量不足的倒罐工单排队等待，并给出还差多少升
 */
import type { Batch } from '@/types/batch'
import type { Operation } from '@/types/operation'
import type { Tank } from '@/types/tank'

/** 归一化作业：容量核算只关心这些字段 */
export interface RackingLike
  extends Pick<
    Operation,
    'id' | 'batchId' | 'type' | 'date' | 'seq' | 'state' | 'targetTankId' | 'transferVolumeL' | 'shortfallL'
  > {}

export interface CapacityInput {
  tanks: Tank[]
  batches: Batch[]
  operations: RackingLike[]
}

export interface TankCapacity {
  tankId: string
  code: string
  capacityL: number
  /** 已占用（在罐批次 + 已完成倒罐保留） */
  occupiedL: number
  /** 剩余容量 */
  freeL: number
  /** 占用明细，便于看板解释容量去向 */
  occupiedBy: Array<{ batchId: string; volumeL: number; reason: string }>
}

/** 批次当前所在罐：取该批次最近一次「已完成」的倒罐目标罐；没有则回退入罐绑定罐 */
export function effectiveTankId(batch: Pick<Batch, 'tankId'>, doneRacking: RackingLike[]): string {
  const latest = doneRacking
    .filter((op) => op.targetTankId)
    .sort((a, b) => b.date.localeCompare(a.date) || b.seq - a.seq)[0]
  return latest?.targetTankId ?? batch.tankId
}

/**
 * 计算各罐占用：
 * 1. 每个在罐批次按其有效位置落罐（最近完成倒罐优先），占 batch.volumeL
 * 2. 已完成倒罐若与批次当前位置不一致（酒已再转走），其保留量已计入第 1 步，不重复累计
 */
export function computeTankCapacities({ tanks, batches, operations }: CapacityInput): Map<string, TankCapacity> {
  const activeBatches = batches.filter((batch) => batch.state !== '已出罐')
  const result = new Map<string, TankCapacity>()
  for (const tank of tanks) {
    result.set(tank.id, {
      tankId: tank.id,
      code: tank.code,
      capacityL: tank.capacityL,
      occupiedL: 0,
      freeL: tank.capacityL,
      occupiedBy: []
    })
  }

  for (const batch of activeBatches) {
    const done = operations
      .filter((op) => op.type === '倒罐' && op.state === '已完成' && op.batchId === batch.id)
      .sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq)
    const locationTankId = effectiveTankId(batch, done)
    const entry = result.get(locationTankId)
    if (entry) {
      entry.occupiedL += batch.volumeL
      entry.occupiedBy.push({
        batchId: batch.id,
        volumeL: batch.volumeL,
        reason: done.length > 0 ? '已完成倒罐保留' : '在罐批次'
      })
    }
  }

  for (const entry of result.values()) {
    entry.occupiedL = Math.min(entry.capacityL, entry.occupiedL)
    entry.freeL = Math.max(0, entry.capacityL - entry.occupiedL)
  }
  return result
}

/** 源罐当前可供倒出的液量：批次在罐液量（有效位置必须是源罐） */
export function sourceAvailableVolume(
  batch: Batch,
  sourceTankId: string,
  operations: RackingLike[]
): number {
  if (batch.state === '已出罐') return 0
  const done = operations.filter(
    (op) => op.type === '倒罐' && op.state === '已完成' && op.batchId === batch.id
  )
  if (effectiveTankId(batch, done) !== sourceTankId) return 0
  return batch.volumeL
}

/** 排队评估结果 */
export interface QueueEvaluationItem {
  id: string
  /** 评估后的状态 */
  state: '计划' | '排队'
  /** 排队时还差多少 L */
  shortfallL: number
  /** 评估时目标罐剩余容量 */
  freeL: number
}

/**
 * 依日期 / 顺序对所有未完成倒罐工单做容量评估。
 * 「计划」工单按计划日先后参与占位（先排先占），容量不够则转「排队」。
 * 「待复核」工单不参与占位，必须先复核。
 */
export function evaluateQueue(input: CapacityInput): QueueEvaluationItem[] {
  const capacities = computeTankCapacities(input)
  const pending = input.operations
    .filter((op) => op.type === '倒罐' && op.state !== '已完成' && op.state !== '待复核' && op.targetTankId)
    .sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq)

  const results: QueueEvaluationItem[] = []
  for (const op of pending) {
    const cap = capacities.get(op.targetTankId)
    const freeL = cap ? cap.freeL : 0
    if (cap && freeL >= op.transferVolumeL) {
      // 计划单先排先占：占住目标罐对应容量（直到完成或取消）
      cap.occupiedL += op.transferVolumeL
      cap.freeL = Math.max(0, cap.capacityL - cap.occupiedL)
      cap.occupiedBy.push({ batchId: op.batchId, volumeL: op.transferVolumeL, reason: '已确认倒罐预留' })
      results.push({ id: op.id, state: '计划', shortfallL: 0, freeL })
    } else {
      results.push({
        id: op.id,
        state: '排队',
        shortfallL: Math.max(0, op.transferVolumeL - freeL),
        freeL
      })
    }
  }
  return results
}
