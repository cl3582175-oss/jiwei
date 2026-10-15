/** P0核对注册表没有窗口字段；只为已知常用系列使用保守值，未知型号按8192。 */
export function modelContextLength(kind: string, model: string): number {
  if (kind === 'ollama') return 8192
  if (/^deepseek-(?:flash|v4-pro|chat|reasoner)$/i.test(model)) return 128000
  if (/^qwen-(?:plus|turbo)/i.test(model)) return 32768
  if (/^kimi-|^moonshot-/i.test(model)) return 128000
  if (/^glm-/i.test(model)) return 32768
  if (/^gpt-|^o[1-4](?:-|$)/i.test(model)) return 128000
  if (/^claude-/i.test(model)) return 200000
  if (/^gemini-/i.test(model)) return 1048576
  return 8192
}
