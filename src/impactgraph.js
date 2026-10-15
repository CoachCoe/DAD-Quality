import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { command } from './process.js';
import { digest, RunError } from './core.js';
import { replayFixture } from './discovery-fixture.js';

const POSTGRES = 'postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';
const NGINX = 'nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export function composeDefinition({ id, port, password, apiPassword, staffPassword }) {
  const publicOrigin = `http://localhost:${port}`, staffOrigin = `http://staff.localhost:${port}`;
  const common = { DONOR_PUBLIC_ORIGIN: publicOrigin, DONOR_STAFF_ORIGIN: staffOrigin, DONOR_GO_WORKERS_ENABLED: 'false' };
  const base = { networks: ['isolated'], labels: { 'atm.run': id }, security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'] };
  return {
    name: id,
    services: {
      postgres: { ...base, image: POSTGRES, environment: { POSTGRES_USER: 'atm_owner', POSTGRES_PASSWORD: password, POSTGRES_DB: 'impactgraph_atm' }, tmpfs: ['/var/lib/postgresql/data'], healthcheck: { test: ['CMD-SHELL', 'pg_isready -U atm_owner -d impactgraph_atm'], interval: '2s', timeout: '2s', retries: 30 }, cap_drop: [], security_opt: [] },
      'test-postgres': { ...base, image: POSTGRES, environment: { POSTGRES_USER: 'atm_owner', POSTGRES_PASSWORD: password, POSTGRES_DB: 'donor_go' }, tmpfs: ['/var/lib/postgresql/data'], healthcheck: { test: ['CMD-SHELL', 'pg_isready -U atm_owner -d donor_go'], interval: '2s', timeout: '2s', retries: 30 }, cap_drop: [], security_opt: [] },
      migrate: { ...base, image: `${id}/api:local`, command: ['migrate'], environment: { DONOR_GO_DATABASE_URL: `postgresql://atm_owner:${password}@postgres/impactgraph_atm?sslmode=disable` } },
      api: { ...base, image: `${id}/api:local`, environment: { ...common, DONOR_API_DATABASE_URL: `postgresql://atm_api:${apiPassword}@postgres/impactgraph_atm?sslmode=disable` }, read_only: true, tmpfs: ['/tmp'], healthcheck: { test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8002/health/ready'], interval: '2s', timeout: '3s', retries: 30 } },
      web: { ...base, image: `${id}/web:local`, environment: { ...common, DONOR_API_BASE_URL: 'http://api:8002' }, tmpfs: ['/tmp', '/app/.next/cache'] },
      ingress: { image: NGINX, labels: { 'atm.run': id }, networks: ['isolated', 'edge'], ports: [`127.0.0.1:${port}:8080`], volumes: ['./nginx.conf:/etc/nginx/conf.d/default.conf:ro'], healthcheck: { test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/'], interval: '2s', timeout: '3s', retries: 30 } },
      staff: { ...base, image: `${id}/api:local`, entrypoint: ['staff'], environment: { ...common, DONOR_STAFF_CLI_DATABASE_URL: `postgresql://atm_staff:${staffPassword}@postgres/impactgraph_atm?sslmode=disable` } },
      'api-tests': { ...base, image: `${id}/api-checks:local`, environment: { TEST_DATABASE_URL: `postgresql://atm_owner:${password}@test-postgres/donor_go?sslmode=disable` }, command: ['sh', '-c', 'go vet ./... && go test -race ./...'], working_dir: '/src' },
      'web-tests': { ...base, image: `${id}/web-checks:local`, command: ['sh', '-c', 'npm run lint -- --vcs-enabled=false && npm test -- --run && npm run typecheck'], working_dir: '/app' },
    },
    networks: { isolated: { internal: true }, edge: {} },
  };
}

export class ImpactGraph {
  constructor(run, { repo, revision = 'HEAD', sourceIdentity, signal }) {
    this.run = run; this.repo = path.resolve(repo); this.revision = revision; this.signal = signal;
    if (sourceIdentity && !/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceIdentity)) throw new Error('Invalid GitHub source identity.');
    this.sourceIdentity = sourceIdentity;
    this.id = run.data.id; this.source = path.join(run.dir, 'source'); this.file = path.join(run.dir, 'compose.json'); this.created = false;
  }
  async logged(result, label, binary, args, options = {}) {
    try {
      const output = await command(binary, args, { signal: this.signal, ...options });
      result.evidence.push(await this.run.evidence(`${label}.log`, output.stdout + output.stderr));
      return output;
    } catch (error) {
      result.evidence.push(await this.run.evidence(`${label}.log`, (error.stdout ?? '') + (error.stderr ?? '') + '\n' + error.message));
      throw error;
    }
  }
  compose(args, options = {}) { return command('docker', ['compose', '-p', this.id, '-f', this.file, ...args], { signal: this.signal, ...options }); }
  async snapshot(result) {
    const { stdout } = await command('git', ['rev-parse', '--verify', `${this.revision}^{commit}`], { cwd: this.repo, signal: this.signal });
    const revision = stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new RunError('Invalid source revision.');
    const tree = await command('git', ['ls-tree', '-r', '--name-only', revision], { cwd: this.repo, signal: this.signal });
    const files = tree.stdout.trim().split('\n');
    if (files.some(f => /(^|\/)\.env(?:\.|$)/.test(f) && !f.endsWith('.example'))) throw new RunError('Snapshot refuses tracked environment files containing potential credentials.');
    for (const file of ['apps/donor-api/Dockerfile', 'apps/web/Dockerfile', 'apps/web/package-lock.json']) {
      if (!files.includes(file)) throw new RunError(`ImpactGraph adapter requires ${file}.`);
    }
    await mkdir(this.source, { mode: 0o700 });
    const archive = path.join(this.run.dir, 'source.tar');
    await command('git', ['archive', '--format=tar', `--output=${archive}`, revision], { cwd: this.repo, signal: this.signal });
    await command('tar', ['-xf', archive, '-C', this.source], { signal: this.signal });
    const changes = await command('git', ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', revision], { cwd: this.repo, signal: this.signal });
    const worktree = await command('git', ['status', '--porcelain'], { cwd: this.repo, signal: this.signal });
    this.run.data.candidate = { revision, sourceArchiveSha256: digest(await readFile(archive)), source: this.sourceIdentity ?? this.repo, changedFiles: changes.stdout.trim().split('\n').filter(Boolean).slice(0, 500), excludesWorkingTreeChanges: true, workingTreeDirty: Boolean(worktree.stdout.trim()) };
    result.evidence.push(await this.run.evidence('candidate.json', JSON.stringify(this.run.data.candidate, null, 2)));
    return { summary: `Archived committed revision ${revision.slice(0, 12)}; working tree and environment files excluded.` };
  }
  async docker(result) {
    await this.logged(result, 'docker', 'docker', ['info', '--format', '{{.ServerVersion}}']);
    await this.logged(result, 'compose-version', 'docker', ['compose', 'version']);
    const resources = await command('docker', ['info', '--format', '{"version":{{json .ServerVersion}},"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}},"architecture":{{json .Architecture}}}'], { signal: this.signal });
    this.port = await freePort();
    this.publicOrigin = `http://localhost:${this.port}`; this.staffOrigin = `http://staff.localhost:${this.port}`;
    this.password = randomBytes(24).toString('hex'); this.apiPassword = randomBytes(24).toString('hex'); this.staffPassword = randomBytes(24).toString('hex');
    const config = composeDefinition(this);
    // Runtime credentials are private, never linked in reports. These are run-local only.
    await writeFile(this.file, JSON.stringify(config, null, 2), { mode: 0o600 });
    await writeFile(path.join(this.run.dir, 'nginx.conf'), `server {\n listen 8080;\n server_name _;\n location / {\n  proxy_pass http://web:3000;\n  proxy_set_header Host $http_host;\n  proxy_set_header X-Forwarded-Proto $scheme;\n  proxy_set_header X-Forwarded-For $remote_addr;\n }\n}\n`, { mode: 0o600 });
    this.run.data.environment = { docker: JSON.parse(resources.stdout), publicOrigin: this.publicOrigin, staffOrigin: this.staffOrigin, outboundNetwork: 'internal Docker network', integrations: 'Stripe, SMTP and push disabled', composeSha256: digest(JSON.stringify(config)) };
    return { summary: 'Docker ready; unique project and loopback port allocated.' };
  }
  async build(result) {
    for (const [service, file] of [['api', 'apps/donor-api/Dockerfile'], ['web', 'apps/web/Dockerfile']]) {
      const args = ['build', '--label', `atm.run=${this.id}`, '--label', `org.opencontainers.image.revision=${this.run.data.candidate.revision}`, '-f', path.join(this.source, file)];
      if (service === 'web') args.push('--build-arg', `DONOR_PUBLIC_ORIGIN=${this.publicOrigin}`, '--build-arg', `DONOR_STAFF_ORIGIN=${this.staffOrigin}`);
      if (this.run.data.options.mode !== 'exploration') await this.logged(result, `build-${service}-checks`, 'docker', [...args, '--target', 'build', '-t', `${this.id}/${service}-checks:local`, this.source], { timeout: 900_000, failureStatus: 'failed' });
      await this.logged(result, `build-${service}`, 'docker', [...args, '-t', `${this.id}/${service}:local`, this.source], { timeout: 900_000, failureStatus: 'failed' });
    }
    this.run.data.candidate.images = {};
    for (const service of ['api', 'web']) {
      const image = await command('docker', ['image', 'inspect', `${this.id}/${service}:local`, '--format', '{{.Id}}'], { signal: this.signal });
      this.run.data.candidate.images[service] = image.stdout.trim();
    }
    return { summary: 'Application images built from the archived revision.' };
  }
  async sql(query) {
    return this.compose(['exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'atm_owner', '-d', 'impactgraph_atm', '-At'], { input: query });
  }
  async database(result) {
    this.created = true;
    await this.logged(result, 'database-start', 'docker', ['compose', '-p', this.id, '-f', this.file, 'up', '-d', '--wait', '--wait-timeout', '90', 'postgres', ...(this.run.data.options.mode === 'exploration' ? [] : ['test-postgres'])]);
    await this.logged(result, 'migrations', 'docker', ['compose', '-p', this.id, '-f', this.file, 'run', '--rm', '-T', 'migrate'], { failureStatus: 'failed' });
    // Passwords are generated hexadecimal strings, never supplied by users or a model.
    await this.sql(`CREATE USER atm_api PASSWORD '${this.apiPassword}';\nGRANT dad_api TO atm_api;\nCREATE USER atm_staff PASSWORD '${this.staffPassword}';\nGRANT dad_staff_cli TO atm_staff;\n`);
    if (this.run.data.options.mode !== 'exploration') await this.logged(result, 'test-migrations', 'docker', ['compose', '-p', this.id, '-f', this.file, 'run', '--rm', '-T', '-e', `DONOR_GO_DATABASE_URL=postgresql://atm_owner:${this.password}@test-postgres/donor_go?sslmode=disable`, 'migrate'], { failureStatus: 'failed' });
    else result.evidence.push(await this.run.evidence('test-migrations.log', 'Not applicable: exploration uses only the application database.'));
    return { summary: this.run.data.options.mode === 'exploration' ? 'Disposable application database migrated; application processes use separate roles.' : 'Disposable application and integration-test databases migrated; application processes use separate roles.' };
  }
  async suite(result, name) {
    await this.logged(result, name, 'docker', ['compose', '-p', this.id, '-f', this.file, 'run', '--rm', '-T', name], { timeout: 900_000, failureStatus: 'failed' });
    return { summary: name === 'api-tests' ? 'Go vet and race-enabled backend tests passed.' : 'Frontend lint, unit tests and type checks passed.' };
  }
  async deploy(result) {
    await this.logged(result, 'deploy', 'docker', ['compose', '-p', this.id, '-f', this.file, 'up', '-d', '--wait', '--wait-timeout', '120', 'api', 'web', 'ingress'], { timeout: 180_000 });
    const { stdout } = await this.compose(['exec', '-T', 'web', 'node', '-e', `fetch('http://127.0.0.1:3000/').then(r=>{console.log(r.status);if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))`]);
    result.evidence.push(await this.run.evidence('readiness.log', stdout));
    const response = await fetch(this.publicOrigin, { signal: AbortSignal.any([this.signal, AbortSignal.timeout(10_000)]), redirect: 'manual' });
    if (response.status !== 200) throw new RunError(`Published ingress returned HTTP ${response.status}.`);
    await response.body?.cancel();
    return { summary: 'API database readiness and production web health passed.' };
  }
  async invitation() {
    const { stdout } = await this.compose(['run', '--rm', '-T', 'staff', '--email', 'administrator@atm.invalid', '--name', 'ATM Administrator']);
    const invitation = stdout.match(/http:\/\/\S+\/staff\/activate#token=\S+/)?.[0];
    if (!invitation || new URL(invitation).origin !== this.staffOrigin) throw new RunError('Staff bootstrap returned no valid run-scoped invitation.');
    return invitation;
  }
  async verifyStaff() {
    const { stdout } = await this.sql(`BEGIN READ ONLY;\nSELECT json_build_object('staff', (SELECT count(*) FROM donor_staff WHERE email='administrator@atm.invalid' AND role='ADMIN' AND disabled=false), 'passkeys', (SELECT count(*) FROM donor_staff_passkeys p JOIN donor_staff s ON s.id=p.staff_id WHERE s.email='administrator@atm.invalid'), 'active_sessions', (SELECT count(*) FROM donor_staff_sessions x JOIN donor_staff s ON s.id=x.staff_id WHERE s.email='administrator@atm.invalid' AND x.revoked_at IS NULL AND x.expires_at>now()), 'revoked_sessions', (SELECT count(*) FROM donor_staff_sessions x JOIN donor_staff s ON s.id=x.staff_id WHERE s.email='administrator@atm.invalid' AND x.revoked_at IS NOT NULL));\nROLLBACK;`);
    const value = stdout.split('\n').find(line => line.startsWith('{'));
    if (!value) throw new RunError('Database verifier returned no result.');
    const state = JSON.parse(value);
    if (state.staff !== 1 || state.passkeys !== 1 || state.active_sessions < 1 || state.revoked_sessions < 1) throw new RunError('Persisted staff, passkey, or session invariants failed.', 'failed');
    return state;
  }
  async donorFixture() {
    // Only generated UUIDs and hexadecimal hashes enter SQL. The fixture is
    // synthetic setup, not evidence that email delivery or gift checkout works.
    const donor = randomUUID(), other = randomUUID();
    const token = randomBytes(32).toString('base64url'), sibling = randomBytes(32).toString('base64url');
    await this.sql(`BEGIN;
INSERT INTO donors(id,email) VALUES ('${donor}','claim@atm.invalid'),('${other}','other@atm.invalid');
INSERT INTO donor_login_links(id,donor_id,token_hash,expires_at) VALUES
('${randomUUID()}','${donor}','${digest(token)}',now()+interval '15 minutes'),
('${randomUUID()}','${donor}','${digest(sibling)}',now()+interval '15 minutes');
COMMIT;`);
    return { donor, other, links: [token, sibling].map(value => `${this.publicOrigin}/account/claim#token=${value}`) };
  }
  async verifyDonor({ signedOut = false } = {}) {
    const { stdout } = await this.sql(`BEGIN READ ONLY;
SELECT json_build_object(
'claimed', (SELECT count(*) FROM donors WHERE email='claim@atm.invalid' AND claimed_at IS NOT NULL),
'consumed_links', (SELECT count(*) FROM donor_login_links l JOIN donors d ON d.id=l.donor_id WHERE d.email='claim@atm.invalid' AND l.consumed_at IS NOT NULL),
'sessions', (SELECT count(*) FROM donor_sessions s JOIN donors d ON d.id=s.donor_id WHERE d.email='claim@atm.invalid'),
'active_sessions', (SELECT count(*) FROM donor_sessions s JOIN donors d ON d.id=s.donor_id WHERE d.email='claim@atm.invalid' AND s.revoked_at IS NULL AND s.expires_at>now()),
'revoked_sessions', (SELECT count(*) FROM donor_sessions s JOIN donors d ON d.id=s.donor_id WHERE d.email='claim@atm.invalid' AND s.revoked_at IS NOT NULL),
'other_claimed', (SELECT count(*) FROM donors WHERE email='other@atm.invalid' AND claimed_at IS NOT NULL),
'other_sessions', (SELECT count(*) FROM donor_sessions s JOIN donors d ON d.id=s.donor_id WHERE d.email='other@atm.invalid'));
ROLLBACK;`);
    const value = stdout.split('\n').find(line => line.startsWith('{'));
    if (!value) throw new RunError('Donor database verifier returned no result.');
    const state = JSON.parse(value);
    if (state.claimed !== 1 || state.consumed_links !== 2 || state.sessions !== 1 || state.active_sessions !== (signedOut ? 0 : 1) || state.revoked_sessions !== (signedOut ? 1 : 0) || state.other_claimed !== 0 || state.other_sessions !== 0) throw new RunError('Persisted donor claim, link, or session invariants failed.', 'failed');
    return state;
  }
  async discoveryFixture() {
    const actors = [{ id: 'guest', description: 'Anonymous visitor', entry: '/' }];
    const statements = ['BEGIN;'];
    for (const [index, label] of ['a', 'b'].entries()) {
      const donor = randomUUID(), checkout = randomUUID(), token = randomBytes(32).toString('base64url');
      const amount = (index + 1) * 1700;
      statements.push(`INSERT INTO donors(id,email,claimed_at) VALUES ('${donor}','explorer-${label}@atm.invalid',now());
INSERT INTO donor_sessions(id,donor_id,token_hash,expires_at) VALUES ('${randomUUID()}','${donor}','${digest(token)}',now()+interval '1 hour');
INSERT INTO donor_checkouts(id,donor_id,amount_minor,frequency) VALUES ('${checkout}','${donor}',${amount},'ONE_TIME');
INSERT INTO donor_gifts(id,donor_id,checkout_id,stripe_object_id,amount_minor,currency,frequency,paid_at) VALUES ('${randomUUID()}','${donor}','${checkout}','atm_explorer_${donor}',${amount},'USD','ONE_TIME',now());
INSERT INTO donor_metric_projections(id,donor_id,net_minor,computed_at,next_refresh_at) VALUES ('${randomUUID()}','${donor}',${amount},now(),now()+interval '1 day');`);
      actors.push({ id: `donor-${label}`, description: `Claimed synthetic donor explorer-${label}@atm.invalid; one USD ${(amount / 100).toFixed(2)} gift`, entry: '/account/dashboard', cookie: token });
    }
    statements.push('COMMIT;');
    await this.sql(statements.join('\n'));
    return actors;
  }
  async discoveryState() {
    // Fixed projection for fixture identities: no arbitrary SQL, session tokens or hashes.
    const { stdout } = await this.sql(`BEGIN READ ONLY;
SELECT json_object_agg(actor, state) FROM (
SELECT CASE d.email WHEN 'explorer-a@atm.invalid' THEN 'donor-a' ELSE 'donor-b' END AS actor,
json_build_object('public_name',d.public_name,'referral_emails',coalesce(p.referral_emails,false),'marketing_emails',coalesce(p.marketing_emails,false),
'preferences_version',coalesce(p.version,0),'gift_count',(SELECT count(*) FROM donor_gifts g WHERE g.donor_id=d.id),
'active_sessions',(SELECT count(*) FROM donor_sessions s WHERE s.donor_id=d.id AND s.revoked_at IS NULL AND s.expires_at>now())) AS state
FROM donors d LEFT JOIN donor_preferences p ON p.donor_id=d.id WHERE d.email IN ('explorer-a@atm.invalid','explorer-b@atm.invalid')
) fixture;
ROLLBACK;`);
    const value = stdout.split('\n').find(line => line.startsWith('{'));
    if (!value) throw new RunError('Discovery state verifier returned no result.');
    const raw = JSON.parse(value);
    return raw;
  }
  async discoveryReplayFixture() {
    if (this.run.data.options.mode !== 'exploration' || !this.created || !/^atm-[0-9]{14}-[a-f0-9]{8}$/.test(this.id)) throw new RunError('Fixture replay requires a run-owned exploration database.');
    return replayFixture({
      // Restart the proxy too: Docker can assign new app addresses after a stop.
      // Its healthcheck must observe the upstream before exploration resumes.
      stop: () => this.compose(['stop', '--timeout', '10', 'ingress', 'api', 'web']),
      start: async () => {
        await this.compose(['up', '-d', '--wait', '--wait-timeout', '90', 'api', 'web']);
        await this.compose(['up', '-d', '--wait', '--wait-timeout', '90', 'ingress']);
      },
      snapshot: async () => (await this.compose(['exec', '-T', 'postgres', 'pg_dump', '-U', 'atm_owner', '-d', 'impactgraph_atm', '--clean', '--if-exists', '--no-owner'], { maxBytes: 32_000_000 })).stdout,
      restore: data => this.sql(`BEGIN;\n${data}\nCOMMIT;`),
      inspect: () => this.discoveryState(),
    });
  }
  async performanceFixture() {
    // Separate from the authentication journeys; no email or payment processor.
    // Each donor has a full first page and ten additional synthetic gifts.
    const cookies = [], statements = ['BEGIN;'];
    for (let i = 0; i < 12; i++) {
      const donor = randomUUID(), checkout = randomUUID(), token = randomBytes(32).toString('base64url');
      cookies.push(`dad_donor_session=${token}`);
      statements.push(`INSERT INTO donors(id,email,claimed_at) VALUES ('${donor}','load-${i}@atm.invalid',now());
INSERT INTO donor_sessions(id,donor_id,token_hash,expires_at) VALUES ('${randomUUID()}','${donor}','${digest(token)}',now()+interval '1 hour');
INSERT INTO donor_checkouts(id,donor_id,amount_minor,frequency) VALUES ('${checkout}','${donor}',1000,'ONE_TIME');
INSERT INTO donor_gifts(id,donor_id,checkout_id,stripe_object_id,amount_minor,currency,frequency,paid_at)
SELECT gen_random_uuid(),'${donor}','${checkout}','atm_${donor}_'||n,1000,'USD','ONE_TIME',timestamptz '2026-01-01 00:00:00+00'+n*interval '1 day' FROM generate_series(1,60) n;
INSERT INTO donor_metric_projections(id,donor_id,net_minor,computed_at,next_refresh_at) VALUES ('${randomUUID()}','${donor}',60000,now(),now()+interval '1 day');`);
    }
    statements.push('COMMIT;');
    await this.sql(statements.join('\n'));
    return cookies;
  }
  async cleanup(result) {
    if (this.created) {
      // Cleanup gets its own deadline and is not canceled with the run.
      try {
        const logs = await this.compose(['logs', '--no-color', '--tail', '150', 'api', 'web', 'ingress'], { timeout: 20_000 });
        result.evidence.push(await this.run.evidence('services.log', logs.stdout + logs.stderr));
      } catch { /* Removal must still run if log collection fails. */ }
      await this.logged(result, 'cleanup', 'docker', ['compose', '-p', this.id, '-f', this.file, 'down', '--volumes', '--remove-orphans', '--timeout', '10'], { timeout: 90_000 });
    } else {
      result.evidence.push(await this.run.evidence('cleanup.log', 'No application environment was created.'));
    }
    return { summary: 'Run-owned containers and ephemeral databases removed. Images and evidence retained locally.' };
  }
}
