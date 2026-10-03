/**
 * 按批次派生比重序列、日均下降速率与发酵停滞判定
 * 被批次读数页、品评页与苹乳页消费。
 * 计算逻辑收在 utils/trend.ts 纯函数中，与读数变更后的事务内重算共用同一套判定。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import type { ReadingRow } from '@/utils/db'
import { computeTrendPoints, summarizeTrend, type TrendPoint } from '@/utils/trend'
import { stageTone, type FermentStage } from '@/utils/gravity'

export interface FermentTrend {
  /** 按日期升序的读数趋势点 */
  points: ComputedRef<TrendPoint[]>
  /** 平均比重日下降速率 */
  avgDeclinePerDay: ComputedRef<number>
  /** 是否疑似发酵停滞（末尾连续两次下降均低于阈值） */
  stuck: ComputedRef<boolean>
  /** 超温天数 */
  overTempDays: ComputedRef<number>
  /** 最新比重 */
  latestGravity: ComputedRef<number>
  /** 当前发酵阶段 */
  stage: ComputedRef<FermentStage>
  /** 阶段对应的标签配色 */
  tone: ComputedRef<'primary' | 'success' | 'warning' | 'info'>
  /** 潜在酒精度（由首个读数估算） */
  potential: ComputedRef<number>
  /** 趋势维度是否可转罐（进入后发酵且未停滞） */
  transferable: ComputedRef<boolean>
  /** 自绘趋势条需要的最大最小比重 */
  range: ComputedRef<{ min: number; max: number }>
}

/** 传入某个批次的读数集合（已按日期升序），返回派生指标 */
export function useFermentTrend(readings: Ref<ReadingRow[]>): FermentTrend {
  const points = computed<TrendPoint[]>(() => computeTrendPoints(readings.value))
  const summary = computed(() => summarizeTrend(points.value))

  const stage = computed<FermentStage>(() => summary.value.stage)
  const range = computed(() => {
    const values = points.value.map((item) => item.gravity)
    if (values.length === 0) return { min: 0.99, max: 1.1 }
    return { min: Math.min(...values) - 0.005, max: Math.max(...values) + 0.005 }
  })

  return {
    points,
    avgDeclinePerDay: computed(() => summary.value.avgDeclinePerDay),
    stuck: computed(() => summary.value.stuck),
    overTempDays: computed(() => summary.value.overTempDays),
    latestGravity: computed(() => summary.value.latestGravity),
    stage,
    tone: computed(() => stageTone(stage.value)),
    potential: computed(() => summary.value.potential),
    transferable: computed(() => summary.value.transferable),
    range
  }
}
