/**
 * 乐观锁冲突：两个窗口同时保存时，只接受基于最新版本的改动。
 * 冲突方携带 ConflictDetail，由页面展示冲突日期与受影响工单。
 */
import type { ConflictDetail } from '@/types/versioning'

export class VersionConflictError extends Error {
  readonly detail: ConflictDetail

  constructor(detail: ConflictDetail, message: string) {
    super(message)
    this.name = 'VersionConflictError'
    this.detail = detail
  }

  static is(err: unknown): err is VersionConflictError {
    return err instanceof VersionConflictError
  }
}
