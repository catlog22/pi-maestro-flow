import assert from "node:assert/strict";
import test from "node:test";
import {
  SETTINGS_EDITOR_KINDS,
  type SettingsEditor,
  type SettingDefinition,
} from "pi-maestro-settings-core/v1";

test("protocol gains list-crud and overview editor kinds", () => {
  assert.ok(SETTINGS_EDITOR_KINDS.includes("list-crud"));
  assert.ok(SETTINGS_EDITOR_KINDS.includes("overview"));
  assert.ok(SETTINGS_EDITOR_KINDS.includes("secret"));
  assert.ok(SETTINGS_EDITOR_KINDS.includes("action"));
});

test("secret editors declare writeOnly to become writable", () => {
  const editor = {
    kind: "secret",
    writeOnly: true,
  } satisfies SettingsEditor;
  assert.equal(editor.writeOnly, true);
});

test("list-crud editors carry itemFields and label keys", () => {
  const editor: SettingsEditor = {
    kind: "list-crud",
    itemLabelKey: "api.item.provider",
    addLabelKey: "api.action.add",
    itemFields: [{
      key: "id",
      group: "providers",
      labelKey: "api.field.id",
      scopes: ["global"],
      merge: "override",
      activation: "live",
      sensitivity: "public",
      reversibility: "full",
      editor: { kind: "text" },
    }, {
      key: "enabled",
      group: "providers",
      labelKey: "api.field.enabled",
      scopes: ["global"],
      merge: "override",
      activation: "live",
      sensitivity: "public",
      reversibility: "full",
      editor: { kind: "boolean" },
    }],
  };
  assert.equal(editor.kind, "list-crud");
  assert.equal(editor.itemFields?.length, 2);
  const field = editor.itemFields![0]!;
  assert.ok((field satisfies SettingDefinition));
  assert.equal(field.editor.kind, "text");
});

test("overview editors carry no item fields", () => {
  const editor = {
    kind: "overview",
  } satisfies SettingsEditor;
  assert.equal(editor.kind, "overview");
});
