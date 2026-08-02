import assert from "node:assert/strict";
import test from "node:test";
import {
  SETTINGS_ANNOUNCE_EVENT,
  SETTINGS_CHANGED_EVENT,
  SETTINGS_DISCOVER_EVENT,
  SETTINGS_LOCALE_EVENT,
  SETTINGS_PROTOCOL_VERSION,
  type SettingsDiscoverEventV1,
  type SettingsLocaleEventV1,
} from "pi-maestro-settings-core/v1/events";

const discover: SettingsDiscoverEventV1 = {
  version: SETTINGS_PROTOCOL_VERSION,
  requestId: "request-1",
  context: { cwd: "/workspace", locale: "en" },
};
const locale: SettingsLocaleEventV1 = {
  version: SETTINGS_PROTOCOL_VERSION,
  locale: "zh-CN",
  generation: "locale-1",
};

test("v1 event names and protocol version are stable", () => {
  assert.equal(SETTINGS_PROTOCOL_VERSION, 1);
  assert.equal(SETTINGS_DISCOVER_EVENT, "maestro:settings:discover");
  assert.equal(SETTINGS_ANNOUNCE_EVENT, "maestro:settings:announce");
  assert.equal(SETTINGS_CHANGED_EVENT, "maestro:settings:changed");
  assert.equal(SETTINGS_LOCALE_EVENT, "maestro:settings:locale");
  assert.deepEqual(discover, {
    version: 1,
    requestId: "request-1",
    context: { cwd: "/workspace", locale: "en" },
  });
  assert.deepEqual(locale, { version: 1, locale: "zh-CN", generation: "locale-1" });
});
