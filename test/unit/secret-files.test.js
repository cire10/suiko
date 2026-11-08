// @ts-check
// Credential and key files by name and by path (util/secret-files.js): what a code review leaves out of its
// untracked files (code/git.js looksSecret / secretKind) and what the content origin refuses (util/paths.js
// isDeniedPath). Every kind says what the file looks like; ordinary source and config files are never matched.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { secretFileKind } from '../../src/core/util/secret-files.js';
import { looksSecret, secretKind } from '../../src/core/code/git.js';
import { isDeniedPath } from '../../src/core/util/paths.js';

/** [path, what it looks like] */
const SECRETS = [
  ['.env', 'an environment file'],
  ['config/.env.production', 'an environment file'],
  ['deploy/id_rsa', 'an SSH key'],
  ['keys/id_ed25519.pub', 'an SSH key'],
  ['.ssh/config', 'an SSH file'],
  ['ops/.ssh/deploy_key', 'an SSH file'],
  ['.gnupg/pubring.kbx', 'a GnuPG keyring'],
  ['backup/secring.gpg', 'a GnuPG keyring'],
  ['certs/server.pem', 'a private key or certificate'],
  ['tls/Server.KEY', 'a private key or certificate'],
  ['putty/me.ppk', 'a private key or certificate'],
  ['ios/AuthKey_ABC123XYZ.p8', 'a private key or certificate'],
  ['store.p12', 'a private key or certificate'],
  ['android/release.keystore', 'a keystore'],
  ['android/app.jks', 'a keystore'],
  ['login.keychain-db', 'a keystore'],
  ['.npmrc', 'npm credentials'],
  ['packages/web/.npmrc', 'npm credentials'],
  ['.pypirc', 'PyPI credentials'],
  ['.netrc', 'login credentials (netrc)'],
  ['_netrc', 'login credentials (netrc)'],
  ['.git-credentials', 'git credentials'],
  ['.aws/credentials', 'AWS credentials'],
  ['home/.aws/credentials', 'AWS credentials'],
  ['.docker/config.json', 'Docker credentials'],
  ['.dockercfg', 'Docker credentials'],
  ['.kube/config', 'Kubernetes credentials'],
  ['kubeconfig', 'Kubernetes credentials'],
  ['clusters/prod.kubeconfig', 'Kubernetes credentials'],
  ['.config/gh/hosts.yml', 'GitHub CLI credentials'],
  ['client_secret_1234.apps.googleusercontent.com.json', 'an OAuth client secret'],
  ['gcp-service-account.json', 'a service account key'],
  ['keys/my_service_account_key.json', 'a service account key'],
  ['app-firebase-adminsdk-x1y2z.json', 'a service account key'],
  ['credentials.json', 'a credentials file'],
  ['config/Credentials.JSON', 'a credentials file'],
  ['application_default_credentials.json', 'a credentials file'],
  ['.cargo/credentials.toml', 'a credentials file'],
  ['.gem/credentials', 'a credentials file'],
  ['credentials.tfrc.json', 'a credentials file'],
  ['.htpasswd', 'a password file'],
  ['.pgpass', 'PostgreSQL passwords'],
  ['.my.cnf', 'MySQL credentials'],
  ['.s3cfg', 'cloud storage credentials'],
  ['.vault-token', 'a Vault token'],
  ['.terraformrc', 'Terraform credentials'],
  ['infra/terraform.tfstate', 'Terraform state'],
  ['infra/terraform.tfstate.backup', 'Terraform state'],
  ['vault.kdbx', 'a password database'],
  ['vpn/office.ovpn', 'a VPN profile'],
];

/** Ordinary files: always reviewed, never refused for their name. */
const ORDINARY = [
  'src/credentials.js',
  'src/credentials/index.ts',
  'src/aws/credentials.ts',
  'docs/credentials.md',
  'src/secret-manager.js',
  'src/keystore.py',
  'lib/netrc.go',
  'src/npmrc.ts',
  'src/service-account.ts',
  'k8s/service-account.yaml',
  'charts/app/templates/secret.yaml',
  'docker/config.json',
  'config.json',
  'kube/config',
  'src/kubeconfig.go',
  'package.json',
  'Dockerfile',
  'env.ts',
  'src/key.ts',
  'game.p8',
  '.nvmrc',
  '.npmignore',
  '.dockerignore',
  '.gitignore',
  '.github/workflows/ci.yml',
  '.vscode/settings.json',
  '.eslintrc.json',
  '.config/app/settings.yml',
  'README.md',
];

describe('credential and key files', () => {
  test('each kind is found by name or by path, case-insensitively, and says what it looks like', () => {
    for (const [p, what] of SECRETS) {
      assert.equal(secretFileKind(p), what, p);
      assert.equal(secretKind(p), what, p);
      assert.equal(looksSecret(p), true, p);
    }
    assert.equal(secretFileKind('ops\\.ssh\\deploy_key'), 'an SSH file', 'native separators');
  });

  test('ordinary source and config files are never matched', () => {
    for (const p of ORDINARY) {
      assert.equal(secretFileKind(p), null, p);
      assert.equal(looksSecret(p), false, p);
    }
    assert.equal(secretFileKind(''), null);
    assert.equal(secretFileKind(/** @type {any} */ (null)), null);
  });

  test('the content origin refuses the same files (dot-paths were refused already), and still serves ordinary ones', () => {
    for (const [p] of SECRETS) assert.equal(isDeniedPath(p), true, p);
    for (const p of ['credentials.json', 'android/release.keystore', 'gcp-service-account.json', 'infra/terraform.tfstate', 'kubeconfig']) {
      assert.equal(isDeniedPath(p), true, p);
    }
    for (const p of ORDINARY.filter((x) => !x.split('/').some((s) => s.startsWith('.')))) assert.equal(isDeniedPath(p), false, p);
    assert.equal(isDeniedPath('img/arch.png'), false);
  });
});
