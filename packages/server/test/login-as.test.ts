import { test } from "node:test";
import assert from "node:assert/strict";
import { bannerShowsUser } from "../src/salesforce/login-as.ts";

const jeff = { name: "Jeff Kraft", username: "jeffkraft@rms.com" };

test("matches the Login As banner by username", () => {
  assert.equal(bannerShowsUser("Logged in as Jeff Kraft (jeffkraft@rms.com) | Sandbox: tmcdev | Log out as Jeff Kraft", jeff), true);
  assert.equal(bannerShowsUser("Logged in as Jeff Kraft (JeffKraft@RMS.com) | Sandbox: tmcdev", jeff), true);
});

test("a different user in the banner is not a match, even if the page mentions the persona", () => {
  assert.equal(bannerShowsUser("Logged in as Someone Else (other@rms.com) | Log out as Jeff Kraft", jeff), false);
  assert.equal(bannerShowsUser("Logged in as Jeff Kraft (jeffkraft2@rms.com)", jeff), false);
});

test("falls back to the name only when the banner shows no username", () => {
  assert.equal(bannerShowsUser("Logged in as Jeff Kraft | Log out", jeff), true);
  assert.equal(bannerShowsUser("Logged in as Jeff Krafton | Log out", jeff), false);
  assert.equal(bannerShowsUser("", jeff), false);
});
