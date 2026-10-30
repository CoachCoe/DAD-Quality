import { parseArgs } from 'node:util';
import { createDashboardServer } from './dashboard.js';
import { redact } from './core.js';

process.umask(0o077);
const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    output: { type: 'string', default: '.atm/runs' },
    policy: { type: 'string' },
    target: { type: 'string', default: 'dad' },
    config: { type: 'string' },
    port: { type: 'string', default: '4310' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'npm start -- --repo /path/to/repo [--target dad|generic-web] [--config atm.config.json] [--port 4310] [--output .atm/runs] [--policy FILE]',
  );
} else {
  if (!values.repo) throw new Error('Use: npm start -- --repo /path/to/repo [--target dad|generic-web]');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  if (values.config !== undefined && values.target !== 'generic-web')
    throw new Error('--config applies only to --target generic-web.');
  createDashboardServer({
    repo: values.repo,
    root: values.output,
    port,
    policy: values.policy,
    target: values.target,
    configFile: values.config,
  })
    .then(app => {
      console.log(
        `ATM dashboard: ${app.origin}\nRepository: ${app.dashboard.repo}\nStop with Ctrl-C. Active validation will be canceled and cleaned up.`,
      );
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        console.log('Stopping dashboard; waiting for run cleanup…');
        await app.close();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch(error => {
      console.error(redact(error.message));
      process.exitCode = 1;
    });
}
