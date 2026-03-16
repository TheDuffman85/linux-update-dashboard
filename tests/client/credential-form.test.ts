import { describe, expect, test } from "bun:test";
import { buildCredentialPayload, validateCredentialForm } from "../../client/lib/credential-form";
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

describe("validateCredentialForm", () => {
  test("requires a password for new username/password credentials", () => {
    expect(
      validateCredentialForm("Ops", "usernamePassword", {
        username: "root",
        password: "",
        privateKey: "",
        passphrase: "",
        certificatePem: "",
        privateKeyPem: "",
        privateKeyPassword: "",
      }),
    ).toBe("Password is required");
  });

  test("allows stored secrets to stay unchanged while editing", () => {
    expect(
      validateCredentialForm(
        "Ops",
        "sshKey",
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
          privateKey: "(stored)",
        }),
      ),
    ).toBeNull();
  });
});
