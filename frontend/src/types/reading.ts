/** 发酵读数：逐日记录比重、温度与糖度 */
export interface Reading {
  id: string
  /** 所属批次 */
  batchId: string
  /** 记录日期 YYYY-MM-DD（同批次同日唯一） */
  date: string
  /** 比重（SG） */
  gravity: number
  /** 温度 ℃ */
  tempC: number
  /** 糖度 °Bx */
  brix: number
}

/**
 * 读数生命周期状态：
 * - 有效：参与趋势重算
 * - 已撤回：软删除，保留行与版本历史，不再参与趋势
 */
export type ReadingStatus = '有效' | '已撤回'

/**
 * 可追溯读数。
 * version 为「批次 + 日期」维度的行版本号：每次改动 / 撤回 +1，
 * 另一窗口基于旧 version 保存时按并发冲突拒绝（乐观锁）。
 */
export interface VersionedReading extends Reading {
  /** 行版本号，从 1 开始 */
  version: number
  /** 生命周期状态 */
  status: ReadingStatus
  /** 撤回原因（status === '已撤回' 时填写） */
  withdrawReason: string
}

/** 趋势点：在读数基础上派生下降速率与超温标记 */
export interface ReadingPoint extends VersionedReading {
  /** 相对上一条有效读数的比重日下降速率 */
  declinePerDay: number
  /** 是否超温（> 30 ℃） */
  overTemp: boolean
  /** 当日是否疑似停滞（本日与前一日下降速率均低于阈值） */
  stuck: boolean
}

/** 超温阈值 ℃ */
export const OVER_TEMP_C = 30
/** 发酵停滞判定：连续 2 日比重下降 < 0.002 视为停滞 */
export const STUCK_DECLINE_THRESHOLD = 0.002

/** 可转罐：最新比重不高于该阈值（后发酵及以后） */
export const RACKABLE_GRAVITY_MAX = 1.02
/** 可转罐要求近期超温读数已经解除：最近 N 天内无超温 */
export const RACKABLE_RECENT_DAYS = 2
/** 可转罐要求至少有 N 条有效读数 */
export const RACKABLE_MIN_READINGS = 2

export function createEmptyReading(): Omit<Reading, 'id'> {
  return { batchId: '', date: new Date().toISOString().slice(0, 10), gravity: 1.09, tempC: 24, brix: 22 }
}
