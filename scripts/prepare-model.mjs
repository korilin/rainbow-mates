import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cachedModel, modelRevision, modelHash, modelWeights } from '../desktop/memory/encoder.mjs'

const script = fileURLToPath(import.meta.url)
const cache = cachedModel()
const manifestFile = fileURLToPath(new URL('../build/models/bge-m3-manifest.json', import.meta.url))

async function matches(path, entry) {
  try {
    if ((await stat(path)).size !== entry.bytes) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex') === entry.sha256
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function prepare() {
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  if (manifest.repository !== 'gpahal/bge-m3-onnx-int8' || manifest.revision !== modelRevision
    || !Array.isArray(manifest.files)
    || manifest.files.find(entry => entry.name === modelWeights)?.sha256 !== modelHash) {
    throw new Error('内置模型清单与固定版本不一致。')
  }
  await mkdir(cache, { recursive: true })
  for (const entry of manifest.files) {
    if (!/^[\w.-]+$/.test(entry.name) || ['.', '..'].includes(entry.name)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error('内置模型清单无效。')
    }
    const path = join(cache, entry.name)
    if (await matches(path, entry)) continue
    const partial = path + '.part'
    if (!await matches(partial, entry)) {
      const url = 'https://huggingface.co/' + manifest.repository + '/resolve/' + modelRevision + '/' + entry.name
      console.log('准备内置模型 ' + entry.name + ' (' + Math.round(entry.bytes / 1024 ** 2) + ' MB)')
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          execFileSync('/usr/bin/curl', ['--fail', '--location', '--retry', '2', '--connect-timeout', '20',
            '--max-time', '1800', '--continue-at', '-', '--output', partial, url], { stdio: 'inherit' })
          if (await matches(partial, entry)) break
          throw new Error('内置模型 SHA-256 校验失败：' + entry.name)
        } catch (error) {
          if (attempt === 1) throw error
          await rm(partial, { force: true })
        }
      }
    }
    if (!await matches(partial, entry)) throw new Error('内置模型下载未完成：' + entry.name)
    await rename(partial, path)
  }
  const temporary = join(cache, 'rainbow-model-manifest.json.tmp')
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n')
  await rename(temporary, join(cache, 'rainbow-model-manifest.json'))
  console.log('内置模型已就绪（固定版本及 SHA-256 校验通过）。')
}

export function prepareMemoryModel() {
  execFileSync(process.execPath, [script], { stdio: 'inherit' })
}

if (process.argv[1] && script === process.argv[1]) {
  if (process.platform !== 'darwin') throw new Error('当前打包入口支持 macOS。')
  if (process.argv[2] === '--locked') await prepare()
  else {
    await mkdir(dirname(cache), { recursive: true })
    const result = spawnSync('/usr/bin/lockf', ['-k', join(dirname(cache), '.prepare.lock'), process.execPath, script, '--locked'], { stdio: 'inherit' })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  }
}
