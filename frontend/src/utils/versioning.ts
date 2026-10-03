/**
 * 版本链：把读数、批次趋势与倒罐工单接成可追溯的整体。
 * - 每个批次一个数据版本号（batchVersions），读数 / 工单每次变更 +1
 * - 每次变更追加审计日志（changeLogs），跨窗口冲突时按版本号差列出明细
 * - 保存携带 baseVersion（本窗口基准版本），事务内比对，不一致即拒绝（乐观锁）
 * - 读数改动 / 撤回后从受影响日期起重算停滞、超温与可转罐结论，失效待办退回「待复核」
 */
import { db, ROW_REVISION, type OperationRow, type ReadingRow } from './db'
import { analyzeReadings } from './trend'
import { createId } from './uuid'
import { PENDING_OPERATION_STATES, type Operation } from '../types/operation'
import { CHANGE_ACTION_LABELS, type ChangeAction, type ChangeLog } from '../types/changeLog'
import type { RecalcResult, VersionConflict } from '../types/transfer'

/* ------------------------------ 基础原语 ------------------------------ */

/** 读取批次当前数据版本（无记录视为 0） */
export async function getBatchVersion(batchId: string): Promise<number> {
  const row = await db.batchVersions.get(batchId)
  return row?.version ?? 0
}

/** 读取全部批次版本（窗口加载时快照基准版本用） */
export async function listBatchVersions(): Promise<Record<string, number>> {
  const rows = await db.batchVersions.toArray()
  const map: Record<string, number> = {}
  rows.forEach((row) => {
    map[row.batchId] = row.version
  })
  return map
}

/** 事务内：批次版本 +1 并返回新版本号 */
export async function bumpBatchVersion(batchId: string): Promise<number> {
  const next = (await getBatchVersion(batchId)) + 1
  await db.batchVersions.put({ batchId, version: next, updatedAt: Date.now() })
  return next
}

/** 事务内：追加一条审计日志 */
export async function appendChangeLog(entry: Omit<ChangeLog, 'id' | 'at'>): Promise<void> {
  const now = Date.now()
  await db.changeLogs.put({
    ...entry,
    id: createId('log'),
    at: now,
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  })
}

/** 工单的可读描述（日志与冲突列表共用） */
export function operationLabel(op: Pick<Operation, 'type' | 'date' | 'operator'>): string {
  return `${op.type} · ${op.date} · ${op.operator || '未指派'}`
}

/* ------------------------------ 版本冲突 ------------------------------ */

/** 跨窗口保存冲突：本窗口基于旧版本，保存被拒绝 */
export class VersionConflictError extends Error {
  readonly conflict: VersionConflict

  constructor(conflict: VersionConflict) {
    super(`批次数据已被其它窗口更新（v${conflict.baseVersion} → v${conflict.currentVersion}），本次保存被拒绝`)
    this.name = 'VersionConflictError'
    this.conflict = conflict
  }
}

export function isVersionConflict(error: unknown): error is VersionConflictError {
  return error instanceof VersionConflictError
}

/** 汇总 baseVersion 之后发生的变更，作为冲突明细 */
async function collectConflict(batchId: string, baseVersion: number): Promise<VersionConflict> {
  const currentVersion = await getBatchVersion(batchId)
  const logs = await db.changeLogs
    .where('batchId')
    .equals(batchId)
    .filter((log) => log.batchVersion > baseVersion)
    .toArray()
  const readingDates = [...new Set(logs.filter((log) => log.entity === 'reading').map((log) => log.date))].sort()
  const operations = logs
    .filter((log) => log.entity === 'operation')
    .map((log) => ({ id: log.entityId, date: log.date, label: log.label, action: CHANGE_ACTION_LABELS[log.action] }))
  return { batchId, baseVersion, currentVersion, readingDates, operations }
}

/** 事务内：断言本窗口基于最新版本，否则抛 VersionConflictError */
export async function assertLatestVersion(batchId: string, baseVersion: number): Promise<void> {
  const current = await getBatchVersion(batchId)
  if (current !== baseVersion) {
    throw new VersionConflictError(await collectConflict(batchId, baseVersion))
  }
}

/* ------------------------------ 趋势重算与工单退回 ------------------------------ */

function recalcDetail(recalc: RecalcResult): string {
  const parts = [
    recalc.stuck ? '疑似停滞' : '发酵正常',
    `超温 ${recalc.overTempDays} 天`,
    recalc.transferable ? '可转罐' : '暂不可转罐'
  ]
  if (recalc.invalidated.length > 0) parts.push(`退回 ${recalc.invalidated.length} 条工单复核`)
  return parts.join('；')
}

/**
 * 事务内：从受影响日期起重算批次趋势（停滞 / 超温 / 可转罐），
 * 把失效的待办工单（计划 / 排队中）退回「待复核」并逐条记日志。
 */
export async function recalcBatchFromDate(
  batchId: string,
  fromDate: string,
  batchVersion: number
): Promise<RecalcResult> {
  const readings = await db.readings.where('batchId').equals(batchId).sortBy('date')
  const summary = analyzeReadings(readings)
  const operations = await db.operations.where('batchId').equals(batchId).toArray()
  const now = Date.now()
  const invalidated: RecalcResult['invalidated'] = []

  for (const op of operations) {
    if (!PENDING_OPERATION_STATES.includes(op.state)) continue
    const affected = op.date >= fromDate
    const transferBroken = op.type === '倒罐' && !summary.transferable
    if (!affected && !transferBroken) continue
    const reason =
      transferBroken && !affected
        ? `读数自 ${fromDate} 起变更，重算后不再满足可转罐条件，待复核`
        : `读数自 ${fromDate} 起变更，趋势结论已重算，待复核`
    await db.operations.update(op.id, {
      state: '待复核',
      invalidReason: reason,
      version: op.version + 1,
      updatedAt: now
    } as never)
    invalidated.push({ id: op.id, date: op.date, type: op.type, reason })
    await appendChangeLog({
      batchId,
      entity: 'operation',
      entityId: op.id,
      action: 'invalidate',
      date: op.date,
      label: operationLabel(op),
      detail: reason,
      batchVersion
    })
  }

  return {
    batchId,
    fromDate,
    stuck: summary.stuck,
    overTempDays: summary.overTempDays,
    transferable: summary.transferable,
    invalidated
  }
}

/* ------------------------------ 读数保存 / 撤回 ------------------------------ */

export interface SaveReadingInput {
  batchId: string
  date: string
  gravity: number
  tempC: number
  brix: number
  /** 本窗口加载数据时的批次版本 */
  baseVersion: number
  /** 编辑已有读数时传其 id；新增时为空 */
  editingId?: string | null
}

export interface SaveReadingResult {
  id: string
  /** 变更后的批次数据版本 */
  version: number
  recalc: RecalcResult
}

const READING_TABLES = [db.readings, db.operations, db.changeLogs, db.batchVersions]

/**
 * 保存读数（新增 / 编辑）：同批次同日唯一（同日落为更新），
 * 版本校验通过后从该日期起重算趋势并退回失效工单。
 */
export async function saveReadingVersioned(input: SaveReadingInput): Promise<SaveReadingResult> {
  return db.transaction('rw', READING_TABLES, async () => {
    await assertLatestVersion(input.batchId, input.baseVersion)
    const now = Date.now()
    const sameDay = (await db.readings
      .where('[batchId+date]')
      .equals([input.batchId, input.date])
      .first()) as ReadingRow | undefined
    if (input.editingId && sameDay && sameDay.id !== input.editingId) {
      throw new Error(`该批次 ${input.date} 已有读数，请直接编辑当日记录`)
    }
    // 唯一性：同批次同日合并为一行（补录历史读数时同日覆盖）
    const targetId = input.editingId ?? sameDay?.id ?? createId('reading')
    const prev = (await db.readings.get(targetId)) as ReadingRow | undefined
    const action: ChangeAction = prev ? 'update' : 'create'
    await db.readings.put({
      id: targetId,
      batchId: input.batchId,
      date: input.date,
      gravity: input.gravity,
      tempC: input.tempC,
      brix: input.brix,
      version: (prev?.version ?? 0) + 1,
      revision: ROW_REVISION,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    })
    const version = await bumpBatchVersion(input.batchId)
    await appendChangeLog({
      batchId: input.batchId,
      entity: 'reading',
      entityId: targetId,
      action,
      date: input.date,
      label: `读数 · ${input.date}`,
      detail: `比重 ${input.gravity} · ${input.tempC}℃ · ${input.brix}°Bx`,
      batchVersion: version
    })
    const recalc = await recalcBatchFromDate(input.batchId, input.date, version)
    await appendChangeLog({
      batchId: input.batchId,
      entity: 'batch',
      entityId: input.batchId,
      action: 'recalc',
      date: input.date,
      label: '趋势重算',
      detail: recalcDetail(recalc),
      batchVersion: version
    })
    return { id: targetId, version, recalc }
  })
}

/** 撤回读数：从被撤回日期起重算趋势并退回失效工单 */
export async function withdrawReadingVersioned(input: {
  id: string
  batchId: string
  baseVersion: number
}): Promise<SaveReadingResult> {
  return db.transaction('rw', READING_TABLES, async () => {
    await assertLatestVersion(input.batchId, input.baseVersion)
    const row = (await db.readings.get(input.id)) as ReadingRow | undefined
    if (!row) throw new Error('读数不存在或已被撤回')
    await db.readings.delete(input.id)
    const version = await bumpBatchVersion(input.batchId)
    await appendChangeLog({
      batchId: input.batchId,
      entity: 'reading',
      entityId: input.id,
      action: 'withdraw',
      date: row.date,
      label: `读数 · ${row.date}`,
      detail: `撤回比重 ${row.gravity} · ${row.tempC}℃ 的读数`,
      batchVersion: version
    })
    const recalc = await recalcBatchFromDate(input.batchId, row.date, version)
    await appendChangeLog({
      batchId: input.batchId,
      entity: 'batch',
      entityId: input.batchId,
      action: 'recalc',
      date: row.date,
      label: '趋势重算',
      detail: recalcDetail(recalc),
      batchVersion: version
    })
    return { id: input.id, version, recalc }
  })
}

/* ------------------------------ 工单删除 / 调序 ------------------------------ */

/** 删除工单（版本校验 + 日志） */
export async function deleteOperationVersioned(id: string, baseVersion: number): Promise<number> {
  return db.transaction('rw', [db.operations, db.changeLogs, db.batchVersions], async () => {
    const op = (await db.operations.get(id)) as OperationRow | undefined
    if (!op) throw new Error('作业不存在或已被删除')
    await assertLatestVersion(op.batchId, baseVersion)
    await db.operations.delete(id)
    const version = await bumpBatchVersion(op.batchId)
    await appendChangeLog({
      batchId: op.batchId,
      entity: 'operation',
      entityId: id,
      action: 'withdraw',
      date: op.date,
      label: operationLabel(op),
      detail: '撤回该作业安排',
      batchVersion: version
    })
    return version
  })
}

/**
 * 拖拽调序：不写死版本校验（连续拖拽体验优先），
 * 但每个涉及批次都 bump 版本并记日志 —— 其它窗口随后的表单保存会被判冲突。
 */
export async function reorderOperationsVersioned(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', [db.operations, db.changeLogs, db.batchVersions], async () => {
    const bumped = new Map<string, number>()
    for (let index = 0; index < orderedIds.length; index += 1) {
      const op = (await db.operations.get(orderedIds[index])) as OperationRow | undefined
      if (!op || op.seq === index + 1) continue
      await db.operations.update(op.id, { seq: index + 1, version: op.version + 1, updatedAt: Date.now() } as never)
      let version = bumped.get(op.batchId)
      if (version === undefined) {
        version = await bumpBatchVersion(op.batchId)
        bumped.set(op.batchId, version)
      }
      await appendChangeLog({
        batchId: op.batchId,
        entity: 'operation',
        entityId: op.id,
        action: 'reorder',
        date: op.date,
        label: operationLabel(op),
        detail: `顺序调整为 #${index + 1}`,
        batchVersion: version
      })
    }
  })
}
