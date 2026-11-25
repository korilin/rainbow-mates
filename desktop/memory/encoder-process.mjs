import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Tokenizer } from '@huggingface/tokenizers'
import ort from 'onnxruntime-node'
import { dimension, encoderVersion, maxTokens, modelWeights } from './encoder.mjs'

const directory = process.argv[2]
const readJson = async file => JSON.parse(await readFile(join(directory, file), 'utf8'))
let pipeline

async function load() {
  const [json, config] = await Promise.all(['tokenizer.json', 'tokenizer_config.json'].map(readJson))
  const tokenizer = new Tokenizer(json, config)
  const session = await ort.InferenceSession.create(join(directory, modelWeights), {
    executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1, logSeverityLevel: 3,
  })
  return { tokenizer, session, pad: tokenizer.encode('<pad>', { add_special_tokens: false }).ids[0] ?? 1 }
}

function chunks(text, tokenizer) {
  const budget = maxTokens - 2
  const count = value => tokenizer.encode(value, { add_special_tokens: false }).ids.length
  const parts = []
  const split = value => {
    if (count(value) <= budget) { parts.push(value); return }
    const chars = Array.from(value)
    const middle = Math.ceil(chars.length / 2)
    split(chars.slice(0, middle).join(''))
    split(chars.slice(middle).join(''))
  }
  for (const sentence of text.match(/[^。！？.!?\n]+[。！？.!?\n]*|[。！？.!?\n]+/gu) || [text]) split(sentence)
  const result = []
  let active = ''
  for (const part of parts) {
    if (active && count(active + part) > budget) {
      if (active.trim()) result.push(active.trim())
      active = ''
    }
    active += part
  }
  if (active.trim()) result.push(active.trim())
  return result
}

async function infer({ tokenizer, session, pad }, texts) {
  const rows = texts.map(text => {
    const { ids } = tokenizer.encode(text, { add_special_tokens: true })
    return ids.length <= maxTokens ? ids : [...ids.slice(0, maxTokens - 1), ids.at(-1)]
  })
  const width = Math.max(...rows.map(row => row.length))
  const size = rows.length * width
  const ids = new BigInt64Array(size).fill(BigInt(pad))
  const mask = new BigInt64Array(size)
  for (const [index, row] of rows.entries()) {
    ids.set(row.map(BigInt), index * width)
    mask.fill(1n, index * width, index * width + row.length)
  }
  const shape = [rows.length, width]
  const feeds = {
    input_ids: new ort.Tensor('int64', ids, shape),
    attention_mask: new ort.Tensor('int64', mask, shape),
  }
  if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(size), shape)
  const { dense_vecs: dense } = await session.run(feeds, ['dense_vecs'])
  if (dense.dims[0] !== rows.length || dense.dims[1] !== dimension) throw new Error('内置模型返回了无效的向量维度。')
  return rows.map((_, index) => {
    const data = dense.data.slice(index * dimension, (index + 1) * dimension)
    const norm = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0))
    if (!Number.isFinite(norm) || norm === 0) throw new Error('内置模型返回了无效的向量。')
    return Float32Array.from(data, value => value / norm)
  })
}

process.on('message', async ({ texts, split }) => {
  try {
    const engine = await (pipeline ||= load().catch(error => { pipeline = null; throw error }))
    const result = []
    for (const text of texts) {
      const pieces = split ? chunks(text, engine.tokenizer) : [text]
      const vectors = []
      for (let index = 0; index < pieces.length; index += 2) vectors.push(...await infer(engine, pieces.slice(index, index + 2)))
      result.push(vectors)
    }
    process.send({ result: { version: encoderVersion, dimension, vectors: result, peakRssKiB: process.resourceUsage().maxRSS } })
  } catch (error) {
    process.send({ error: String(error.message).slice(0, 1000) })
  }
})
process.on('disconnect', () => process.exit())
