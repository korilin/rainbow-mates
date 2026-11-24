import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url)
  const { include_dir: headers } = require('node-api-headers')
  const file = path => fileURLToPath(new URL(path, import.meta.url))
  mkdirSync(file('../desktop/native'), { recursive: true })
  execFileSync('/usr/bin/xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-O2', '-DNAPI_VERSION=8', '-bundle',
    '-undefined', 'dynamic_lookup', '-I', headers, '-framework', 'AppKit', '-framework', 'ApplicationServices',
    file('../native/computer.mm'), '-o', file('../desktop/native/computer.node')], { stdio: 'inherit' })
}
