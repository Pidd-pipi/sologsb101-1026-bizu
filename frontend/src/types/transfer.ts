/**
 * 倒罐容量与跨窗口版本冲突的共享类型
 * 供 utils/transfer.ts、utils/versioning.ts 与页面 / store 消费。
 */

/** 目标罐容量状况 */
export interface TankCapacity {
  tankId: string
  /** 罐标称容量（L） */
  capacityL: number
  /** 已被在罐批次占用的液量（L）：含已完成倒罐改绑进来的批次 */
  usedL: number
  /** 剩余可用容量（L） */
  remainingL: number
}

/** 可转罐结论：趋势维度（发酵到位且未停滞）+ 容量维度 */
export interface TransferVerdict {
  /** 趋势是否允许转罐（后发酵起且未停滞） */
  trendOk: boolean
  /** 目标罐剩余容量是否装得下源罐液量 */
  capacityOk: boolean
  /** 还差多少升（容量不足时 > 0） */
  shortfallL: number
  /** 综合结论 */
  ok: boolean
  /** 人读原因列表 */
  reasons: string[]
}

/** 跨窗口保存冲突：本窗口基于旧版本，拒绝保存时抛出 */
export interface VersionConflict {
  batchId: string
  /** 本窗口基于的版本 */
  baseVersion: number
  /** 当前最新版本 */
  currentVersion: number
  /** 期间被改动的读数日期（升序去重） */
  readingDates: string[]
  /** 期间被改动的工单 */
  operations: Array<{ id: string; date: string; label: string; action: string }>
}

/** 读数变更后的趋势重算结果 */
export interface RecalcResult {
  batchId: string
  /** 受影响起始日期（从该日期起重算） */
  fromDate: string
  /** 重算后是否疑似停滞 */
  stuck: boolean
  /** 重算后超温天数 */
  overTempDays: number
  /** 重算后趋势维度是否可转罐 */
  transferable: boolean
  /** 被退回「待复核」的工单 */
  invalidated: Array<{ id: string; date: string; type: string; reason: string }>
}
