import { createHash, X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const folder = fileURLToPath(new URL('../build/signing/', import.meta.url))
const stateDirectory = join(homedir(), 'Library', 'Application Support', 'Rainbow Mates Build')
const configurationFile = join(stateDirectory, 'signing.json')

function identities(keychain, validOnly = false) {
  return execFileSync('/usr/bin/security', ['find-identity', ...(validOnly ? ['-v'] : []), '-p', 'codesigning', keychain], { encoding: 'utf8' })
}

export async function prepareSigning() {
  if (process.platform !== 'darwin') throw new Error('固定签名初始化需要 macOS。')
  const pinned = JSON.parse(await readFile(join(folder, 'identity.json'), 'utf8'))
  const certificateFile = join(folder, 'certificate.pem')
  const archiveFile = join(folder, 'identity.p12')
  const certificate = new X509Certificate(await readFile(certificateFile))
  if (!/^[A-Fa-f0-9]{40}$/.test(pinned.identity)
    || certificate.fingerprint.replaceAll(':', '') !== pinned.identity.toUpperCase()
    || createHash('sha256').update(await readFile(archiveFile)).digest('hex') !== pinned.archiveSha256) {
    throw new Error('固定签名备份或证书指纹不匹配。')
  }
  const keychain = execFileSync('/usr/bin/security', ['default-keychain', '-d', 'user'], { encoding: 'utf8' }).trim().replace(/^"|"$/g, '')
  const hasIdentity = validOnly => identities(keychain, validOnly).toUpperCase().includes(pinned.identity.toUpperCase())
  if (!hasIdentity(false)) {
    const temporary = await mkdtemp(join(tmpdir(), 'rainbow-import-signing-'))
    try {
      const helper = join(temporary, 'Rainbow Signing Restore')
      execFileSync('/usr/bin/swiftc', [fileURLToPath(new URL('./import-signing.swift', import.meta.url)), '-o', helper], { stdio: 'inherit' })
      console.log('请在系统弹窗中输入签名备份密码并完成钥匙串授权。')
      execFileSync(helper, [archiveFile, keychain], { stdio: 'inherit' })
    } finally { await rm(temporary, { recursive: true, force: true }) }
    if (!hasIdentity(false)) throw new Error('未能恢复指定的固定签名身份。')
  }
  if (!hasIdentity(true)) {
    console.log('请在系统弹窗中允许本机信任 Rainbow Mates 的代码签名证书。')
    execFileSync('/usr/bin/security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-k', keychain, certificateFile], { stdio: 'inherit' })
    if (!hasIdentity(true)) throw new Error('固定签名证书尚未取得本机代码签名信任。')
  }
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  const signing = { identity: pinned.identity, name: pinned.name, requirement: pinned.requirement, keychain }
  await writeFile(configurationFile + '.tmp', JSON.stringify(signing, null, 2) + '\n', { mode: 0o600 })
  await rename(configurationFile + '.tmp', configurationFile)
  await writeFile(join(stateDirectory, 'signing-certificate.pem'), await readFile(certificateFile), { mode: 0o600 })
  console.log('固定签名身份已就绪。')
  return signing
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await prepareSigning()
