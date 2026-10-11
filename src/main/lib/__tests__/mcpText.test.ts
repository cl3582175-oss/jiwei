import { describe, expect, it } from 'vitest'
import { exposedName, resultText } from '../mcpText'

describe('MCP 结果转文本', () => {
  it('文字原样，图片与资源给出说明', () => {
    const t = resultText(
      {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', mimeType: 'image/png' },
          { type: 'resource', resource: { uri: 'file:///a', text: 'body' } },
          { type: 'resource_link', uri: 'https://x', name: 'X' }
        ]
      },
      true
    )
    expect(t).toBe('hello\n[图片 image/png]\nbody\n[X](https://x)')
  })
  it('没有文字时用结构化结果；空结果有提示；超长截断', () => {
    expect(resultText({ content: [], structuredContent: { a: 1 } }, true)).toBe('{"a":1}')
    expect(resultText({ content: [] }, false)).toBe('(no content)')
    expect(resultText({ content: [{ type: 'text', text: 'x'.repeat(30000) }] }, true).length).toBeLessThan(20010)
  })
})

describe('给模型看的工具名', () => {
  it('只含合法字符，中文服务器名用 ID 前缀', () => {
    expect(exposedName('File System', 'abc', 'read_file')).toBe('mcp__file_system__read_file')
    expect(exposedName('文件', '0f3a9b2c-1111', 'read.file')).toBe('mcp__s0f3a9b__read_file')
  })
  it('超过 64 个字符时截断并加哈希，仍然唯一', () => {
    const a = exposedName('server', 'x', 'a'.repeat(80))
    const b = exposedName('server', 'x', `${'a'.repeat(79)}b`)
    expect(a.length).toBeLessThanOrEqual(64)
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[a-zA-Z0-9_-]+$/)
  })
})
