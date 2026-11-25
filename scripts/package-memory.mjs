import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, cp, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { cachedModel, modelDirectory, modelHash, modelRevision, modelWeights } from '../desktop/memory/encoder.mjs'

const required = new Map([
  [modelWeights, [569_958_496, modelHash]],
  ['tokenizer.json', [17_082_799, '249df0778f236f6ece390de0de746838ef25b9d6954b68c2ee71249e0a9d8fd4']],
  ['tokenizer_config.json', [1203, 'b87c8703482b0300d3da30e201519aa641f6a450f5eb5bf1e624afbf70c74d80']],
])

export async function stageMemoryResources(project, source, temporary) {
  const cache = cachedModel()
  const manifestName = 'rainbow-model-manifest.json'
  const manifest = JSON.parse(await readFile(join(cache, manifestName), 'utf8'))
  if (manifest.repository !== 'gpahal/bge-m3-onnx-int8' || manifest.revision !== modelRevision || !Array.isArray(manifest.files)) {
    throw new Error('内置记忆模型版本不符合打包要求。')
  }
  const records = new Map(manifest.files.map(entry => [entry.name, entry]))
  for (const [name, [bytes, hash]] of required) {
    const entry = records.get(name)
    if (entry?.bytes !== bytes || entry.sha256 !== hash) throw new Error('内置记忆模型清单不匹配：' + name)
  }
  const target = join(temporary, modelDirectory)
  await mkdir(target)
  for (const [name, entry] of records) {
    if (!/^[\w.-]+$/u.test(name) || ['.', '..'].includes(name)) throw new Error('内置模型清单含无效文件名。')
    const output = join(target, name)
    await cp(join(cache, name), output, { dereference: true })
    await chmod(output, 0o644)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(output)) hash.update(chunk)
    if ((await stat(output)).size !== entry.bytes || hash.digest('hex') !== entry.sha256) {
      throw new Error('内置模型校验失败：' + name)
    }
  }
  await cp(join(cache, manifestName), join(target, manifestName))
  await cp(join(project, 'scripts', 'bge-m3-LICENSE'), join(target, 'LICENSE'))
  for (const name of ['@huggingface/tokenizers', 'onnxruntime-common', 'onnxruntime-node']) {
    const installed = join(project, 'node_modules', name)
    const destination = join(source, 'node_modules', name)
    const binaries = join(installed, 'bin', 'napi-v6')
    const currentMac = join(binaries, 'darwin', process.arch)
    if (name === 'onnxruntime-node') await stat(join(currentMac, 'onnxruntime_binding.node'))
    await cp(installed, destination, {
      recursive: true,
      filter: path => {
        if (name !== 'onnxruntime-node' || !path.startsWith(binaries + '/')) return true
        if (path === join(binaries, 'darwin') || path === currentMac) return true
        return path.startsWith(currentMac + '/') && !/libonnxruntime\.1\.\d+\.\d+\.dylib$/u.test(path)
      },
    })
  }
  return target
}
