/**
 * 可追溯版本相关模型：
 * - TrendPoint / TrendSnapshot：批次趋势重算结果（停滞、超温、可转罐）
 * - AuditLog：读数 / 工单的版本变更流水，用于「可追溯」
 */

/** 趋势派生结论类型 */
export type TrendFlag = '停滞' | '超温' | '可转罐'

/** 单个日期的趋势点（由有效读数重算得出） */
export interface TrendPoint {
  date: string
  gravity: number
  tempC: number
  brix: number
  /** 相对上一条有效读数的比重日下降速率 */
  declinePerDay: number
  /** 当日超温 */
  overTemp: boolean
  /** 当日处于停滞窗口 */
  stuck: boolean
}

/** 批次趋势快照：某次读数版本下重算得到的完整结论 */
export interface TrendSnapshot {
  id: string
  batchId: string
  /** 生成该快照时的批次读数版本 */
  readingVersion: number
  /** 参与计算的有效读数日期（升序） */
  dates: string[]
  points: TrendPoint[]
  /** 停滞日期（窗口内每日都标） */
  stuckDates: string[]
  /** 超温日期 */
  overTempDates: string[]
  /** 当前是否可转罐 */
  rackable: boolean
  /** 不可转罐原因（rackable=false 时） */
  rackableReasons: string[]
  /** 最新比重 */
  latestGravity: number
}

/** 审计动作 */
export type AuditAction =
  | '读数新增'
  | '读数改动'
  | '读数撤回'
  | '工单保存'
  | '工单失效'
  | '工单复核'
  | '工单完成'
  | '工单删除'
  | '容量排队'
  | '容量放行'

/** 版本变更流水 */
export interface AuditLog {
  id: string
  /** 关联批次 */
  batchId: string
  /** 变更后（或变更涉及）的读数版本；与读数无关时记当前版本 */
  readingVersion: number
  action: AuditAction
  /** 涉及的读数日期列表 */
  dates: string[]
  /** 涉及的作业 / 工单 id 列表 */
  operationIds: string[]
  /** 人类可读说明 */
  message: string
  /** 变更前快照（JSON 字符串，便于追溯） */
  beforeJson: string
  /** 变更后快照（JSON 字符串） */
  afterJson: string
  createdAt: number
}

/** 冲突详情：另一窗口已经把读数推进到新版本 */
export interface ReadingConflictDetail {
  kind: 'reading'
  batchId: string
  /** 保存方携带的版本 */
  expectedVersion: number
  /** 库里最新版本 */
  currentVersion: number
  /** 自 expectedVersion 起被改动 / 撤回的日期 */
  changedDates: string[]
  /** 依据已失效的倒罐工单行（用于提示） */
  affectedOperations: Array<{ id: string; date: string; targetTankId: string }>
}

/** 冲突详情：另一窗口已经保存了同一张工单的新版本 */
export interface OperationConflictDetail {
  kind: 'operation'
  operationId: string
  expectedVersion: number
  currentVersion: number
  /** 工单计划日期 */
  date: string
  targetTankId: string
}

export type ConflictDetail = ReadingConflictDetail | OperationConflictDetail
