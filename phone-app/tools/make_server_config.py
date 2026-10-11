#!/usr/bin/env python3
"""
Builds the server's config.json from your desktop app's data/config.json.

  python make_server_config.py "C:\\path\\to\\data\\config.json" AuthKey_ABC123DEFG.p8 ^
         --team-id ABCDE12345 --key-id ABC123DEFG

It writes server-config.json (keep it secret: it holds your logins and your Apple key) and prints
the SERVER KEY you type into the iPhone app. Nothing is sent anywhere.
"""
import argparse
import json
import secrets
import sys

ap = argparse.ArgumentParser()
ap.add_argument("desktop_config", help="your PC app's data/config.json")
ap.add_argument("p8", nargs="?", default=None, help="the AuthKey_XXXX.p8 file from Apple (leave out if you have no paid Apple account: the server then runs without push notifications)")
ap.add_argument("--team-id", default=None, help="10-character Apple Team ID")
ap.add_argument("--key-id", default=None, help="10-character Key ID of the .p8 key")
ap.add_argument("--bundle-id", default="win.multichat.giveaway")
ap.add_argument("--sandbox", action="store_true",
                help="use Apple's test push servers (only for apps installed straight from Xcode)")
ap.add_argument("--out", default="server-config.json")
a = ap.parse_args()

try:
    with open(a.desktop_config, encoding="utf-8") as f:
        cfg = json.load(f)
except Exception as e:
    sys.exit(f"Could not read {a.desktop_config}: {e}")
pem = None
if a.p8:
    try:
        pem = open(a.p8, encoding="utf-8").read().strip()
    except Exception as e:
        sys.exit(f"Could not read {a.p8}: {e}")
    if "BEGIN PRIVATE KEY" not in pem:
        sys.exit("That file does not look like an Apple .p8 key.")
    if not (a.team_id and a.key_id):
        sys.exit("With a .p8 key you must also give --team-id and --key-id.")
if not cfg.get("creators"):
    print("Note: your desktop config has no creators yet. Add some in the PC app first, or list Twitch "
          "channels in server.channels.")

key = secrets.token_hex(24)
cfg["server"] = {
    "api_key": key,
    "port": 8080,
    "watch": [],               # creator names to watch; empty means all of your creators
    "channels": [],            # extra Twitch channels to watch
    "live_only": True,         # skip chats where the streamer is offline
    "time_sensitive": False,   # true only if you enabled the Time Sensitive capability in Xcode
    "trust_proxy": True,
}
if pem:
    cfg["server"]["apns"] = {"team_id": a.team_id, "key_id": a.key_id, "bundle_id": a.bundle_id,
                             "key_pem": pem, "sandbox": a.sandbox}
else:
    print("No Apple key given: the server will watch chats but cannot send push notifications.")
with open(a.out, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)

print(f"Wrote {a.out}")
print()
print("SERVER KEY (type this into the iPhone app):")
print(f"  {key}")
print()
print("Keep the file private. Anyone with it can use your accounts.")
