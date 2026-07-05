Set ws = CreateObject("Wscript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
ws.Run "cmd /c """ & scriptDir & "\run-service.cmd""", 0, False
