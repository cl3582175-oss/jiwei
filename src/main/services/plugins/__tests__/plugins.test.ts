import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import JSZip from 'jszip'
import { gzipSync } from 'zlib'
import * as tar from 'tar'
import {
  PluginManifestSchema,
  MarketplaceEntrySchema,
  JiweiExtSchema,
  PluginRecipeSchema,
  parseMarketplace,
  pluginSourceSupport,
  inferCapabilities,
  addedCapabilities,
  resolvePluginVersion,
  satisfiesPluginEngine,
  safeRelativePath
} from '@shared/plugins'
import { parsePlugin, resolvePluginMcp } from '../components'
import { inspectZip, preparePluginSource, PLUGIN_LIMITS } from '../sources'
const roots: string[] = []
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'jiwei-p1a-test-'))
  roots.push(dir)
  return dir
}
async function file(root: string, path: string, content: string) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content)
}
async function json(root: string, path: string, value: unknown) {
  await file(root, path, JSON.stringify(value))
}
const skill = (name: string) => `---\nname: ${name}\ndescription: Self authored test\n---\nRead this text only.`
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})
describe('plugin contracts', () => {
  it('accepts display versions, strips unknown fields, enforces names and config options', () => {
    expect(PluginManifestSchema.parse({ name: 'demo', version: 'spring-release', unknown: 1 })).toEqual({
      name: 'demo',
      version: 'spring-release'
    })
    for (const name of ['a/b', 'a@b', 'a:b', '..', '__proto__', 'a\u202eb'])
      expect(PluginManifestSchema.safeParse({ name }).success).toBe(false)
    expect(
      PluginManifestSchema.safeParse({
        name: 'demo',
        userConfig: { key: { type: 'string', title: 'Key', description: 'test', extra: true } }
      }).success
    ).toBe(false)
    expect(JiweiExtSchema.safeParse({ schema: 2 }).success).toBe(false)
  })
  it('validates market names and source support without treating names as trust', () => {
    const market = (name: string) => ({ name, owner: { name: 'Example' }, plugins: [{ name: 'demo', source: './' }] })
    for (const name of ['jiwei', 'jiwei-official', 'JIWEI-fake', '__proto__', 'a..b'])
      expect(() => parseMarketplace(market(name))).toThrow()
    expect(parseMarketplace(market('jiwei'), true).name).toBe('jiwei')
    for (const source of [
      './p',
      { source: 'github', repo: 'example/repo' },
      { source: 'git-subdir', url: 'https://github.com/example/repo', path: 'plugins/p' },
      { source: 'url', url: 'https://github.com/example/repo.git' },
      { source: 'archive', url: 'https://example.org/p.zip' }
    ])
      expect(pluginSourceSupport(source).supported).toBe(true)
    for (const source of [{ source: 'npm' }, { source: 'command' }, { source: 'url', url: 'https://elsewhere.org/a/b' }])
      expect(pluginSourceSupport(source).supported).toBe(false)
  })
  it.each(['../x', '/x', 'C:/x', 'a\\b', 'a/../b', '\\server\\x'])('rejects manifest path %s', (path) => {
    expect(() => safeRelativePath(path)).toThrow()
    for (const key of ['skills', 'commands', 'mcpServers'])
      expect(PluginManifestSchema.safeParse({ name: 'demo', [key]: path }).success).toBe(false)
  })
  it('checks engine ranges and version precedence', () => {
    for (const range of ['>=0.10.0', '>=0.9.0 <0.11.0', '^0.10.0', '~0.10.0', '0.10.x', '0.9.0 || 0.10.0'])
      expect(satisfiesPluginEngine(range)).toBe(true)
    for (const range of ['>=0.11.0', '^0.9.0', '<0.10.0', 'latest', '0.10.0-beta', '']) expect(satisfiesPluginEngine(range)).toBe(false)
    const all = { manifest: 'release', entry: 'entry', sha: 'a'.repeat(40), hash: 'b'.repeat(64) }
    expect(resolvePluginVersion(all)).toBe('release')
    expect(resolvePluginVersion({ ...all, manifest: undefined })).toBe('entry')
    expect(resolvePluginVersion({ hash: all.hash, sha: all.sha })).toBe('a'.repeat(12))
    expect(resolvePluginVersion({ hash: all.hash })).toBe('b'.repeat(12))
  })
  it('rejects recipes with arbitrary tools', () => {
    const recipe = {
      id: 'test',
      name: { zh: '测试', en: 'Test' },
      instructionEn: 'Read',
      task: { name: 'Test', instruction: 'Read', trigger: { type: 'manual' }, tools: ['exec'], outputs: { inbox: true } }
    }
    expect(PluginRecipeSchema.safeParse(recipe).success).toBe(false)
    expect(PluginRecipeSchema.safeParse({ ...recipe, task: { ...recipe.task, tools: ['mail_read', 'knowledge_search'] } }).success).toBe(
      true
    )
  })
})
describe('plugin components', () => {
  it('maps skills, commands, MCP override, unsupported components and runtime placeholders', async () => {
    const root = await temp()
    await json(root, '.claude-plugin/plugin.json', {
      name: 'demo',
      skills: 'extra',
      mcpServers: [
        { remote: { type: 'http', url: 'https://new.example/mcp', headers: { Authorization: '${user_config.token}' } } },
        {
          local: {
            command: '${CLAUDE_PLUGIN_ROOT}/server',
            args: ['${CLAUDE_PLUGIN_DATA}', '${user_config.count}'],
            env: { TOKEN: '${user_config.token}' }
          }
        }
      ],
      userConfig: { token: { type: 'string', title: 'Token', description: 'Test', sensitive: true } }
    })
    await file(root, 'skills/valid/SKILL.md', skill('valid'))
    await file(root, 'skills/bad/SKILL.md', skill('different'))
    await file(root, 'extra/extra-skill/SKILL.md', skill('extra-skill'))
    await file(root, 'skills/valid/helper.py', 'print("not executed")')
    await file(root, 'commands/hello.md', '---\ndescription: Explain\n---\nHello $ARGUMENTS')
    await json(root, '.mcp.json', { mcpServers: { remote: { url: 'https://old.example/mcp' } } })
    await file(root, 'hooks/hooks.json', '{}')
    const result = await parsePlugin(root)
    expect(result.skills.map((s) => s.name)).toEqual(['demo:valid', 'demo:extra-skill', 'demo:hello'])
    expect(result.skills[0].hasScripts).toBe(true)
    expect(result.skills[2].body).not.toContain('$ARGUMENTS')
    expect(result.issues).toHaveLength(1)
    expect(result.unsupported).toContain('hooks')
    expect(result.mcpServers.remote.url).toBe('https://new.example/mcp')
    const runtime = resolvePluginMcp(result.mcpServers.local, {
      root: '/cache/demo',
      data: '/data/demo',
      userConfig: { token: 'fixture-secret', count: 3 }
    })
    expect(runtime.command).toBe('/cache/demo/server')
    expect(runtime.args).toEqual(['/data/demo', '3'])
    expect(runtime.env.TOKEN).toBe('fixture-secret')
    expect(result.mcpServers.local.env.TOKEN).toBe('${user_config.token}')
    expect(() => resolvePluginMcp(result.mcpServers.local, { root, data: root, userConfig: {} })).toThrow('Missing')
    expect(result.capabilities.domains).toEqual(['new.example'])
    expect(result.capabilities.sensitive).toEqual(['token'])
    const empty = inferCapabilities({ manifest: { name: 'demo' }, mcpServers: {}, feeds: [], unsupported: [] })
    expect(addedCapabilities(empty, { ...result.capabilities, dataLeavesDevice: true })).toMatchObject({
      servers: ['local', 'remote'],
      domains: ['new.example'],
      sensitive: ['token'],
      dataLeavesDevice: true
    })
    expect(addedCapabilities(result.capabilities, result.capabilities)).toEqual({})
    expect(addedCapabilities(result.capabilities, { ...result.capabilities, commands: ['changed'] }).commands).toEqual(['changed'])
  })
  it('honors selected skills in root market entries and explicit command replacement', async () => {
    const root = await temp()
    for (const name of ['selected', 'hidden']) await file(root, `skills/${name}/SKILL.md`, skill(name))
    await file(root, 'commands/hidden.md', 'Hidden')
    await file(root, 'custom/show.md', 'Shown')
    const entry = MarketplaceEntrySchema.parse({
      name: 'selection',
      source: './',
      strict: false,
      skills: ['skills/selected'],
      commands: 'custom'
    })
    const parsed = await parsePlugin(root, { entry })
    expect(parsed.skills.map((s) => s.name)).toEqual(['selection:selected', 'selection:show'])
    await json(root, '.claude-plugin/plugin.json', { name: 'selection' })
    await expect(parsePlugin(root, { entry })).rejects.toThrow('conflicts')
  })
  it('supports root skill and command objects; gates renderer and engine', async () => {
    const root = await temp()
    await file(root, 'SKILL.md', skill('root-skill'))
    await json(root, '.claude-plugin/plugin.json', { name: 'demo', commands: { inline: { content: 'Read $ARGUMENTS' } } })
    await json(root, 'jiwei/manifest.json', { schema: 1, renderers: ['manim'], engines: { jiwei: '>=0.10.0' }, unknown: true })
    const result = await parsePlugin(root)
    expect(result.skills.map((s) => s.name)).toEqual(['demo:root-skill', 'demo:inline'])
    expect(result.extension?.renderers).toEqual([])
    expect(result.unsupported).toContain('renderer:manim')
    expect(result.issues[0].code).toBe('unknown_field')
    expect((await parsePlugin(root, { trustedBuiltin: true })).extension?.renderers).toEqual(['manim'])
    await json(root, 'jiwei/manifest.json', { schema: 1, engines: { jiwei: '>=0.11.0' } })
    await expect(parsePlugin(root)).rejects.toThrow('engine')
    await json(root, '.claude-plugin/plugin.json', { name: '../bad' })
    await expect(parsePlugin(root)).rejects.toThrow()
  })
})
describe('Jiwei components', () => {
  it('loads templates, frameworks, recipes, sources and valid lenses; skips malformed components', async () => {
    const root = await temp(),
      localized = { zh: '测试', en: 'Test' }
    await json(root, '.claude-plugin/plugin.json', { name: 'demo' })
    await json(root, 'jiwei/templates/article.json', {
      id: 'article',
      type: 'article',
      title: localized,
      description: localized,
      outline: ['Start'],
      guidance: 'Use evidence'
    })
    await json(root, 'jiwei/frameworks/check.json', {
      id: 'check',
      title: localized,
      description: localized,
      criteria: [
        { name: 'Quality', weight: 2, hint: 'Evidence' },
        { name: 'Effort', weight: 1, hint: 'Estimate' }
      ],
      questions: ['Why?']
    })
    await json(root, 'jiwei/recipes/read.json', {
      id: 'read',
      name: localized,
      instructionEn: 'Read',
      task: { name: 'Read', instruction: 'Read', trigger: { type: 'manual' }, tools: ['note_read'], outputs: { inbox: true } }
    })
    await json(root, 'jiwei/sources.json', { feeds: [{ url: 'https://example.org/feed', title: 'Example', kind: 'rss' }] })
    await file(
      root,
      'jiwei/lenses/view/SKILL.md',
      '---\nname: view\ndescription: Test view\nmetadata:\n  kind: lens\n  output: items\n  landing: append\n---\nReview evidence.'
    )
    await json(root, 'jiwei/templates/invalid.json', { id: 'invalid' })
    await file(root, 'jiwei/lenses/bad/SKILL.md', skill('bad'))
    await file(root, 'jiwei/icon.png', 'not png')
    const result = await parsePlugin(root)
    expect(result.templates.map((v) => v.id)).toEqual(['article'])
    expect(result.frameworks.map((v) => v.id)).toEqual(['check'])
    expect(result.recipes.map((v) => v.id)).toEqual(['read'])
    expect(result.feeds).toHaveLength(1)
    expect(result.skills.map((v) => v.name)).toEqual(['demo:view'])
    expect(result.issues).toHaveLength(3)
    expect(result.icon).toBeNull()
    expect(result.capabilities.feeds).toEqual(['https://example.org/feed'])
  })
})

describe('safe staging', () => {
  async function zipFile(root: string, zip: JSZip) {
    const path = join(root, 'input.zip')
    await writeFile(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' }))
    return path
  }
  it('copies folders and extracts zip/tar into owned disposable staging', async () => {
    const parent = await temp(),
      source = join(parent, 'source')
    await file(source, 'nested/skill/SKILL.md', skill('skill'))
    const folder = await preparePluginSource({ path: source, type: 'folder', tempParent: parent, subdir: 'nested' })
    expect(await readdir(folder.root)).toEqual(['skill'])
    await folder.cleanup()
    const zip = new JSZip()
    zip.file('repo/skills/demo/SKILL.md', skill('demo'))
    const zipped = await preparePluginSource({ path: await zipFile(parent, zip), type: 'zip', tempParent: parent, subdir: 'repo' })
    expect(await readdir(zipped.root)).toEqual(['skills'])
    await zipped.cleanup()
    const path = join(parent, 'input.tar.gz')
    await tar.c({ file: path, gzip: true, cwd: source }, ['nested'])
    const unpacked = await preparePluginSource({ path, type: 'tar.gz', tempParent: parent })
    expect(await readdir(unpacked.root)).toEqual(['nested'])
    await unpacked.cleanup()
    expect((await readdir(parent)).filter((n) => n.startsWith('jiwei-plugin-'))).toEqual([])
  })
  it.each(['../outside.txt', '/outside.txt', 'a\\b.txt', 'C:/outside.txt'])('rejects raw zip path %s and cleans staging', async (name) => {
    const parent = await temp(),
      zip = new JSZip()
    zip.file(name, 'danger', { createFolders: false })
    await expect(preparePluginSource({ path: await zipFile(parent, zip), type: 'zip', tempParent: parent })).rejects.toThrow()
    expect((await readdir(parent)).filter((n) => n.startsWith('jiwei-plugin-'))).toEqual([])
  })
  it('rejects zip symlinks and declared size bombs before decompression', async () => {
    const parent = await temp(),
      zip = new JSZip()
    zip.file('link', 'target', { unixPermissions: 0o120777 })
    await expect(preparePluginSource({ path: await zipFile(parent, zip), type: 'zip', tempParent: parent })).rejects.toThrow('symlink')
    const plain = new JSZip()
    plain.file('test.txt', 'ok')
    const buffer = await plain.generateAsync({ type: 'nodebuffer' })
    const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    buffer.writeUInt32LE(PLUGIN_LIMITS.bytes + 1, central + 24)
    expect(() => inspectZip(buffer)).toThrow('limit')
  })
  it('stops understated zip actual size and excessive entry count', async () => {
    const parent = await temp(),
      zip = new JSZip()
    zip.file('bomb.txt', 'a'.repeat(PLUGIN_LIMITS.textBytes + 1))
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    buffer.writeUInt32LE(1, central + 24)
    buffer.writeUInt32LE(1, 22)
    const path = join(parent, 'bomb.zip')
    await writeFile(path, buffer)
    await expect(preparePluginSource({ path, type: 'zip', tempParent: parent })).rejects.toThrow()
    const countZip = new JSZip()
    for (let i = 0; i <= PLUGIN_LIMITS.entries; i++) countZip.file(`${i}.txt`, '')
    const count = await countZip.generateAsync({ type: 'nodebuffer' })
    expect(() => inspectZip(count)).toThrow('entry')
    expect((await readdir(parent)).filter((n) => n.startsWith('jiwei-plugin-'))).toEqual([])
  })
  it('rejects folder/tar links and oversized folder text', async () => {
    const parent = await temp(),
      source = join(parent, 'source')
    await file(source, 'a.txt', 'text')
    await symlink('a.txt', join(source, 'link'))
    await expect(preparePluginSource({ path: source, type: 'folder', tempParent: parent })).rejects.toThrow('symlink')
    const path = join(parent, 'link.tar.gz')
    await tar.c({ file: path, gzip: true, cwd: source }, ['link'])
    await expect(preparePluginSource({ path, type: 'tar.gz', tempParent: parent })).rejects.toThrow('symlink')
    await rm(join(source, 'link'))
    await file(source, 'a.txt', 'a'.repeat(PLUGIN_LIMITS.textBytes + 1))
    await expect(preparePluginSource({ path: source, type: 'folder', tempParent: parent })).rejects.toThrow('limit')
  })
  it('checks tar raw paths, declared size and decompressed padding budget', async () => {
    const parent = await temp()
    const archive = async (name: string, size: number, padding = 1024) => {
      const header = new tar.Header({ path: name, size, type: 'File', mode: 0o600 })
      header.encode()
      const path = join(parent, 'unsafe.tar.gz')
      await writeFile(path, gzipSync(Buffer.concat([header.block!, Buffer.alloc(padding)])))
      return path
    }
    for (const name of ['../escape', '/escape', 'C:/escape', 'a\\b']) {
      await expect(preparePluginSource({ path: await archive(name, 0), type: 'tar.gz', tempParent: parent })).rejects.toThrow()
    }
    await expect(
      preparePluginSource({ path: await archive('huge.png', PLUGIN_LIMITS.bytes + 1), type: 'tar.gz', tempParent: parent })
    ).rejects.toThrow('limit')
    await expect(
      preparePluginSource({
        path: await archive('empty.txt', 0, PLUGIN_LIMITS.bytes + 4 * 1024 * 1024),
        type: 'tar.gz',
        tempParent: parent
      })
    ).rejects.toThrow('limit')
    expect((await readdir(parent)).filter((n) => n.startsWith('jiwei-plugin-'))).toEqual([])
  })
  it.each(['ExtendedHeader', 'GlobalExtendedHeader', 'NextFileHasLongPath', 'SolarisACL'] as const)(
    'counts raw %s headers toward the tar entry limit and cleans rejected staging',
    async (type) => {
      const parent = await temp(),
        path = join(parent, 'metadata.tar.gz')
      const metadata = new tar.Header({ path: 'metadata', size: 0, type, mode: 0o600 })
      const ordinary = new tar.Header({ path: 'valid.txt', size: 0, type: 'File', mode: 0o600 })
      metadata.encode()
      ordinary.encode()
      const headers = Array.from({ length: PLUGIN_LIMITS.entries + 1 }, () => metadata.block!)
      await writeFile(path, gzipSync(Buffer.concat([...headers, ordinary.block!, Buffer.alloc(1024)])))
      await expect(preparePluginSource({ path, type: 'tar.gz', tempParent: parent })).rejects.toThrow('limit')
      expect((await readdir(parent)).filter((name) => name.startsWith('jiwei-plugin-'))).toEqual([])
    }
  )
  it('preserves the exact tar entry boundary and PAX size framing', async () => {
    const parent = await temp(),
      path = join(parent, 'boundary.tar.gz')
    const metadata = new tar.Header({ path: 'metadata', size: 0, type: 'ExtendedHeader', mode: 0o600 })
    const ordinary = new tar.Header({ path: 'valid.txt', size: 0, type: 'File', mode: 0o600 })
    metadata.encode()
    ordinary.encode()
    await writeFile(
      path,
      gzipSync(
        Buffer.concat([...Array.from({ length: PLUGIN_LIMITS.entries - 1 }, () => metadata.block!), ordinary.block!, Buffer.alloc(1024)])
      )
    )
    const boundary = await preparePluginSource({ path, type: 'tar.gz', tempParent: parent })
    expect(await readdir(boundary.root)).toEqual(['valid.txt'])
    await boundary.cleanup()
    const data = Buffer.alloc(512)
    data.write('abc')
    await writeFile(
      path,
      gzipSync(Buffer.concat([new tar.Pax({ path: 'nested/valid.txt', size: 3 }).encode(), ordinary.block!, data, Buffer.alloc(1024)]))
    )
    const pax = await preparePluginSource({ path, type: 'tar.gz', tempParent: parent })
    expect(await readFile(join(pax.root, 'nested/valid.txt'), 'utf8')).toBe('abc')
    await pax.cleanup()
    expect((await readdir(parent)).filter((name) => name.startsWith('jiwei-plugin-'))).toEqual([])
  })
  it.each([false, true])('rejects GNU directory framing hiding excessive metadata (mixed=%s)', async (mixed) => {
    const parent = await temp(),
      path = join(parent, 'gnu-directory.tar.gz')
    const encode = (value: ConstructorParameters<typeof tar.Header>[0]) => {
      const header = new tar.Header(value)
      header.encode()
      return header.block!
    }
    const directoryName = Buffer.alloc(512)
    directoryName.write('folder/\0')
    const metadata = encode({ path: 'metadata', size: 0, type: 'ExtendedHeader', mode: 0o600 })
    const headers = Array.from({ length: PLUGIN_LIMITS.entries + 1 }, () => metadata)
    const prefix = mixed ? [new tar.Pax({ mtime: new Date(0) }, true).encode(), new tar.Pax({ path: 'original.png' }).encode()] : []
    await writeFile(
      path,
      gzipSync(
        Buffer.concat([
          ...prefix,
          encode({ path: 'long-name', size: 8, type: mixed ? 'OldGnuLongPath' : 'NextFileHasLongPath', mode: 0o600 }),
          directoryName,
          encode({ path: 'placeholder.png', size: (PLUGIN_LIMITS.entries + 2) * 512, type: 'File', mode: 0o600 }),
          ...headers,
          encode({ path: 'valid.txt', size: 0, type: 'File', mode: 0o600 }),
          Buffer.alloc(1024)
        ])
      )
    )
    await expect(preparePluginSource({ path, type: 'tar.gz', tempParent: parent })).rejects.toThrow('limit')
    expect((await readdir(parent)).filter((name) => name.startsWith('jiwei-plugin-'))).toEqual([])
  })
  it.each(['pax', 'gnu'] as const)('uses effective %s long binary names without rejecting valid payloads', async (kind) => {
    const parent = await temp(),
      path = join(parent, 'long-binary.tar.gz'),
      name = 'a'.repeat(120) + '.png',
      payload = Buffer.alloc(2 * 1024 * 1024)
    const ordinary = new tar.Header({ path: name, size: payload.length, type: 'File', mode: 0o600 })
    ordinary.encode()
    let metadata: Buffer
    if (kind === 'pax') metadata = new tar.Pax({ path: name }).encode()
    else {
      const header = new tar.Header({ path: 'long-name', size: Buffer.byteLength(name) + 1, type: 'NextFileHasLongPath', mode: 0o600 })
      header.encode()
      const body = Buffer.alloc(512)
      body.write(name)
      metadata = Buffer.concat([header.block!, body])
    }
    await writeFile(path, gzipSync(Buffer.concat([metadata, ordinary.block!, payload, Buffer.alloc(1024)])))
    const source = await preparePluginSource({ path, type: 'tar.gz', tempParent: parent })
    expect((await readFile(join(source.root, name))).length).toBe(payload.length)
    await source.cleanup()
    expect((await readdir(parent)).filter((name) => name.startsWith('jiwei-plugin-'))).toEqual([])
  })
  it('rejects GNU long-link and conflicting PAX sizes without temporary residue', async () => {
    const parent = await temp(),
      path = join(parent, 'conflicting.tar.gz')
    const fileHeader = new tar.Header({ path: 'valid.txt', size: 0, type: 'File', mode: 0o600 })
    fileHeader.encode()
    const linkHeader = new tar.Header({ path: 'long-link', size: 7, type: 'NextFileHasLongLinkpath', mode: 0o600 })
    linkHeader.encode()
    const link = Buffer.alloc(512)
    link.write('target\0')
    await writeFile(path, gzipSync(Buffer.concat([linkHeader.block!, link, fileHeader.block!, Buffer.alloc(1024)])))
    await expect(preparePluginSource({ path, type: 'tar.gz', tempParent: parent })).rejects.toThrow('symlink')
    await writeFile(
      path,
      gzipSync(
        Buffer.concat([new tar.Pax({ size: 2 }, true).encode(), new tar.Pax({ size: 3 }).encode(), fileHeader.block!, Buffer.alloc(1536)])
      )
    )
    await expect(preparePluginSource({ path, type: 'tar.gz', tempParent: parent })).rejects.toThrow('conflicting tar size')
    expect((await readdir(parent)).filter((name) => name.startsWith('jiwei-plugin-'))).toEqual([])
  })
  it('rejects manifest references through a symlink before component reads', async () => {
    const parent = await temp(),
      root = join(parent, 'plugin'),
      outside = join(parent, 'outside')
    await file(outside, 'SKILL.md', skill('outside'))
    await json(root, '.claude-plugin/plugin.json', { name: 'demo', skills: 'linked' })
    await symlink(outside, join(root, 'linked'))
    await expect(parsePlugin(root)).rejects.toThrow('symlink')
  })
})
