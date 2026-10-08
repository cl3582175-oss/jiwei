import { v7 as uuidv7 } from 'uuid'

/** 时间有序的全局唯一 ID（UUIDv7），适合同步与索引局部性 */
export function newId(): string {
  return uuidv7()
}
