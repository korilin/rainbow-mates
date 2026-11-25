import { fork } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const modelRevision = '2b34e84df040034d4b9eabb62383a87c18955822'
export const modelDirectory = 'bge-m3-onnx-int8'
export const modelWeights = 'model_quantized.onnx'
export const modelHash = '16de7ea1146ca427e14938ec3e9abfdcaff0e6ac76434cd693ac35d761250bcb'
export const encoderVersion = 'gpahal/bge-m3-onnx-int8@' + modelRevision + ':hf-tokenizers-0.2.0:dense-l2-v1'
export const dimension = 1024
export const maxTokens = 1024
export const cachedModel = () => join(homedir(), 'Library', 'Caches', 'rainbow-mates', 'models', modelDirectory, modelRevision)

export class Encoder {
  constructor(directory, { idleMs = 5 * 60_000, timeoutMs = 45_000 } = {}) {
    Object.assign(this, { directory, idleMs, timeoutMs })
    this.foreground = []
    this.background = []
  }

  encode(texts, { split = false, priority = true } = {}) {
    if (this.closed) return Promise.reject(new Error('记忆编码器已关闭。'))
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > 2
      || texts.some(text => typeof text !== 'string' || !text.trim() || text.length > 16_000)) {
      return Promise.reject(new Error('记忆编码内容无效。'))
    }
    return new Promise((resolve, reject) => {
      const queue = priority ? this.foreground : this.background
      queue.push({ texts, split, resolve, reject })
      this.pump()
    })
  }

  pump() {
    if (this.current || this.closed) return
    const next = this.foreground.shift() || this.background.shift()
    if (!next) {
      if (this.child) this.idle = setTimeout(() => this.release(), this.idleMs).unref()
      return
    }
    clearTimeout(this.idle)
    try {
      if (!this.child) this.start()
      this.current = next
      this.deadline = setTimeout(() => {
        this.release(new Error('本机记忆编码超时。'))
        this.pump()
      }, this.timeoutMs).unref()
      this.child.send({ texts: next.texts, split: next.split })
    } catch (error) {
      if (this.current === next) this.release(error)
      else next.reject(error)
      this.pump()
    }
  }

  start() {
    const child = fork(fileURLToPath(new URL('./encoder-process.mjs', import.meta.url)), [this.directory], {
      execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced',
    })
    this.child = child
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', data => { stderr = (stderr + data).slice(-1200) })
    const ended = error => {
      if (this.child !== child) return
      this.release(error)
      this.pump()
    }
    child.on('error', ended)
    child.once('exit', (code, signal) => ended(new Error(stderr.trim() || '记忆编码进程已退出 (' + (signal || code) + ')。')))
    child.on('message', ({ result, error }) => {
      if (this.child !== child || !this.current) return
      const current = this.current
      this.current = null
      clearTimeout(this.deadline)
      if (error) current.reject(new Error(error))
      else current.resolve(result)
      this.pump()
    })
  }

  release(error) {
    clearTimeout(this.idle)
    clearTimeout(this.deadline)
    const child = this.child
    this.child = null
    child?.kill()
    this.current?.reject(error || new Error('记忆编码进程已退出。'))
    this.current = null
  }

  close() {
    this.closed = true
    const error = new Error('记忆编码器已关闭。')
    this.release(error)
    for (const request of [...this.foreground, ...this.background]) request.reject(error)
    this.foreground.length = 0
    this.background.length = 0
  }
}
