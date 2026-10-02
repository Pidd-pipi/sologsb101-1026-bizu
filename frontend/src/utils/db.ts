/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbwinetank-db
 * - version(1)：初版七张表
 * - version(2)：读数按 (批次,日期) 版本化、批次带 readingVersion、作业扩展为倒罐工单
 *   （目标罐 / 倒罐液量 / 排队 / 待复核 / 依据版本），新增 trends 与 auditlogs 两张表
 * - 地块 / 发酵罐 / 入罐批次 / 发酵读数 / 作业 / 苹乳 / 品评 七张主表分表存储
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 * - 纯前端应用：不依赖任何后端或数据库服务；IndexedDB 事务天然跨窗口串行
 */
import Dexie, { type Table } from 'dexie'
import type { Parcel } from '../types/parcel'
import type { Tank } from '../types/tank'
import type { Batch } from '../types/batch'
import type { ReadingStatus, VersionedReading } from '../types/reading'
import type { Operation } from '../types/operation'
import type { Mlf } from '../types/mlf'
import type { Tasting } from '../types/tasting'
import type { AuditLog, TrendSnapshot } from '../types/versioning'
import { nowIso } from './uuid'
import { seedDatabase } from './seed'
import { deriveTrend } from './trend'
import { computeTankCapacities } from './capacity'
import { VersionConflictError } from './conflict'

/** 数据库名 */
export const DB_NAME = 'gbwinetank-db'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2

/** 行结构修订号，便于后续按行迁移 */
export const ROW_REVISION = 2

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number
  createdAt: number
  updatedAt: number
}

export type ParcelRow = Parcel & Revisioned
export type TankRow = Tank & Revisioned
export type BatchRow = Batch & Revisioned
export type ReadingRow = VersionedReading & Revisioned
export type OperationRow = Operation & Revisioned
export type MlfRow = Mlf & Revisioned
export type TastingRow = Tasting & Revisioned
export type TrendRow = TrendSnapshot & Revisioned
export type AuditRow = AuditLog & Revisioned

class GbWineTankDatabase extends Dexie {
  parcels!: Table<ParcelRow, string>
  tanks!: Table<TankRow, string>
  batches!: Table<BatchRow, string>
  readings!: Table<ReadingRow, string>
  operations!: Table<OperationRow, string>
  mlfs!: Table<MlfRow, string>
  tastings!: Table<TastingRow, string>
  trends!: Table<TrendRow, string>
  auditlogs!: Table<AuditRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1).stores({
      parcels: 'id, name, variety, aspect, updatedAt',
      tanks: 'id, code, material, tempControl, state, updatedAt',
      batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
      readings: 'id, batchId, date, updatedAt',
      operations: 'id, batchId, type, state, date, seq, updatedAt',
      mlfs: 'id, batchId, state, updatedAt',
      tastings: 'id, batchId, date, verdict, updatedAt'
    })

    this.version(2)
      .stores({
        parcels: 'id, name, variety, aspect, updatedAt',
        tanks: 'id, code, material, tempControl, state, updatedAt',
        batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
        // [batchId+date] 为业务唯一键：读数按批次和日期唯一（软撤回保留行，仍占唯一键）
        readings: 'id, [batchId+date], batchId, date, status, version, updatedAt',
        operations:
          'id, batchId, type, state, date, seq, targetTankId, basisVersion, updatedAt',
        mlfs: 'id, batchId, state, updatedAt',
        tastings: 'id, batchId, date, verdict, updatedAt',
        trends: 'id, batchId, readingVersion, updatedAt',
        auditlogs: 'id, batchId, action, createdAt'
      })
      .upgrade(async (tx) => {
        const now = Date.now()

        // 批次：初始读数版本 0
        await tx
          .table<BatchRow, string>('batches')
          .toCollection()
          .modify((row) => {
            if (typeof row.readingVersion !== 'number') row.readingVersion = 0
            row.updatedAt = row.updatedAt ?? now
          })

        // 读数：补版本字段，全部置为「有效」v1；batchId+date 在旧库中天然不重复
        await tx
          .table<ReadingRow, string>('readings')
          .toCollection()
          .modify((row) => {
            if (typeof row.version !== 'number') row.version = 1
            if (row.status !== '已撤回') row.status = '有效'
            if (typeof row.withdrawReason !== 'string') row.withdrawReason = ''
          })

        // 作业：旧倒罐单扩展为工单字段（已完成单默认从源罐转往自身罐并保留容量）
        const batchRows = await tx.table<BatchRow, string>('batches').toArray()
        const batchById = new Map(batchRows.map((row) => [row.id, row]))
        await tx
          .table<OperationRow, string>('operations')
          .toCollection()
          .modify((row) => {
            if (typeof row.targetTankId !== 'string') {
              row.targetTankId = row.type === '倒罐' ? batchById.get(row.batchId)?.tankId ?? '' : ''
            }
            if (typeof row.transferVolumeL !== 'number') {
              row.transferVolumeL =
                row.type === '倒罐' ? batchById.get(row.batchId)?.volumeL ?? 0 : 0
            }
            if (typeof row.shortfallL !== 'number') row.shortfallL = 0
            if (typeof row.basisVersion !== 'number') row.basisVersion = 0
            if (!Array.isArray(row.staleDates)) row.staleDates = []
            if (typeof row.reviewNote !== 'string') row.reviewNote = ''
            // 旧库的「计划」倒罐单与新读数版本无关，统一退回复核，避免旧趋势结论继续有效
            if (row.type === '倒罐' && row.state === '计划') {
              row.state = '待复核'
              row.reviewNote = '读数版本升级，请复核后重新排单'
            }
          })

        // 回填每个批次的趋势快照（基于升级后的有效读数，版本取该批次最大读数版本）
        const readingRows = await tx.table<ReadingRow, string>('readings').toArray()
        const byBatch = new Map<string, ReadingRow[]>()
        for (const row of readingRows) {
          const list = byBatch.get(row.batchId) ?? []
          list.push(row)
          byBatch.set(row.batchId, list)
        }
        const trendTable = tx.table<TrendRow, string>('trends')
        for (const [batchId, list] of byBatch) {
          const derived = deriveTrend(list)
          const version = list.reduce((max, row) => Math.max(max, row.version), 1)
          await trendTable.put({
            id: `trend-${batchId}`,
            batchId,
            readingVersion: version,
            dates: derived.dates,
            points: derived.points,
            stuckDates: derived.stuckDates,
            overTempDates: derived.overTempDates,
            rackable: derived.rackable,
            rackableReasons: derived.rackableReasons,
            latestGravity: derived.latestGravity,
            revision: ROW_REVISION,
            createdAt: now,
            updatedAt: now
          })
        }
      })
  }
}

export const db = new GbWineTankDatabase()

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.parcels.count()) === 0) {
    await seedDatabase()
  }
}

/* ------------------------------ 地块 ------------------------------ */

export async function listParcels(): Promise<ParcelRow[]> {
  const rows = await db.parcels.toArray()
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function putParcel(row: ParcelRow): Promise<void> {
  await db.parcels.put(row)
}

export async function updateParcel(id: string, patch: Partial<Parcel>): Promise<void> {
  await db.parcels.update(id, { ...patch, updatedAt: Date.now() } as never)
}

/** 删除地块：级联删除其下批次及批次的读数/作业/苹乳/品评，并释放占用的罐位 */
export async function removeParcel(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.tanks, db.trends, db.auditlogs],
    async () => {
      const batches = await db.batches.where('parcelId').equals(id).toArray()
      for (const batch of batches) {
        await cascadeRemoveBatch(batch.id)
      }
      await db.parcels.delete(id)
    }
  )
}

/* ------------------------------ 发酵罐 ------------------------------ */

export async function listTanks(): Promise<TankRow[]> {
  const rows = await db.tanks.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function putTank(row: TankRow): Promise<void> {
  await db.tanks.put(row)
}

export async function updateTank(id: string, patch: Partial<Tank>): Promise<void> {
  await db.transaction('rw', [db.tanks, db.operations, db.auditlogs, db.batches], async () => {
    await db.tanks.update(id, { ...patch, updatedAt: Date.now() } as never)
    // 罐容量 / 状态变化会影响倒罐排队结果，重排一次
    await reevaluateQueue(undefined)
  })
}

export async function removeTank(id: string): Promise<void> {
  const active = await db.batches.where('tankId').equals(id).filter((b) => b.state !== '已出罐').count()
  if (active > 0) {
    throw new Error('该罐仍有在罐批次，请先出罐或改绑其它罐位')
  }
  await db.transaction('rw', db.tanks, db.batches, async () => {
    await db.batches.where('tankId').equals(id).modify({ tankId: '', updatedAt: Date.now() })
    await db.tanks.delete(id)
  })
}

/* ------------------------------ 入罐批次 ------------------------------ */

export async function listBatches(): Promise<BatchRow[]> {
  const rows = await db.batches.toArray()
  return rows.sort((a, b) => b.harvestDate.localeCompare(a.harvestDate))
}

export async function putBatch(row: BatchRow): Promise<void> {
  await db.batches.put(row)
}

export async function updateBatch(id: string, patch: Partial<Batch>): Promise<void> {
  await db.batches.update(id, { ...patch, updatedAt: Date.now() } as never)
}

/** 内部级联删除：清掉批次下属全部子表数据 */
async function cascadeRemoveBatch(batchId: string): Promise<void> {
  await db.readings.where('batchId').equals(batchId).delete()
  await db.operations.where('batchId').equals(batchId).delete()
  await db.mlfs.where('batchId').equals(batchId).delete()
  await db.tastings.where('batchId').equals(batchId).delete()
  await db.trends.where('batchId').equals(batchId).delete()
  await db.auditlogs.where('batchId').equals(batchId).delete()
  const batch = await db.batches.get(batchId)
  if (batch && batch.tankId) {
    await db.tanks.update(batch.tankId, { state: '空闲', updatedAt: Date.now() } as never)
  }
  await db.batches.delete(batchId)
}

export async function removeBatch(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.tanks, db.trends, db.auditlogs],
    async () => {
      await cascadeRemoveBatch(id)
      // 批次删除可能释放目标罐容量，重算剩余排队工单
      await reevaluateQueue(undefined)
    }
  )
}

/** 出罐：批次置为已出罐并自动释放罐位 */
export async function shipBatch(id: string): Promise<void> {
  await db.transaction('rw', db.batches, db.tanks, db.operations, db.auditlogs, async () => {
    const batch = await db.batches.get(id)
    if (!batch) throw new Error('批次不存在')
    if (batch.tankId) {
      await db.tanks.update(batch.tankId, { state: '空闲', updatedAt: Date.now() } as never)
    }
    await db.batches.update(id, { state: '已出罐', updatedAt: Date.now() } as never)
    // 出罐释放罐位，排队倒罐单可能获得容量放行
    await reevaluateQueue(undefined)
  })
}

/** 校验罐位是否可以分配给指定批次 */
export async function assertTankAssignable(tankId: string, batchId: string | null): Promise<void> {
  const tank = await db.tanks.get(tankId)
  if (!tank) throw new Error('发酵罐不存在')
  if (tank.state === '清洗中') throw new Error(`罐 ${tank.code} 正在清洗中，暂不可分配`)
  const occupants = await db.batches
    .where('tankId')
    .equals(tankId)
    .filter((b) => b.state !== '已出罐' && b.id !== batchId)
    .toArray()
  if (occupants.length > 0) {
    throw new Error(`罐 ${tank.code} 已被批次占用，禁止重复分配`)
  }
}

/* ------------------------------ 发酵读数（版本化） ------------------------------ */

export async function listReadings(): Promise<ReadingRow[]> {
  const rows = await db.readings.toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

/** 批次的全部读数（含已撤回），按日期升序 */
export async function listReadingsByBatch(batchId: string): Promise<ReadingRow[]> {
  const rows = await db.readings.where('batchId').equals(batchId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

/** 批次趋势快照与审计流水 */
export async function listTrendSnapshots(): Promise<TrendRow[]> {
  return db.trends.toArray()
}

export async function listAuditLogs(): Promise<AuditRow[]> {
  const rows = await db.auditlogs.toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

async function appendAudit(log: Omit<AuditLog, 'id' | 'createdAt'>): Promise<void> {
  const now = Date.now()
  await db.auditlogs.put({
    ...log,
    id: `audit-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  })
}

/** 写入一条审计并附带前后快照 */
async function writeAudit(
  batchId: string,
  readingVersion: number,
  action: AuditLog['action'],
  message: string,
  dates: string[] = [],
  operationIds: string[] = [],
  before: unknown = null,
  after: unknown = null
): Promise<void> {
  await appendAudit({
    batchId,
    readingVersion,
    action,
    dates,
    operationIds,
    message,
    beforeJson: JSON.stringify(before),
    afterJson: JSON.stringify(after)
  })
}

export interface ReadingChangeInput {
  /** 改动：已有行 id；新增：留空 */
  id?: string
  batchId: string
  date: string
  gravity: number
  tempC: number
  brix: number
  /** 保存方窗口所依据的批次读数版本；0 表示新增窗口的初始基线 */
  expectedVersion: number
}

/**
 * 读数新增 / 改动（乐观锁事务）。
 * - 读数按批次和日期唯一（撤回行仍占唯一键）
 * - expectedVersion 落后于库内 readingVersion 时拒绝保存并报冲突日期 / 工单
 * - 成功后从受影响日期起重算停滞、超温、可转罐，依据失效的倒罐工单退回复核
 */
export async function saveReadingChange(input: ReadingChangeInput): Promise<ReadingRow> {
  return db.transaction(
    'rw',
    [db.batches, db.readings, db.operations, db.trends, db.auditlogs, db.tanks],
    async () => {
      const batch = await db.batches.get(input.batchId)
      if (!batch) throw new Error('批次不存在')
      const now = Date.now()

      // 1) 乐观锁：另一窗口已经把读数推进到新版本 → 拒绝
      if (input.expectedVersion !== batch.readingVersion) {
        const changed = await collectChangedDates(input.batchId, input.expectedVersion)
        const staleOps = await db.operations
          .where('batchId')
          .equals(input.batchId)
          .filter((op) => op.type === '倒罐' && op.state !== '已完成')
          .toArray()
        throw new VersionConflictError(
          {
            kind: 'reading',
            batchId: input.batchId,
            expectedVersion: input.expectedVersion,
            currentVersion: batch.readingVersion,
            changedDates: changed,
            affectedOperations: staleOps.map((op) => ({
              id: op.id,
              date: op.date,
              targetTankId: op.targetTankId
            }))
          },
          '读数已被另一窗口更新，请刷新后基于最新版本重新保存'
        )
      }

      // 2) 业务唯一键：同批次同日期仅允许一条（已撤回仍占键，需先恢复或编辑该行）
      const sameDay = await db.readings
        .where('[batchId+date]')
        .equals([input.batchId, input.date])
        .first()
      if (sameDay && sameDay.id !== input.id) {
        if (sameDay.status === '已撤回') {
          throw new Error(`该批次 ${input.date} 的读数已撤回，请在撤回行上恢复后再修改`)
        }
        throw new Error(`该批次 ${input.date} 已有读数，请直接编辑已有记录`)
      }

      const existing = input.id ? await db.readings.get(input.id) : sameDay ?? undefined
      if (input.id && !existing) throw new Error('读数不存在或已被删除，请刷新后重试')
      if (existing && existing.batchId !== input.batchId) throw new Error('不能跨批次修改读数')

      // 3) 落库：版本 +1
      const nextVersion = batch.readingVersion + 1
      const before = existing ? serializeReading(existing) : null
      let row: ReadingRow
      if (existing) {
        row = {
          ...existing,
          date: input.date,
          gravity: input.gravity,
          tempC: input.tempC,
          brix: input.brix,
          status: '有效',
          withdrawReason: '',
          version: existing.version + 1,
          updatedAt: now
        }
      } else {
        row = {
          id:
            input.id ??
            `reading-${input.batchId}-${input.date}-${Math.random().toString(36).slice(2, 8)}`,
          batchId: input.batchId,
          date: input.date,
          gravity: input.gravity,
          tempC: input.tempC,
          brix: input.brix,
          status: '有效',
          withdrawReason: '',
          version: 1,
          revision: ROW_REVISION,
          createdAt: now,
          updatedAt: now
        }
      }
      await db.readings.put(row)
      await db.batches.update(input.batchId, { readingVersion: nextVersion, updatedAt: now } as never)

      // 4) 重算趋势 + 失效工单 + 排队重排
      const changedDates = await rebuildTrendAndInvalidate(input.batchId, input.date, nextVersion)

      await writeAudit(
        input.batchId,
        nextVersion,
        before ? '读数改动' : '读数新增',
        before ? `读数 ${input.date} 已改为版本 v${row.version}` : `新增 ${input.date} 读数（v1）`,
        [input.date],
        changedDates.invalidatedOperationIds,
        before,
        serializeReading(row)
      )
      return row
    }
  )
}

/** 撤回读数（软删除，版本保留并继续占用批次+日期唯一键） */
export interface ReadingWithdrawInput {
  id: string
  reason: string
  expectedVersion: number
}

export async function withdrawReading(input: ReadingWithdrawInput): Promise<void> {
  await db.transaction(
    'rw',
    [db.batches, db.readings, db.operations, db.trends, db.auditlogs, db.tanks],
    async () => {
      const row = await db.readings.get(input.id)
      if (!row) throw new Error('读数不存在或已被删除，请刷新后重试')
      const batch = await db.batches.get(row.batchId)
      if (!batch) throw new Error('批次不存在')
      if (input.expectedVersion !== batch.readingVersion) {
        const changed = await collectChangedDates(row.batchId, input.expectedVersion)
        const staleOps = await db.operations
          .where('batchId')
          .equals(row.batchId)
          .filter((op) => op.type === '倒罐' && op.state !== '已完成')
          .toArray()
        throw new VersionConflictError(
          {
            kind: 'reading',
            batchId: row.batchId,
            expectedVersion: input.expectedVersion,
            currentVersion: batch.readingVersion,
            changedDates: changed,
            affectedOperations: staleOps.map((op) => ({
              id: op.id,
              date: op.date,
              targetTankId: op.targetTankId
            }))
          },
          '读数已被另一窗口更新，请刷新后基于最新版本重新撤回'
        )
      }
      if (row.status === '已撤回') throw new Error('该读数已撤回')

      const before = serializeReading(row)
      const now = Date.now()
      const nextVersion = batch.readingVersion + 1
      await db.readings.update(row.id, {
        status: '已撤回' as ReadingStatus,
        withdrawReason: input.reason.trim() || '补录更正',
        version: row.version + 1,
        updatedAt: now
      } as never)
      await db.batches.update(row.batchId, { readingVersion: nextVersion, updatedAt: now } as never)

      const changedDates = await rebuildTrendAndInvalidate(row.batchId, row.date, nextVersion)
      await writeAudit(
        row.batchId,
        nextVersion,
        '读数撤回',
        `撤回 ${row.date} 读数：${input.reason.trim() || '补录更正'}`,
        [row.date],
        changedDates.invalidatedOperationIds,
        before,
        serializeReading(await db.readings.get(row.id))
      )
    }
  )
}

/** 恢复撤回的读数（同样走乐观锁） */
export async function restoreReading(id: string, expectedVersion: number): Promise<void> {
  const row = await db.readings.get(id)
  if (!row) throw new Error('读数不存在')
  await saveReadingChange({
    id: row.id,
    batchId: row.batchId,
    date: row.date,
    gravity: row.gravity,
    tempC: row.tempC,
    brix: row.brix,
    expectedVersion
  })
}

/** 自基线版本起被改动 / 撤回的日期（读审计流水） */
async function collectChangedDates(batchId: string, baselineVersion: number): Promise<string[]> {
  const logs = await db.auditlogs
    .where('batchId')
    .equals(batchId)
    .filter((log) => log.readingVersion > baselineVersion)
    .toArray()
  const dates = new Set<string>()
  for (const log of logs) {
    for (const date of log.dates) dates.add(date)
  }
  return [...dates].sort()
}

function serializeReading(row: ReadingRow | undefined): Omit<ReadingRow, 'revision' | 'createdAt' | 'updatedAt'> | null {
  if (!row) return null
  const { revision: _r, createdAt: _c, updatedAt: _u, ...rest } = row
  return rest
}

/**
 * 重算某批次趋势快照；把依据版本落后且日期受影响的未完成倒罐工单退回「待复核」；
 * 随后全局重排排队。返回受影响日期与失效工单。
 */
async function rebuildTrendAndInvalidate(
  batchId: string,
  changedDate: string,
  nextVersion: number
): Promise<{ affected: string[]; invalidatedOperationIds: string[] }> {
  const now = Date.now()
  const readings = await listReadingsByBatch(batchId)
  const derived = deriveTrend(readings)
  const affected = derived.dates.filter((date) => date >= changedDate)

  await db.trends.put({
    id: `trend-${batchId}`,
    batchId,
    readingVersion: nextVersion,
    dates: derived.dates,
    points: derived.points,
    stuckDates: derived.stuckDates,
    overTempDates: derived.overTempDates,
    rackable: derived.rackable,
    rackableReasons: derived.rackableReasons,
    latestGravity: derived.latestGravity,
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  })

  // 依据版本落后的未完成倒罐工单一律退回「待复核」：
  // 停滞 / 超温 / 可转罐结论已从 changedDate 起重算，旧排单不再可信
  const pendingRacking = await db.operations
    .where('batchId')
    .equals(batchId)
    .filter(
      (op) =>
        op.type === '倒罐' &&
        op.state !== '已完成' &&
        op.state !== '待复核' &&
        op.basisVersion < nextVersion
    )
    .toArray()

  const invalidatedOperationIds: string[] = []
  for (const op of pendingRacking) {
    const staleDates = [...new Set([...(op.staleDates ?? []), ...affected])].sort()
    await db.operations.update(op.id, {
      state: '待复核',
      staleDates,
      shortfallL: 0,
      reviewNote: `所依据的读数（${changedDate} 起）已改动或撤回，停滞 / 超温 / 可转罐结论已重算，请复核`,
      updatedAt: now
    } as never)
    invalidatedOperationIds.push(op.id)
    await writeAudit(
      batchId,
      nextVersion,
      '工单失效',
      `倒罐工单 ${op.date} → 罐 ${op.targetTankId || '?'} 依据过期，退回复核`,
      affected,
      [op.id]
    )
  }

  await reevaluateQueue(batchId)
  return { affected, invalidatedOperationIds }
}

/* ------------------------------ 作业 / 倒罐工单（版本化 + 容量） ------------------------------ */

export async function listOperations(): Promise<OperationRow[]> {
  const rows = await db.operations.toArray()
  return rows.sort((a, b) => a.seq - b.seq || a.date.localeCompare(b.date))
}

export async function putOperation(row: OperationRow): Promise<void> {
  await db.operations.put(row)
}

export async function updateOperation(id: string, patch: Partial<Operation>): Promise<void> {
  await db.operations.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export interface OperationChangeInput {
  id?: string
  batchId: string
  type: Operation['type']
  date: string
  durationMin: number
  operator: string
  targetTankId: string
  transferVolumeL: number
  /** 保存方所依据的批次读数版本 */
  expectedReadingVersion: number
  /** 编辑已有工单时携带该工单最后更新时间，防止两个窗口互相覆盖 */
  expectedUpdatedAt?: number
}

/**
 * 保存倒罐 / 普通作业（乐观锁事务）：
 * - 只接受基于最新读数版本的改动
 * - 倒罐要求：目标罐可分配、当前趋势可转罐、源罐液量不超过目标罐剩余容量
 * - 容量不足 → 状态「排队」并记录 shortfallL；容量足够 → 「计划」
 */
export async function saveOperationChange(input: OperationChangeInput): Promise<OperationRow> {
  return db.transaction(
    'rw',
    [db.batches, db.readings, db.operations, db.tanks, db.trends, db.auditlogs],
    async () => {
      const batch = await db.batches.get(input.batchId)
      if (!batch) throw new Error('批次不存在')
      const now = Date.now()

      const existing = input.id ? await db.operations.get(input.id) : undefined
      if (input.id && !existing) throw new Error('工单不存在或已被删除，请刷新后重试')
      if (existing && existing.updatedAt !== input.expectedUpdatedAt) {
        throw new VersionConflictError(
          {
            kind: 'operation',
            operationId: existing.id,
            expectedVersion: input.expectedReadingVersion,
            currentVersion: batch.readingVersion,
            date: input.date,
            targetTankId: input.targetTankId
          },
          '该工单已被另一窗口修改，请刷新后基于最新版本重新保存'
        )
      }

      // 乐观锁：只接受基于最新读数版本的改动
      if (input.expectedReadingVersion !== batch.readingVersion) {
        const changedDates = await collectChangedDates(input.batchId, input.expectedReadingVersion)
        const staleOps = await db.operations
          .where('batchId')
          .equals(input.batchId)
          .filter((op) => op.type === '倒罐' && op.state !== '已完成')
          .toArray()
        throw new VersionConflictError(
          {
            kind: 'reading',
            batchId: input.batchId,
            expectedVersion: input.expectedReadingVersion,
            currentVersion: batch.readingVersion,
            changedDates: changedDates,
            affectedOperations: staleOps.map((op) => ({
              id: op.id,
              date: op.date,
              targetTankId: op.targetTankId
            }))
          },
          '批次读数已有新版本，倒罐结论可能已变化，请刷新后重新排单'
        )
      }

      let seq = existing?.seq ?? 0
      if (!existing) {
        const rows = await db.operations.where('batchId').equals(input.batchId).toArray()
        seq = rows.reduce((max, item) => Math.max(max, item.seq), 0) + 1
      }

      let state: Operation['state'] = '计划'
      let shortfallL = 0

      if (input.type === '倒罐') {
        if (!input.targetTankId) throw new Error('请选择目标罐')
        const target = await db.tanks.get(input.targetTankId)
        if (!target) throw new Error('目标罐不存在')
        if (target.state === '清洗中') throw new Error(`目标罐 ${target.code} 正在清洗中，暂不可转入`)
        if (input.targetTankId === batch.tankId) {
          throw new Error('目标罐与源罐相同，无需倒罐')
        }

        // 当前趋势必须满足可转罐
        const trend = await db.trends.get(`trend-${input.batchId}`)
        if (trend && !trend.rackable) {
          throw new Error(`当前不满足可转罐条件：${trend.rackableReasons.join('；')}`)
        }

        // 可转罐要求：源罐液量（批次在罐全量）不超过目标罐剩余容量
        // 已完成倒罐占住的容量保留 + 已确认计划单先排先占
        const sourceVolume = batch.volumeL
        const freeL = await freeCapacityFor(input.targetTankId, input.id)
        if (freeL < sourceVolume) {
          state = '排队'
          shortfallL = sourceVolume - freeL
        }
      }

      // 倒罐按源罐批次全量转罐；普通作业不携带液量
      const transferVolume = input.type === '倒罐' ? batch.volumeL : 0
      const targetTankId = input.type === '倒罐' ? input.targetTankId : ''

      const row: OperationRow = existing
        ? {
            ...existing,
            batchId: input.batchId,
            type: input.type,
            date: input.date,
            durationMin: input.durationMin,
            operator: input.operator,
            targetTankId,
            transferVolumeL: transferVolume,
            state: input.type === '倒罐' ? state : '计划',
            shortfallL: input.type === '倒罐' ? shortfallL : 0,
            basisVersion: batch.readingVersion,
            staleDates: [],
            reviewNote: '',
            updatedAt: now
          }
        : {
            id: `operation-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            batchId: input.batchId,
            type: input.type,
            date: input.date,
            durationMin: input.durationMin,
            operator: input.operator,
            state: input.type === '倒罐' ? state : '计划',
            seq,
            targetTankId,
            transferVolumeL: transferVolume,
            shortfallL: input.type === '倒罐' ? shortfallL : 0,
            basisVersion: batch.readingVersion,
            staleDates: [],
            reviewNote: '',
            revision: ROW_REVISION,
            createdAt: now,
            updatedAt: now
          }

      await db.operations.put(row)
      await reevaluateQueue(input.batchId)

      const targetCode = targetTankId ? (await db.tanks.get(targetTankId))?.code ?? '?' : ''
      await writeAudit(
        input.batchId,
        batch.readingVersion,
        '工单保存',
        input.type === '倒罐'
          ? state === '排队'
            ? `倒罐工单 ${input.date} → 罐 ${targetCode} 容量不足，排队等待（还差 ${shortfallL}L）`
            : `倒罐工单 ${input.date} → 罐 ${targetCode} 已确认（源罐 ${transferVolume}L）`
          : `${input.type}作业 ${input.date} 已排定`,
        [],
        [row.id],
        existing ? serializeOperation(existing) : null,
        serializeOperation(row)
      )
      if (input.type === '倒罐' && state === '排队') {
        await writeAudit(
          input.batchId,
          batch.readingVersion,
          '容量排队',
          `目标罐 ${targetCode} 还差 ${shortfallL}L，工单进入排队`,
          [],
          [row.id]
        )
      }
      return (await db.operations.get(row.id)) ?? row
    }
  )
}

/** 计算目标罐对「某张工单」可用的剩余容量（排除该工单自身占位） */
async function freeCapacityFor(targetTankId: string, excludeOperationId?: string): Promise<number> {
  const [tanks, batches, operations] = await Promise.all([
    db.tanks.toArray(),
    db.batches.toArray(),
    db.operations.toArray()
  ])
  const capacities = computeTankCapacities({ tanks, batches, operations })
  const cap = capacities.get(targetTankId)
  if (!cap) return 0
  // computeTankCapacities 只算在罐批次与已完成保留；已确认计划单先排先占需叠加
  let reserved = 0
  for (const op of operations) {
    if (
      op.type === '倒罐' &&
      op.state === '计划' &&
      op.targetTankId === targetTankId &&
      op.id !== excludeOperationId
    ) {
      reserved += op.transferVolumeL
    }
  }
  return Math.max(0, cap.freeL - reserved)
}

/**
 * 重排所有未完成倒罐工单：按日期 / seq 先排先占，容量足够转「计划」，不足保持「排队」并算差额。
 * skipBatchId 批次内刚被退回「待复核」的工单不参与占位。
 */
async function reevaluateQueue(_skipBatchId?: string): Promise<void> {
  const [tanks, batches, operations] = await Promise.all([
    db.tanks.toArray(),
    db.batches.toArray(),
    db.operations.toArray()
  ])
  const capacities = computeTankCapacities({ tanks, batches, operations })
  const now = Date.now()

  const pending = operations
    .filter((op) => op.type === '倒罐' && (op.state === '计划' || op.state === '排队') && op.targetTankId)
    .sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq)

  for (const op of pending) {
    const cap = capacities.get(op.targetTankId)
    const freeL = cap ? cap.freeL : 0
    if (cap && freeL >= op.transferVolumeL) {
      cap.occupiedL += op.transferVolumeL
      cap.freeL = Math.max(0, cap.capacityL - cap.occupiedL)
      if (op.state !== '计划' || op.shortfallL !== 0) {
        await db.operations.update(op.id, { state: '计划', shortfallL: 0, updatedAt: now } as never)
        await writeAudit(
          op.batchId,
          batches.find((item) => item.id === op.batchId)?.readingVersion ?? 0,
          '容量放行',
          `倒罐工单 ${op.date} 获得容量，已从排队转计划`,
          [],
          [op.id]
        )
      }
    } else {
      const shortfallL = Math.max(0, op.transferVolumeL - freeL)
      if (op.state !== '排队' || op.shortfallL !== shortfallL) {
        await db.operations.update(op.id, { state: '排队', shortfallL, updatedAt: now } as never)
        await writeAudit(
          op.batchId,
          batches.find((item) => item.id === op.batchId)?.readingVersion ?? 0,
          '容量排队',
          `目标罐剩余 ${freeL}L，工单排队等待（还差 ${shortfallL}L）`,
          [],
          [op.id]
        )
      }
    }
  }
}

function serializeOperation(
  row: OperationRow
): Omit<OperationRow, 'revision' | 'createdAt' | 'updatedAt'> {
  const { revision: _r, createdAt: _c, updatedAt: _u, ...rest } = row
  return rest
}

/**
 * 复核退回的倒罐工单：
 * - 复核通过：依据版本刷新到当前批次版本，清空失效日期，再按容量决定计划 / 排队
 * - 复核不通过（趋势已不可转罐）：抛错，工单保持待复核
 */
export async function reviewOperation(id: string, note: string): Promise<OperationRow> {
  return db.transaction('rw', [db.operations, db.batches, db.tanks, db.trends, db.auditlogs], async () => {
    const op = await db.operations.get(id)
    if (!op) throw new Error('工单不存在')
    const batch = await db.batches.get(op.batchId)
    if (!batch) throw new Error('批次不存在')
    const trend = await db.trends.get(`trend-${op.batchId}`)
    if (op.type === '倒罐' && trend && !trend.rackable) {
      throw new Error(`复核未通过，当前不可转罐：${trend.rackableReasons.join('；')}`)
    }
    const now = Date.now()
    const next: OperationRow = {
      ...op,
      basisVersion: batch.readingVersion,
      staleDates: [],
      reviewNote: note,
      state: '排队', // 先排队，由容量评估决定是否升计划
      shortfallL: 0,
      updatedAt: now
    }
    await db.operations.put(next)
    await reevaluateQueue(op.batchId)
    const refreshed = await db.operations.get(id)
    await writeAudit(
      op.batchId,
      batch.readingVersion,
      '工单复核',
      `工单 ${op.date} 复核通过（${note || '无备注'}），依据刷新到 v${batch.readingVersion}`,
      [],
      [id]
    )
    return refreshed ?? next
  })
}

export async function removeOperation(id: string): Promise<void> {
  await db.transaction('rw', [db.operations, db.batches, db.auditlogs], async () => {
    const op = await db.operations.get(id)
    await db.operations.delete(id)
    if (op) {
      const batch = await db.batches.get(op.batchId)
      await writeAudit(
        op.batchId,
        batch?.readingVersion ?? 0,
        '工单删除',
        `删除 ${op.date} 的「${op.type}」工单`,
        [],
        [id],
        serializeOperation(op),
        null
      )
    }
    await reevaluateQueue(undefined)
  })
}

/** 批量写回拖拽后的作业顺序（不动倒罐容量状态） */
export async function reorderOperations(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', [db.operations, db.auditlogs, db.batches], async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.operations.update(orderedIds[index], { seq: index + 1, updatedAt: Date.now() } as never)
    }
    // 顺序变化可能影响排队先后（先排先占），重排一次
    await reevaluateQueue(undefined)
  })
}

/**
 * 完成作业：
 * - 普通作业：置完成并回写批次最近作业时间
 * - 倒罐工单：完成后批次转入目标罐，旧罐释放；已完成倒罐占住的容量持续保留；
 *   随后重排排队工单（容量释放后自动放行）
 */
export async function completeOperation(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.operations, db.batches, db.tanks, db.auditlogs],
    async () => {
      const operation = await db.operations.get(id)
      if (!operation) throw new Error('作业不存在')
      if (operation.state === '待复核') throw new Error('该工单依据已失效，请先复核')
      if (operation.state === '排队') throw new Error('目标罐容量不足，工单仍在排队等待')
      const now = Date.now()

      await db.operations.update(id, { state: '已完成', updatedAt: now } as never)
      const patch: Record<string, unknown> = { lastOperationAt: nowIso(), updatedAt: now }

      if (operation.type === '倒罐' && operation.targetTankId) {
        const batch = await db.batches.get(operation.batchId)
        if (batch) {
          const sourceTankId = batch.tankId
          patch.tankId = operation.targetTankId
          await db.batches.update(operation.batchId, patch as never)
          // 批次转走后，若旧罐已无其它在罐批次，置为空闲
          if (sourceTankId && sourceTankId !== operation.targetTankId) {
            const remaining = await db.batches
              .where('tankId')
              .equals(sourceTankId)
              .filter((item) => item.state !== '已出罐')
              .count()
            if (remaining === 0) {
              await db.tanks.update(sourceTankId, { state: '空闲', updatedAt: now } as never)
            }
          }
          await db.tanks.update(operation.targetTankId, { state: '在用', updatedAt: now } as never)

          // 同批次仍有指向旧源罐的未完成倒罐工单：源罐液量已迁走，退回复核
          const siblings = await db.operations
            .where('batchId')
            .equals(operation.batchId)
            .filter(
              (op) =>
                op.id !== operation.id &&
                op.type === '倒罐' &&
                op.state !== '已完成' &&
                op.state !== '待复核'
            )
            .toArray()
          for (const sibling of siblings) {
            await db.operations.update(sibling.id, {
              state: '待复核',
              shortfallL: 0,
              reviewNote: '批次已由另一张倒罐工单转走，源罐液量变化，请重新确认来源与目标容量',
              updatedAt: now
            } as never)
            await writeAudit(
              operation.batchId,
              batch.readingVersion,
              '工单失效',
              `倒罐工单 ${sibling.date} 因批次已转罐退回复核`,
              [],
              [sibling.id]
            )
          }
        }
      } else {
        await db.batches.update(operation.batchId, patch as never)
      }

      const batch = await db.batches.get(operation.batchId)
      const targetCode = operation.targetTankId
        ? (await db.tanks.get(operation.targetTankId))?.code ?? '?'
        : ''
      await writeAudit(
        operation.batchId,
        batch?.readingVersion ?? 0,
        '工单完成',
        operation.type === '倒罐'
          ? `倒罐完成：批次转入罐 ${targetCode}（${operation.transferVolumeL}L，容量保留）`
          : `「${operation.type}」作业完成`,
        [],
        [id]
      )

      // 容量变化：在罐批次位置迁移 + 排队重排
      await reevaluateQueue(undefined)
    }
  )
}

/** 某个批次现有作业的最大序号 */
export async function nextOperationSeq(batchId: string): Promise<number> {
  const rows = await db.operations.where('batchId').equals(batchId).toArray()
  return rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1
}

/* ------------------------------ 苹乳发酵 ------------------------------ */

export async function listMlfs(): Promise<MlfRow[]> {
  return db.mlfs.toArray()
}

export async function putMlf(row: MlfRow): Promise<void> {
  await db.mlfs.put(row)
}

export async function updateMlf(id: string, patch: Partial<Mlf>): Promise<void> {
  await db.mlfs.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeMlf(id: string): Promise<void> {
  await db.mlfs.delete(id)
}

/* ------------------------------ 品评调配 ------------------------------ */

export async function listTastings(): Promise<TastingRow[]> {
  const rows = await db.tastings.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putTasting(row: TastingRow): Promise<void> {
  await db.tastings.put(row)
}

export async function updateTasting(id: string, patch: Partial<Tasting>): Promise<void> {
  await db.tastings.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeTasting(id: string): Promise<void> {
  await db.tastings.delete(id)
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  parcels: Parcel[]
  tanks: Tank[]
  batches: Batch[]
  readings: Array<Omit<ReadingRow, keyof Revisioned>>
  operations: Array<Omit<OperationRow, keyof Revisioned>>
  mlfs: Mlf[]
  tastings: Tasting[]
  trends: Array<Omit<TrendRow, keyof Revisioned>>
  auditlogs: Array<Omit<AuditRow, keyof Revisioned>>
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as Omit<T, keyof Revisioned>
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [parcels, tanks, batches, readings, operations, mlfs, tastings, trends, auditlogs] = await Promise.all([
    db.parcels.toArray(),
    db.tanks.toArray(),
    db.batches.toArray(),
    db.readings.toArray(),
    db.operations.toArray(),
    db.mlfs.toArray(),
    db.tastings.toArray(),
    db.trends.toArray(),
    db.auditlogs.toArray()
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    parcels: parcels.map(stripRow),
    tanks: tanks.map(stripRow),
    batches: batches.map(stripRow),
    readings: readings.map(stripRow),
    operations: operations.map(stripRow),
    mlfs: mlfs.map(stripRow),
    tastings: tastings.map(stripRow),
    trends: trends.map(stripRow),
    auditlogs: auditlogs.map(stripRow)
  }
}

function stamp<T>(row: T): T & Revisioned {
  return { ...row, revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now() }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.tanks, db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.trends, db.auditlogs],
    async () => {
      await Promise.all([
        db.parcels.clear(),
        db.tanks.clear(),
        db.batches.clear(),
        db.readings.clear(),
        db.operations.clear(),
        db.mlfs.clear(),
        db.tastings.clear(),
        db.trends.clear(),
        db.auditlogs.clear()
      ])
      await db.parcels.bulkPut(snapshot.parcels.map(stamp))
      await db.tanks.bulkPut(snapshot.tanks.map(stamp))
      await db.batches.bulkPut(
        snapshot.batches.map((row) => stamp({ ...row, readingVersion: row.readingVersion ?? 0 }))
      )
      await db.readings.bulkPut(
        snapshot.readings.map((row) =>
          stamp({
            ...row,
            status: row.status ?? '有效',
            withdrawReason: row.withdrawReason ?? '',
            version: row.version ?? 1
          } as ReadingRow)
        )
      )
      await db.operations.bulkPut(
        snapshot.operations.map((row) =>
          stamp({
            ...row,
            targetTankId: row.targetTankId ?? '',
            transferVolumeL: row.transferVolumeL ?? 0,
            shortfallL: row.shortfallL ?? 0,
            basisVersion: row.basisVersion ?? 0,
            staleDates: row.staleDates ?? [],
            reviewNote: row.reviewNote ?? ''
          } as OperationRow)
        )
      )
      await db.mlfs.bulkPut(snapshot.mlfs.map(stamp))
      await db.tastings.bulkPut(snapshot.tastings.map(stamp))
      if (snapshot.trends) await db.trends.bulkPut(snapshot.trends.map(stamp))
      if (snapshot.auditlogs) await db.auditlogs.bulkPut(snapshot.auditlogs.map(stamp))
    }
  )
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.tanks, db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.trends, db.auditlogs],
    async () => {
      await Promise.all([
        db.parcels.clear(),
        db.tanks.clear(),
        db.batches.clear(),
        db.readings.clear(),
        db.operations.clear(),
        db.mlfs.clear(),
        db.tastings.clear(),
        db.trends.clear(),
        db.auditlogs.clear()
      ])
    }
  )
  await seedDatabase()
}

/** 各表行数统计，供页脚与概览展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [parcels, tanks, batches, readings, operations, mlfs, tastings, trends, auditlogs] = await Promise.all([
    db.parcels.count(),
    db.tanks.count(),
    db.batches.count(),
    db.readings.count(),
    db.operations.count(),
    db.mlfs.count(),
    db.tastings.count(),
    db.trends.count(),
    db.auditlogs.count()
  ])
  return { parcels, tanks, batches, readings, operations, mlfs, tastings, trends, auditlogs }
}
