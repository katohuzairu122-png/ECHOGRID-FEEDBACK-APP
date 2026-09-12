import { describe, it, expect } from 'vitest';
import { rethrowControlFlow } from './rethrow-control-flow';

/**
 * These tests are the upgrade guard. This helper depends on the shape of
 * Next.js's control-flow digest strings rather than on a framework import
 * (see the module's own note on why), so the cases below are what would fail
 * if a future Next release renamed them -- which is the signal to revisit,
 * and is better than the silent swallowed redirect that would otherwise
 * return.
 */
describe('rethrowControlFlow', () => {
  /** The shape `redirect()` actually throws: prefix, then mode, target and
   * status appended after semicolons. */
  const redirectError = () => Object.assign(new Error('NEXT_REDIRECT'), {
    digest: 'NEXT_REDIRECT;replace;/loyalty/login;307;',
  });

  it('re-throws a redirect, so a catch block cannot cancel the navigation', () => {
    const err = redirectError();
    expect(() => rethrowControlFlow(err)).toThrow(err);
  });

  it('re-throws notFound()', () => {
    const err = Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_NOT_FOUND' });
    expect(() => rethrowControlFlow(err)).toThrow(err);
  });

  it('re-throws the same object, not a copy -- the framework matches on identity and digest', () => {
    const err = redirectError();
    let caught: unknown;
    try {
      rethrowControlFlow(err);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
  });

  it('does nothing for a real application error, so the caller still handles it', () => {
    expect(() => rethrowControlFlow(new Error('API exploded'))).not.toThrow();
    expect(() => rethrowControlFlow(Object.assign(new Error('nope'), { digest: 12345 }))).not.toThrow();
    expect(() =>
      rethrowControlFlow(Object.assign(new Error('nope'), { digest: 'SOMETHING_ELSE' })),
    ).not.toThrow();
  });

  it('does not throw on the values a catch block can actually receive', () => {
    // `catch (err)` is `unknown`: anything can be thrown in JavaScript, and
    // a helper called first in every catch must not itself become the
    // failure.
    for (const value of [undefined, null, 'a string', 0, false, {}, []]) {
      expect(() => rethrowControlFlow(value)).not.toThrow();
    }
  });

  it('is not fooled by a digest that merely CONTAINS the prefix', () => {
    // Prefix match, not substring: an application error whose digest happens
    // to mention a redirect must not be mistaken for one.
    expect(() =>
      rethrowControlFlow(Object.assign(new Error('x'), { digest: 'ERR_NEXT_REDIRECT_FAILED' })),
    ).not.toThrow();
  });
});
