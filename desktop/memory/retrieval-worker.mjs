import { parentPort, workerData } from 'node:worker_threads'
import { dimension, encoderVersion } from './encoder.mjs'
import { eligible, exactTerms, openMemoryDatabase, strength, terms } from './database.mjs'

const db = openMemoryDatabase(workerData, true)
const selectVectors = db.prepare(`SELECT m.*, v.vector FROM memory m JOIN vectors v ON v.memory_id=m.id AND v.version=m.version
  WHERE m.owner=? AND m.state='active' AND v.encoder=? AND v.dimension=?`)
const lexicalQuery = db.prepare(`SELECT m.*, words AS indexed_words, bm25(memory_fts) AS rank FROM memory_fts JOIN memory m ON m.id=memory_fts.memory_id
  WHERE memory_fts MATCH ? AND m.owner=? AND m.state='active' ORDER BY rank`)

const denseFloor = 0.49
const stopWords = new Set(('a an the of is are am was were what who where how which do does did to in at on my i me can should ' +
  'could would it its he she they their you your and or for during from with as that this before after by about ' +
  '是否 什么 怎么 如何 之前 上次 一个 这个 那个 时候 可以 哪个 哪些 已经 是否 需要').split(' '))

function search(owner, query, vector, now, scope) {
  const dense = new Map()
  if (vector) {
    for (const row of selectVectors.iterate(owner, encoderVersion, dimension)) {
      if (!eligible(row, now) || row.vector.byteLength !== dimension * 4) continue
      const bytes = new DataView(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength)
      let similarity = 0, magnitude = 0
      for (let index = 0; index < dimension; index++) {
        const value = bytes.getFloat32(index * 4, true)
        similarity += value * vector[index]
        magnitude += value * value
      }
      similarity /= Math.sqrt(magnitude)
      if (!Number.isFinite(similarity) || similarity < denseFloor) continue
      const previous = dense.get(row.id)
      if (!previous || previous.similarity < similarity) dense.set(row.id, { row, similarity })
    }
  }
  const semantic = [...dense.values()].sort((a, b) => b.similarity - a.similarity).slice(0, 20)
  const words = terms(query).filter(word => word.length > 1 && !stopWords.has(word)).slice(0, 24)
  const lexical = []
  if (words.length) {
    const phrase = words.map(word => '"' + word.replaceAll('"', '""') + '"').join(' OR ')
    for (const row of lexicalQuery.iterate(phrase, owner)) {
      if (!eligible(row, now)) continue
      const indexed = new Set(row.indexed_words.split(' '))
      const overlap = words.reduce((count, word) => count + Number(indexed.has(word)), 0)
      if (overlap < Math.min(words.length, 2)) continue
      lexical.push(row)
      if (lexical.length === 20) break
    }
  }
  const fields = exactTerms(query)
  const exact = fields.length ? db.prepare(`SELECT m.*, count(*) AS hits FROM fields f JOIN memory m ON m.id=f.memory_id
    WHERE f.owner=? AND m.state='active' AND f.field IN (${fields.map(() => '?').join(',')})
    GROUP BY m.id ORDER BY hits DESC`).all(owner, ...fields).filter(row => eligible(row, now)).slice(0, 20) : []
  const combined = new Map()
  function add(row, score, similarity) {
    const existing = combined.get(row.id)
    if (existing) existing.score += score
    else combined.set(row.id, {
      id: row.id, version: row.version,
      score: score + (scope && row.scope === scope ? 0.018 : 0), similarity,
      strength: strength(row, now), importance: row.importance,
    })
  }
  semantic.forEach(({ row, similarity }, rank) => add(row, 2 / (20 + rank) + 0.35 * (similarity - denseFloor), similarity))
  lexical.forEach((row, rank) => add(row, 0.25 / (20 + rank)))
  exact.forEach((row, rank) => add(row, 1.3 / (20 + rank)))
  return [...combined.values()].sort((a, b) => b.score - a.score || b.strength - a.strength || b.importance - a.importance)
}

parentPort.on('message', ({ id, args }) => {
  try {
    db.exec('BEGIN')
    const result = search(...args)
    db.exec('COMMIT')
    parentPort.postMessage({ id, result })
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    parentPort.postMessage({ id, error: error.message })
  }
})
