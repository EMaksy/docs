'use strict'

const fs = require('node:fs')
const path = require('node:path')

const HOSTED_GIT_REPO_RX = /^(?:https?:\/\/|.+@)(github\.com)[/:](.+?)(?:\.git)?$/
const POSIX_SEP_RX = new RegExp(`\\${path.sep}`, 'g')

module.exports.register = function () {
  const repoCache = new Map()

  this.once('contentAggregated', ({ contentAggregate }) => {
    for (const bucket of contentAggregate) {
      for (const file of bucket.files || []) {
        const src = file.src
        if (!src || src.editUrl || !src.scanned) continue

        const absPath = getAbsolutePath(src)
        if (!absPath) continue

        const repoRoot = findRepoRoot(absPath)
        if (!repoRoot) continue

        const repoInfo = getRepoInfo(repoCache, repoRoot)
        if (!repoInfo) continue

        const relPath = path.relative(repoRoot, absPath).replace(POSIX_SEP_RX, '/')
        const editUrl = buildEditUrl(repoInfo, relPath)
        if (editUrl) src.editUrl = editUrl
      }
    }
  })
}

function getAbsolutePath (src) {
  if (src.realpath && path.isAbsolute(src.realpath)) return src.realpath
  if (src.abspath && path.isAbsolute(src.abspath)) return src.abspath
  if (src.scanned && src.origin?.collectorWorktree) return path.join(src.origin.collectorWorktree, src.scanned)
  return null
}

function findRepoRoot (filePath) {
  let current = path.dirname(filePath)
  while (true) {
    if (exists(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function resolveGitDir (repoRoot) {
  const gitPath = path.join(repoRoot, '.git')
  try {
    const stat = fs.statSync(gitPath)
    if (stat.isDirectory()) return gitPath
    if (stat.isFile()) {
      const data = fs.readFileSync(gitPath, 'utf8')
      const match = data.match(/^gitdir: (.+)$/m)
      if (match) return path.resolve(repoRoot, match[1].trim())
    }
  } catch {
    return null
  }
  return null
}

function getRepoInfo (cache, repoRoot) {
  if (cache.has(repoRoot)) return cache.get(repoRoot)

  const gitDir = resolveGitDir(repoRoot)
  if (!gitDir) return cache.set(repoRoot, null).get(repoRoot)

  const remoteUrl = readRemoteUrl(gitDir)
  const head = readHead(gitDir)
  const info = remoteUrl && head ? { remoteUrl, head } : null
  cache.set(repoRoot, info)
  return info
}

function readRemoteUrl (gitDir, remoteName = 'origin') {
  const configPath = path.join(gitDir, 'config')
  let config
  try {
    config = fs.readFileSync(configPath, 'utf8')
  } catch {
    return null
  }

  let inRemote = false
  for (const line of config.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const remoteMatch = trimmed.match(/^\[remote "(.+)"\]$/)
    if (remoteMatch) {
      inRemote = remoteMatch[1] === remoteName
      continue
    }
    if (inRemote) {
      const urlMatch = trimmed.match(/^url = (.+)$/)
      if (urlMatch) return urlMatch[1].trim()
    }
    if (trimmed.startsWith('[')) inRemote = false
  }
  return null
}

function readHead (gitDir) {
  let head
  try {
    head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
  } catch {
    return null
  }

  if (head.startsWith('ref: ')) {
    const ref = head.slice(5).trim()
    if (ref.startsWith('refs/heads/')) {
      return { refName: ref.slice('refs/heads/'.length), refType: 'branch' }
    }
    if (ref.startsWith('refs/tags/')) {
      return { refName: ref.slice('refs/tags/'.length), refType: 'tag' }
    }
    return { refName: ref.split('/').slice(1).join('/'), refType: 'ref' }
  }

  if (/^[0-9a-f]{7,40}$/.test(head)) return { refName: head, refType: 'hash' }
  return null
}

function buildEditUrl (repoInfo, relPath) {
  const { remoteUrl, head } = repoInfo
  const match = remoteUrl.match(HOSTED_GIT_REPO_RX)
  if (!match) return null

  const repoPath = match[2].replace(/\.git$/, '')
  const action = head.refType === 'branch' ? 'edit' : 'blob'

  const parts = [match[1], repoPath, action, head.refName]
  if (relPath) parts.push(relPath)

  let url = `https://${parts.join('/')}`
  if (url.includes(' ')) url = url.replace(/ /g, '%20')
  return url
}

function exists (filePath) {
  try {
    fs.accessSync(filePath)
    return true
  } catch {
    return false
  }
}
