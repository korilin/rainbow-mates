import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { encoderVersion, dimension } from './encoder.mjs'

export const day = 86_400_000
export const retentionFloor = 20
export const halfLife = (importance, complexity, count) => Math.min(Math.max(importance - complexity + count, 1), 10) ** 2
export const strength = (row, now) => row.start_strength * 0.5 ** (
  Math.max(0, now - row.started_at) / day / halfLife(row.importance, row.complexity, row.recall_count))
export const eligible = (row, now) => row?.state === 'active' && (row.valid_until === null || row.valid_until > now)
  && strength(row, now) >= retentionFloor

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
export const terms = text => [...new Set(Array.from(segmenter.segment(text.normalize('NFKC').toLowerCase()))
  .filter(part => part.isWordLike).map(part => part.segment))].slice(0, 128)
export const exactTerms = text => [...new Set((text.normalize('NFKC').toLowerCase()
  .match(/[a-z0-9]+(?:[_./:@-][a-z0-9]+)+|\b[a-z]+\d+[a-z0-9]*\b/g) || []))].slice(0, 48)

export function openMemoryDatabase(filename, readOnly = false) {
  const db = new DatabaseSync(filename, { readOnly, timeout: 3000 })
  db.exec('PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;')
  return db
}

export class MemoryDatabase {
  constructor(filename) {
    this.filename = filename
    this.db = openMemoryDatabase(filename)
    chmodSync(filename, 0o600)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, version INTEGER NOT NULL,
        state TEXT NOT NULL, body TEXT, fact_key TEXT, subject TEXT, scope TEXT,
        cardinality TEXT, evidence TEXT, valid_until INTEGER, importance INTEGER NOT NULL,
        complexity INTEGER NOT NULL, recall_count INTEGER NOT NULL, start_strength REAL NOT NULL,
        started_at INTEGER NOT NULL, replaced_by TEXT, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memory_active ON memory(owner, state);
      CREATE INDEX IF NOT EXISTS memory_fact ON memory(owner, fact_key, subject, scope, state);
      CREATE TABLE IF NOT EXISTS vectors (
        memory_id TEXT NOT NULL REFERENCES memory(id), version INTEGER NOT NULL,
        encoder TEXT NOT NULL, dimension INTEGER NOT NULL, segment INTEGER NOT NULL, vector BLOB NOT NULL,
        PRIMARY KEY (memory_id, encoder, segment)
      ) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED, owner UNINDEXED, words);
      CREATE TABLE IF NOT EXISTS fields (
        owner TEXT NOT NULL, field TEXT NOT NULL, memory_id TEXT NOT NULL REFERENCES memory(id),
        PRIMARY KEY(owner, field, memory_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, id TEXT NOT NULL, ref TEXT NOT NULL,
        kind TEXT NOT NULL, speaker TEXT NOT NULL, body TEXT, scope TEXT, at INTEGER NOT NULL, event_id TEXT NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0, UNIQUE(owner, id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS source_pending ON source(owner, consumed, seq);
      CREATE TABLE IF NOT EXISTS evidence (
        memory_id TEXT NOT NULL REFERENCES memory(id), source_seq INTEGER NOT NULL REFERENCES source(seq),
        PRIMARY KEY(memory_id, source_seq)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS evidence_source ON evidence(source_seq, memory_id);
      CREATE TABLE IF NOT EXISTS receipt (
        owner TEXT NOT NULL, memory_id TEXT NOT NULL REFERENCES memory(id), event_id TEXT NOT NULL,
        result_ref TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY(owner, memory_id, event_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS owner_state (
        owner TEXT PRIMARY KEY, watermark INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0, error TEXT, last_active INTEGER NOT NULL DEFAULT 0,
        last_organized TEXT, dirty INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS index_state (id INTEGER PRIMARY KEY CHECK(id=1), encoder TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS injected (
        owner TEXT NOT NULL, thread_id TEXT NOT NULL, memory_id TEXT NOT NULL REFERENCES memory(id),
        version INTEGER NOT NULL, PRIMARY KEY(owner, thread_id, memory_id)
      ) STRICT;
    `)
    const legacy = this.get('SELECT encoder FROM vectors ORDER BY rowid LIMIT 1')?.encoder
    this.run('INSERT OR IGNORE INTO index_state VALUES(1,?)', legacy || encoderVersion)
  }

  indexVersion() { return this.get('SELECT encoder FROM index_state WHERE id=1').encoder }

  lackingVectors(now, limit = 2) {
    const missing = this.db.prepare(`SELECT m.* FROM memory m WHERE m.state='active' AND NOT EXISTS (
      SELECT 1 FROM vectors v WHERE v.memory_id=m.id AND v.version=m.version AND v.encoder=? AND v.dimension=?
    ) ORDER BY m.updated_at`)
    const rows = []
    for (const row of missing.iterate(encoderVersion, dimension)) {
      if (eligible(row, now)) rows.push(row)
      if (rows.length >= limit) break
    }
    return rows
  }

  stageVectors(rows, vectors, now) {
    return this.transaction(() => {
      for (const [index, staged] of rows.entries()) {
        const row = this.row(staged.owner, staged.id)
        if (eligible(row, now) && row.version === staged.version) this.putVectors(row.id, row.version, vectors[index])
      }
      if (this.lackingVectors(now, 1).length) return false
      this.run('UPDATE index_state SET encoder=? WHERE id=1', encoderVersion)
      this.run('DELETE FROM vectors WHERE encoder<>?', encoderVersion)
      return true
    })
  }

  get(sql, ...values) { return this.db.prepare(sql).get(...values) }
  all(sql, ...values) { return this.db.prepare(sql).all(...values) }
  run(sql, ...values) { return this.db.prepare(sql).run(...values) }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  capture(owner, eventId, sources, now) {
    if (!sources.length) return
    this.transaction(() => {
      this.touch(owner, now)
      for (const source of sources) {
        if (!source.body?.trim()) continue
        this.run(`INSERT OR IGNORE INTO source(owner,id,ref,kind,speaker,body,scope,at,event_id) VALUES(?,?,?,?,?,?,?,?,?)`,
          owner, source.id, source.ref, source.kind, source.speaker, source.body.slice(0, 16_000), source.scope ?? null, source.at ?? now, eventId)
      }
    })
  }

  touch(owner, now) {
    this.run(`INSERT INTO owner_state(owner,last_active) VALUES(?,?)
      ON CONFLICT(owner) DO UPDATE SET last_active=max(last_active,excluded.last_active)`, owner, now)
  }

  pending(owner, through = Number.MAX_SAFE_INTEGER, limit = 12) {
    return this.all('SELECT * FROM source WHERE owner=? AND consumed=0 AND seq<=? ORDER BY seq LIMIT ?', owner, through, limit)
  }

  hasSource(owner, id) { return Boolean(this.get('SELECT 1 AS seen FROM source WHERE owner=? AND id=?', owner, id)) }

  watermarkTarget(owner) {
    return this.get('SELECT max(seq) AS seq FROM source WHERE owner=? AND consumed=0', owner).seq
  }

  state(owner) { return this.get('SELECT * FROM owner_state WHERE owner=?', owner) }

  recordFailure(owner, error, now) {
    const attempts = (this.state(owner)?.attempts || 0) + 1
    this.run('UPDATE owner_state SET attempts=?, retry_at=?, error=? WHERE owner=?',
      attempts, now + Math.min(15 * 60_000, 1000 * 2 ** Math.min(attempts, 10)), error.slice(0, 240), owner)
  }

  recent(owner, now, limit = 16) {
    return this.all("SELECT * FROM memory WHERE owner=? AND state='active' ORDER BY updated_at DESC LIMIT ?", owner, limit * 2)
      .filter(row => eligible(row, now)).slice(0, limit)
  }

  row(owner, id) { return this.get('SELECT * FROM memory WHERE owner=? AND id=?', owner, id) }

  describe(row, now, contextScope) {
    const sources = this.all(`SELECT s.id,s.ref,s.kind,s.speaker,s.at FROM evidence e JOIN source s ON s.seq=e.source_seq
      WHERE e.memory_id=? AND s.owner=? ORDER BY s.seq LIMIT 12`, row.id, row.owner)
    if (!sources.length) return null
    const directEvidenceAt = this.get(`SELECT max(s.at) AS at FROM evidence e JOIN source s ON s.seq=e.source_seq
      WHERE e.memory_id=? AND s.owner=? AND s.kind='user' AND s.speaker='user'`, row.id, row.owner).at
    const peers = row.cardinality === 'single' ? this.all(`SELECT * FROM memory WHERE owner=? AND fact_key=? AND subject=?
      AND scope=? AND state='active' AND id<>?`, row.owner, row.fact_key, row.subject, row.scope, row.id)
      .filter(item => eligible(item, now)) : []
    const reasons = []
    if (row.evidence === 'unverified') {
      reasons.push('unverified_source')
      if (peers.some(item => item.evidence === 'user')) reasons.push('direct_evidence_available')
    }
    if (row.scope && row.scope !== contextScope) reasons.push('scope_requires_verification')
    if (peers.some(item => item.evidence === row.evidence)) reasons.push('conflicting_evidence')
    return { id: row.id, version: row.version, body: row.body, factKey: row.fact_key, subject: row.subject,
      scope: row.scope, cardinality: row.cardinality, evidence: row.evidence, validUntil: row.valid_until,
      importance: row.importance, complexity: row.complexity, sources, reasons, directEvidenceAt }
  }

  rowsFor(owner, matches, now, scope) {
    return matches.flatMap(({ id, version }) => {
      const row = this.row(owner, id)
      if (!eligible(row, now) || row.version !== version) return []
      const described = this.describe(row, now, scope)
      return described ? [described] : []
    })
  }

  clearIndex(id) {
    this.run('DELETE FROM vectors WHERE memory_id=?', id)
    this.run('DELETE FROM fields WHERE memory_id=?', id)
    this.run('DELETE FROM memory_fts WHERE memory_id=?', id)
  }

  retire(row, state, now, replacement = null) {
    this.clearIndex(row.id)
    this.run('UPDATE memory SET state=?, replaced_by=?, updated_at=? WHERE id=?', state, replacement, now, row.id)
  }

  index(owner, id, version, operation) {
    const words = [operation.body, operation.factKey, ...operation.aliases].join(' ')
    this.run('INSERT INTO memory_fts VALUES(?,?,?)', id, owner, terms(words).join(' '))
    for (const field of exactTerms(words)) this.run('INSERT INTO fields VALUES(?,?,?)', owner, field, id)
    this.putVectors(id, version, operation.vectors)
  }

  putVectors(id, version, vectors) {
    this.run('DELETE FROM vectors WHERE memory_id=? AND encoder=?', id, encoderVersion)
    for (const [segment, vector] of vectors.entries()) {
      this.run('INSERT INTO vectors VALUES(?,?,?,?,?,?)', id, version, encoderVersion, dimension, segment,
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength))
    }
  }

  resolveTargets(owner, operation, now, allowPendingCorrection = false) {
    return operation.targets.map(target => {
      const row = this.row(owner, target.id)
      const correcting = allowPendingCorrection && row?.state === 'correcting' && operation.op === 'correct'
      if ((!correcting && !eligible(row, now)) || row.version !== target.version) throw new Error('记忆版本已变更。')
      return row
    })
  }

  markCorrections(owner, operations, now) {
    this.transaction(() => {
      for (const operation of operations.filter(item => item.op === 'correct')) {
        for (const target of this.resolveTargets(owner, operation, now, true)) {
          this.run("UPDATE memory SET state='correcting' WHERE id=?", target.id)
        }
      }
    })
  }

  commit(owner, batch, operations, now, organizedDay) {
    this.transaction(() => {
      for (const source of batch) {
        if (this.get('SELECT consumed FROM source WHERE owner=? AND seq=?', owner, source.seq)?.consumed !== 0) {
          throw new Error('经历已被其他作业处理。')
        }
      }
      for (const operation of operations) this.apply(owner, operation, now)
      for (const source of batch) this.run('UPDATE source SET consumed=1 WHERE owner=? AND seq=?', owner, source.seq)
      const through = batch.at(-1)?.seq ?? 0
      this.run(`UPDATE owner_state SET watermark=max(watermark,?), attempts=0, retry_at=0, error=NULL,
        dirty=CASE WHEN ? IS NOT NULL THEN 0 WHEN ?>0 THEN 1 ELSE dirty END,
        last_organized=coalesce(?,last_organized) WHERE owner=?`, through, organizedDay ?? null,
      operations.length, organizedDay ?? null, owner)
      // A retry can choose a different correction operation. Purge any superseded drafts only after the batch commits.
      if (batch.length) {
        for (const row of this.all("SELECT * FROM memory WHERE owner=? AND state='correcting'", owner)) this.retire(row, 'corrected', now)
      }
      this.cleanup(owner, now)
    })
  }

  apply(owner, operation, now) {
    const targets = this.resolveTargets(owner, operation, now, true)
    const [old] = targets
    if (operation.op === 'forget') {
      this.retire(old, 'forgotten', now)
      return
    }
    if (operation.op === 'score') {
      this.run('UPDATE memory SET importance=?, complexity=?, start_strength=?, started_at=?, updated_at=? WHERE id=?',
        operation.importance, operation.complexity, strength(old, now), now, now, old.id)
      return
    }
    if (operation.op === 'add') {
      const duplicate = this.get(`SELECT * FROM memory WHERE owner=? AND state='active' AND fact_key=? AND subject=?
        AND scope=? AND body=? AND cardinality=? AND valid_until IS ? AND evidence=?`, owner, operation.factKey,
      operation.subject, operation.scope, operation.body, operation.cardinality, operation.validUntil, operation.evidence)
      const directAt = Math.max(0, ...operation.sources.filter(source => source.kind === 'user' && source.speaker === 'user').map(source => source.at))
      if (!duplicate && operation.evidence === 'user' && operation.cardinality === 'single') {
        const newer = this.get(`SELECT 1 AS found FROM memory m JOIN evidence e ON e.memory_id=m.id JOIN source s ON s.seq=e.source_seq
          WHERE m.owner=? AND m.state='active' AND m.evidence='user' AND m.fact_key=? AND m.subject=? AND m.scope=?
          AND s.owner=m.owner AND s.kind='user' AND s.speaker='user' AND s.at>? LIMIT 1`,
        owner, operation.factKey, operation.subject, operation.scope, directAt)
        if (newer) return
      }
      if (eligible(duplicate, now)) {
        for (const source of operation.sources) this.run('INSERT OR IGNORE INTO evidence VALUES(?,?)', duplicate.id, source.seq)
        return
      }
    }
    const inherits = ['revise', 'merge'].includes(operation.op)
    const id = operation.op === 'revise' ? old.id : randomUUID()
    const version = operation.op === 'revise' ? old.version + 1 : 1
    const count = inherits ? Math.max(...targets.map(row => row.recall_count)) : 1
    const initial = inherits ? Math.max(...targets.map(row => strength(row, now))) : 100
    const values = [version, operation.body, operation.factKey, operation.subject, operation.scope, operation.cardinality,
      operation.evidence, operation.validUntil, operation.importance, operation.complexity, count, initial, now, now]
    if (operation.op === 'revise') {
      this.clearIndex(id)
      this.run(`UPDATE memory SET version=?,body=?,fact_key=?,subject=?,scope=?,cardinality=?,evidence=?,valid_until=?,
        importance=?,complexity=?,recall_count=?,start_strength=?,started_at=?,updated_at=? WHERE id=?`, ...values, id)
    } else {
      this.run(`INSERT INTO memory(id,owner,state,version,body,fact_key,subject,scope,cardinality,evidence,valid_until,
        importance,complexity,recall_count,start_strength,started_at,updated_at) VALUES(?,?,'active',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, owner, ...values)
    }
    for (const source of operation.sources) this.run('INSERT OR IGNORE INTO evidence VALUES(?,?)', id, source.seq)
    for (const target of targets) {
      if (target.id === id) continue
      this.retire(target, operation.op === 'correct' ? 'corrected' : 'merged', now, id)
      if (operation.op === 'merge') {
        this.run('INSERT OR IGNORE INTO evidence SELECT ?, source_seq FROM evidence WHERE memory_id=?', id, target.id)
        this.run(`INSERT OR IGNORE INTO receipt SELECT owner,?,event_id,result_ref,reason,at FROM receipt
          WHERE owner=? AND memory_id=?`, id, owner, target.id)
      }
    }
    this.index(owner, id, version, operation)
  }

  cleanup(owner, now) {
    for (const row of this.all(`SELECT * FROM memory WHERE owner=? AND (state='active' OR (state<>'correcting' AND body IS NOT NULL))`, owner)) {
      if (eligible(row, now)) continue
      if (row.state === 'active') this.retire(row, 'expired', now)
      this.run('UPDATE memory SET body=NULL,fact_key=NULL,subject=NULL,scope=NULL,cardinality=NULL,evidence=NULL WHERE id=?', row.id)
      this.run('DELETE FROM evidence WHERE memory_id=?', row.id)
      this.run("UPDATE receipt SET reason='' WHERE memory_id=?", row.id)
    }
    this.run(`UPDATE source SET body=NULL WHERE owner=? AND consumed=1 AND body IS NOT NULL`, owner)
  }

  use(owner, eventId, resultRef, uses, sent, now) {
    this.transaction(() => {
      for (const use of uses) {
        const row = this.row(owner, use.id)
        if (sent.get(use.id) !== use.version || !eligible(row, now) || row.version !== use.version) continue
        const inserted = this.run('INSERT OR IGNORE INTO receipt VALUES(?,?,?,?,?,?)', owner, row.id, eventId, resultRef, use.reason, now)
        if (inserted.changes) this.run('UPDATE memory SET recall_count=recall_count+1,start_strength=100,started_at=? WHERE id=?', now, row.id)
      }
    })
  }

  acceptContext(owner, threadId, sent) {
    if (!threadId || !sent.size) return
    this.transaction(() => {
      for (const [id, version] of sent) {
        this.run('INSERT OR IGNORE INTO injected VALUES(?,?,?,?)', owner, threadId, id, version)
      }
    })
  }

  staleContext(owner, threadId, now) {
    return this.all(`SELECT m.*, i.version AS injected_version FROM injected i JOIN memory m ON m.id=i.memory_id
      WHERE i.owner=? AND i.thread_id=?`, owner, threadId).some(row => !eligible(row, now) || row.version !== row.injected_version)
  }

  discardContext(owner, threadId) { this.run('DELETE FROM injected WHERE owner=? AND thread_id=?', owner, threadId) }
  close() { this.db.close() }
}
