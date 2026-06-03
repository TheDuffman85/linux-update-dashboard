import { describe, expect, test } from "vitest";
import { getApprovedHostKeyInvalidationSystemIds } from "../../client/lib/systems";

describe("getApprovedHostKeyInvalidationSystemIds", () => {
  test("returns unique systems whose host keys were approved", () => {
    expect(getApprovedHostKeyInvalidationSystemIds([
      {
        systemId: 7,
        role: "target",
        host: "host-a",
        port: 22,
        algorithm: "ssh-ed25519",
        fingerprintSha256: "SHA256:a",
        rawKey: "key-a",
      },
      {
        systemId: 7,
        role: "target",
        host: "host-a",
        port: 22,
        algorithm: "ssh-ed25519",
        fingerprintSha256: "SHA256:a",
        rawKey: "key-a",
      },
      {
        systemId: 9,
        role: "jump",
        host: "jump",
        port: 22,
        algorithm: "ssh-ed25519",
        fingerprintSha256: "SHA256:b",
        rawKey: "key-b",
      },
      {
        role: "target",
        host: "new-host",
        port: 22,
        algorithm: "ssh-ed25519",
        fingerprintSha256: "SHA256:c",
        rawKey: "key-c",
      },
    ])).toEqual([7, 9]);
  });
});
