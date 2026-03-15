import { describe, expect, test } from "bun:test";
import { buildCredentialPayload } from "../../client/lib/credential-form";
import type { CredentialDetail } from "../../client/lib/credentials";

function makeInitial(
  payload: CredentialDetail["payload"]
): Pick<CredentialDetail, "payload"> {
  return { payload };
}

describe("buildCredentialPayload", () => {
  test("keeps stored password placeholders when editing username/password credentials", () => {
    expect(
      buildCredentialPayload(
        "usernamePassword",
        {
          username: "root",
          password: "",
          privateKey: "",
          passphrase: "",
          certificatePem: "",
          privateKeyPem: "",
          privateKeyPassword: "",
        },
        makeInitial({
          username: "root",
          password: "(stored)",
        })
      )
    ).toEqual({
      username: "root",
      password: "(stored)",
    });
  });

  test("prefers newly entered ssh key values", () => {
    expect(
      buildCredentialPayload("sshKey", {
        username: "ops",
        password: "",
        privateKey: "PRIVATE KEY",
        passphrase: "secret",
        certificatePem: "",
        privateKeyPem: "",
        privateKeyPassword: "",
      })
    ).toEqual({
      username: "ops",
      privateKey: "PRIVATE KEY",
      passphrase: "secret",
    });
  });

  test("keeps stored certificate secrets when left unchanged", () => {
    expect(
      buildCredentialPayload(
        "certificate",
        {
          username: "ubuntu",
          password: "",
          privateKey: "",
          passphrase: "",
          certificatePem: "",
          privateKeyPem: "",
          privateKeyPassword: "",
        },
        makeInitial({
          username: "ubuntu",
          certificatePem: "(stored)",
          privateKeyPem: "(stored)",
          privateKeyPassword: "(stored)",
        })
      )
    ).toEqual({
      username: "ubuntu",
      certificatePem: "(stored)",
      privateKeyPem: "(stored)",
      privateKeyPassword: "(stored)",
    });
  });
});
