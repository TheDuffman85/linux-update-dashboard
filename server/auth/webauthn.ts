import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from "@simplewebauthn/server";

const rpName = "Linux Update Dashboard";

export async function getRegistrationOptions(
  userId: number,
  username: string,
  existingCredentials: Array<{ credentialId: string }>,
  rpID: string
) {
  const excludeCredentials = existingCredentials.map((cred) => ({
    id: cred.credentialId,
  }));

  return generateRegistrationOptions({
    rpName,
    rpID,
    userName: username,
    userDisplayName: username,
    userID: new TextEncoder().encode(String(userId)),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    excludeCredentials,
  });
}

export async function verifyRegistration(
  credential: unknown,
  expectedChallenge: string,
  expectedOrigin: string,
  rpID: string
): Promise<VerifiedRegistrationResponse> {
  return verifyRegistrationResponse({
    response: credential as Parameters<
      typeof verifyRegistrationResponse
    >[0]["response"],
    expectedChallenge,
    expectedRPID: rpID,
    expectedOrigin,
  });
}

export async function getAuthenticationOptions(
  credentials: Array<{ credentialId: string }>,
  rpID: string
) {
  const allowCredentials = credentials.map((cred) => ({
    id: cred.credentialId,
  }));

  return generateAuthenticationOptions({
    rpID,
    allowCredentials: allowCredentials.length > 0 ? allowCredentials : undefined,
    userVerification: "preferred",
  });
}

export async function verifyAuthentication(
  credential: unknown,
  expectedChallenge: string,
  expectedOrigin: string,
  rpID: string,
  storedCredential: {
    credentialId: string;
    publicKey: string;
    signCount: number;
  }
): Promise<VerifiedAuthenticationResponse> {
  return verifyAuthenticationResponse({
    response: credential as Parameters<
      typeof verifyAuthenticationResponse
    >[0]["response"],
    expectedChallenge,
    expectedRPID: rpID,
    expectedOrigin,
    credential: {
      id: storedCredential.credentialId,
      publicKey: Buffer.from(storedCredential.publicKey, "base64url"),
      counter: storedCredential.signCount,
    },
  });
}
