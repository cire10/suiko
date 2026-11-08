// @ts-check
// Credential and key files, by file name and by path (never by contents): what a code review leaves out of its
// untracked files (code/git.js looksSecret), and, together with the dot-path rule, what the content origin never
// serves and the store never copies into its (committed) asset snapshots (util/paths.js isDeniedPath).
//
// Each rule says what the file looks like, for the reports: `.npmrc (excluded: looks like npm credentials)`.
// Names are matched case-insensitively and in ASCII. A source file is never matched: the rules name dot-files,
// key and keystore extensions, or data files (.json, .yaml...) named after credentials, so `src/credentials.js`,
// `docker/config.json` or `.nvmrc` stay in a review.

/**
 * @typedef {object} SecretRule
 * @property {string} what what such a file is, after "looks like" ('npm credentials')
 * @property {RegExp} [name] matched against the lowercase basename
 * @property {RegExp} [path] matched against the whole lowercase POSIX path
 */

/** Extensions of data files that hold credentials when named after them (source files are never among them). */
const DATA_EXT = '(?:json|ya?ml|toml|ini|xml|cfg|conf|properties)';

/**
 * In order: the first match names the file (a path rule before the generic name rule it would also match).
 * @type {readonly SecretRule[]}
 */
export const SECRET_RULES = Object.freeze([
  { what: 'an environment file', name: /^\.env/ },
  { what: 'an SSH key', name: /^id_(rsa|dsa|ecdsa|ed25519)/ },
  { what: 'an SSH file', path: /(^|\/)\.ssh\// },
  { what: 'a GnuPG keyring', path: /(^|\/)\.gnupg\// },
  { what: 'a GnuPG keyring', name: /^secring\./ },
  { what: 'a private key or certificate', name: /\.(pem|key|ppk|p12|pfx|pkcs12)$/ },
  { what: 'a private key or certificate', name: /^authkey_[a-z0-9]+\.p8$/ },
  { what: 'a keystore', name: /\.(keystore|jks|bks|keychain|keychain-db)$/ },
  { what: 'npm credentials', name: /^\.npmrc$/ },
  { what: 'PyPI credentials', name: /^\.pypirc$/ },
  { what: 'login credentials (netrc)', name: /^(\.netrc|_netrc|\.authinfo)$/ },
  { what: 'git credentials', name: /^\.git-credentials$/ },
  { what: 'AWS credentials', path: /(^|\/)\.aws\/credentials$/ },
  { what: 'Docker credentials', path: /(^|\/)\.docker\/config\.json$/ },
  { what: 'Docker credentials', name: /^\.dockercfg$/ },
  { what: 'Kubernetes credentials', path: /(^|\/)\.kube\/config$/ },
  { what: 'Kubernetes credentials', name: /^kubeconfig(\.(ya?ml|json))?$|\.kubeconfig$/ },
  { what: 'GitHub CLI credentials', path: /(^|\/)\.config\/gh\/hosts\.ya?ml$/ },
  { what: 'an OAuth client secret', name: /^client_secret.*\.json$/ },
  { what: 'a service account key', name: /(service[-_]?account|firebase-adminsdk).*\.json$/ },
  { what: 'a credentials file', name: new RegExp(`^credentials$|credentials.*\\.${DATA_EXT}$`) },
  { what: 'a password file', name: /^\.htpasswd$/ },
  { what: 'PostgreSQL passwords', name: /^\.pgpass$/ },
  { what: 'MySQL credentials', name: /^\.my\.cnf$/ },
  { what: 'cloud storage credentials', name: /^(\.s3cfg|\.boto)$/ },
  { what: 'a Vault token', name: /^\.vault-token$/ },
  { what: 'Terraform credentials', name: /^(\.terraformrc|terraform\.rc)$/ },
  { what: 'Terraform state', name: /\.tfstate(\.backup)?$/ },
  { what: 'a password database', name: /\.kdbx$/ },
  { what: 'a VPN profile', name: /\.ovpn$/ },
]);

/**
 * What a path looks like when it names a credential or key file ('npm credentials'), else null.
 * @param {string} p a relative path, POSIX or native (any text; only ASCII patterns are checked)
 * @returns {string | null}
 */
export function secretFileKind(p) {
  if (typeof p !== 'string' || !p) return null;
  const rel = p.replace(/\\/g, '/').toLowerCase();
  const base = rel.split('/').filter(Boolean).pop() ?? '';
  for (const r of SECRET_RULES) {
    if ((r.name && r.name.test(base)) || (r.path && r.path.test(rel))) return r.what;
  }
  return null;
}
