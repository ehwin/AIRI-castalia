' ============================================================
'  Castalia - Anima event digest, windowless launcher
'  NOTE: keep this file ASCII-only. Windows Script Host reads
'  .vbs using the OEM/ANSI codepage, so non-ASCII comments get
'  mangled and can break parsing (same rule as the .cmd files).
'
'  Why: a Scheduled Task that runs node directly creates a console;
'  with Windows Terminal as the default host that console becomes a
'  visible window on every run (every 10 minutes). wscript.exe is a
'  GUI-subsystem binary, so this path shows nothing.
' ============================================================
Option Explicit

Dim sh, node, script, cmd
Set sh = CreateObject("WScript.Shell")

node = "D:\castalia\run\Castalia\bin\CastaliaNode.exe"
script = "D:\castalia\run\Castalia\scripts\anima_event_digest.mjs"

cmd = Chr(34) & node & Chr(34) & " " & Chr(34) & script & Chr(34)
sh.Run cmd, 0, False
