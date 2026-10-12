/* global require, module, process */
/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder CommonJS hook entrypoints */
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')

function signingOptions(env) {
  if (!env.CSC_LINK) return { identity: '-', hardenedRuntime: false, notarize: false }
  for (const key of ['CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    if (env[key] === undefined || (key !== 'CSC_KEY_PASSWORD' && !env[key]))
      throw new Error(`${key} is required for the Developer ID release mode`)
  }
  return { hardenedRuntime: true, notarize: true }
}

async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const options = signingOptions(process.env)
  Object.assign(context.packager.platformSpecificBuildOptions, options)
  // '-' is the YAML fallback. Remove it when builder should discover the imported certificate.
  if (options.identity === undefined) delete context.packager.platformSpecificBuildOptions.identity
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const resources = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
  writeFileSync(join(resources, 'jiwei-signing.json'), JSON.stringify({ mode: process.env.CSC_LINK ? 'developer-id' : 'adhoc' }))
}

async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const application = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-vv', application], { stdio: 'inherit' })
}

module.exports = { signingOptions, beforePack, afterPack, afterSign }
