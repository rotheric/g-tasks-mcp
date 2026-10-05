const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function dependenciesWork() {
  // Use a fresh process so a failed native-module load is never cached.
  const probe = spawnSync(process.execPath, ['-e', `
    require('typescript');
    require('tsx/package.json');
    require('esbuild').transformSync('const ready = true;', { loader: 'ts' });
  `], { cwd: root, stdio: 'ignore' });
  return probe.status === 0;
}

if (!dependenciesWork()) {
  console.log(`Installing dependencies for ${process.platform}/${process.arch}…`);
  // npm's JS entry point also works when npm is invoked through a version manager.
  const npm = process.env.npm_execpath;
  const install = npm
    ? spawnSync(process.execPath, [npm, 'ci'], { cwd: root, stdio: 'inherit' })
    : spawnSync('npm', ['ci'], { cwd: root, stdio: 'inherit' });
  if (install.status !== 0) process.exit(install.status || 1);
  if (!dependenciesWork()) {
    console.error('Dependencies remain unusable after npm ci.');
    process.exit(1);
  }
}
