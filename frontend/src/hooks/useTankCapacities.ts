/**
 * useTankCapacities：响应式计算各罐容量占用与剩余。
 * 占用 = 在罐批次（含已完成倒罐保留）+ 已确认倒罐计划单先排先占。
 */
import { computed, type ComputedRef } from 'vue'
import { type BatchRow, type OperationRow, type TankRow } from '@/utils/db'
import { computeTankCapacities, type TankCapacity } from '@/utils/capacity'

export interface TankCapacitiesResult {
  capacities: ComputedRef<Map<string, TankCapacity>>
  /** 含计划单预留的剩余容量（工单保存时的真实可用值） */
  freeWithReservations: ComputedRef<Map<string, number>>
  /** 罐 id → 占用百分比 */
  usagePercent: (tankId: string) => number
}

export function useTankCapacities(
  tanks: { value: TankRow[] },
  batches: { value: BatchRow[] },
  operations: { value: OperationRow[] }
): TankCapacitiesResult {
  const capacities = computed(() =>
    computeTankCapacities({
      tanks: tanks.value,
      batches: batches.value,
      operations: operations.value
    })
  )

  const freeWithReservations = computed(() => {
    const map = new Map<string, number>()
    for (const [tankId, cap] of capacities.value) {
      const reserved = operations.value
        .filter((op) => op.type === '倒罐' && op.state === '计划' && op.targetTankId === tankId)
        .reduce((sum, op) => sum + op.transferVolumeL, 0)
      map.set(tankId, Math.max(0, cap.freeL - reserved))
    }
    return map
  })

  function usagePercent(tankId: string): number {
    const cap = capacities.value.get(tankId)
    if (!cap || cap.capacityL <= 0) return 0
    return Math.min(100, Math.round((cap.occupiedL / cap.capacityL) * 100))
  }

  return { capacities, freeWithReservations, usagePercent }
}
