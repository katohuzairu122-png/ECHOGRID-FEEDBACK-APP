import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const TARGET = Object.freeze({
  account: 'cf205213947e3617297373060fe4c15f',
  worker: 'echo-grid-feedback-web',
  resource: '83591b02fdb84691b1c81a1699f4bba4',
  homepage: 'https://echo-grid.uk/',
});

export function assertReleaseBinding({ expected, runSha, main, ref, confirmation }) {
  if (!/^[0-9a-f]{40}$/.test(expected ?? '') || expected !== runSha || expected !== main ||
      ref !== 'refs/heads/main' || confirmation !== 'DEPLOY_PRODUCTION_WEB_ONLY') {
    throw new Error('Release must bind the exact current main SHA and Web-only confirmation');
  }
}

export function assertProductionProtection(environment) {
  const reviewers = environment.protection_rules?.find(rule => rule.type === 'required_reviewers');
  const policy = environment.deployment_branch_policy;
  if (environment.name !== 'production' || !Array.isArray(reviewers?.reviewers) || !reviewers.reviewers.length ||
      reviewers.prevent_self_review !== true || !policy ||
      (!policy.protected_branches && !policy.custom_branch_policies)) {
    throw new Error('Production requires independent reviewers, prevention of self-review and branch restrictions');
  }
}

export function assertWebOnlyConfiguration(wrangler, adapter) {
  const name = wrangler.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1];
  const resourceStanzas = /^\s*\[\[?[^\]\n]*(r2_buckets|d1_databases|queues|services|durable_objects|kv_namespaces|hyperdrive|pipelines|triggers|unsafe)/m;
  const cleanAdapter = adapter.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
  if (name !== TARGET.worker || resourceStanzas.test(wrangler) || !cleanAdapter.endsWith('exportdefaultdefineCloudflareConfig();')) {
    throw new Error('Web-only release supports only the existing stateless Worker; review resource/cache changes separately');
  }
}

export function assertDeploymentContinuity(before, after, expectedVersion) {
  if (JSON.stringify(before.apiVersions) !== JSON.stringify(after.apiVersions)) {
    throw new Error('API deployment changed during the Web release; investigate without modifying the API');
  }
  if (!expectedVersion || after.webVersions.length !== 1 || after.webVersions[0].version_id !== expectedVersion ||
      after.webVersions[0].percentage !== 100) throw new Error('Web deployment does not match uploaded version at 100%');
}

async function getJson(url, token) {
  const response = await globalThis.fetch(url, {
    method: 'GET', redirect: 'error', signal: globalThis.AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Read-only provider verification failed: HTTP ${response.status}`);
  return response.json();
}

async function snapshot() {
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = process.env;
  if (account !== TARGET.account || !token) throw new Error('Unexpected production account or missing credential');
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  const get = async path => {
    const result = await getJson(base + path, token);
    if (result.success !== true) throw new Error('Provider read returned failure');
    return result.result;
  };
  const [resource, domains, web, api] = await Promise.all([
    get(`/workers/workers/${TARGET.worker}`), get('/workers/domains'),
    get(`/workers/scripts/${TARGET.worker}/deployments`), get('/workers/scripts/echo-grid-feedback-api/deployments'),
  ]);
  if (resource.id !== TARGET.resource || resource.name !== TARGET.worker ||
      !domains.some(domain => domain.hostname === 'echo-grid.uk' && domain.service === TARGET.worker)) {
    throw new Error('Production Worker resource/domain identity mismatch');
  }
  if (!web.deployments?.[0]?.versions?.length || !api.deployments?.[0]?.versions?.length) {
    throw new Error('Incomplete deployment evidence');
  }
  return { account, resource: resource.id, worker: resource.name,
    webVersions: web.deployments[0].versions, apiVersions: api.deployments[0].versions,
    checkedAt: new Date().toISOString(), commit: process.env.AUTHORIZED_COMMIT };
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'authorize') {
    const { EXPECTED_COMMIT: expected, RUN_SHA: runSha, CURRENT_MAIN: tip, DISPATCH_REF: ref, CONFIRMATION: confirmation } = process.env;
    assertReleaseBinding({ expected, runSha, main: tip, ref, confirmation });
    appendFileSync(process.env.GITHUB_OUTPUT, `commit=${expected}\n`);
    return;
  }
  if (mode === 'protection') {
    if (process.env.GITHUB_REPOSITORY !== 'katohuzairu122-png/ECHOGRID-FEEDBACK-APP') throw new Error('Unexpected repository');
    const environment = await getJson(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/environments/production`, process.env.GH_TOKEN);
    assertProductionProtection(environment);
    return;
  }
  if (!['before', 'after'].includes(mode)) throw new Error('Unsupported release operation');
  assertWebOnlyConfiguration(readFileSync('apps/web/wrangler.toml', 'utf8'), readFileSync('apps/web/open-next.config.ts', 'utf8'));
  mkdirSync('provenance', { recursive: true });
  const current = await snapshot();
  if (mode === 'after') {
    const before = JSON.parse(readFileSync('provenance/before.json', 'utf8'));
    const log = readFileSync('provenance/deploy.log', 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
    const version = log.match(/Current Version ID:\s*([0-9a-f-]{36})/)?.[1];
    assertDeploymentContinuity(before, current, version);
    const responses = [];
    for (const url of [TARGET.homepage, new URL('login', TARGET.homepage).href]) {
      const response = await globalThis.fetch(url, { redirect: 'manual', cache: 'no-store', signal: globalThis.AbortSignal.timeout(30000) });
      if (response.status !== 200) throw new Error('Post-deployment public Web smoke failed');
      responses.push({ url, status: response.status, cfRay: response.headers.get('cf-ray') });
      await response.body?.cancel();
    }
    current.responses = responses;
  }
  writeFileSync(`provenance/${mode}.json`, JSON.stringify(current, null, 2) + '\n');
  console.log(`Verified ${mode} Web-only release evidence`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
