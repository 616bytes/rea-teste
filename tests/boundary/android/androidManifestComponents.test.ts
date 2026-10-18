import { expect, it } from "vitest";

import {
  ANDROID_MANIFEST_LIMITS,
  parseAndroidManifestComponents,
  resolveAndroidComponentName,
} from "../../../src/android/AndroidManifestComponents.js";

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app">
  <application android:label="Example">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
    <activity android:name="DetailActivity">
      <intent-filter>
        <action android:name="com.example.app.OPEN_DETAIL" />
      </intent-filter>
    </activity>
    <activity android:name="com.example.app.HiddenActivity" android:exported="false">
      <intent-filter>
        <action android:name="com.example.app.HIDDEN" />
      </intent-filter>
    </activity>
    <activity-alias
      android:name=".AliasActivity"
      android:targetActivity=".MainActivity"
      android:exported="true" />
    <service
      android:name=".SyncService"
      android:permission="com.example.app.SYNC"
      android:foregroundServiceType="dataSync" />
    <receiver android:name=".BootReceiver">
      <intent-filter>
        <action android:name="android.intent.action.BOOT_COMPLETED" />
      </intent-filter>
    </receiver>
    <provider
      android:name=".DataProvider"
      android:authorities="com.example.app.data;com.example.app.backup"
      android:exported="false" />
    <meta-data android:name="ignored" android:value="not-a-component" />
  </application>
</manifest>`;

it("projects declared components with resolved names and export defaults", () => {
  const inventory = parseAndroidManifestComponents(MANIFEST, "complete");
  expect(inventory.status).toBe("complete");
  expect(inventory.limitations).toEqual([]);
  expect(inventory.items.map(({ kind, name }) => [kind, name])).toEqual([
    ["activity", "com.example.app.MainActivity"],
    ["activity", "com.example.app.DetailActivity"],
    ["activity", "com.example.app.HiddenActivity"],
    ["activity-alias", "com.example.app.AliasActivity"],
    ["service", "com.example.app.SyncService"],
    ["receiver", "com.example.app.BootReceiver"],
    ["provider", "com.example.app.DataProvider"],
  ]);
  expect(inventory.items[0]).toMatchObject({
    declared_name: ".MainActivity",
    exported: true,
    exported_by_intent_filter: true,
    actions: ["android.intent.action.MAIN"],
    categories: ["android.intent.category.LAUNCHER"],
  });
  // Absent android:exported is the documented intent-filter default, not a
  // declaration, so both fields are reported.
  expect(inventory.items[1]).toMatchObject({
    exported: null,
    exported_by_intent_filter: true,
  });
  expect(inventory.items[2]).toMatchObject({
    exported: false,
    exported_by_intent_filter: true,
  });
  expect(inventory.items[3]).toMatchObject({
    target_activity: ".MainActivity",
  });
  expect(inventory.items[4]).toMatchObject({
    permission: "com.example.app.SYNC",
    foreground_service_type: "dataSync",
    actions: [],
  });
  expect(inventory.items[5]).toMatchObject({
    actions: ["android.intent.action.BOOT_COMPLETED"],
    categories: [],
  });
  expect(inventory.items[6]?.authorities).toEqual([
    "com.example.app.data",
    "com.example.app.backup",
  ]);
});

it("resolves relative names against the manifest package", () => {
  expect(resolveAndroidComponentName("com.example.app", ".Main")).toBe(
    "com.example.app.Main",
  );
  expect(resolveAndroidComponentName("com.example.app", "Main")).toBe(
    "com.example.app.Main",
  );
  expect(resolveAndroidComponentName("com.example.app", "org.other.Main")).toBe(
    "org.other.Main",
  );
  expect(resolveAndroidComponentName(null, ".Main")).toBe(".Main");
});

it("does not establish a component inventory from truncated manifest text", () => {
  const inventory = parseAndroidManifestComponents(MANIFEST, "partial");
  expect(inventory.status).toBe("partial");
  expect(inventory.items).toEqual([]);
  expect(inventory.limitations[0]).toContain("truncated");
});

it("reports unavailable inventory for malformed or unexpected manifests", () => {
  expect(
    parseAndroidManifestComponents("<manifest><application>", "complete"),
  ).toMatchObject({ status: "unavailable", items: [] });
  expect(
    parseAndroidManifestComponents(
      '<?xml version="1.0" encoding="utf-8"?><resources />',
      "complete",
    ),
  ).toMatchObject({ status: "unavailable", items: [] });
  expect(
    parseAndroidManifestComponents(
      '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE manifest><manifest />',
      "complete",
    ),
  ).toMatchObject({ status: "unavailable", items: [] });
});

it("bounds the component inventory and says so", () => {
  const repeated = Array.from(
    { length: ANDROID_MANIFEST_LIMITS.components + 1 },
    (_, index) => `<activity android:name=".Activity${String(index)}" />`,
  ).join("");
  const inventory = parseAndroidManifestComponents(
    `<?xml version="1.0" encoding="utf-8"?><manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application>${repeated}</application></manifest>`,
    "complete",
  );
  expect(inventory.status).toBe("partial");
  expect(inventory.items).toHaveLength(ANDROID_MANIFEST_LIMITS.components);
  expect(inventory.limitations.join(" ")).toContain(
    String(ANDROID_MANIFEST_LIMITS.components),
  );
});
