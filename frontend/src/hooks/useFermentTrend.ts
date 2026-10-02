/**
 * 按批次派生比重序列、日均下降速率与发酵停滞判定
 * 被批次读数页、品评页与苹乳页消费。
 *
 * 数据来源为「有效」读数（已撤回行不参与趋势）；
 * 重算结论与落库的趋势快照（utils/trend + db.rebuildTrendAndInvalidate）保持一致，
 * 页面只做只读派生，所有写操作必须经过版本化事务。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import type { ReadingPoint } from '@/types/reading'
import { RACKABLE_GRAVITY_MAX, STUCK_DECLINE_THRESHOLD } from '@/types/reading'
import type { ReadingRow } from '@/utils/db'
import { activeReadings, deriveTrend } from '@/utils/trend'
import {
  fermentationStage,
  potentialAbv,
  stageTone,
  type FermentStage
} from '@/utils/gravity'

export interface FermentTrend {
  /** 按日期升序的有效读数趋势点 */
  points: ComputedRef<ReadingPoint[]>
  /** 平均比重日下降速率 */
  avgDeclinePerDay: ComputedRef<number>
  /** 是否疑似发酵停滞（存在停滞窗口） */
  stuck: ComputedRef<boolean>
  /** 停滞日期 */
  stuckDates: ComputedRef<string[]>
  /** 超温天数 */
  overTempDays: ComputedRef<number>
  /** 超温日期 */
  overTempDates: ComputedRef<string[]>
  /** 最新比重 */
  latestGravity: ComputedRef<number>
  /** 当前发酵阶段 */
  stage: ComputedRef<FermentStage>
  /** 阶段对应的标签配色 */
  tone: ComputedRef<'primary' | 'success' | 'warning' | 'info'>
  /** 潜在酒精度（由首个读数估算） */
  potential: ComputedRef<number>
  /** 自绘趋势条需要的最大最小比重 */
  range: ComputedRef<{ min: number; max: number }>
  /** 当前是否满足可转罐条件 */
  rackable: ComputedRef<boolean>
  /** 不可转罐原因 */
  rackableReasons: ComputedRef<string[]>
}

/** 传入某个批次的读数集合（可含撤回行），返回派生指标 */
export function useFermentTrend(readings: Ref<ReadingRow[]>): FermentTrend {
  const derived = computed(() => deriveTrend(readings.value))

  const pointRows = computed<ReadingPoint[]>(() => {
    const rows = activeReadings(readings.value)
    return derived.value.points.map((point, index) => ({
      ...rows[index],
      declinePerDay: point.declinePerDay,
      overTemp: point.overTemp,
      stuck: point.stuck
    }))
  })

  const avgDeclinePerDay = computed(() => {
    const list = pointRows.value.slice(1)
    if (list.length === 0) return 0
    return Number((list.reduce((sum, item) => sum + item.declinePerDay, 0) / list.length).toFixed(4))
  })

  const stuck = computed(() => derived.value.stuckDates.length > 0)
  const stuckDates = computed(() => derived.value.stuckDates)
  const overTempDays = computed(() => derived.value.overTempDates.length)
  const overTempDates = computed(() => derived.value.overTempDates)
  const latestGravity = computed(() => derived.value.latestGravity)
  const stage = computed<FermentStage>(() =>
    latestGravity.value > 0 ? fermentationStage(latestGravity.value) : '起酵'
  )
  const potential = computed(() =>
    pointRows.value.length > 0 ? potentialAbv(pointRows.value[0].gravity) : 0
  )
  const range = computed(() => {
    const values = pointRows.value.map((item) => item.gravity)
    if (values.length === 0) return { min: 0.99, max: 1.1 }
    return { min: Math.min(...values) - 0.005, max: Math.max(...values) + 0.005 }
  })
  const rackable = computed(() => derived.value.rackable)
  const rackableReasons = computed(() => derived.value.rackableReasons)

  return {
    points: pointRows,
    avgDeclinePerDay,
    stuck,
    stuckDates,
    overTempDays,
    overTempDates,
    latestGravity,
    stage,
    tone: computed(() => stageTone(stage.value)),
    potential,
    range,
    rackable,
    rackableReasons
  }
}

/** 供模板 / 其它模块引用阈值 */
export { STUCK_DECLINE_THRESHOLD, RACKABLE_GRAVITY_MAX }
