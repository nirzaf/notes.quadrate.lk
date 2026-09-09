#!/usr/bin/env node

import { statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHermesMcpConfig } from '../packages/shared/dist/hermes.js';

const NOTES_PROFILES = new Set(['read', 'share', 'write']);
const VAULT_PROFILES = new Set(['none', 'metadata', 'reveal', 'write']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALUE_FLAGS = new Map([
  ['--server-path', 'serverPath'],
  ['--plugin-dir', 'pluginDir'],
  ['--notes-profile', 'notesProfile'],
  ['--vault-profile', 'vaultProfile'],
  ['--device-id', 'deviceId'],
]);

class ExportConfigurationError extends Error {}

function invalidConfiguration() {
  return new ExportConfigurationError('invalid exporter configuration');
}

function parseArgs(argv) {
  const values = {
    serverPath: null,
    pluginDir: null,
    notesProfile: 'read',
    vaultProfile: 'none',
    deviceId: null,
    includePublicShare: false,
    allowStatusProbe: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--include-public-share' || flag === '--allow-status-probe') {
      if (seen.has(flag)) throw invalidConfiguration();
      seen.add(flag);
      if (flag === '--include-public-share') values.includePublicShare = true;
      else values.allowStatusProbe = true;
      continue;
    }
    const key = VALUE_FLAGS.get(flag);
    if (!key || seen.has(flag) || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw invalidConfiguration();
    }
    seen.add(flag);
    values[key] = argv[index + 1];
    index += 1;
  }
  if (!values.serverPath || !values.pluginDir) throw invalidConfiguration();
  if (!NOTES_PROFILES.has(values.notesProfile) || !VAULT_PROFILES.has(values.vaultProfile)) throw invalidConfiguration();
  if (values.includePublicShare && values.notesProfile !== 'write') throw invalidConfiguration();
  if (values.deviceId && values.notesProfile !== 'write') throw invalidConfiguration();
  if (values.notesProfile === 'write' && !values.deviceId) throw invalidConfiguration();
  if (values.deviceId && !UUID_PATTERN.test(values.deviceId)) throw invalidConfiguration();
  return values;
}

function assertAbsoluteFile(value) {
  if (!isAbsolute(value)) throw invalidConfiguration();
  try {
    if (!statSync(value).isFile()) throw invalidConfiguration();
  } catch (error) {
    if (error instanceof ExportConfigurationError) throw error;
    throw invalidConfiguration();
  }
  if (!/\.(?:c|m)?js$/i.test(value)) throw invalidConfiguration();
}

function assertPluginDirectory(value) {
  if (!isAbsolute(value)) throw invalidConfiguration();
  try {
    if (!statSync(value).isDirectory()) throw invalidConfiguration();
    for (const file of ['plugin.yaml', '__init__.py', 'commands.py', 'launch.mjs', 'README.md']) {
      if (!statSync(join(value, file)).isFile()) throw invalidConfiguration();
    }
    if (!statSync(join(value, 'skills', 'workflow', 'SKILL.md')).isFile()) throw invalidConfiguration();
  } catch (error) {
    if (error instanceof ExportConfigurationError) throw error;
    throw invalidConfiguration();
  }
}

function selectedPlaceholder(profile, environment) {
  const key = profile === 'write' ? 'QNOTES_WRITE_TOKEN' : 'QNOTES_TOKEN';
  const value = environment[key];
  if (typeof value !== 'string' || !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) throw invalidConfiguration();
  return value;
}

function exportConfig(options) {
  assertAbsoluteFile(options.serverPath);
  assertPluginDirectory(options.pluginDir);
  const canonical = JSON.parse(buildHermesMcpConfig({
    profile: options.notesProfile,
    serverPath: options.serverPath,
    vaultProfile: options.vaultProfile,
    ...(options.deviceId ? { deviceId: options.deviceId } : {}),
    includePublicShare: options.includePublicShare,
  }));
  const serverName = `qnotes_${options.notesProfile}`;
  const canonicalServer = canonical.mcp_servers?.[serverName];
  if (!canonicalServer || typeof canonicalServer !== 'object') throw invalidConfiguration();
  const canonicalEnvironment = canonicalServer.env;
  const environment = {
    QNOTES_URL: canonicalEnvironment.QNOTES_URL,
    QNOTES_PLUGIN_TOKEN: selectedPlaceholder(options.notesProfile, canonicalEnvironment),
  };
  if (options.notesProfile === 'write') environment.QNOTES_MCP_DEVICE_ID = options.deviceId;
  if (options.vaultProfile !== 'none') {
    if (canonicalEnvironment.QVAULT_TOKEN !== '${QVAULT_TOKEN}') throw invalidConfiguration();
    environment.QNOTES_PLUGIN_VAULT_TOKEN = canonicalEnvironment.QVAULT_TOKEN;
  }
  const launcherPath = resolve(options.pluginDir, 'launch.mjs');
  const args = [
    launcherPath,
    '--server-path', options.serverPath,
    '--notes-profile', options.notesProfile,
    '--vault-profile', options.vaultProfile,
    ...(options.includePublicShare ? ['--include-public-share'] : []),
  ];
  const pluginEntry = {
    settings: {
      server_name: serverName,
      notes_profile: options.notesProfile,
      vault_profile: options.vaultProfile,
    },
  };
  if (options.allowStatusProbe) {
    pluginEntry.mcp_allowlist = [serverName];
    console.error('Warning: status probing grants this plugin access to the server-wide MCP surface, including any configured write or reveal tools.');
  }
  return {
    mcp_servers: {
      [serverName]: {
        ...canonicalServer,
        command: 'node',
        args,
        env: environment,
      },
    },
    plugins: {
      entries: {
        qnotes: pluginEntry,
      },
    },
  };
}

try {
  const options = parseArgs(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(exportConfig(options), null, 2)}\n`);
} catch {
  process.stderr.write('QNotes Hermes configuration could not be generated.\n');
  process.exitCode = 1;
}
