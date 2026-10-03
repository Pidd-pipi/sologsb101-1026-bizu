/** 作业类型 */
export type OperationType = '倒罐' | '压帽' | '淋皮'
/**
 * 作业状态：
 * - 计划：已排定且容量 / 趋势校验通过
 * - 排队中：倒罐目标罐剩余容量不足，等待容量释放
 * - 待复核：读数变更导致趋势结论重算后失效，需人工确认
 * - 已完成：已执行（倒罐完成即把批次改绑到目标罐，占住容量）
 */
export type OperationState = '计划' | '排队中' | '待复核' | '已完成'

/** 车间作业：倒罐 / 压帽 / 淋皮 */
export interface Operation {
  id: string
  /** 所属批次 */
  batchId: string
  /** 作业类型 */
  type: OperationType
  /** 计划日期 YYYY-MM-DD */
  date: string
  /** 时长（分钟） */
  durationMin: number
  /** 操作人 */
  operator: string
  /** 作业状态 */
  state: OperationState
  /** 拖拽调序后的先后次序（从 1 开始） */
  seq: number
  /** 倒罐目标罐 id（仅倒罐必填，其它类型为空串） */
  targetTankId: string
  /** 退回复核的原因（读数变更触发重算时写入；复核恢复后清空） */
  invalidReason: string | null
}

export const OPERATION_TYPES: OperationType[] = ['倒罐', '压帽', '淋皮']
export const OPERATION_STATES: OperationState[] = ['计划', '排队中', '待复核', '已完成']

/** 会被读数变更退回「待复核」的待办状态 */
export const PENDING_OPERATION_STATES: OperationState[] = ['计划', '排队中']

export function createEmptyOperation(): Omit<Operation, 'id' | 'seq'> {
  return {
    batchId: '',
    type: '倒罐',
    date: new Date().toISOString().slice(0, 10),
    durationMin: 45,
    operator: '',
    state: '计划',
    targetTankId: '',
    invalidReason: null
  }
}
