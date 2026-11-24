import assert from 'node:assert/strict'
import test from 'node:test'
import { nextPackageVersion } from '../scripts/package-version.mjs'

test('numbering starts at 000 for each release and macOS build numbers rise across releases', () => {
  const first = nextPackageVersion('0.123.456')
  const second = nextPackageVersion('0.123.456', first.state)
  const newRelease = nextPackageVersion('0.124.0', second.state)
  const earlierRelease = nextPackageVersion('0.123.456', newRelease.state)
  assert.deepEqual([first.displayVersion, second.displayVersion, newRelease.displayVersion, earlierRelease.displayVersion],
    ['0.123.456.000', '0.123.456.001', '0.124.0.000', '0.123.456.002'])
  assert.deepEqual([first.macBuildVersion, second.macBuildVersion, newRelease.macBuildVersion, earlierRelease.macBuildVersion],
    ['1', '2', '3', '4'])
})

test('the final package is 999 and packaging cannot silently reset a version or a corrupt record', () => {
  const next = nextPackageVersion('0.1.0', { lastMacBuild: 999, packages: { '0.1.0': 998 } })
  assert.equal(next.displayVersion, '0.1.0.999')
  assert.throws(() => nextPackageVersion('0.1.0', next.state), /已用到 999/)
  assert.throws(() => nextPackageVersion('0.1.0.000'), /发布版本/)
  assert.throws(() => nextPackageVersion('0.1.0', { lastMacBuild: 9, packages: { '0.1.0': '008' } }), /记录无效/)
})
