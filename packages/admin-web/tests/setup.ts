/// <reference types="vitest/globals" />
import { vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Polyfill ResizeObserver for radix-ui components in jsdom
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = MockResizeObserver;

// Polyfill pointer-capture + scrollIntoView for radix-ui components in jsdom.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// Polyfill matchMedia for the shadcn sidebar's useIsMobile hook in jsdom.
if (!window.matchMedia) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

// Stub Cognito env vars so module-init does not throw when test files import
// code that depends on them. These values are intentionally fake.
vi.stubEnv('VITE_COGNITO_PLATFORM_ADMINS_POOL_ID', 'eu-central-1_test');
vi.stubEnv('VITE_COGNITO_PLATFORM_ADMINS_CLIENT_ID', 'test-client-id');
