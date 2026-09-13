' Runs the proxy with no console window and stays alive until it exits, so the
' scheduled task owns the process lifetime and can restart it.
' Usage: wscript //nologo run-hidden.vbs <node.exe> <server.mjs> <config.toml>
Option Explicit
Dim shell, fso, dir, quote, commandLine
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
quote = Chr(34)

If WScript.Arguments.Count <> 3 Then
  WScript.Quit 2
End If

commandLine = "cmd.exe /c " & quote _
  & quote & WScript.Arguments(0) & quote & " " _
  & quote & WScript.Arguments(1) & quote & " " _
  & quote & WScript.Arguments(2) & quote _
  & " >>" & quote & dir & "\proxy.stdout.log" & quote _
  & " 2>>" & quote & dir & "\proxy.stderr.log" & quote _
  & quote

' 0 = hidden window, True = wait for the proxy to exit before returning.
WScript.Quit shell.Run(commandLine, 0, True)
