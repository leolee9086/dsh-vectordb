import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolveSidecarBinary } from '@leolee9086/vectordb'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

/**
 * Windows 的工作区构建产物可能继承 Low 完整性标签。
 * 宿主把可信包产物安装到自己的运行时缓存，再从那里启动；不改工作区 ACL，
 * 也不改变调用进程的令牌。受限调用者仍受其令牌限制。
 * 以内容散列分版本，避免升级时覆盖尚在运行的 exe。
 */
export async function prepareSidecarBinary(config = {}) {
  const source = resolveSidecarBinary(config.binary)
  if (process.platform !== 'win32' || config.cacheBinary === false) return source
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const root = config.binaryCachePath ?? join(home, 'cache', 'vectordb-runtime')
  const bytes = await readFile(source)
  const hash = digest(bytes)
  const directory = join(root, hash)
  const target = join(directory, 'vectordb-sidecar.exe')
  const verify = async () => {
    try {
      if (digest(await readFile(target)) !== hash) throw new Error('向量侧车运行时缓存校验失败：' + target)
      return true
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }
  if (await verify()) return target
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, randomUUID() + '.tmp')
  try {
    // 只写字节，让新文件继承安装位置的描述符；不复制工作区的安全描述符。
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o700 })
    try {
      await rename(temporary, target)
    } catch (error) {
      // 两个宿主同时安装同一版本时，另一方写成的内容必须经过同样的校验。
      if (!await verify()) throw error
    }
    if (!await verify()) throw new Error('向量侧车安装后文件缺失')
    return target
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error })
  }
}
