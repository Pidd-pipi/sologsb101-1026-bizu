/**
 * 变更日志：把读数、批次趋势与倒罐工单接成可追溯版本链。
 * 每次读数保存 / 撤回、趋势重算、工单退回 / 复核 / 排队 / 完成都会追加一条日志，
 * 并带上变更后的批次数据版本号（batchVersion），供跨窗口冲突检测列出明细。
 */

/** 日志作用的实体 */
export type ChangeEntity = 'reading' | 'operation' | 'batch'

/** 变更动作 */
export type ChangeAction =
  | 'init' // 初始录入（播种）
  | 'create' // 新增
  | 'update' // 修改
  | 'withdraw' // 撤回（读数删除）
  | 'recalc' // 趋势重算
  | 'invalidate' // 工单退回复核
  | 'review' // 工单复核恢复
  | 'queue' // 容量不足转入排队
  | 'dequeue' // 容量释放后恢复计划
  | 'complete' // 作业完成
  | 'reorder' // 作业调序

/** 变更日志行 */
export interface ChangeLog {
  id: string
  /** 所属批次 */
  batchId: string
  /** 作用的实体类型 */
  entity: ChangeEntity
  /** 实体 id（读数 / 工单 / 批次） */
  entityId: string
  /** 变更动作 */
  action: ChangeAction
  /** 业务日期（读数日期 / 工单日期），用于冲突时列出受影响日期 */
  date: string
  /** 可读描述，如「倒罐 · 2024-09-26 · 林沐」 */
  label: string
  /** 补充细节（退回原因、重算结论等） */
  detail: string
  /** 本次变更后的批次数据版本号 */
  batchVersion: number
  /** 变更发生时间戳（ms） */
  at: number
}

/** 批次数据版本：读数或工单每变更一次 +1，跨窗口乐观锁的基准 */
export interface BatchVersion {
  batchId: string
  version: number
  updatedAt: number
}

export const CHANGE_ACTION_LABELS: Record<ChangeAction, string> = {
  init: '初始录入',
  create: '新增',
  update: '修改',
  withdraw: '撤回',
  recalc: '趋势重算',
  invalidate: '退回复核',
  review: '复核恢复',
  queue: '转入排队',
  dequeue: '恢复计划',
  complete: '完成',
  reorder: '调序'
}
