/**
 * 批次趋势重算引擎（纯函数）：
 * 从有效读数派生 停滞 / 超温 / 可转罐 结论。
 * 读数新增、改动或撤回后，从受影响日期起重算（实现上全量重算该批次，
 * 但调用方只把「受影响日期起」的结论变化落库 / 退单，见 recomputeTrendAfterChange）。
 */
import {
  OVER_TEMP_C,
  RACKABLE_GRAVITY_MAX,
  RACKABLE_MIN_READINGS,
  RACKABLE_RECENT_DAYS,
  STUCK_DECLINE_THRESHOLD,
  type VersionedReading
} from '@/types/reading'
import type { TrendPoint } from '@/types/versioning'
import { gravityDeclinePerDay, isOverTemp } from './gravity'

export interface DerivedTrend {
  points: TrendPoint[]
  dates: string[]
  stuckDates: string[]
  overTempDates: string[]
  latestGravity: number
  rackable: boolean
  rackableReasons: string[]
}

/** 过滤掉已撤回读数并按日期升序 */
export function activeReadings(readings: VersionedReading[]): VersionedReading[] {
  return readings
    .filter((row) => row.status === '有效')
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** 由有效读数全量派生趋势结论 */
export function deriveTrend(readings: VersionedReading[]): DerivedTrend {
  const rows = activeReadings(readings)
  const points: TrendPoint[] = rows.map((row, index) => {
    const prev = index > 0 ? rows[index - 1] : null
    const days = prev
      ? (new Date(row.date).getTime() - new Date(prev.date).getTime()) / 86400000
      : 0
    const declinePerDay = prev ? gravityDeclinePerDay(prev.gravity, row.gravity, days) : 0
    return {
      date: row.date,
      gravity: row.gravity,
      tempC: row.tempC,
      brix: row.brix,
      declinePerDay,
      overTemp: isOverTemp(row.tempC),
      stuck: false
    }
  })

  // 停滞：某日与前一日的比重日下降速率都为正且低于阈值，则这两日都落在停滞窗口
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]
    const curr = points[i]
    if (
      prev.declinePerDay > 0 &&
      curr.declinePerDay > 0 &&
      prev.declinePerDay < STUCK_DECLINE_THRESHOLD &&
      curr.declinePerDay < STUCK_DECLINE_THRESHOLD
    ) {
      prev.stuck = true
      curr.stuck = true
    }
  }

  const dates = points.map((point) => point.date)
  const stuckDates = points.filter((point) => point.stuck).map((point) => point.date)
  const overTempDates = points.filter((point) => point.overTemp).map((point) => point.date)
  const latest = points[points.length - 1]
  const latestGravity = latest ? latest.gravity : 0

  const reasons: string[] = []
  if (rows.length < RACKABLE_MIN_READINGS) {
    reasons.push(`有效读数不足 ${RACKABLE_MIN_READINGS} 条`)
  }
  if (latest && latestGravity > RACKABLE_GRAVITY_MAX) {
    reasons.push(`最新比重 ${latestGravity} 高于 ${RACKABLE_GRAVITY_MAX}，发酵未到后段`)
  }
  if (latest && latest.stuck) {
    reasons.push('最近两次读数显示疑似停滞')
  }
  if (latest && points.slice(-RACKABLE_RECENT_DAYS).some((point) => point.overTemp)) {
    reasons.push(`最近 ${RACKABLE_RECENT_DAYS} 条读数仍有超温（>${OVER_TEMP_C}℃）`)
  }

  return {
    points,
    dates,
    stuckDates,
    overTempDates,
    latestGravity,
    rackable: reasons.length === 0,
    rackableReasons: reasons
  }
}

/**
 * 受影响日期集合：从变更日（含）起的所有有效读数日期。
 * 改动 / 撤回会改变变更日的下降速率以及之后每日的派生结论。
 */
export function affectedDates(readings: VersionedReading[], changedDate: string): string[] {
  return activeReadings(readings)
    .filter((row) => row.date >= changedDate)
    .map((row) => row.date)
}
