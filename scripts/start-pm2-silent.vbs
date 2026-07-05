' 静默启动 PM2（无控制台窗口）
Set ws = CreateObject("Wscript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
ws.Run "cmd /c """ & scriptDir & "\pm2-resurrect.cmd""", 0, False
