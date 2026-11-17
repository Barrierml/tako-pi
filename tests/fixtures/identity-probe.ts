/**
 * Prints the identity resolved by lib/tako-auth.ts as JSON.
 *
 * Runs in a child process so each scenario gets a fresh module instance with
 * its own process.env. The raw key is never printed; tests compare the
 * SHA-256 accountFingerprint instead.
 */
import { getTakoIdentity, TAKO_CONFIG_PATH } from "../../lib/tako-auth.ts";

const identity = getTakoIdentity();
process.stdout.write(
  JSON.stringify({
    hasIdentity: identity !== null,
    configPath: TAKO_CONFIG_PATH,
    accountFingerprint: identity?.accountFingerprint ?? null,
    gatewayBaseUrl: identity?.gatewayBaseUrl ?? null,
    messagesBaseUrl: identity?.messagesBaseUrl ?? null,
    catalogUrl: identity?.catalogUrl ?? null,
  }),
);
