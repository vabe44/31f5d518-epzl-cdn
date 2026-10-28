import { appendFile } from 'node:fs/promises'

const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
])

const DEFAULT_REPOSITORY = 'vabe44/31f5d518-epzl-cdn'
const DEFAULT_VERSION = 'main'
const DEFAULT_CONCURRENCY = 8
const DEFAULT_ATTEMPTS = 5
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_BASE_DELAY_MS = 3_000
const DEFAULT_MAX_DELAY_MS = 30_000

const repository = process.env.JSDELIVR_REPO || DEFAULT_REPOSITORY
const version = process.env.JSDELIVR_VERSION || DEFAULT_VERSION
const concurrency = readPositiveInteger('WARM_CONCURRENCY', DEFAULT_CONCURRENCY)
const attempts = readPositiveInteger('WARM_ATTEMPTS', DEFAULT_ATTEMPTS)
const timeoutMs = readPositiveInteger('WARM_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
const baseDelayMs = readPositiveInteger('WARM_BASE_DELAY_MS', DEFAULT_BASE_DELAY_MS)
const maxDelayMs = readPositiveInteger('WARM_MAX_DELAY_MS', DEFAULT_MAX_DELAY_MS)
const dryRun = process.argv.includes('--dry-run') || process.env.WARM_DRY_RUN === '1'
const mode = process.env.WARM_MODE || 'unknown'

function readPositiveInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function normalizePath(value) {
  return value
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .trim()
}

function isImagePath(filePath) {
  const dotIndex = filePath.lastIndexOf('.')
  return dotIndex !== -1 && IMAGE_EXTENSIONS.has(filePath.slice(dotIndex).toLowerCase())
}

function parseInput(rawInput) {
  const values = rawInput.includes('\0') ? rawInput.split('\0') : rawInput.split(/\r?\n/)
  return [...new Set(values.map(normalizePath).filter((filePath) => filePath && isImagePath(filePath)))].sort()
}

function buildUrl(filePath) {
  const encodedPath = filePath.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return `https://cdn.jsdelivr.net/gh/${repository}@${encodeURIComponent(version)}/${encodedPath}`
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function fetchImage(filePath) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(buildUrl(filePath), {
      headers: {
        'user-agent': 'empuzzled-cdn-jsdelivr-warmer',
      },
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }

    // Consume the response body so the CDN request fully completes.
    await response.arrayBuffer()
  } finally {
    clearTimeout(timeout)
  }
}

async function warmWithRetries(filePath) {
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fetchImage(filePath)
      return { attempts: attempt, filePath, ok: true }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)

      if (attempt < attempts) {
        const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)))
        const jitter = Math.floor(Math.random() * 500)
        console.log(`[retry] ${filePath}: ${lastError}; retrying in ${exponentialDelay + jitter}ms`)
        await sleep(exponentialDelay + jitter)
      }
    }
  }

  return { attempts, error: lastError, filePath, ok: false }
}

async function warmImages(filePaths) {
  let nextIndex = 0
  let completed = 0
  const failures = []
  const workerCount = Math.min(concurrency, filePaths.length)

  async function worker() {
    while (true) {
      const index = nextIndex
      nextIndex += 1

      if (index >= filePaths.length) {
        return
      }

      const result = await warmWithRetries(filePaths[index])
      completed += 1

      if (!result.ok) {
        failures.push(result)
        console.error(`[failed] ${result.filePath}: ${result.error}`)
      }

      if (completed === filePaths.length || completed % 100 === 0) {
        console.log(`[progress] ${completed}/${filePaths.length}`)
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return failures.sort((left, right) => left.filePath.localeCompare(right.filePath))
}

async function writeSummary({ failures, filePaths }) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY
  if (!summaryFile) {
    return
  }

  const succeeded = filePaths.length - failures.length
  const lines = [
    '## jsDelivr image cache warm-up',
    '',
    `- Mode: ${mode}`,
    `- Requested: ${filePaths.length}`,
    `- Succeeded: ${succeeded}`,
    `- Failed: ${failures.length}`,
  ]

  if (failures.length > 0) {
    lines.push('', '### Failed files', ...failures.map(({ error, filePath }) => `- \`${filePath}\` — ${error}`))
  }

  await appendFile(summaryFile, `${lines.join('\n')}\n`)
}

const filePaths = parseInput(await readStdin())

console.log(`[info] ${mode} run: ${filePaths.length} image file(s) selected`)

if (dryRun) {
  for (const filePath of filePaths) {
    console.log(`[dry-run] ${buildUrl(filePath)}`)
  }
  await writeSummary({ failures: [], filePaths })
  process.exit(0)
}

if (filePaths.length === 0) {
  console.log('[info] No image files need warming')
  await writeSummary({ failures: [], filePaths })
  process.exit(0)
}

const failures = await warmImages(filePaths)
await writeSummary({ failures, filePaths })

if (failures.length > 0) {
  process.exitCode = 1
}
