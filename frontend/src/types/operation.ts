/** 作业类型 */
export type OperationType = '倒罐' | '压帽' | '淋皮'
/**
 * 作业状态：
 * - 计划：已确认可执行（倒罐工单要求容量校验通过）
 * - 已完成：已完成，倒罐完成后容量持续占用
 * - 排队：倒罐目标罐剩余容量不足，等待容量释放
 * - 待复核：其依据的批次读数 / 趋势已被改动或撤回，结论失效，退回人工复核
 */
export type OperationState = '计划' | '已完成' | '排队' | '待复核'

/** 车间作业：倒罐 / 压帽 / 淋皮 */
export interface Operation {
  id: string
  /** 所属批次（倒罐时为源罐所在批次） */
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
  /* ---------------------------- 倒罐工单字段 ---------------------------- */
  /** 目标罐 id（仅倒罐） */
  targetTankId: string
  /** 本次倒罐液量 L（仅倒罐，不超过源罐批次在罐液量） */
  transferVolumeL: number
  /** 排队时距目标罐剩余容量还差多少 L（仅排队状态） */
  shortfallL: number
  /**
   * 排单所依据的批次读数版本（乐观锁）。
   * 两个窗口同时保存时，若批次 readingVersion 已大于该值，则本单依据过期，拒绝保存。
   */
  basisVersion: number
  /** 依据被改动的具体日期（待复核时展示冲突日期） */
  staleDates: string[]
  /** 复核备注 */
  reviewNote: string
}

export const OPERATION_TYPES: OperationType[] = ['倒罐', '压帽', '淋皮']
/** 支持的全部状态（含排队 / 待复核） */
export const OPERATION_STATES: OperationState[] = ['计划', '已完成', '排队', '待复核']
/** 倒罐工单才有的状态 */
export const RACKING_STATES: OperationState[] = ['排队', '待复核']
/** 未完成、仍可执行或等待执行的状态 */
export const PENDING_STATES: OperationState[] = ['计划', '排队', '待复核']

export function isRackingOperation(op: Pick<Operation, 'type'>): boolean {
  return op.type === '倒罐'
}

export function createEmptyOperation(): Omit<Operation, 'id' | 'seq'> {
  return {
    batchId: '',
    type: '倒罐',
    date: new Date().toISOString().slice(0, 10),
    durationMin: 45,
    operator: '',
    state: '计划',
    targetTankId: '',
    transferVolumeL: 0,
    shortfallL: 0,
    basisVersion: 0,
    staleDates: [],
    reviewNote: ''
  }
}
