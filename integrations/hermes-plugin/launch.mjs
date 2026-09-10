#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { validateApiEndpoint } from './endpoint-policy.mjs';

const NOTES_PROFILES = new Set(['read', 'share', 'write']);
const VAULT_PROFILES = new Set(['none', 'metadata', 'reveal', 'write']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENV_KEYS_TO_ISOLATE = [
  'QNOTES_URL',
  'QNOTES_MCP_PROFILE',
  'QNOTES_TOKEN',
  'QNOTES_READ_TOKEN',
  'QNOTES_WRITE_TOKEN',
  'QNOTES_MCP_DEVICE_ID',
  'QNOTES_MCP_ENABLE_PUBLIC_SHARE',
  'QNOTES_ALLOW_INSECURE_LOOPBACK',
  'QVAULT_TOKEN',
  'QVAULT_MCP_PROFILE',
  'QVAULT_URL',
  'QNOTES_PLUGIN_TOKEN',
  'QNOTES_PLUGIN_VAULT_TOKEN',
];

class LauncherConfigurationError extends Error {}

function configurationError() {
  return new LauncherConfigurationError('invalid launcher configuration');
}

function parseArgs(argv) {
  const values = {
    serverPath: null,
    notesProfile: null,
    vaultProfile: null,
    includePublicShare: false,
  };
  const valueFlags = new Map([
    ['--server-path', 'serverPath'],
    ['--notes-profile', 'notesProfile'],
    ['--vault-profile', 'vaultProfile'],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--include-public-share') {
      if (seen.has(argument)) throw configurationError();
      seen.add(argument);
      values.includePublicShare = true;
      continue;
    }
    const key = valueFlags.get(argument);
    if (!key || seen.has(argument) || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw configurationError();
    }
    seen.add(argument);
    values[key] = argv[index + 1];
    index += 1;
  }
  if (!values.serverPath || !values.notesProfile || !values.vaultProfile) throw configurationError();
  if (!NOTES_PROFILES.has(values.notesProfile) || !VAULT_PROFILES.has(values.vaultProfile)) throw configurationError();
  if (values.includePublicShare && values.notesProfile !== 'write') throw configurationError();
  return values;
}

function validateServerPath(value) {
  if (!isAbsolute(value)) throw configurationError();
  try {
    if (!statSync(value).isFile()) throw configurationError();
  } catch (error) {
    if (error instanceof LauncherConfigurationError) throw error;
    throw configurationError();
  }
  if (!/\.(?:c|m)?js$/i.test(value)) throw configurationError();
  return value;
}

function validateUrl(value, allowInsecureLoopback) {
  try {
    return validateApiEndpoint(value, { allowInsecureLoopback });
  } catch {
    throw configurationError();
  }
}

function selectedCredential(environment, key) {
  const value = environment[key];
  if (typeof value !== 'string' || !value.trim() || value.includes('${') || value.includes('\0')) {
    throw configurationError();
  }
  return value;
}

function selectedDeviceId(environment) {
  const value = environment.QNOTES_MCP_DEVICE_ID;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw configurationError();
  return value;
}

function buildChildEnvironment(options, parentEnvironment) {
  if (typeof parentEnvironment.QVAULT_URL === 'string' && parentEnvironment.QVAULT_URL.trim()) {
    throw configurationError();
  }
  const notesAlias = 'QNOTES_PLUGIN_TOKEN';
  const childEnvironment = { ...parentEnvironment };
  for (const key of ENV_KEYS_TO_ISOLATE) delete childEnvironment[key];
  const allowInsecureLoopback = parentEnvironment.QNOTES_ALLOW_INSECURE_LOOPBACK === 'true';
  childEnvironment.QNOTES_URL = validateUrl(parentEnvironment.QNOTES_URL, allowInsecureLoopback);
  if (allowInsecureLoopback) childEnvironment.QNOTES_ALLOW_INSECURE_LOOPBACK = 'true';
  const token = selectedCredential(parentEnvironment, notesAlias);
  if (options.notesProfile === 'read') childEnvironment.QNOTES_READ_TOKEN = token;
  if (options.notesProfile === 'share') childEnvironment.QNOTES_TOKEN = token;
  if (options.notesProfile === 'write') {
    childEnvironment.QNOTES_WRITE_TOKEN = token;
    childEnvironment.QNOTES_MCP_DEVICE_ID = selectedDeviceId(parentEnvironment);
  }
  childEnvironment.QNOTES_MCP_PROFILE = options.notesProfile;
  if (options.includePublicShare) childEnvironment.QNOTES_MCP_ENABLE_PUBLIC_SHARE = 'true';

  if (options.vaultProfile !== 'none') {
    childEnvironment.QVAULT_TOKEN = selectedCredential(parentEnvironment, 'QNOTES_PLUGIN_VAULT_TOKEN');
    childEnvironment.QVAULT_MCP_PROFILE = options.vaultProfile;
  }
  return childEnvironment;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const serverPath = validateServerPath(options.serverPath);
  const environment = buildChildEnvironment(options, process.env);
  const child = spawn(process.execPath, [serverPath], {
    env: environment,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });

  let settled = false;
  const forwardSignal = (signal) => {
    if (!settled) child.kill(signal);
  };
  process.once('SIGINT', () => forwardSignal('SIGINT'));
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));
  await new Promise((resolve, reject) => {
    child.once('error', () => reject(configurationError()));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).then(({ code, signal }) => {
    settled = true;
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}

run().catch(() => {
  process.stderr.write('QNotes launcher could not start the selected runtime.\n');
  process.exitCode = 1;
});
