// Inspect only the requested thread's kernel writer lock. File existence, saved
// PIDs and timestamps are never ownership evidence. No lock file is modified.
import fs from 'node:fs'
import path from 'node:path'

export function writerStatus(home, threadId, platform = process.platform, proc = '/proc') {
  if (typeof threadId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(threadId)) return { status: 'unknown' }
  if (platform !== 'linux') return { status: 'unknown' }
  try {
    const file = path.join(home, 'thread-writer-locks', `${threadId}.lock`)
    let stat
    try { stat = fs.statSync(file, { bigint: true }) } catch (error) {
      if (error.code === 'ENOENT') return { status: 'released' }
      throw error
    }
    // Linux dev_t encoding, as used by /proc/locks (hex major:minor:inode).
    const major = ((stat.dev >> 8n) & 0xfffn) | ((stat.dev >> 32n) & 0xfffff000n)
    const minor = (stat.dev & 0xffn) | ((stat.dev >> 12n) & 0xffffff00n)
    for (const line of fs.readFileSync(path.join(proc, 'locks'), 'utf8').split('\n')) {
      const fields = line.trim().split(/\s+/)
      if (fields[1] === '->') continue // a waiter is not an owner
      const device = fields[5]?.split(':')
      if (device?.length !== 3 || BigInt(`0x${device[0]}`) !== major || BigInt(`0x${device[1]}`) !== minor || device[2] !== String(stat.ino)) continue
      const pid = fields[4]
      if (!/^\d+$/.test(pid)) return { status: 'unknown' }
      // The kernel lock plus its current process, never a persisted PID alone.
      fs.statSync(path.join(proc, pid))
      return { status: 'held' }
    }
    return { status: 'released' }
  } catch { return { status: 'unknown' } }
}
