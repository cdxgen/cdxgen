import fs from "node:fs";
import https from "node:https";
import usb from "usb";

const endpoint = process.env.CDXGEN_TEST_URL;

export function boot() {
  fs.readFileSync("config/settings.json", "utf8");
  https.request("https://example.invalid/api");
  fetch(endpoint);
  eval("console.log('eval-path')");
  return import(process.env.CDXGEN_PLUGIN_NAME);
}

export function enumerateHardware() {
  return usb.getDeviceList();
}
