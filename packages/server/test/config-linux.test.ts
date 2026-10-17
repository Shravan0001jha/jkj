import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { childEnv } from '../src/services/employees.js';
import { testWorkplace } from './fakes/workplace.js';

/**
 * The Workplace on the Linux server (cloud migration, 17 Oct): no Mac toolchain paths are invented
 * for a machine that has none, evidence runs on GitHub there by default, and the workflow repo is
 * configurable. On the Mac nothing changes.
 */

test('on Linux the Android, JDK and Xcode paths are not the Mac defaults; set from the environment they are kept', () => {
  const linux = loadConfig(['--no-open'], {}, 'linux');
  // Run on a Mac, the paths exist and are kept (a path that is really there is fine anywhere).
  const want = (p: string): string => (existsSync(p) ? p : '');
  assert.equal(linux.evidence.androidHome, want('/opt/homebrew/share/android-commandlinetools'));
  assert.equal(linux.evidence.javaHome, want('/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home'));
  assert.equal(linux.evidence.developerDir, want('/Applications/Xcode.app/Contents/Developer'));
  const set = loadConfig(['--no-open'], { ANDROID_HOME: '/opt/android', WORKPLACE_JAVA_HOME: '/usr/lib/jvm/java-17' }, 'linux');
  assert.equal(set.evidence.androidHome, '/opt/android');
  assert.equal(set.evidence.javaHome, '/usr/lib/jvm/java-17');
  const mac = loadConfig(['--no-open'], {}, 'darwin');
  assert.equal(mac.evidence.androidHome, '/opt/homebrew/share/android-commandlinetools');
  assert.equal(mac.evidence.developerDir, '/Applications/Xcode.app/Contents/Developer');
});

test('evidence runs on GitHub on Linux and locally on the Mac, unless WORKPLACE_EVIDENCE_ON says otherwise', () => {
  assert.equal(loadConfig(['--no-open'], {}, 'linux').evidence.runOn, 'github');
  assert.equal(loadConfig(['--no-open'], {}, 'darwin').evidence.runOn, 'local');
  assert.equal(loadConfig(['--no-open'], { WORKPLACE_EVIDENCE_ON: 'github' }, 'darwin').evidence.runOn, 'github');
  const g = loadConfig(['--no-open'], { WORKPLACE_GITHUB_WORKFLOW_REPO: 'iris-ci', WORKPLACE_GITHUB_WORKFLOW_REF: 'trunk' }, 'linux').github;
  assert.deepEqual([g.workflowRepo, g.workflowRef], ['iris-ci', 'trunk']);
  const d = loadConfig(['--no-open'], {}, 'linux').github;
  assert.deepEqual([d.workflowRepo, d.workflowRef], ['iris-e2e', 'main']);
});

test('an employee session gets no empty toolchain variables', () => {
  const { wp, tmp } = testWorkplace();
  try {
    wp.config.evidence.androidHome = ''; wp.config.evidence.javaHome = ''; wp.config.evidence.developerDir = '';
    const env = childEnv(wp, 'kabir');
    assert.equal(env['DEVELOPER_DIR'], process.env['DEVELOPER_DIR']);
    assert.notEqual(env['ANDROID_HOME'], '');
    assert.notEqual(env['JAVA_HOME'], '');
  } finally { tmp.cleanup(); }
});
