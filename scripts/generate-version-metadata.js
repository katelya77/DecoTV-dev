#!/usr/bin/env node

/* eslint-disable no-console */

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const publicDir = path.join(projectRoot, 'public');
const packageJson = require(path.join(projectRoot, 'package.json'));

const TIMESTAMP_REGEX = /^\d{14}$/;

function runGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function toTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function timestampToIso(timestamp) {
  if (!TIMESTAMP_REGEX.test(timestamp)) {
    return new Date().toISOString();
  }

  const year = Number(timestamp.slice(0, 4));
  const month = Number(timestamp.slice(4, 6)) - 1;
  const day = Number(timestamp.slice(6, 8));
  const hour = Number(timestamp.slice(8, 10));
  const minute = Number(timestamp.slice(10, 12));
  const second = Number(timestamp.slice(12, 14));

  return new Date(year, month, day, hour, minute, second).toISOString();
}

function normalizeTimestamp(value) {
  return typeof value === 'string' && TIMESTAMP_REGEX.test(value) ? value : '';
}

function firstNonEmpty(...values) {
  return (
    values.find((value) => typeof value === 'string' && value.trim()) || ''
  );
}

function updateServiceWorkerVersionRevision(timestamp) {
  const swPath = path.join(publicDir, 'sw.js');
  if (!fs.existsSync(swPath)) return;

  const versionBytes = Buffer.from(`${timestamp}\n`, 'utf8');
  const revision = crypto.createHash('md5').update(versionBytes).digest('hex');
  const content = fs.readFileSync(swPath, 'utf8');
  const updated = content.replace(
    /(\{ url: ['"]\/VERSION\.txt['"], revision: ['"])[a-f0-9]+(['"] \})/i,
    `$1${revision}$2`,
  );

  if (updated !== content) {
    fs.writeFileSync(swPath, updated, 'utf8');
    console.log(`✅ Updated service worker VERSION.txt revision: ${revision}`);
  }
}

function main() {
  const timestamp =
    normalizeTimestamp(
      firstNonEmpty(
        process.env.BUILD_TIMESTAMP,
        process.env.NEXT_PUBLIC_BUILD_TIMESTAMP,
      ),
    ) || toTimestamp();

  const commitSha = firstNonEmpty(
    process.env.GIT_COMMIT_SHA,
    process.env.NEXT_PUBLIC_BUILD_COMMIT_SHA,
    process.env.GITHUB_SHA,
    process.env.VERCEL_GIT_COMMIT_SHA,
    runGit(['rev-parse', 'HEAD']),
  );

  const commitDate = firstNonEmpty(
    process.env.GIT_COMMIT_DATE,
    process.env.NEXT_PUBLIC_BUILD_COMMIT_DATE,
    commitSha ? runGit(['show', '-s', '--format=%cI', commitSha]) : '',
  );

  const ref = firstNonEmpty(
    process.env.GIT_REF_NAME,
    process.env.NEXT_PUBLIC_BUILD_REF,
    process.env.GITHUB_REF_NAME,
    process.env.VERCEL_GIT_COMMIT_REF,
    runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
  );

  const repo = firstNonEmpty(
    process.env.NEXT_PUBLIC_UPDATE_REPO,
    process.env.GITHUB_REPOSITORY,
    'Decohererk/DecoTV',
  );

  const metadata = {
    version: packageJson.version,
    timestamp,
    buildTime: timestampToIso(timestamp),
    commitSha,
    shortCommit: commitSha ? commitSha.slice(0, 7) : '',
    commitDate,
    ref,
    repo,
    source:
      process.env.GITHUB_ACTIONS === 'true'
        ? 'github-actions'
        : process.env.VERCEL
          ? 'vercel'
          : process.env.DOCKER_BUILD === 'true' ||
              process.env.DOCKER_ENV === 'true'
            ? 'docker'
            : 'local',
  };

  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(
    path.join(publicDir, 'version.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(publicDir, 'VERSION.txt'),
    `${timestamp}\n`,
    'utf8',
  );

  if (process.env.UPDATE_ROOT_VERSION === 'true') {
    fs.writeFileSync(
      path.join(projectRoot, 'VERSION.txt'),
      `${timestamp}\n`,
      'utf8',
    );
  }

  updateServiceWorkerVersionRevision(timestamp);

  console.log(
    `✅ Generated version metadata: v${metadata.version} ${timestamp} ${metadata.shortCommit || 'no-commit'}`,
  );
}

main();
