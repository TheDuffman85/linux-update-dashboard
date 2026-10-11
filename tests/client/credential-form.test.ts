import { describe, expect, test } from "vitest";
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

describe("secret credentials", () => {
  const empty = {
    username: "",
    password: "",
    privateKey: "",
    passphrase: "",
    certificatePem: "",
    privateKeyPem: "",
    privateKeyPassword: "",
  };

  test("validates without a username and keeps the stored value on edit", () => {
    expect(validateCredentialForm("token", "secret", { ...empty, secretValue: "ghp_x" })).toBeNull();
    expect(validateCredentialForm("token", "secret", empty)).toBe("Secret value is required");
    expect(validateCredentialForm("token", "secret", { ...empty, secretValue: "a\nb" }))
      .toBe("Secret value must be a single line");
    expect(validateCredentialForm("token", "secret", empty, makeInitial({ value: "(stored)" }))).toBeNull();
    expect(buildCredentialPayload("secret", empty, makeInitial({ value: "(stored)" })))
      .toEqual({ value: "(stored)" });
    expect(buildCredentialPayload("secret", { ...empty, secretValue: "ghp_new" }))
      .toEqual({ value: "ghp_new" });
  });
});
