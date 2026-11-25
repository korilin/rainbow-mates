import { Worker } from 'node:worker_threads'

export class Retrieval {
  constructor(filename) {
    this.filename = filename
    this.requests = new Map()
    this.sequence = 0
  }

  search(...args) {
    if (this.closed) return Promise.reject(new Error('记忆检索已关闭。'))
    if (!this.worker) this.start()
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject })
      this.worker.ref()
      this.worker.postMessage({ id, args })
    })
  }

  start() {
    const worker = new Worker(new URL('./retrieval-worker.mjs', import.meta.url), { workerData: this.filename, execArgv: [] })
    this.worker = worker
    worker.on('message', ({ id, result, error }) => {
      const request = this.requests.get(id)
      if (!request) return
      this.requests.delete(id)
      if (!this.requests.size) worker.unref()
      if (error) request.reject(new Error(error))
      else request.resolve(result)
    })
    const ended = error => {
      if (this.worker !== worker) return
      this.worker = null
      for (const request of this.requests.values()) request.reject(error)
      this.requests.clear()
    }
    worker.once('error', ended)
    worker.once('exit', () => ended(new Error('记忆检索进程已退出。')))
  }

  close() {
    this.closed = true
    for (const request of this.requests.values()) request.reject(new Error('记忆检索已关闭。'))
    this.requests.clear()
    void this.worker?.terminate()
  }
}
