const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
  if (result.status !== 0) process.exit(result.status || 1);
}

let plist = fs.readFileSync(path.join(root, 'launchd', `${label}.plist`), 'utf8');
plist = plist.replace('/absolute/path/to/node', xml(process.execPath))
  .replace('/absolute/path/to/g-tasks-mcp', xml(root))
  .replace('/Users/YOUR_USERNAME/Library/Logs/g-tasks-mcp.log', xml(path.join(logs, 'g-tasks-mcp.log')))
  .replace('/Users/YOUR_USERNAME/Library/Logs/g-tasks-mcp.error.log', xml(path.join(logs, 'g-tasks-mcp.error.log')));

fs.mkdirSync(agents, { recursive: true });
fs.mkdirSync(logs, { recursive: true });
// Stop an existing job before replacing its definition or starting another writer.
const existing = spawnSync('launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' });
if (existing.error) {
  console.error(existing.error.message);
  process.exit(1);
}
if (existing.status === 0) launchctl(['bootout', `${domain}/${label}`]);
fs.writeFileSync(destination, plist, { mode: 0o644 });
launchctl(['bootstrap', domain, destination]);
console.log(`Installed and started ${label}. Logs: ${logs}/g-tasks-mcp{,.error}.log`);
