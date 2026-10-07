const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

if (process.platform !== 'darwin') {
  console.error('make install requires macOS (launchd).');
  process.exit(1);
}
if (process.argv.includes('--check-platform')) process.exit(0);

const root = path.resolve(__dirname, '..');
const label = 'com.rotheric.g-tasks-mcp';
const domain = `gui/${process.getuid()}`;
const agents = path.join(os.homedir(), 'Library', 'LaunchAgents');
const logs = path.join(os.homedir(), 'Library', 'Logs');
const destination = path.join(agents, `${label}.plist`);
const xml = value => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[character]);

function launchctl(args) {
  const result = spawnSync('launchctl', args, { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) {
    console.error(`Failed: launchctl ${args.join(' ')}`);
    if (args[0] === 'bootstrap') {
      console.error(`Check disabled state: launchctl print-disabled ${domain}`);
      console.error(`Inspect launchd logs: log show --last 5m --style compact --predicate 'process == "launchd"'`);
    }
    process.exit(result.status || 1);
  }
}

function jobPresent() {
  const result = spawnSync('launchctl', ['print', `${domain}/${label}`], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 113 || /Could not find service/i.test(result.stderr || '')) return false;
  throw new Error(`Cannot determine launchd service state: ${result.stderr || `exit status ${result.status}`}`);
}

async function install() {
  let plist = fs.readFileSync(path.join(root, 'launchd', `${label}.plist`), 'utf8');
  plist = plist.replace('/absolute/path/to/node', xml(process.execPath))
    .replace('/absolute/path/to/g-tasks-mcp', xml(root))
    .replace('/Users/YOUR_USERNAME/Library/Logs/g-tasks-mcp.log', xml(path.join(logs, 'g-tasks-mcp.log')))
    .replace('/Users/YOUR_USERNAME/Library/Logs/g-tasks-mcp.error.log', xml(path.join(logs, 'g-tasks-mcp.error.log')));

  const validation = spawnSync('/usr/bin/plutil', ['-lint', '--', '-'], {
    input: plist,
    encoding: 'utf8',
  });
  if (validation.error || validation.status !== 0) {
    console.error('Generated LaunchAgent plist failed validation; existing service was not stopped.');
    console.error(validation.error?.message || validation.stderr || validation.stdout);
    process.exit(1);
  }

  fs.mkdirSync(agents, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  // bootout can return before launchd finishes removing the old job.
  if (jobPresent()) {
    launchctl(['bootout', `${domain}/${label}`]);
    const deadline = Date.now() + 30000;
    while (jobPresent()) {
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for ${label} to unload; replacement was not started.`);
      await delay(100);
    }
  }
  fs.writeFileSync(destination, plist, { mode: 0o644 });
  // Installing explicitly enables this job, including persistent overrides from an earlier disable.
  launchctl(['enable', `${domain}/${label}`]);
  launchctl(['bootstrap', domain, destination]);
  console.log(`Installed and started ${label}. Logs: ${logs}/g-tasks-mcp{,.error}.log`);
}

install().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
