const releasePattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const validPackageNumber = number => Number.isInteger(number) && number >= 0 && number <= 999

export function nextPackageVersion(releaseVersion, state = { lastMacBuild: 0, packages: {} }) {
  if (typeof releaseVersion !== 'string' || !releasePattern.test(releaseVersion)) {
    throw new Error('发布版本必须使用大版本.业务版本.小版本。')
  }
  const { lastMacBuild, packages } = state || {}
  if (!Number.isSafeInteger(lastMacBuild) || lastMacBuild < 0 || lastMacBuild === Number.MAX_SAFE_INTEGER
      || !packages || typeof packages !== 'object' || Array.isArray(packages)
      || Object.entries(packages).some(([version, build]) => !releasePattern.test(version) || !validPackageNumber(build))) {
    throw new Error('本机打包版本记录无效。')
  }
  const packageNumber = (packages[releaseVersion] ?? -1) + 1
  if (packageNumber > 999) throw new Error(releaseVersion + ' 的包版本已用到 999，请指定新的发布版本。')

  return {
    displayVersion: releaseVersion + '.' + String(packageNumber).padStart(3, '0'),
    macBuildVersion: String(lastMacBuild + 1),
    state: { lastMacBuild: lastMacBuild + 1, packages: { ...packages, [releaseVersion]: packageNumber } },
  }
}
