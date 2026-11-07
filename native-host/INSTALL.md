# Native host install

Optional everywhere. Skip it and the app falls back to calendar evidence, failing quiet.

Host manifest (`com.acc.quietprobe.json`) — replace the extension id:

```json
{
  "name": "com.acc.quietprobe",
  "description": "Reads OS Focus / Do Not Disturb state",
  "path": "/absolute/path/to/quiet-probe.py",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]
}
```

**macOS** — `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
(Edge: `Microsoft Edge`; Brave: `BraveSoftware/Brave-Browser`).
`chmod +x quiet-probe.py` and confirm the shebang resolves.

**Windows** — `path` must be absolute with escaped backslashes, and `.py` files are not
directly executable by the browser. Point at a launcher instead:

```bat
@echo off
python "%~dp0quiet-probe.py"
```

Then register it:

```
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.acc.quietprobe" ^
  /ve /t REG_SZ /d "C:\path\to\com.acc.quietprobe.json" /f
```

**Linux** — `~/.config/google-chrome/NativeMessagingHosts/`.

**Firefox** — same manifest, but `allowed_extensions: ["ambient-companion@yourorg.example"]`
instead of `allowed_origins`, in `~/.mozilla/native-messaging-hosts/`.

**Safari** — this script will not work. Safari routes native messages through the containing
app's `SafariWebExtensionHandler`, so the Focus probe has to be reimplemented in Swift there.
The Safari build drops the `nativeMessaging` permission and the resolver handles its absence.

## Verify

```bash
python3 -c "
import json,struct,subprocess
p=subprocess.Popen(['python3','quiet-probe.py'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
msg=json.dumps({'q':'focus'}).encode()
p.stdin.write(struct.pack('=I',len(msg))+msg); p.stdin.flush()
n=struct.unpack('=I',p.stdout.read(4))[0]
print(json.loads(p.stdout.read(n)))
"
```
