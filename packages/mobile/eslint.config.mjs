import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['app/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    rules: {
      'no-undef': 'off',
    },
  },
];
