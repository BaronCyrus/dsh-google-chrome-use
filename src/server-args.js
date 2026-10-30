/**
 * Turn the plugin's settings into the Chrome DevTools MCP command line.
 */

/** Tool categories each toolset turns off; memory and performance debugging are heavy and rarely needed. */
const TOOLSET_FLAGS = {
  standard: ['--categoryPerformance=false', '--categoryEmulation=false', '--categoryMemory=false'],
  full: [],
  slim: ['--slim'],
}

/**
 * Sent with every launch: no usage statistics or field-data lookups go to
 * Google, and sensitive request headers stay out of what the model reads.
 * Screenshots stay small because image tokens scale with their dimensions.
 */
const COMMON_FLAGS = [
  '--no-usage-statistics',
  '--no-performance-crux',
  '--redactNetworkHeaders',
  '--screenshotFormat=jpeg',
  '--screenshotMaxWidth=1600',
  '--screenshotMaxHeight=2000',
]

/** Environment for the server: no update checks, and Electron's binary must run as plain Node. */
export const SERVER_ENV = {
  CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
  CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
  ELECTRON_RUN_AS_NODE: '1',
}

/**
 * @param options.cliPath - the server's entry script.
 * @param options.target - `dedicated` or `my_chrome`.
 * @param options.config - the plugin's settings.
 * @param options.userDataDir - the dedicated profile's directory.
 * @returns the arguments after the Node executable.
 */
export function buildServerArgs({ cliPath, target, config, userDataDir }) {
  const args = [cliPath, ...COMMON_FLAGS, ...TOOLSET_FLAGS[config.toolset]]
  if (target === 'my_chrome') {
    // The real browser holds the user's logins: a page must not be able to talk
    // the model into reading local files through file: URLs.
    args.push('--autoConnect', '--fileNavigations=false')
  } else {
    args.push(`--userDataDir=${userDataDir}`, `--headless=${config.headless}`)
    if (config.executablePath) args.push(`--executablePath=${config.executablePath}`)
  }
  for (const root of config.fileRoots) args.push(`--filesystemRoot=${root}`)
  args.push(...config.extraArgs)
  return args
}
