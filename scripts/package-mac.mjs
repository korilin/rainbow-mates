import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'

if (process.platform !== 'darwin') throw new Error('请在 macOS 上构建应用包。')

const project = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const { version: electronVersion } = require('electron/package.json')
const { name, productName, version, main, type } = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
const temporary = await mkdtemp(join(tmpdir(), 'rainbow-package-'))

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
  await writeFile(join(source, 'package.json'), JSON.stringify({ name, productName, version, main, type }))
  const [output] = await packager({
    dir: source, name: productName, platform: 'darwin', arch: process.arch, electronVersion,
    appBundleId: 'build.rainbowdeskmates.desktop', appCategoryType: 'public.app-category.productivity',
    icon, asar: true, prune: false,
    osxSign: {
      identity: '-', identityValidation: false, preAutoEntitlements: false, continueOnError: false,
      optionsForFile: () => ({ hardenedRuntime: false }),
    },
    out: join(project, '.release'), overwrite: true,
    ...(process.env.RDS_ELECTRON_ZIP_DIR ? { electronZipDir: process.env.RDS_ELECTRON_ZIP_DIR } : {}),
  })
  const bundle = join(output, productName + '.app')
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
  console.log(bundle)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
