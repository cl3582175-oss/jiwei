// 拒绝与已解释但尚未授权的状态不再次调用系统采集，避免操作系统重复弹窗。
export function screenPermissionAction(status: string, explained: boolean): 'capture' | 'explain' | 'deny' {
  if (status === 'granted') return 'capture'
  if (status === 'denied' || status === 'restricted' || explained) return 'deny'
  return 'explain'
}
