// Severity: 0 = disabled, 1 = warning, 2 = error
// Applicability: 'always' | 'never'
// See https://commitlint.js.org/reference/rules.html

/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'chore', 'docs', 'test', 'refactor', 'perf', 'ci', 'build', 'revert'],
    ],
    'scope-enum': [
      2,
      'always',
      ['api', 'web', 'mobile', 'database', 'infra', 'shared', 'e2e', 'deps'],
    ],
    // Scope is optional: empty scope emits a warning but does not fail the commit.
    'scope-empty': [1, 'never'],
    'subject-case': [2, 'never', ['upper-case', 'pascal-case', 'start-case']],
    'header-max-length': [2, 'always', 72],
  },
};
