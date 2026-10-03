/**
 * 发酵趋势纯函数：由读数序列派生趋势点与结论（停滞 / 超温 / 可转罐）。
 * 从 hooks/useFermentTrend 抽出的无副作用实现，供以下场景共用同一套判定：
 * - hooks/useFermentTrend（页面响应式展示）
 * - utils/versioning（读数变更后从事务内重算并退回失效工单）
 */
import type { Reading } from '../types/reading'
import { STUCK_DECLINE_THRESHOLD } from '../types/reading'
import {
  fermentationStage,
  gravityDeclinePerDay,
  isOverTemp,
  potentialAbv,
  type FermentStage
} from './gravity'

/** 趋势点：读数 + 派生的下降速率与超温标记 */
export interface TrendPoint extends Reading {
  /** 相对上一条读数的比重日下降速率 */
  declinePerDay: number
  /** 是否超温（> 30 ℃） */
  overTemp: boolean
}

/** 一批读数的趋势结论 */
export interface TrendSummary {
  points: TrendPoint[]
  /** 平均比重日下降速率 */
  avgDeclinePerDay: number
  /** 是否疑似发酵停滞（末尾连续两次下降均低于阈值） */
  stuck: boolean
  /** 超温天数 */
  overTempDays: number
  /** 最新比重 */
  latestGravity: number
  /** 当前发酵阶段 */
  stage: FermentStage
  /** 潜在酒精度（由首个读数估算） */
  potential: number
  /** 趋势维度是否可转罐：进入后发酵（比重 < 1.02）且未停滞 */
  transferable: boolean
}

/** 由按日期升序的读数序列计算趋势点 */
export function computeTrendPoints(readings: Reading[]): TrendPoint[] {
  return readings.map((row, index) => {
    const prev = index > 0 ? readings[index - 1] : null
    const days = prev ? (new Date(row.date).getTime() - new Date(prev.date).getTime()) / 86400000 : 0
    return {
      ...row,
      declinePerDay: prev ? gravityDeclinePerDay(prev.gravity, row.gravity, days) : 0,
      overTemp: isOverTemp(row.tempC)
    }
  })
}

/** 由趋势点汇总结论 */
export function summarizeTrend(points: TrendPoint[]): TrendSummary {
  const declines = points.slice(1)
  const avgDeclinePerDay =
    declines.length > 0
      ? Number((declines.reduce((sum, item) => sum + item.declinePerDay, 0) / declines.length).toFixed(4))
      : 0

  const tail = points.slice(-2)
  const stuck =
    tail.length >= 2 && tail.every((item) => item.declinePerDay > 0 && item.declinePerDay < STUCK_DECLINE_THRESHOLD)

  const latestGravity = points.length > 0 ? points[points.length - 1].gravity : 0
  const stage = latestGravity > 0 ? fermentationStage(latestGravity) : '起酵'
  const transferable = points.length > 0 && !stuck && (stage === '后发酵' || stage === '结束')

  return {
    points,
    avgDeclinePerDay,
    stuck,
    overTempDays: points.filter((item) => item.overTemp).length,
    latestGravity,
    stage,
    potential: points.length > 0 ? potentialAbv(points[0].gravity) : 0,
    transferable
  }
}

/** 读数序列 → 趋势结论（便捷入口） */
export function analyzeReadings(readings: Reading[]): TrendSummary {
  return summarizeTrend(computeTrendPoints(readings))
}
