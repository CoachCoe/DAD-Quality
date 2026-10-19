import { randomBytes, randomUUID } from 'node:crypto';
import { digest } from '../../core.js';

// Only generated UUIDs, hexadecimal hashes and passwords are interpolated; no
// value supplied by an operator or a model reaches these statements.

export function roleSetupSql({ apiPassword, staffPassword }) {
  return `CREATE USER atm_api PASSWORD '${apiPassword}';\nGRANT dad_api TO atm_api;\nCREATE USER atm_staff PASSWORD '${staffPassword}';\nGRANT dad_staff_cli TO atm_staff;\n`;
}

export function verifyStaffSql() {
  return `BEGIN READ ONLY;\nSELECT json_build_object('staff', (SELECT count(*) FROM donor_staff WHERE email='administrator@atm.invalid' AND role='ADMIN' AND disabled=false), 'passkeys', (SELECT count(*) FROM donor_staff_passkeys p JOIN donor_staff s ON s.id=p.staff_id WHERE s.email='administrator@atm.invalid'), 'active_sessions', (SELECT count(*) FROM donor_staff_sessions x JOIN donor_staff s ON s.id=x.staff_id WHERE s.email='administrator@atm.invalid' AND x.revoked_at IS NULL AND x.expires_at>now()), 'revoked_sessions', (SELECT count(*) FROM donor_staff_sessions x JOIN donor_staff s ON s.id=x.staff_id WHERE s.email='administrator@atm.invalid' AND x.revoked_at IS NOT NULL));\nROLLBACK;`;
}

export function donorFixtureSql({ donor, other, token, sibling }) {
  return `BEGIN;
INSERT INTO donors(id,email) VALUES ('${donor}','claim@atm.invalid'),('${other}','other@atm.invalid');
INSERT INTO donor_login_links(id,donor_id,token_hash,expires_at) VALUES
('${randomUUID()}','${donor}','${digest(token)}',now()+interval '15 minutes'),
('${randomUUID()}','${donor}','${digest(sibling)}',now()+interval '15 minutes');
COMMIT;`;
}

export function verifyDonorSql() {
  return `BEGIN READ ONLY;
SELECT json_build_object(
'claimed', (SELECT count(*) FROM donors WHERE email='claim@atm.invalid' AND claimed_at IS NOT NULL),
'consumed_links', (SELECT count(*) FROM donor_login_links l JOIN donors d ON d.id=l.donor_id WHERE d.email='claim@atm.invalid' AND l.consumed_at IS NOT NULL),
'sessions', (SELECT count(*) FROM donor_sessions s JOIN donors d ON d.id=s.donor_id WHERE d.email='claim@atm.invalid'),
'active_sessions', (SELECT count(*) FROM donor_sessions s JOIN donors d ON d.id=s.donor_id WHERE d.email='claim@atm.invalid' AND s.revoked_at IS NULL AND s.expires_at>now()),
'revoked_sessions', (SELECT count(*) FROM donor_sessions s JOIN donors d ON d.id=s.donor_id WHERE d.email='claim@atm.invalid' AND s.revoked_at IS NOT NULL),
'other_claimed', (SELECT count(*) FROM donors WHERE email='other@atm.invalid' AND claimed_at IS NOT NULL),
'other_sessions', (SELECT count(*) FROM donor_sessions s JOIN donors d ON d.id=s.donor_id WHERE d.email='other@atm.invalid'));
ROLLBACK;`;
}

export function discoveryFixture() {
  const actors = [{ id: 'guest', description: 'Anonymous visitor', entry: '/' }];
  const statements = ['BEGIN;'];
  for (const [index, label] of ['a', 'b'].entries()) {
    const donor = randomUUID(),
      checkout = randomUUID(),
      token = randomBytes(32).toString('base64url');
    const amount = (index + 1) * 1700;
    statements.push(`INSERT INTO donors(id,email,claimed_at) VALUES ('${donor}','explorer-${label}@atm.invalid',now());
INSERT INTO donor_sessions(id,donor_id,token_hash,expires_at) VALUES ('${randomUUID()}','${donor}','${digest(token)}',now()+interval '1 hour');
INSERT INTO donor_checkouts(id,donor_id,amount_minor,frequency) VALUES ('${checkout}','${donor}',${amount},'ONE_TIME');
INSERT INTO donor_gifts(id,donor_id,checkout_id,stripe_object_id,amount_minor,currency,frequency,paid_at) VALUES ('${randomUUID()}','${donor}','${checkout}','atm_explorer_${donor}',${amount},'USD','ONE_TIME',now());
INSERT INTO donor_metric_projections(id,donor_id,net_minor,computed_at,next_refresh_at) VALUES ('${randomUUID()}','${donor}',${amount},now(),now()+interval '1 day');`);
    actors.push({
      id: `donor-${label}`,
      description: `Claimed synthetic donor explorer-${label}@atm.invalid; one USD ${(amount / 100).toFixed(2)} gift`,
      entry: '/account/dashboard',
      cookie: token,
      cookieName: 'dad_donor_session',
    });
  }
  statements.push('COMMIT;');
  return { statements: statements.join('\n'), actors };
}

export function discoveryStateSql() {
  return `BEGIN READ ONLY;
SELECT json_object_agg(actor, state) FROM (
SELECT CASE d.email WHEN 'explorer-a@atm.invalid' THEN 'donor-a' ELSE 'donor-b' END AS actor,
json_build_object('public_name',d.public_name,'referral_emails',coalesce(p.referral_emails,false),'marketing_emails',coalesce(p.marketing_emails,false),
'preferences_version',coalesce(p.version,0),'gift_count',(SELECT count(*) FROM donor_gifts g WHERE g.donor_id=d.id),
'active_sessions',(SELECT count(*) FROM donor_sessions s WHERE s.donor_id=d.id AND s.revoked_at IS NULL AND s.expires_at>now())) AS state
FROM donors d LEFT JOIN donor_preferences p ON p.donor_id=d.id WHERE d.email IN ('explorer-a@atm.invalid','explorer-b@atm.invalid')
) fixture;
ROLLBACK;`;
}

export function performanceFixture() {
  const cookies = [],
    statements = ['BEGIN;'];
  for (let i = 0; i < 12; i++) {
    const donor = randomUUID(),
      checkout = randomUUID(),
      token = randomBytes(32).toString('base64url');
    cookies.push(`dad_donor_session=${token}`);
    statements.push(`INSERT INTO donors(id,email,claimed_at) VALUES ('${donor}','load-${i}@atm.invalid',now());
INSERT INTO donor_sessions(id,donor_id,token_hash,expires_at) VALUES ('${randomUUID()}','${donor}','${digest(token)}',now()+interval '1 hour');
INSERT INTO donor_checkouts(id,donor_id,amount_minor,frequency) VALUES ('${checkout}','${donor}',1000,'ONE_TIME');
INSERT INTO donor_gifts(id,donor_id,checkout_id,stripe_object_id,amount_minor,currency,frequency,paid_at)
SELECT gen_random_uuid(),'${donor}','${checkout}','atm_${donor}_'||n,1000,'USD','ONE_TIME',timestamptz '2026-01-01 00:00:00+00'+n*interval '1 day' FROM generate_series(1,60) n;
INSERT INTO donor_metric_projections(id,donor_id,net_minor,computed_at,next_refresh_at) VALUES ('${randomUUID()}','${donor}',60000,now(),now()+interval '1 day');`);
  }
  statements.push('COMMIT;');
  return { statements: statements.join('\n'), cookies };
}

export function replayRestoreSql(data) {
  return `BEGIN;\n${data}\nCOMMIT;`;
}
