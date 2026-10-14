import { describe, expect, it } from 'vitest'
import { mirrorUrls } from '../updates'

describe('更新安装包的下载来源', () => {
  it('官方发布仓库的安装包：镜像在前，GitHub 原地址兜底', () => {
    const url = 'https://github.com/cl3582175-oss/jiwei-releases/releases/download/v0.14.0/Jiwei-0.14.0-mac-arm64.dmg'
    expect(mirrorUrls(url)).toEqual([`https://gh-proxy.com/${url}`, `https://ghfast.top/${url}`, url])
  })
  it('自定义更新源、其它仓库或带查询参数的地址不改', () => {
    for (const url of [
      'https://updates.example.com/Jiwei-1.0.0.dmg',
      'https://github.com/someone/else/releases/download/v1/x.dmg',
      'https://github.com/cl3582175-oss/jiwei-releases/releases/download/v0.14.0/x.dmg?token=1',
      'http://127.0.0.1:9000/Jiwei-1.0.0.dmg'
    ])
      expect(mirrorUrls(url)).toEqual([url])
  })
})
