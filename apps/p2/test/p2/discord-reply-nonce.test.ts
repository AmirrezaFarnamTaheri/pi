import assert from "node:assert/strict";
import { it } from "node:test";
import { replyNonce } from "../../plugins/discord/reply-nonce.ts";

it("gives a stable unique Discord nonce for each reply chunk across retries", () => {
  const one = replyNonce("12345678901234567890", 0);
  assert.match(one, /^[0-9a-f]{25}$/);
  assert.equal(one, replyNonce("12345678901234567890", 0));
  assert.notEqual(one, replyNonce("12345678901234567890", 1));
  assert.notEqual(one, replyNonce("22345678901234567890", 0));
});
