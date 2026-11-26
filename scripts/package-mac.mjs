import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'
import { nextPackageVersion } from './package-version.mjs'
import { stageMemoryResources } from './package-memory.mjs'
import { prepareSigning } from './prepare-signing.mjs'
import { prepareMemoryModel } from './prepare-model.mjs'

if (process.platform !== 'darwin') throw new Error('请在 macOS 上构建应用包。')

const project = fileURLToPath(new URL('..', import.meta.url))
const stateDirectory = join(homedir(), 'Library', 'Application Support', 'Rainbow Mates Build')
const stateFile = join(stateDirectory, 'versions.json')

if (process.argv[2] === '--locked') {
  await packageMac()
} else {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  const result = spawnSync('/usr/bin/lockf', ['-k', join(stateDirectory, 'package.lock'), process.execPath,
    fileURLToPath(import.meta.url), '--locked'], { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

async function packageMac() {
  const signingFile = join(stateDirectory, 'signing.json')
  const signing = await prepareSigning()
  prepareMemoryModel()
  const require = createRequire(import.meta.url)

  const { version: electronVersion } = require('electron/package.json')
  const { name, productName, version, main, type } = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
  const previous = await readFile(stateFile, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  const sharedStateFile = join(project, 'build', 'versions.json')
  const sharedState = JSON.parse(await readFile(sharedStateFile, 'utf8'))
  const states = previous === undefined ? [sharedState] : [sharedState, JSON.parse(previous)]
  const merged = { lastMacBuild: 0, packages: {} }
  for (const current of states) {
    nextPackageVersion(version, current)
    merged.lastMacBuild = Math.max(merged.lastMacBuild, current.lastMacBuild)
    for (const [release, number] of Object.entries(current.packages)) {
      merged.packages[release] = Math.max(merged.packages[release] ?? -1, number)
    }
  }
  const { displayVersion, macBuildVersion, state } = nextPackageVersion(version, merged)
  for (const script of ['build', 'build:computer']) execFileSync('npm', ['run', script], { cwd: project, stdio: 'inherit' })

  const releaseDirectory = join(project, '.release')
  await mkdir(releaseDirectory, { recursive: true })
  const temporary = await mkdtemp(join(releaseDirectory, '.packaging-'))
  const stateTemporary = join(stateDirectory, '.versions-' + randomUUID())
  try {
    const source = join(temporary, 'app')
    const iconset = join(temporary, 'Rainbow.iconset')
    const icon = join(temporary, 'Rainbow.icns')
    await mkdir(source)
    await mkdir(iconset)
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = String(size * scale)
        const file = join(iconset, 'icon_' + size + 'x' + size + (scale === 2 ? '@2x' : '') + '.png')
        execFileSync('/usr/bin/sips', ['-z', pixels, pixels, join(project, 'public', 'app-icon.png'), '--out', file])
      }
    }
    execFileSync('/usr/bin/iconutil', ['--convert', 'icns', '--output', icon, iconset])
    for (const folder of ['desktop', 'shared', 'dist']) {
      await cp(join(project, folder), join(source, folder), { recursive: true })
    }
    await writeFile(join(source, 'package.json'), JSON.stringify({ name, productName, version, main, type, rainbowVersion: displayVersion }))
    const embeddingModel = await stageMemoryResources(project, source, temporary)
    const [output] = await packager({
      dir: source, name: productName, platform: 'darwin', arch: process.arch, electronVersion,
      appVersion: version, buildVersion: macBuildVersion, extendInfo: { RainbowMatesVersion: displayVersion },
      appBundleId: 'build.rainbowdeskmates.desktop', appCategoryType: 'public.app-category.productivity',
      icon, asar: { unpack: '**/*.{node,dylib}' }, prune: false,
      extraResource: [embeddingModel],
      osxSign: {
        identity: signing.identity, keychain: signing.keychain, identityValidation: false,
        preAutoEntitlements: false, continueOnError: false,
        optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
      },
      out: join(temporary, 'output'),
      ...(process.env.RDS_ELECTRON_ZIP_DIR ? { electronZipDir: process.env.RDS_ELECTRON_ZIP_DIR } : {}),
    })
    const appName = productName + '.app'
    const appPath = join(output, appName)
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement',
      '=certificate leaf = H"' + signing.identity + '" and identifier "build.rainbowdeskmates.desktop"', appPath])
    const requirementsOutput = spawnSync('/usr/bin/codesign', ['--display', '-r-', appPath], { encoding: 'utf8' })
    if (requirementsOutput.error) throw requirementsOutput.error
    if (requirementsOutput.status !== 0) throw new Error('无法读取应用签名要求。')
    const requirement = /^#?\s*(designated => .+)$/m.exec(requirementsOutput.stdout + '\n' + requirementsOutput.stderr)?.[1]
    if (!requirement || /\bcdhash\b/.test(requirement)) throw new Error('应用签名身份未固定。')
    if (signing.requirement && signing.requirement !== requirement) throw new Error('本次应用签名要求与既有版本不一致。')
    if (!signing.requirement) await writeFile(signingFile, JSON.stringify({ ...signing, requirement }, null, 2) + '\n', { mode: 0o600 })
    await writeFile(stateTemporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    const destination = join(releaseDirectory, basename(output))
    await publishPackage(output, destination, stateTemporary)
    const sharedTemporary = sharedStateFile + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(sharedTemporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' })
      await rename(sharedTemporary, sharedStateFile)
    } finally { await rm(sharedTemporary, { force: true }) }
    console.log('Rainbow Mates v' + displayVersion)
    console.log(join(destination, appName))
  } finally {
    await rm(stateTemporary, { force: true })
    await rm(temporary, { recursive: true, force: true })
  }
}

async function publishPackage(output, destination, stateTemporary) {
  // Keep a signed build available if updating the version record or moving the app fails.
  const backup = destination + '.backup-' + randomUUID()
  const backedUp = await rename(destination, backup).then(() => true, error => {
    if (error.code !== 'ENOENT') throw error
    return false
  })
  try {
    await rename(stateTemporary, stateFile)
    await rename(output, destination)
  } catch (error) {
    if (backedUp) await rename(backup, destination)
    throw error
  }
  if (backedUp) await rm(backup, { recursive: true, force: true })
}
