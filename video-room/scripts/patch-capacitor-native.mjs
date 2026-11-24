/**
 * After `npx cap sync`, inject iOS background audio entitlements and
 * Android mic/FGS permissions that the shell needs for screen-off calls.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

patchIosInfoPlist();
patchAndroidManifest();
console.log("Patched Capacitor native projects for screen-off voice.");

function patchIosInfoPlist() {
  const plistPath = join(root, "ios", "App", "App", "Info.plist");
  if (!existsSync(plistPath)) {
    console.log("Skip iOS Info.plist (ios/ not present yet).");
    return;
  }
  let plist = readFileSync(plistPath, "utf8");

  if (!plist.includes("UIBackgroundModes")) {
    plist = plist.replace(
      "</dict>\n</plist>",
      `	<key>UIBackgroundModes</key>
	<array>
		<string>audio</string>
	</array>
</dict>
</plist>`,
    );
  } else if (!plist.includes("<string>audio</string>")) {
    plist = plist.replace(
      /<key>UIBackgroundModes<\/key>\s*<array>/,
      `$&
		<string>audio</string>`,
    );
  }

  if (!plist.includes("NSMicrophoneUsageDescription")) {
    plist = plist.replace(
      "</dict>\n</plist>",
      `	<key>NSMicrophoneUsageDescription</key>
	<string>Voice Room needs the microphone so others can hear you while the screen is locked.</string>
</dict>
</plist>`,
    );
  }

  writeFileSync(plistPath, plist);
  console.log("Updated ios Info.plist background audio + mic usage.");
}

function patchAndroidManifest() {
  const manifestPath = join(
    root,
    "android",
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (!existsSync(manifestPath)) {
    console.log("Skip AndroidManifest (android/ not present yet).");
    return;
  }

  let manifest = readFileSync(manifestPath, "utf8");
  const permissions = [
    "android.permission.RECORD_AUDIO",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_MICROPHONE",
    "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.WAKE_LOCK",
  ];

  for (const permission of permissions) {
    if (manifest.includes(permission)) continue;
    manifest = manifest.replace(
      "<application",
      `    <uses-permission android:name="${permission}" />\n\n    <application`,
    );
  }

  writeFileSync(manifestPath, manifest);

  const keepXmlDir = join(
    root,
    "android",
    "app",
    "src",
    "main",
    "res",
    "xml",
  );
  mkdirSync(keepXmlDir, { recursive: true });
  // Capacitor may already ship network security; ensure dir exists for future overlays.
  console.log("Updated android AndroidManifest permissions.");
}
