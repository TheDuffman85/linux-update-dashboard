import { describe, expect, test } from "vitest";
import {
  getRecoverableAuthRefreshState,
  isHardAuthRefreshFailure,
  type AuthState,
} from "../../client/context/AuthContext";
import { ApiError } from "../../client/lib/client";

function makeState(overrides: Partial<AuthState> = {}): AuthState {
  return {
    user: null,
    loading: false,
    setupRequired: false,
    oidcEnabled: false,
    passwordLoginDisabled: false,
    passkeysEnabled: false,
    hasPassword: false,
    backendUnavailable: false,
    ...overrides,
  };
}

describe("auth refresh recovery", () => {
  test("keeps initial auth loading during a recoverable backend outage", () => {
    expect(getRecoverableAuthRefreshState(makeState({ user: null }))).toMatchObject({
      loading: true,
      backendUnavailable: true,
      user: null,
    });
  });

  test("keeps an existing authenticated user during a recoverable backend outage", () => {
    expect(
      getRecoverableAuthRefreshState(makeState({
        user: { userId: 1, username: "admin" },
      })),
    ).toMatchObject({
      loading: false,
      backendUnavailable: true,
      user: { userId: 1, username: "admin" },
    });
  });

  test("treats unauthenticated responses as hard auth failures", () => {
    expect(isHardAuthRefreshFailure(new ApiError(401, "Unauthorized"))).toBe(true);
    expect(isHardAuthRefreshFailure(new ApiError(403, "Forbidden"))).toBe(true);
    expect(isHardAuthRefreshFailure(new ApiError(503, "Unavailable"))).toBe(false);
    expect(isHardAuthRefreshFailure(new TypeError("network down"))).toBe(false);
  });
});
