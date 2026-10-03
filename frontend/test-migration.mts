/**
 * 迁移冒烟测试：模拟 v1 旧库（无数据版本、无 targetTankId、有重复读数），
 * 用新 schema（v3）打开后验证：读数去重、字段补齐、唯一索引生效。
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'

let failures = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.error(`  ✗ ${name} ${extra}`)
  }
}

async function main(): Promise<void> {
  // 1) 以 v1 结构建旧库并写入历史数据
  const old = new Dexie('gbwinetank-db')
  old.version(1).stores({
    parcels: 'id, name, variety, aspect, updatedAt',
    tanks: 'id, code, material, tempControl, state, updatedAt',
    batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
    readings: 'id, batchId, date, updatedAt',
    operations: 'id, batchId, type, state, date, seq, updatedAt',
    mlfs: 'id, batchId, state, updatedAt',
    tastings: 'id, batchId, date, verdict, updatedAt'
  })
  await old.open()
  await old.table('parcels').put({ id: 'p-1', name: '老地块', variety: '梅洛', areaMu: 3, vineAge: 9, aspect: '南' })
  await old.table('batches').put({
    id: 'b-1', parcelId: 'p-1', tankId: '', harvestDate: '2024-09-01',
    volumeL: 800, brix: 22, state: '酒精发酵', lastOperationAt: null
  })
  // 同批次同日两条读数（历史脏数据）：应保留 updatedAt 较新的一条
  await old.table('readings').bulkPut([
    { id: 'r-old', batchId: 'b-1', date: '2024-09-02', gravity: 1.08, tempC: 25, brix: 20, updatedAt: 100 },
    { id: 'r-new', batchId: 'b-1', date: '2024-09-02', gravity: 1.07, tempC: 26, brix: 19, updatedAt: 200 },
    { id: 'r-other', batchId: 'b-1', date: '2024-09-03', gravity: 1.05, tempC: 26, brix: 17, updatedAt: 300 }
  ])
  await old.table('operations').put({
    id: 'op-1', batchId: 'b-1', type: '倒罐', date: '2024-09-05', durationMin: 40,
    operator: '老张', state: '计划', seq: 1
  })
  await old.close()

  // 2) 用新代码打开（触发 v2 去重 + 补字段，v3 加唯一索引）
  const { db, DB_SCHEMA_VERSION } = await import('./src/utils/db')
  await db.open()
  check('库版本升到 v3', db.verno === 3, `实际 ${db.verno}`)
  check('DB_SCHEMA_VERSION 常量一致', DB_SCHEMA_VERSION === 3)

  const readings = await db.readings.where('batchId').equals('b-1').toArray()
  check('同批次同日读数已去重为 1 条', readings.filter((r) => r.date === '2024-09-02').length === 1)
  const kept = readings.find((r) => r.date === '2024-09-02')
  check('保留 updatedAt 较新的读数', kept?.id === 'r-new' && kept.gravity === 1.07)
  check('读数补齐数据版本号', readings.every((r) => typeof r.version === 'number'))

  const op = await db.operations.get('op-1')
  check('工单补齐 targetTankId / invalidReason / version',
    op?.targetTankId === '' && op.invalidReason === null && typeof op.version === 'number')

  // 3) 唯一索引生效：直接写重复 (batchId, date) 应失败
  let uniqueBlocked = false
  try {
    await db.readings.put({
      id: 'r-dup', batchId: 'b-1', date: '2024-09-02', gravity: 1.06, tempC: 25, brix: 18,
      version: 1, revision: 2, createdAt: 1, updatedAt: 1
    })
  } catch {
    uniqueBlocked = true
  }
  check('唯一索引拒绝同批次同日重复读数', uniqueBlocked)

  console.log(failures === 0 ? '\n迁移测试全部通过 ✅' : `\n${failures} 项失败 ❌`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('迁移测试异常：', error)
  process.exit(1)
})
