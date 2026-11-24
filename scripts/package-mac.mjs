import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'
import { nextPackageVersion } from './package-version.mjs'

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
  const require = createRequire(import.meta.url)
  const { version: electronVersion } = require('electron/package.json')
  const { name, productName, version, main, type } = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
  const previous = await readFile(stateFile, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  const { displayVersion, macBuildVersion, state } = nextPackageVersion(version, previous === undefined ? undefined : JSON.parse(previous))
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
    const [output] = await packager({
      dir: source, name: productName, platform: 'darwin', arch: process.arch, electronVersion,
      appVersion: version, buildVersion: macBuildVersion, extendInfo: { RainbowMatesVersion: displayVersion },
      appBundleId: 'build.rainbowdeskmates.desktop', appCategoryType: 'public.app-category.productivity',
      icon, asar: { unpack: '**/*.node' }, prune: false,
      osxSign: {
        identity: '-', identityValidation: false, preAutoEntitlements: false, continueOnError: false,
        optionsForFile: () => ({ hardenedRuntime: false }),
      },
      out: join(temporary, 'output'),
      ...(process.env.RDS_ELECTRON_ZIP_DIR ? { electronZipDir: process.env.RDS_ELECTRON_ZIP_DIR } : {}),
    })
    const appName = productName + '.app'
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(output, appName)])
    await writeFile(stateTemporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    const destination = join(releaseDirectory, basename(output))
    await publishPackage(output, destination, stateTemporary)
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
